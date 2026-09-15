# Auto-imported by CPython at interpreter startup for ANY process whose sys.path
# includes this directory (we put it on PYTHONPATH in the image). Morgan's runner is
# a child process that talks to the VPN-only VM over its self-signed internal cert.
# PYTHONHTTPSVERIFY=0 is supposed to disable verification but is unreliable in this
# build, so we apply the same explicit monkeypatch the worker uses in-process. This
# makes urllib's default HTTPS context skip verification (internal private-network
# traffic to the VM only).
try:
    import ssl
    ssl._create_default_https_context = ssl._create_unverified_context
except Exception:
    pass
