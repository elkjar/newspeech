#!/usr/bin/env python3
"""Serve the site from the repo root for local work on pages that need the
Netlify function: POST /api/subscribe answers 200 without touching Resend so
the album page's download gate (and the plugin pages') pass. Everything else
is plain static, with the gitignored assets (EP FLACs) present locally.

    python3 tools/serve-local.py [port]      # default 8765
"""
import http.server, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)
    def do_POST(self):
        if self.path.startswith("/api/subscribe"):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            try: print("[subscribe] (local, not sent)", json.loads(body or b"{}"))
            except Exception: pass
            out = b'{"ok":true,"local":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers(); self.wfile.write(out); return
        self.send_error(404)
    def log_message(self, fmt, *args):
        if "/assets/" in (args[0] if args else ""): return
        super().log_message(fmt, *args)

http.server.ThreadingHTTPServer.allow_reuse_address = True
print(f"serving {ROOT} at http://127.0.0.1:{PORT}/  (POST /api/subscribe → 200, nothing sent)")
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
