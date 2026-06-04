#!/usr/bin/env python3
"""
DRM/EME 層の判別力チェック: A で全層を突破した headless Chrome 攻撃者が
Widevine を持つか（=「Chrome を名乗るのに DRM 無し」で捕まるか）を確認する。

  python bot/check_drm.py            # headless+UA偽装（= tuned adversary と同条件）
  python bot/check_drm.py --headed   # 実GPUの実ブラウザ（参考: 本物の消費者Chrome）
"""
import argparse, json, os, time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

URL = os.environ.get("HP_URL", "http://localhost:8000")


def probe(headed):
    o = Options()
    if not headed:
        o.add_argument("--headless=new")
    o.add_argument("--disable-blink-features=AutomationControlled")
    o.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
    d = webdriver.Chrome(options=o); d.set_script_timeout(30)
    try:
        d.get(URL + "/index.html")
        for _ in range(60):
            if d.execute_script("return !!window.__hpResult"):
                break
            time.sleep(0.2)
        coreA = d.execute_script("return window.__hpResult ? window.__hpResult.coreA : {}")
        ua = d.execute_script("return navigator.userAgent")
        return {"claims_chrome": "chrome" in ua.lower(), "drm": coreA.get("drm"),
                "media": coreA.get("media"), "webglSoftware": (coreA.get("webgl") or {}).get("software")}
    finally:
        d.quit()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--headed", action="store_true"); a = ap.parse_args()
    res = probe(a.headed)
    print(json.dumps(res, ensure_ascii=False))
    drm = res.get("drm") or {}
    if res.get("claims_chrome") and not drm.get("widevine"):
        print(">> Chrome を名乗るのに Widevine 無し = DRM 層がこの攻撃者を捕捉できる")
    elif drm.get("widevine"):
        print(">> Widevine あり(robustness=%s) = この攻撃者は DRM 層を通過する" % drm.get("widevineRobustness"))
