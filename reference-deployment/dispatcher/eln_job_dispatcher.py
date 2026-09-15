#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Johnson Lab ELN — analysis job dispatcher (removes the manual `az job start`).

Polls the eLabFTW "Analysis runs" store for Status=Queued records; when there is work AND the
Container Apps GPU job is not already running, it STARTS the job via the Azure management API using
the VM's managed identity. The worker (inside the job) then claims and processes every Queued run.

So the whole flow is hands-off: a user submits from the colocalization tool → this dispatcher starts
the GPU job → results are written back. No shell, ever.

Requires (env file /etc/elab-job-dispatcher.env):
  ELAB_APIKEY   eLabFTW API key (read the Analysis-runs store)
  ELAB_BASE     default https://localhost/api/v2
  AZ_SUB, AZ_RG, AZ_JOB   Azure subscription / resource group / job name
Needs the VM managed identity to have read + start on the job (Microsoft.App/jobs/read + .../start/action).

RUN (foreground): python3 eln_job_dispatcher.py
DEPLOY: systemd service elab-job-dispatcher. Standard library only.
"""
import os, ssl, json, time, urllib.request, urllib.error
from urllib.parse import urlencode

ELAB_BASE = os.environ.get("ELAB_BASE", "https://localhost/api/v2").rstrip("/")
ELAB_KEY  = os.environ.get("ELAB_APIKEY", "")
AZ_SUB    = os.environ.get("AZ_SUB", "YOUR-AZURE-SUBSCRIPTION-ID")
AZ_RG     = os.environ.get("AZ_RG", "YOUR-RESOURCE-GROUP")
AZ_JOB    = os.environ.get("AZ_JOB", "coloc-worker")            # colocalization / cell counting / morphology
AZ_JOB_GCAMP = os.environ.get("AZ_JOB_GCAMP", "gcamp-worker")   # calcium imaging (GCaMP) — separate image
API_VER   = os.environ.get("AZ_API_VERSION", "2024-03-01")
STORE_TITLE = os.environ.get("ANALYSIS_RUNS_TITLE", "Analysis runs").strip().lower()
POLL_SECONDS = int(os.environ.get("DISPATCH_POLL_SECONDS", "20"))
COOLDOWN = int(os.environ.get("DISPATCH_COOLDOWN_SECONDS", "150"))  # after a start, wait before re-checking

_UNVERIFIED = ssl._create_unverified_context()


def mgmt_url(job):
    return ("https://management.azure.com/subscriptions/%s/resourceGroups/%s/providers/Microsoft.App/jobs/%s"
            % (AZ_SUB, AZ_RG, job))


def job_for(job_type):
    """Map a run's Job type to the Container Apps job that runs it."""
    if (job_type or "").strip().lower() == "calcium (gcamp)":
        return AZ_JOB_GCAMP
    return AZ_JOB   # Colocalization, Cell counting, Cell morphology share the coloc image


def imds_token(resource):
    q = urlencode({"api-version": "2018-02-01", "resource": resource})
    req = urllib.request.Request("http://169.254.169.254/metadata/identity/oauth2/token?" + q,
                                 headers={"Metadata": "true"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["access_token"]


def elab_get(path):
    req = urllib.request.Request(ELAB_BASE + path, headers={"Authorization": ELAB_KEY, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60, context=_UNVERIFIED) as r:
        t = r.read().decode()
        return json.loads(t) if t.strip() else None


def analysis_cat():
    cats = elab_get("/teams/current/resources_categories") or []
    for c in cats:
        if str(c.get("title") or "").strip().lower() == STORE_TITLE:
            return c.get("id")
    return None


def queued_by_job(cat_id):
    """Count Status=Queued runs grouped by the Container Apps job that should run them."""
    items = elab_get("/items?cat=%d&extended=1&limit=9999" % cat_id) or []
    counts = {}
    for it in items:
        try:
            ef = json.loads(it.get("metadata") or "{}").get("extra_fields") or {}
        except Exception:
            ef = {}
        if str((ef.get("Status") or {}).get("value") or "") != "Queued":
            continue
        job = job_for(str((ef.get("Job type") or {}).get("value") or ""))
        counts[job] = counts.get(job, 0) + 1
    return counts


def mgmt(method, url):
    token = imds_token("https://management.azure.com/")
    req = urllib.request.Request(url, method=method,
                                 headers={"Authorization": "Bearer " + token, "Content-Length": "0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def job_is_active(job):
    """True if an execution of `job` is currently Running/Processing/Pending (avoid double-start)."""
    st, body = mgmt("GET", mgmt_url(job) + "/executions?api-version=" + API_VER)
    if st != 200 or not isinstance(body, dict):
        return False
    for ex in body.get("value", []):
        s = str(((ex.get("properties") or {}).get("status")) or "").lower()
        if s in ("running", "processing", "pending", "unknown"):
            return True
    return False


def start_job(job):
    st, _ = mgmt("POST", mgmt_url(job) + "/start?api-version=" + API_VER)
    return 200 <= st < 300, st


def main():
    if not ELAB_KEY:
        print("!! ELAB_APIKEY not set"); return 1
    cat = None
    print("[dispatcher] watching '%s' → coloc=%s / gcamp=%s (poll %ds)"
          % (STORE_TITLE, AZ_JOB, AZ_JOB_GCAMP, POLL_SECONDS), flush=True)
    while True:
        try:
            if cat is None:
                cat = analysis_cat()
            if cat is not None:
                started = False
                for job, q in queued_by_job(cat).items():
                    if q > 0 and not job_is_active(job):
                        ok, code = start_job(job)
                        print("[dispatcher] %d queued → start %s: %s (HTTP %s)"
                              % (q, job, "OK" if ok else "FAILED", code), flush=True)
                        started = started or ok
                if started:
                    time.sleep(COOLDOWN)
                    continue
        except Exception as e:
            print("[dispatcher] error: %r" % e, flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
