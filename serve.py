#!/usr/bin/env python3
"""
HumanPhysics PoC 用の極小サーバ（依存なし・Python標準ライブラリのみ）。

  - public/ を静的配信
  - POST /collect で計測結果(JSON)を data/samples.jsonl に1行ずつ追記

起動:
    python serve.py            # http://localhost:8000
    python serve.py 9000       # ポート指定

低コスト・簡単導入の理念どおり、ビルド不要・依存なしで動きます。
"""
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DATA = os.path.join(ROOT, "data")
SAMPLES = os.path.join(DATA, "samples.jsonl")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # ログを簡潔に
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        target = os.path.normpath(os.path.join(PUBLIC, path.lstrip("/")))
        if not target.startswith(PUBLIC) or not os.path.isfile(target):
            self._send(404, b"not found")
            return
        ext = os.path.splitext(target)[1].lower()
        with open(target, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/collect":
            self._send(404, b"not found")
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n)
            obj = json.loads(raw.decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(400, ("bad json: %s" % e).encode())
            return
        obj["_received_at"] = datetime.now(timezone.utc).isoformat()
        obj["_remote"] = self.client_address[0]
        os.makedirs(DATA, exist_ok=True)
        with open(SAMPLES, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        count = sum(1 for _ in open(SAMPLES, encoding="utf-8"))
        self._send(200, json.dumps({"ok": True, "total": count}).encode(), MIME[".json"])


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.makedirs(DATA, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("HumanPhysics PoC server")
    print("  -> http://localhost:%d" % port)
    print("  サンプル: %s" % SAMPLES)
    print("  Ctrl+C で停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
