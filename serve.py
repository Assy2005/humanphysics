#!/usr/bin/env python3
"""
HumanPhysics PoC サーバ（依存なし・Python標準ライブラリのみ）。

役割:
  - public/ を静的配信
  - POST /collect           研究用: 計測結果を data/samples.jsonl に追記
  - POST /hp/challenge       導入用: 署名付き single-use nonce を発行
  - POST /hp/verify          導入用: 署名(信号)を *サーバ側* で採点し pass トークンを発行
  - POST /hp/check           導入用: サイトのバックエンドが pass トークンを検証する例

設計の要点（red-team を踏まえて）:
  - 判定は **サーバ側** で計算する（クライアントの自己申告スコアは信用しない）。
  - 測定は **single-use の署名 nonce** に束縛し、リプレイを封じる。
  - /hp/* は CORS 許可（別ドメインのサイトからも検証サービスとして使えるように。
    本番では Access-Control-Allow-Origin を自サイトに限定すること）。

起動:
    python serve.py            # http://localhost:8000
    python serve.py 9000
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
DATA = os.path.join(ROOT, "data")
SAMPLES = os.path.join(DATA, "samples.jsonl")
SECRET_FILE = os.path.join(DATA, "secret.key")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}

CHALLENGE_TTL = 120     # nonce 有効期間（秒）
TOKEN_TTL = 300         # pass トークン有効期間（秒）
_used_nonces = {}       # nonce -> 失効時刻（single-use 管理）


def _secret():
    os.makedirs(DATA, exist_ok=True)
    if not os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "wb") as f:
            f.write(os.urandom(32))
    with open(SECRET_FILE, "rb") as f:
        return f.read()


SECRET = _secret()


def _hmac(msg: str) -> str:
    return hmac.new(SECRET, msg.encode("utf-8"), hashlib.sha256).hexdigest()


def issue_challenge():
    nonce = os.urandom(16).hex()
    exp = round(time.time() + CHALLENGE_TTL, 3)
    sig = _hmac("%s.%s" % (nonce, exp))
    return {"nonce": nonce, "exp": exp, "sig": sig}


def check_challenge(nonce, exp, sig):
    if not (nonce and exp and sig):
        return False, "missing fields"
    if not hmac.compare_digest(sig, _hmac("%s.%s" % (nonce, exp))):
        return False, "bad signature"
    if time.time() > float(exp):
        return False, "expired"
    # single-use: 期限内に再利用されたら拒否（リプレイ防止）
    now = time.time()
    for k, v in list(_used_nonces.items()):
        if v < now:
            _used_nonces.pop(k, None)
    if nonce in _used_nonces:
        return False, "nonce already used"
    _used_nonces[nonce] = float(exp)
    return True, "ok"


def issue_token(verdict, score):
    payload = {"verdict": verdict, "score": score, "exp": round(time.time() + TOKEN_TTL, 3)}
    body = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return body + "." + _hmac(body)


def check_token(token):
    try:
        body, sig = token.split(".", 1)
        if not hmac.compare_digest(sig, _hmac(body)):
            return {"valid": False, "reason": "bad signature"}
        payload = json.loads(base64.urlsafe_b64decode(body.encode("ascii")))
        if time.time() > float(payload["exp"]):
            return {"valid": False, "reason": "expired"}
        return {"valid": True, "verdict": payload["verdict"], "score": payload["score"]}
    except Exception as e:  # noqa: BLE001
        return {"valid": False, "reason": "malformed: %s" % e}


# ============================ サーバ側スコアリング ============================
# 判定はここ（サーバ）で計算する。クライアントの score は無視する。
REACTION_FLOOR_MS = 100


def _path(obj, dotted, default=None):
    cur = obj
    for k in dotted.split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return default
    return cur


def hp_score(signals):
    signals = signals or {}
    reasons = []
    bot = 0

    aux = signals.get("aux") or {}
    if aux.get("automationGlobals"):
        bot += 60; reasons.append("automation グローバル: %s" % ",".join(aux["automationGlobals"]))
    if aux.get("webdriver") is True:
        bot += 40; reasons.append("navigator.webdriver=true")
    if aux.get("headlessUA"):
        bot += 50; reasons.append("Headless UA")
    if aux.get("engineUAMismatch"):
        bot += 25; reasons.append("エンジン詐称兆候")
    if aux.get("languagesEmpty"):
        bot += 15; reasons.append("languages 空")

    webgl = _path(signals, "coreA.webgl") or {}
    if webgl.get("supported") and webgl.get("software"):
        bot += 35; reasons.append("WebGL ソフトレンダラ: %s" % webgl.get("renderer"))

    # 行動シグナル（フォーム入力中に受動収集。ボタン不要）
    beh = signals.get("behavior") or {}
    if beh:
        chars = beh.get("charsEntered") or 0
        keys = beh.get("keydowns") or 0
        inp = beh.get("inputEvents")
        # 強シグナル: 文字はあるが input イベントが一度も無い＝プログラム的な値注入(自動化)。
        # 人間の貼付/オートフィルは input を発火するので、ここでは誤検知しない。
        if chars > 0 and inp == 0:
            bot += 60; reasons.append("値がプログラム的に設定（input イベントなし＝自動化）")
        if beh.get("untrusted", 0) > 0:
            bot += 45; reasons.append("合成入力イベント(isTrusted=false) %d" % beh["untrusted"])
        fill = beh.get("fillMs")
        if chars > 0 and fill is not None and fill < 400:
            bot += 30; reasons.append("フォーム充填が高速すぎ(%sms)" % fill)
        ick = beh.get("interKeyCV")
        if keys >= 6 and ick is not None and ick < 0.05:
            bot += 30; reasons.append("打鍵間隔が機械的(cv=%s)" % ick)
        if beh.get("pointerMoves", 0) == 0 and beh.get("submittedByClick"):
            bot += 15; reasons.append("クリック前のポインタ移動ゼロ")

    # Core B（step-up を使った場合のみ）
    b = signals.get("coreB") or {}
    s = b.get("summary") or {}
    if s.get("responded", 0) > 0:
        if s.get("belowHumanFloor", 0) > 0:
            bot += 50; reasons.append("反応 %d 回が人間下限(%dms)未満" % (s["belowHumanFloor"], REACTION_FLOOR_MS))
        if s.get("untrustedResponses", 0) > 0:
            bot += 45; reasons.append("合成イベント応答 %d" % s["untrustedResponses"])
        lat = s.get("latency") or {}
        if lat.get("n", 0) >= 3 and lat.get("cv") is not None and lat["cv"] < 0.06:
            bot += 30; reasons.append("反応分布が過小分散(cv=%s)" % lat["cv"])
        if s.get("nogoErrors", 0) > 0:
            bot += 35; reasons.append("No-Go 試行で誤って応答 %d（抑制の失敗）" % s["nogoErrors"])

    human = max(0, min(100, 100 - bot))
    verdict = "human-likely"
    if bot >= 60:
        verdict = "bot-likely"
    elif bot >= 25:
        verdict = "suspect"
    return {"humanScore": human, "botEvidence": bot, "verdict": verdict, "reasons": reasons}


# ================================== HTTP ====================================
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _cors(self):
        # 本番では "*" を自サイトのオリジンに限定すること
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _read_json(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/hp/challenge":
            self._json(200, issue_challenge())
            return
        if path == "/":
            path = "/index.html"
        target = os.path.normpath(os.path.join(PUBLIC, path.lstrip("/")))
        if not target.startswith(PUBLIC) or not os.path.isfile(target):
            self._send(404, b"not found")
            return
        with open(target, "rb") as f:
            self._send(200, f.read(), MIME.get(os.path.splitext(target)[1].lower(), "application/octet-stream"))

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/hp/challenge":
                self._json(200, issue_challenge())
                return
            if path == "/hp/verify":
                body = self._read_json()
                ok, why = check_challenge(body.get("nonce"), body.get("exp"), body.get("sig"))
                if not ok:
                    self._json(403, {"ok": False, "error": why})
                    return
                score = hp_score(body.get("signals"))
                token = issue_token(score["verdict"], score["humanScore"])
                self._json(200, {"ok": True, "token": token, **score})
                return
            if path == "/hp/check":
                body = self._read_json()
                self._json(200, check_token(body.get("token", "")))
                return
            if path == "/collect":
                obj = self._read_json()
                obj["_received_at"] = datetime.now(timezone.utc).isoformat()
                obj["_remote"] = self.client_address[0]
                os.makedirs(DATA, exist_ok=True)
                with open(SAMPLES, "a", encoding="utf-8") as f:
                    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
                self._json(200, {"ok": True})
                return
            self._send(404, b"not found")
        except Exception as e:  # noqa: BLE001
            self._json(400, {"ok": False, "error": str(e)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.makedirs(DATA, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("HumanPhysics PoC server -> http://localhost:%d  (Ctrl+C で停止)" % port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
