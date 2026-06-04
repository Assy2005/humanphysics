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
import threading
import time
from collections import defaultdict, deque
from urllib.parse import parse_qs
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

    # GPU依存（gpu-detect 合流時は coreA.gpu、無ければ coreA.webgl にフォールバック）
    gpu = _path(signals, "coreA.gpu") or {}
    gl = gpu.get("webgl") or _path(signals, "coreA.webgl") or {}
    wg = gpu.get("webgpu") or {}
    ua_l = (aux.get("userAgent") or "").lower()
    is_chrome = ("chrome" in ua_l or "edg" in ua_l) and "firefox" not in ua_l
    if gl.get("supported") is False:
        bot += 50; reasons.append("WebGL 利用不可（GPU無/headless）")
    elif gl.get("software"):
        bot += 45; reasons.append("WebGL ソフトレンダラ: %s" % gl.get("renderer"))
    if gpu:
        if wg.get("supported") and wg.get("adapter") and wg.get("isFallbackAdapter"):
            bot += 35; reasons.append("WebGPU フォールバック(software)アダプタ")
        if is_chrome:
            if not wg.get("supported"):
                bot += 15; reasons.append("Chrome系UAだが WebGPU 非対応")
            elif wg.get("adapter") is False:
                bot += 25; reasons.append("WebGPU APIはあるがアダプタ取得不可（headless の兆候）")
        rnd = (gl.get("renderer") or "").lower()
        claims_gpu = any(x in rnd for x in ["nvidia", "geforce", "radeon", "amd", "intel", "iris", "apple", "adreno", "mali", "directx", "angle"])
        rm = gl.get("renderMs")
        if claims_gpu and not gl.get("software") and rm is not None and rm > 120:
            bot += 40; reasons.append("実GPUを名乗るのに描画が遅い(%sms)＝レンダラ詐称の疑い" % rm)

    # DRM/CDM アテステーション: Chrome系を名乗るのに Widevine も PlayReady も皆無（timeout 除外）
    drm = _path(signals, "coreA.drm") or {}
    ua = (aux.get("userAgent") or "").lower()
    chrome_family = ("chrome" in ua or "crios" in ua or "edg" in ua or "opr" in ua)
    if (chrome_family and drm.get("supported") and drm.get("widevine") is False
            and not drm.get("widevineTimedOut") and drm.get("playready") is False):
        bot += 25; reasons.append("Chrome系UAだが DRM(CDM) 皆無 — 自動化/Chromium の兆候")

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

    human = max(0, min(100, 100 - bot))
    verdict = "human-likely"
    if bot >= 60:
        verdict = "bot-likely"
    elif bot >= 25:
        verdict = "suspect"
    return {"humanScore": human, "botEvidence": bot, "verdict": verdict, "reasons": reasons}


# ============================ サーバ側集約（横断分析）============================
# 単発の受動シグナルは弱い。多数リクエストを横断した「同一指紋の頻度(velocity)」「IP集中」
# 「指紋ローテーション」で、スケールした bot を捕える（＝完全パッシブの本丸）。
# PoC ゆえ in-memory（本番は Redis/DB）。
_AGG_LOCK = threading.Lock()
_EVENTS = deque()        # (ts, fingerprint, ip)
_AGG_WINDOW = 3600       # 保持秒
_AGG_CAP = 20000         # メモリ上限


def fingerprint(signals):
    # 安定した受動シグナルから端末を識別（クライアント申告でなくサーバ側で導出）
    a = signals.get("coreA") or {}
    aux = signals.get("aux") or {}
    parts = [
        aux.get("userAgent", "") or "",
        (a.get("math") or {}).get("hash", "") or "",
        (a.get("webgl") or {}).get("renderer", "") or "",
        str(aux.get("hardwareConcurrency")),
        str(aux.get("deviceMemory")),
        ",".join(aux.get("languages") or []),
        str((a.get("timer") or {}).get("effectiveResolutionMs")),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


def aggregate(fp, ip):
    now = time.time()
    with _AGG_LOCK:
        while _EVENTS and (now - _EVENTS[0][0] > _AGG_WINDOW or len(_EVENTS) > _AGG_CAP):
            _EVENTS.popleft()
        _EVENTS.append((now, fp, ip))
        fp60 = fp600 = ip60 = 0
        ipfps = set()
        for (t, f, i) in _EVENTS:
            if f == fp and now - t <= 60:
                fp60 += 1
            if f == fp and now - t <= 600:
                fp600 += 1
            if i == ip:
                if now - t <= 60:
                    ip60 += 1
                if now - t <= 600:
                    ipfps.add(f)
    return {"fingerprint": fp, "fp_60s": fp60, "fp_600s": fp600, "ip_60s": ip60, "ip_distinct_fps_600s": len(ipfps)}


def aggregate_score(agg):
    bot, reasons = 0, []
    if agg["fp_60s"] >= 40:
        bot += 70; reasons.append("同一指紋が60秒で%d回（自動化）" % agg["fp_60s"])
    elif agg["fp_60s"] >= 15:
        bot += 30; reasons.append("同一指紋が60秒で%d回（高頻度）" % agg["fp_60s"])
    if agg["ip_60s"] >= 80:
        bot += 40; reasons.append("同一IPが60秒で%d回" % agg["ip_60s"])
    if agg["ip_distinct_fps_600s"] >= 12:
        bot += 30; reasons.append("同一IPから指紋%d種（ローテーションの疑い）" % agg["ip_distinct_fps_600s"])
    return bot, reasons


def stats_snapshot():
    now = time.time()
    fpc, ipc = defaultdict(int), defaultdict(int)
    with _AGG_LOCK:
        for (t, f, i) in _EVENTS:
            if now - t <= 600:
                fpc[f] += 1
                ipc[i] += 1
    return {
        "window_s": 600, "events": len(_EVENTS),
        "top_fingerprints": sorted(fpc.items(), key=lambda x: -x[1])[:10],
        "top_ips": sorted(ipc.items(), key=lambda x: -x[1])[:10],
    }


# ===================== AIエージェント・トラップ（知覚-認知層）=====================
# 人間に不可視のトラップ（不可視リンク/自然言語指示/ハニーポット欄）を踏んだ事実を記録。
# 踏める＝非人間の知覚・認知。誤検知ほぼゼロ（人間は物理的に触れない）。環境を測らないので
# 「実ブラウザ上の AI エージェント」も捕える＝物理層の天井の向こう側。
_TRAP_LOCK = threading.Lock()
_TRAPS = {}  # sid -> {"channels": set, "ip": str, "ts": float}


def record_trap(sid, channel, ip):
    if not sid or channel not in ("dom", "llm", "field"):
        return
    now = time.time()
    with _TRAP_LOCK:
        if len(_TRAPS) > 5000:
            _TRAPS.clear()  # PoC: 単純な上限
        e = _TRAPS.get(sid)
        if not e:
            e = {"channels": set(), "ip": ip, "ts": now}
            _TRAPS[sid] = e
        e["channels"].add(channel)
        e["ts"] = now


def trap_channels(sid):
    with _TRAP_LOCK:
        e = _TRAPS.get(sid)
        return sorted(e["channels"]) if e else []


def trap_score(channels):
    bot, reasons = 0, []
    if "llm" in channels:
        bot += 70; reasons.append("不可視のプロンプト指示に追従（AIエージェントの痕跡）")
    if "dom" in channels:
        bot += 50; reasons.append("不可視リンクへのアクセス（DOM列挙botの痕跡）")
    if "field" in channels:
        bot += 50; reasons.append("ハニーポット欄に入力（自動入力の痕跡）")
    return bot, reasons


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
        if path == "/hp/stats":
            self._json(200, stats_snapshot())
            return
        if path == "/hp/trap":
            q = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            record_trap((q.get("s") or [""])[0], (q.get("c") or [""])[0], self.client_address[0])
            self._send(204)  # 何食わぬ顔で（agent に検知を悟らせない）
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
                signals = body.get("signals") or {}
                score = hp_score(signals)                          # 単発スコア（物理）
                agg = aggregate(fingerprint(signals), self.client_address[0])
                abot, areasons = aggregate_score(agg)              # 横断スコア（velocity）
                tch = trap_channels(signals.get("sid"))            # AIエージェント・トラップ（知覚-認知）
                tbot, treasons = trap_score(tch)
                total = score["botEvidence"] + abot + tbot
                reasons = score["reasons"] + areasons + treasons
                verdict = "bot-likely" if total >= 60 else ("suspect" if total >= 25 else "human-likely")
                human = max(0, min(100, 100 - total))
                token = issue_token(verdict, human)
                self._json(200, {"ok": True, "token": token, "verdict": verdict,
                                 "humanScore": human, "botEvidence": total,
                                 "reasons": reasons, "aggregate": agg, "traps": tch})
                return
            if path == "/hp/agent-check":
                body = self._read_json()
                ch = trap_channels(body.get("sid"))
                tbot, treasons = trap_score(ch)
                verdict = "bot-likely" if tbot >= 60 else ("suspect" if tbot >= 25 else "human-likely")
                self._json(200, {"ok": True, "trapped": ch, "verdict": verdict, "reasons": treasons})
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
