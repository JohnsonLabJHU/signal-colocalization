#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Analysis-platform worker (Phase 2) — COLOCALIZATION.

Closes the loop Morgan's read-only runner leaves open: it polls the eLabFTW "Analysis runs" store for
Queued Colocalization jobs, runs `run_elab_colocalization.py` (which stages the experiment's uploaded
images and produces an Excel workbook + QC), then WRITES THE RESULTS BACK — uploading the outputs to the
experiment and to the run record, and driving the record Queued → Running → Done/Failed with a metrics
summary and tool/model provenance.

One-shot: processes every currently-Queued Colocalization run, then exits (so it fits a scale-to-zero
Container Apps job started on demand). Idempotent-ish: it only claims runs that are still "Queued".

Env:
  ELAB_APIKEY   (required)  eLabFTW API key (injected by Container Apps; never baked in)
  ELAB_BASE     API base, default the VM's private endpoint (container reaches it over the private network)
  RUNNER_DIR    where the SignalColocalization repo is installed (default /opt/SignalColocalization)
  JOB_TYPE      which jobs to take (default "Colocalization")
  MAX_JOBS      cap per invocation (default 0 = all queued)
  ANALYSIS_RUNS_TITLE  store category title (default "Analysis runs")
"""
from __future__ import annotations
import os, sys, ssl, json, socket, subprocess, tempfile, datetime, mimetypes, uuid, shutil
from pathlib import Path
import urllib.request, urllib.parse, urllib.error

# The container reaches the VPN-only VM over the private network with its internal cert → don't verify.
ssl._create_default_https_context = ssl._create_unverified_context

ELAB_BASE = (os.environ.get("ELAB_BASE") or "https://your-eln-host.example.org/api/v2").rstrip("/")
ELAB_KEY  = os.environ.get("ELAB_APIKEY", "")
RUNNER_DIR = os.environ.get("RUNNER_DIR", "/opt/SignalColocalization")
JOB_TYPE   = os.environ.get("JOB_TYPE", "Colocalization")
MAX_JOBS   = int(os.environ.get("MAX_JOBS", "0"))
STORE_TITLE = os.environ.get("ANALYSIS_RUNS_TITLE", "Analysis runs").strip().lower()
HOSTNAME = socket.gethostname()

# Blob staging: inputs uploaded through our front door land here; the container reads them with
# the user-assigned managed identity (same UAMI the job uses to pull from ACR — it also has
# Storage Blob Data Contributor). No account keys.
BLOB_ACCT = os.environ.get("BLOB_ACCT", "")
UAMI_CLIENT_ID = os.environ.get("UAMI_CLIENT_ID", "")
BLOB_VER = "2021-08-06"


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


# ---------------- eLabFTW API (read + WRITE; Morgan's client is read-only) ----------------
def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(ELAB_BASE + path, data=data, method=method)
    req.add_header("Authorization", ELAB_KEY)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.strip() else None), r.headers.get("Location")
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t), None
        except Exception: return e.code, t, None


def upload_file(entity, entity_id, filepath, comment="", name=None):
    """POST a file to /<entity>/<id>/uploads as multipart/form-data (pure urllib).
    `name` overrides the stored filename (so results can carry a per-run prefix)."""
    filepath = Path(filepath)
    fname = name or filepath.name
    boundary = "----elabworker" + uuid.uuid4().hex
    ctype = mimetypes.guess_type(filepath.name)[0] or "application/octet-stream"
    pre = []
    pre.append("--" + boundary)
    pre.append('Content-Disposition: form-data; name="file"; filename="%s"' % fname)
    pre.append("Content-Type: " + ctype)
    pre.append("")
    pre.append("")
    body = "\r\n".join(pre).encode() + filepath.read_bytes() + ("\r\n").encode()
    if comment:
        body += ("--" + boundary + "\r\n").encode()
        body += ('Content-Disposition: form-data; name="comment"\r\n\r\n').encode()
        body += (comment + "\r\n").encode()
    body += ("--" + boundary + "--\r\n").encode()
    req = urllib.request.Request("%s/%s/%s/uploads" % (ELAB_BASE, entity, entity_id), data=body, method="POST")
    req.add_header("Authorization", ELAB_KEY)
    req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def msi_token(resource):
    """Managed-identity token — Container Apps identity endpoint if present, else IMDS; uses the UAMI."""
    ep = os.environ.get("IDENTITY_ENDPOINT")
    hdr = os.environ.get("IDENTITY_HEADER")
    if ep and hdr:
        q = urllib.parse.urlencode({"resource": resource, "api-version": "2019-08-01", "client_id": UAMI_CLIENT_ID})
        req = urllib.request.Request(ep + ("&" if "?" in ep else "?") + q, headers={"X-IDENTITY-HEADER": hdr})
    else:
        q = urllib.parse.urlencode({"api-version": "2018-02-01", "resource": resource, "client_id": UAMI_CLIENT_ID})
        req = urllib.request.Request("http://169.254.169.254/metadata/identity/oauth2/token?" + q, headers={"Metadata": "true"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["access_token"]


def download_blob(pointer, dest_dir):
    """Stage a `blob:container/path` pointer to a local file with the managed identity; return the path."""
    spec = pointer[len("blob:"):] if pointer.lower().startswith("blob:") else pointer
    container, _, path = spec.partition("/")
    if not container or not path:
        raise ValueError("bad blob pointer: %r" % pointer)
    url = "https://%s.blob.core.windows.net/%s/%s" % (BLOB_ACCT, container, urllib.parse.quote(path))
    token = msi_token("https://storage.azure.com/")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "x-ms-version": BLOB_VER})
    local = Path(dest_dir) / os.path.basename(path)
    with urllib.request.urlopen(req, timeout=1800) as r, open(local, "wb") as f:
        shutil.copyfileobj(r, f)
    return str(local)


def fields_of(item):
    try:
        return (json.loads(item.get("metadata") or "{}").get("extra_fields") or {})
    except Exception:
        return {}


def fv(ef, name):
    f = ef.get(name)
    return "" if not isinstance(f, dict) else str(f.get("value") or "")


def set_fields(item_id, updates):
    """PATCH extra_fields values on a run record by name (leaves structure intact)."""
    st, full, _ = api("GET", "/items/%d" % item_id)
    if st != 200 or not isinstance(full, dict):
        return False
    m = json.loads(full.get("metadata") or "{}")
    ef = m.setdefault("extra_fields", {})
    for name, value in updates.items():
        if name in ef and isinstance(ef[name], dict):
            ef[name]["value"] = value
        else:
            ef[name] = {"type": "text", "value": value}
    st, _, _ = api("PATCH", "/items/%d" % item_id, {"metadata": json.dumps(m)})
    return 200 <= st < 300


# ---------------- store discovery ----------------
def analysis_runs_category():
    st, cats, _ = api("GET", "/teams/current/resources_categories")
    if st == 200 and isinstance(cats, list):
        for c in cats:
            if str(c.get("title") or "").strip().lower() == STORE_TITLE:
                return c.get("id")
    return None


def queued_runs(cat_id):
    st, items, _ = api("GET", "/items?cat=%d&extended=1&limit=9999" % cat_id)
    if st != 200 or not isinstance(items, list):
        return []
    out = []
    for it in items:
        ef = fields_of(it)
        if fv(ef, "Status") == "Queued" and fv(ef, "Job type") == JOB_TYPE:
            out.append((it, ef))
    # oldest first (process in submission order)
    out.sort(key=lambda pair: pair[0].get("id", 0))
    return out


def tool_version():
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=RUNNER_DIR,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


# ---------------- run one colocalization job ----------------
def process(run_item, ef):
    run_id = run_item["id"]
    exp_id = fv(ef, "Experiment ID")
    config_json = fv(ef, "Config (job JSON)")
    pointers = fv(ef, "Source pointers")
    print("[run %s] claiming (experiment %s)" % (run_id, exp_id or "?"))
    set_fields(run_id, {"Status": "Running", "Worker host": HOSTNAME, "Started at": now_iso(),
                        "Tool version": tool_version(), "Message / log": "Started on %s" % HOSTNAME})

    with tempfile.TemporaryDirectory(prefix="coloc_run_") as tmp:
        tmp = Path(tmp)
        out_dir = tmp / "out"; out_dir.mkdir()
        inputs_dir = tmp / "inputs"; inputs_dir.mkdir()
        job_path = tmp / "job.json"

        # Resolve EVERY source ourselves and REWRITE job["sources"] with the resolved values
        # (blob: pointers become local file paths we staged; experiment:/item: pass through).
        # We must not leave job["sources"] empty — Morgan's job loader validates it is non-empty
        # BEFORE merging any --source args — so we put the resolved list back into the job itself
        # and pass no --source flags.
        try:
            job = json.loads(config_json or "{}")
        except Exception:
            job = {}
        embedded = [str(s).strip() for s in (job.get("sources") or []) if str(s).strip()]
        raw = [s.strip() for s in pointers.replace(",", "\n").splitlines() if s.strip()]
        for e in embedded:
            if e not in raw:
                raw.append(e)
        if not raw:
            raw = embedded

        resolved, staged = [], 0
        for p in raw:
            if p.lower().startswith("blob:"):
                resolved.append(download_blob(p, inputs_dir))      # uploaded through OUR front door
                staged += 1
            else:
                resolved.append(p)                                 # experiment:/item: still supported
        job["sources"] = resolved
        job_path.write_text(json.dumps(job), encoding="utf-8")
        print("[run %s] sources: %d (%d staged from blob)" % (run_id, len(resolved), staged))

        cmd = [sys.executable, "run_elab_colocalization.py", "--job", str(job_path),
               "--output-dir", str(out_dir), "--save-segmentation"]

        # The runner is a child process; it doesn't inherit our in-process SSL monkeypatch, so its own
        # ElabClient verifies the VM's self-signed cert and fails. PYTHONHTTPSVERIFY=0 makes the child
        # skip verification too (internal VPN traffic to the VM).
        env = dict(os.environ, ELAB_APIKEY=ELAB_KEY, ELAB_BASE=ELAB_BASE, PYTHONHTTPSVERIFY="0")
        print("[run %s] %s" % (run_id, " ".join(cmd)))
        proc = subprocess.run(cmd, cwd=RUNNER_DIR, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, timeout=60 * 60 * 3)
        log_tail = (proc.stdout or "")[-6000:]

        if proc.returncode != 0:
            print("[run %s] FAILED rc=%s" % (run_id, proc.returncode))
            set_fields(run_id, {"Status": "Failed", "Finished at": now_iso(),
                                "Error": "runner exited %s" % proc.returncode,
                                "Message / log": log_tail})
            return

        # collect outputs
        xlsx = sorted(out_dir.glob("*.xlsx"))
        csvs = sorted(out_dir.glob("*.csv"))
        qc = sorted((out_dir / "segmentation_qc").glob("*.png")) if (out_dir / "segmentation_qc").exists() else []
        uploaded = []
        # Per-run prefix so multiple runs on the same experiment are distinguishable at a glance,
        # e.g. run3225_2026-09-02_colocalization_results.xlsx
        prefix = "run%s_%s_" % (run_id, now_iso()[:10])
        # upload the workbook + CSVs to BOTH the experiment (if any) and the run record
        targets = [("items", run_id)]
        if exp_id and str(exp_id).strip().isdigit():
            targets.insert(0, ("experiments", int(exp_id)))
        for f in (xlsx + csvs):
            oname = prefix + f.name
            for entity, eid in targets:
                upload_file(entity, eid, f, comment="Colocalization result (run %s)" % run_id, name=oname)
            uploaded.append(oname)
        # attach QC images to the run record only (can be many); prefix them too for tidiness
        for f in qc[:60]:
            upload_file("items", run_id, f, comment="QC (run %s)" % run_id, name=prefix + f.name)
            uploaded.append(prefix + f.name)

        metrics = summarize(out_dir)
        models = "cpdino (HuggingFace YOUR-ORG/cellpose-retinal-models)"
        set_fields(run_id, {"Status": "Done", "Finished at": now_iso(),
                            "Result files": ", ".join(uploaded) or "(none)",
                            "Metrics summary": metrics,
                            "Models + versions": models,
                            "Message / log": log_tail})
        print("[run %s] DONE — %d file(s) uploaded" % (run_id, len(uploaded)))


def summarize(out_dir):
    """Headline numbers from image_summary.csv (best-effort, no pandas dependency in the worker)."""
    p = out_dir / "image_summary.csv"
    if not p.exists():
        # fall back to counting cells.csv rows
        c = out_dir / "cells.csv"
        if c.exists():
            n = max(0, sum(1 for _ in c.open()) - 1)
            return "%d segmented cell(s) total" % n
        return "completed"
    try:
        lines = p.read_text(encoding="utf-8").splitlines()
        return "%d image/reference summary row(s)" % max(0, len(lines) - 1)
    except Exception:
        return "completed"


def preflight():
    """Prove the RUNNER's child interpreter can reach the VM, and surface the REAL
    exception if it can't (Morgan's client hides it behind a friendly message). Runs a
    tiny urlopen in a child python identical to the runner's environment."""
    probe = (
        "import os,urllib.request as u;"
        "url=os.environ['ELAB_BASE'].rstrip('/')+'/experiments?limit=1';"
        "r=u.Request(url);r.add_header('Authorization',os.environ.get('ELAB_APIKEY',''));"
        "u.urlopen(r,timeout=30).read();print('PREFLIGHT_OK')"
    )
    env = dict(os.environ, ELAB_APIKEY=ELAB_KEY, ELAB_BASE=ELAB_BASE, PYTHONHTTPSVERIFY="0")
    try:
        p = subprocess.run([sys.executable, "-c", probe], env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=60)
        print("[preflight] rc=%s | %s" % (p.returncode, (p.stdout or "").strip()[-800:]))
    except Exception as e:
        print("[preflight] probe crashed: %r" % e)


def main():
    if not ELAB_KEY:
        print("!! ELAB_APIKEY not set."); return 1
    preflight()
    cat = analysis_runs_category()
    if not cat:
        print("!! Could not find the '%s' store category." % STORE_TITLE); return 1
    runs = queued_runs(cat)
    if MAX_JOBS > 0:
        runs = runs[:MAX_JOBS]
    print("Queued %s job(s): %d" % (JOB_TYPE, len(runs)))
    for it, ef in runs:
        try:
            process(it, ef)
        except Exception as e:
            print("[run %s] EXCEPTION: %s" % (it.get("id"), e))
            try:
                set_fields(it["id"], {"Status": "Failed", "Finished at": now_iso(), "Error": str(e)[:900]})
            except Exception:
                pass
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
