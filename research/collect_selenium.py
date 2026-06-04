#!/usr/bin/env python3
"""
（任意）Selenium で bot サンプルを収集するスクリプト。

  human サンプルは「ブラウザでページを開く→反応テスト→サーバへ送信」で集める。
  bot サンプルはこのスクリプトで自動生成し、同じ data/samples.jsonl に送る。
  その後 `python analyze.py` で human と bot の分離度を見る。

前提:
  - `python serve.py` が起動していること（http://localhost:8000）
  - Selenium が入っていること:  pip install selenium
    （Selenium 4.6+ は Selenium Manager がドライバを自動取得するので Chrome があればOK）

実行:
    python bot/collect_selenium.py

生成プロファイル:
  passive-headless   : 無操作。Core A / aux の分離（webdriver, ソフトレンダラ等）を見る。
  reaction-fast      : Core B に合成イベントで「即」応答（人間下限未満を踏む）。
  reaction-humanlike : Core B に合成イベントで「人間風の遅延(200-350ms)」応答
                       （遅延では合格しても isTrusted=false で捕まることを確認）。
"""
import json
import os
import sys
import time
import urllib.request

URL = os.environ.get("HP_URL", "http://localhost:8000")
COLLECT = URL + "/collect"

# 刺激を読んで正答を合成イベントで返す bot レスポンダ（モードで遅延を変える）
RESPONDER = {
    "fast": """
      window.__bot_timer = setInterval(() => {
        const s = document.querySelector('#stage .hp-stim');
        if (s) {
          const k = s.textContent.indexOf('◀') >= 0 ? 'ArrowLeft' : 'ArrowRight';
          window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        }
      }, 8);
    """,
    "humanlike": """
      let armed = true;
      window.__bot_timer = setInterval(() => {
        const s = document.querySelector('#stage .hp-stim');
        if (s && armed) {
          armed = false;
          const k = s.textContent.indexOf('◀') >= 0 ? 'ArrowLeft' : 'ArrowRight';
          const d = 200 + Math.random() * 150;  // 人間風の遅延
          setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })), d);
        } else if (!s) { armed = true; }
      }, 10);
    """,
}

RUN_REACTION = """
  const done = arguments[arguments.length - 1];
  const rounds = arguments[0];
  window.__hpRunReaction(rounds).then((cb) => {
    if (window.__bot_timer) clearInterval(window.__bot_timer);
    done(cb.summary);
  });
"""


def post(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(COLLECT, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def make_driver(headless=True):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-gpu")  # 多くの headless 環境でソフトレンダラ(SwiftShader)になりやすい
    opts.add_argument("--window-size=1280,900")
    d = webdriver.Chrome(options=opts)
    d.set_script_timeout(60)
    return d


def wait_passive(driver, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if driver.execute_script("return !!window.__hpResult"):
            return True
        time.sleep(0.2)
    return False


def run_profile(name, headless, core_b_mode, rounds=6):
    print("\n--- profile: %s (headless=%s, coreB=%s) ---" % (name, headless, core_b_mode))
    driver = make_driver(headless=headless)
    try:
        driver.get(URL + "/?label=bot")
        if not wait_passive(driver):
            print("  [!] __hpResult が出ませんでした（JSエラー?）")
            return
        if core_b_mode:
            driver.execute_script(RESPONDER[core_b_mode])
            summary = driver.execute_async_script(RUN_REACTION, rounds)
            print("  Core B summary:", json.dumps(summary, ensure_ascii=False))
        result = driver.execute_script("return window.__hpResult")
        result["label"] = "bot"
        result["profile"] = name
        r = post(result)
        verdict = (result.get("score") or {}).get("verdict")
        print("  verdict=%s  renderer=%s  webdriver=%s  -> 送信OK total=%s"
              % (verdict,
                 (result.get("coreA", {}).get("webgl", {}) or {}).get("renderer"),
                 (result.get("aux", {}) or {}).get("webdriver"),
                 r.get("total")))
    finally:
        driver.quit()


def main():
    try:
        import selenium  # noqa: F401
    except ImportError:
        print("Selenium が見つかりません。  pip install selenium  を実行してください。")
        sys.exit(1)

    # 接続確認
    try:
        urllib.request.urlopen(URL, timeout=5)
    except Exception as e:  # noqa: BLE001
        print("サーバに接続できません (%s)。先に `python serve.py` を起動してください: %s" % (URL, e))
        sys.exit(1)

    run_profile("passive-headless", headless=True, core_b_mode=None)
    run_profile("reaction-fast", headless=True, core_b_mode="fast")
    run_profile("reaction-humanlike", headless=True, core_b_mode="humanlike")
    print("\n完了。`python analyze.py` で分離度を確認してください。")


if __name__ == "__main__":
    main()
