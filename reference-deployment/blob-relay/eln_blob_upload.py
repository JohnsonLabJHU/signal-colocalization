#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Johnson Lab ELN — blob upload relay (analysis-platform front door).

Browser tools POST file bytes here; this service streams them to Azure Blob using
the VM's MANAGED IDENTITY (IMDS token, REST, no account keys, no SDK). The goal
(Tom's requirement): files are uploaded to the cloud through OUR tools, then the
analysis pipeline runs from those blobs — nobody has to touch eLabFTW to feed it.

Security:
  * Binds to the host; reached only through the eLabFTW nginx (same origin).
  * Every request is authenticated by forwarding the caller's eLabFTW session
    cookie to /api/v2/users/me — anonymous callers are rejected (401).
  * Container is allow-listed; blob path is sanitised (no '..', no leading '/').

Endpoints:
  GET  /blobapi/health                      -> {ok, acct, container}
  POST /blobapi/upload?path=<p>&container=<c>&ct=<mime>
       body = raw file bytes (Content-Length required)
       -> {ok, container, path, size, pointer:"blob:<container>/<path>"}

Memory-bounded: reads the request body in blocks and does Put Block + Put Block List.

RUN (foreground):  BLOB_UPLOAD_PORT=8099 python3 eln_blob_upload.py
DEPLOY: systemd unit elab-blob-upload (EnvironmentFile=/etc/elab-blob-upload.env).
Requires only the Python standard library.
"""
import os, ssl, json, base64, socket, urllib.request, urllib.error
from urllib.parse import urlparse, parse_qs, quote
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACCT       = os.environ.get("BLOB_ACCT", "")
EP         = "https://%s.blob.core.windows.net" % ACCT
DEF_CONT   = os.environ.get("BLOB_CONTAINER", "analysis-inputs")
ALLOW_CONT = set((os.environ.get("BLOB_ALLOWED_CONTAINERS", "analysis-inputs,microscopy")).split(","))
ELAB_BASE  = os.environ.get("ELAB_BASE", "https://localhost/api/v2").rstrip("/")
VER        = "2021-08-06"
PORT       = int(os.environ.get("BLOB_UPLOAD_PORT", "8099"))
BIND       = os.environ.get("BLOB_UPLOAD_BIND", "0.0.0.0")
CHUNK      = int(os.environ.get("BLOB_CHUNK_BYTES", str(8 * 1024 * 1024)))   # 8 MiB blocks
MAX_BYTES  = int(os.environ.get("BLOB_MAX_BYTES", str(32 * 1024 * 1024 * 1024)))  # 32 GiB cap

_UNVERIFIED = ssl._create_unverified_context()   # eLab uses a self-signed internal cert


def imds_token():
    req = urllib.request.Request(
        "http://169.254.169.254/metadata/identity/oauth2/token"
        "?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F",
        headers={"Metadata": "true"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["access_token"]


def elab_user(cookie):
    """Return the eLab user dict if the forwarded session cookie is valid, else None."""
    if not cookie:
        return None
    req = urllib.request.Request(ELAB_BASE + "/users/me",
                                 headers={"Cookie": cookie, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10, context=_UNVERIFIED) as r:
            if r.status == 200:
                return json.load(r)
    except Exception:
        return None
    return None


def _blob_req(method, url, data, headers):
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode()[:400]
        except Exception:
            return e.code, ""


def put_block(container, path, block_id, chunk, token):
    url = "%s/%s/%s?comp=block&blockid=%s" % (EP, container, quote(path), quote(block_id))
    return _blob_req("PUT", url, chunk, {
        "Authorization": "Bearer " + token, "x-ms-version": VER,
        "Content-Length": str(len(chunk))})


def put_block_list(container, path, block_ids, content_type, token):
    body = ('<?xml version="1.0" encoding="utf-8"?><BlockList>'
            + "".join("<Latest>%s</Latest>" % b for b in block_ids)
            + "</BlockList>").encode()
    url = "%s/%s/%s?comp=blocklist" % (EP, container, quote(path))
    return _blob_req("PUT", url, body, {
        "Authorization": "Bearer " + token, "x-ms-version": VER,
        "x-ms-blob-content-type": content_type or "application/octet-stream",
        "Content-Type": "application/xml", "Content-Length": str(len(body))})


def safe_path(p):
    """Reject traversal / absolute / control chars; keep a clean relative blob path."""
    if not p:
        return None
    p = p.lstrip("/")
    if ".." in p.split("/") or any(ord(c) < 32 for c in p) or len(p) > 1024:
        return None
    return p


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):   # keep journald quiet; we print our own lines
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        try:
            self.wfile.write(b)
        except Exception:
            pass

    def _read_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            part = self.rfile.read(n - len(buf))
            if not part:
                break
            buf += part
        return bytes(buf)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/blobapi/health":
            return self._send(200, {"ok": True, "acct": ACCT, "container": DEF_CONT,
                                    "allowed": sorted(ALLOW_CONT)})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/blobapi/upload":
            return self._send(404, {"error": "not found"})
        q = parse_qs(u.query)

        user = elab_user(self.headers.get("Cookie"))
        if not user:
            return self._send(401, {"error": "not authenticated to eLabFTW"})

        container = (q.get("container", [DEF_CONT])[0]) or DEF_CONT
        if container not in ALLOW_CONT:
            return self._send(400, {"error": "container not allowed: %s" % container})
        path = safe_path(q.get("path", [None])[0])
        if not path:
            return self._send(400, {"error": "missing or invalid ?path="})
        ct = q.get("ct", ["application/octet-stream"])[0]

        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BYTES:
            return self._send(400, {"error": "bad Content-Length (%s)" % n})

        try:
            token = imds_token()
        except Exception as e:
            return self._send(502, {"error": "managed-identity token failed: %r" % e})

        block_ids, read, i = [], 0, 0
        while read < n:
            want = min(CHUNK, n - read)
            chunk = self._read_exact(want)
            if not chunk:
                return self._send(400, {"error": "client stream ended early at %d/%d" % (read, n)})
            bid = base64.b64encode(("%08d" % i).encode()).decode()
            st, msg = put_block(container, path, bid, chunk, token)
            if st not in (200, 201):
                return self._send(502, {"error": "put_block %d: %s" % (st, msg)})
            block_ids.append(bid)
            read += len(chunk)
            i += 1

        st, msg = put_block_list(container, path, block_ids, ct, token)
        if st not in (200, 201):
            return self._send(502, {"error": "put_block_list %d: %s" % (st, msg)})

        who = (user.get("fullname") or user.get("email") or "user")
        print("[blob-upload] %s -> %s/%s (%d bytes, %d blocks)" % (who, container, path, n, len(block_ids)), flush=True)
        return self._send(200, {"ok": True, "container": container, "path": path,
                                "size": n, "pointer": "blob:%s/%s" % (container, path)})


def main():
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print("[blob-upload] listening on %s:%d  acct=%s  default-container=%s" % (BIND, PORT, ACCT, DEF_CONT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
