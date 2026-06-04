#!/usr/bin/env python3
"""
GPU依存検知の弁別力チェック: headless / headed の実ブラウザで GPUDetect.run() を走らせ、
WebGL/WebGPU の実在・能力・実測時間がどう違うかを見る。

  python bot/check_gpu.py            # headless=new + UA偽装（= tuned adversary 同条件）
  python bot/check_gpu.py --headed   # 実GPU・実描画
"""
import argparse, json, os, time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

URL = os.environ.get("HP_URL", "http://localhost:8000")


def probe(headed, software=False):
    o = Options()
    if not headed:
        o.add_argument("--headless=new")
    if software:  # GPU無し/ソフトレンダラ環境（クラウドサーバ/VM）を模擬
        o.add_argument("--use-angle=swiftshader")
        o.add_argument("--disable-gpu")
    o.add_argument("--disable-blink-features=AutomationControlled")
    o.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
    d = webdriver.Chrome(options=o); d.set_script_timeout(40)
    try:
        d.get(URL + "/gpu.html")
        for _ in range(60):
            if d.execute_script("return !!window.__gpu"):
                break
            time.sleep(0.3)
        return d.execute_script("return window.__gpu")
    finally:
        d.quit()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--software", action="store_true")
    a = ap.parse_args()
    r = probe(a.headed, a.software)
    if not r:
        print("no result (timeout?)"); raise SystemExit
    out = {
        "ua": (r.get("ua") or "")[:50],
        "verdict": r["score"]["verdict"], "score": r["score"]["humanScore"], "reasons": r["score"]["reasons"],
        "webgl": {"supported": r["webgl"].get("supported"), "software": r["webgl"].get("software"),
                  "renderer": r["webgl"].get("renderer"), "renderMs": r["webgl"].get("renderMs")},
        "webgpu": {"supported": r["webgpu"].get("supported"), "adapter": r["webgpu"].get("adapter"),
                   "vendor": r["webgpu"].get("gpuVendor"), "architecture": r["webgpu"].get("gpuArchitecture"),
                   "initMs": r["webgpu"].get("initMs"), "computeMs": r["webgpu"].get("computeMs"),
                   "isFallback": r["webgpu"].get("isFallbackAdapter")},
    }
    print(json.dumps(out, ensure_ascii=False))
