#!/usr/bin/env python3
"""
A = チューンド・アドバーサリ。
強化版 HumanPhysics を「実 Chrome + CDP Input(isTrusted=true) + 人間風 RT + DOM 読み」で攻撃し、
どの層がすり抜けられるか（= 防御の天井）を実測する研究スクリプト。

前提:
  - python serve.py 起動（http://localhost:8000）
  - pip install selenium   （Selenium Manager が Chrome に合うドライバを自動取得）

実行:
  python bot/tuned_adversary.py            # headless=new（既定, 目立たない）
  python bot/tuned_adversary.py --headed   # 実GPU・実描画で Core A を本物にする（フェアな天井測定）

攻撃の中身:
  - aux 回避: --disable-blink-features=AutomationControlled で navigator.webdriver を消す
  - Core B 攻撃: 刺激の向きを DOM から読み、人間の反応時間分布(右歪み, 下限~160ms)で遅延 →
                CDP Input.dispatchKeyEvent で *isTrusted=true* の矢印キーを送る
  - フォーム攻撃: 各欄を人間ペースで打鍵(CDP, isTrusted/inputイベント発火) + CDPマウス移動 + CDPクリック送信
比較のため naive(JS dispatch, isTrusted=false, 即時) も同条件で実行する。
"""
import argparse
import os
import random
import time

URL = os.environ.get("HP_URL", "http://localhost:8000")
ARROWS = {"left": ("ArrowLeft", "ArrowLeft", 37), "right": ("ArrowRight", "ArrowRight", 39)}


def human_rt_ms():
    # 人間の選択反応に近い右歪み（ex-Gaussian 近似）。100ms 下限は踏まない。
    return max(160.0, random.gauss(300, 45) + random.expovariate(1 / 70.0))


def make_driver(headed):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    o = Options()
    if not headed:
        o.add_argument("--headless=new")
    o.add_argument("--disable-blink-features=AutomationControlled")
    o.add_argument("--window-size=1280,900")
    # stealth: UA から "Headless" を消す（実ブラウザを名乗る = 残る唯一の aux 痕跡も潰す）
    o.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
    o.add_experimental_option("excludeSwitches", ["enable-automation"])
    o.add_experimental_option("useAutomationExtension", False)
    d = webdriver.Chrome(options=o)
    d.set_script_timeout(90)
    try:
        d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument",
                          {"source": "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"})
    except Exception:
        pass
    return d


def cdp(d, m, p):
    return d.execute_cdp_cmd(m, p)


def wait_passive(d, t=20):
    for _ in range(int(t / 0.2)):
        if d.execute_script("return !!window.__hpResult"):
            return True
        time.sleep(0.2)
    return False


# ---------------- Core B 攻撃 ----------------
def attack_core_b(d, mode, rounds=6):
    """mode='tuned' (CDP isTrusted + 人間風遅延) / 'naive' (JS dispatch isTrusted=false 即時)"""
    d.get(URL + "/?label=bot")
    if not wait_passive(d):
        return {"error": "no __hpResult"}
    d.execute_script("window.__cb=null; window.__cbDone=false; "
                     "window.__hpRunReaction(arguments[0]).then(r=>{window.__cb=r;window.__cbDone=true;});", rounds)
    answered = 0
    deadline = time.time() + rounds * 6 + 15
    while not d.execute_script("return window.__cbDone") and time.time() < deadline:
        stim = d.execute_script("var s=document.querySelector('#stage .hp-stim'); return s?s.textContent:null;")
        if stim:
            direction = "left" if ("◀" in stim) else "right"  # ◀
            if mode == "tuned":
                time.sleep(human_rt_ms() / 1000.0)
                if d.execute_script("return !!document.querySelector('#stage .hp-stim')"):
                    k = ARROWS[direction]
                    cdp(d, "Input.dispatchKeyEvent", {"type": "keyDown", "key": k[0], "code": k[1], "windowsVirtualKeyCode": k[2]})
                    cdp(d, "Input.dispatchKeyEvent", {"type": "keyUp", "key": k[0], "code": k[1], "windowsVirtualKeyCode": k[2]})
                    answered += 1
                    time.sleep(0.06)
            else:  # naive
                key = "ArrowLeft" if direction == "left" else "ArrowRight"
                d.execute_script("window.dispatchEvent(new KeyboardEvent('keydown',{key:arguments[0],bubbles:true}));", key)
                answered += 1
                time.sleep(0.01)
        else:
            time.sleep(0.02)
    for _ in range(40):
        if d.execute_script("return window.__cbDone"):
            break
        time.sleep(0.2)
    cb = d.execute_script("return window.__cb")
    verdict = d.execute_script("return window.HumanPhysics.computeVerdict(window.__hpResult)")
    return {"summary": cb.get("summary") if cb else None, "verdict": verdict}


# ---------------- フォーム攻撃 ----------------
def type_human(d, text):
    for ch in text:
        cdp(d, "Input.dispatchKeyEvent", {"type": "keyDown", "text": ch, "key": ch})
        cdp(d, "Input.dispatchKeyEvent", {"type": "keyUp", "key": ch})
        time.sleep(max(0.05, random.gauss(0.13, 0.05)))  # 人間風の打鍵間隔


def attack_form(d, mode):
    d.get(URL + "/demo.html")
    time.sleep(0.6)
    fields = [("input[name=name]", "Taro Yamada"),
              ("input[name=email]", "taro.y@example.com"),
              ("input[name=password]", "s3cret-pw!")]
    if mode == "tuned":
        for sel, val in fields:
            d.execute_script("document.querySelector(arguments[0]).focus();", sel)
            for i in range(3):
                cdp(d, "Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 220 + i * 25, "y": 160 + i * 12})
                time.sleep(0.03)
            type_human(d, val)
            time.sleep(random.uniform(0.25, 0.6))
        r = d.execute_script("var b=document.querySelector('button[type=submit]');var x=b.getBoundingClientRect();return [x.x+x.width/2,x.y+x.height/2];")
        cdp(d, "Input.dispatchMouseEvent", {"type": "mouseMoved", "x": r[0], "y": r[1]})
        time.sleep(0.12)
        cdp(d, "Input.dispatchMouseEvent", {"type": "mousePressed", "x": r[0], "y": r[1], "button": "left", "clickCount": 1})
        cdp(d, "Input.dispatchMouseEvent", {"type": "mouseReleased", "x": r[0], "y": r[1], "button": "left", "clickCount": 1})
    else:  # naive: 値をプログラム的に流し込み即送信
        d.execute_script(
            "document.querySelector('input[name=name]').value='Bot';"
            "document.querySelector('input[name=email]').value='bot@x.com';"
            "document.querySelector('input[name=password]').value='password123';"
            "document.querySelector('#signup').requestSubmit();")
    time.sleep(2.2)
    return {"verdict_text": d.execute_script("var e=document.getElementById('verdict');return e?e.textContent:null;"),
            "reasons": d.execute_script("return Array.from(document.querySelectorAll('#reasons li')).map(function(li){return li.textContent;});"),
            "passed": d.execute_script("return !!document.getElementById('signup').__hpPassed;")}


def line():
    print("-" * 74)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true", help="実GPUで起動（Core A を本物にする）")
    args = ap.parse_args()
    try:
        import selenium  # noqa: F401
    except ImportError:
        print("Selenium 未導入。 pip install selenium を実行してください。")
        return

    print("=" * 74)
    print("A: Tuned Adversary vs 強化版 HumanPhysics   (headed=%s)" % args.headed)
    print("URL:", URL)
    print("=" * 74)

    for mode in ("naive", "tuned"):
        d = make_driver(args.headed)
        try:
            print("\n### mode = %s" % mode.upper())
            cb = attack_core_b(d, mode)
            line()
            print("[Core B] verdict:", (cb.get("verdict") or {}).get("verdict"), "| summary:", cb.get("summary"))
            for r in (cb.get("verdict") or {}).get("reasons", []):
                print("   -", r)
        except Exception as e:  # noqa: BLE001
            print("[Core B] error:", e)
        finally:
            d.quit()

        d = make_driver(args.headed)
        try:
            fm = attack_form(d, mode)
            line()
            print("[Form ] verdict:", fm.get("verdict_text"), "| passed(submitted):", fm.get("passed"))
            for r in fm.get("reasons", []):
                print("   -", r)
        except Exception as e:  # noqa: BLE001
            print("[Form ] error:", e)
        finally:
            d.quit()

    print("\n" + "=" * 74)
    print("読み: naive は捕捉され、tuned が human-likely / passed=True に化ければ")
    print("      『その層は CDP+人間風RT で破れる』= 次の B(Go/No-Go, 難易度依存RT) の動機。")
    print("=" * 74)


if __name__ == "__main__":
    main()
