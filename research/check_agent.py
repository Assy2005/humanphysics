#!/usr/bin/env python3
"""
agent-trap を実ツール(Selenium=実Chrome)で検証・硬化するための解析スクリプト。

核心の問い: 「実エージェントの各“知覚経路”に、どのトラップが実際に映るか？」
  - visible_links      … 画面に見えるリンク（人間が辿れるもの）
  - all_dom_links      … DOM上の全リンク（DOM列挙scraper）
  - innerText          … 可視テキスト抽出（多くのLLM agentのテキスト経路）
  - innerHTML          … HTMLソース全体（HTML파싱scraper）
  - accessibility_tree … a11yツリー（多くのcomputer-use agentの経路。aria-hidden は除外される）
これで「どの種類のagentに効くか／効かないか」が分かる。

実行: python research/check_agent.py
前提: python serve.py 起動 + pip install selenium
"""
import json, os, re, time, urllib.request
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

URL = os.environ.get("HP_URL", "http://localhost:8000")
TRAP_RE = re.compile(r'/hp/trap\?c=\w+&s=[\w.%\-]+')


def traps_in(text):
    return sorted(set(TRAP_RE.findall((text or "").replace("&amp;", "&"))))


def make():
    o = Options()
    o.add_argument("--headless=new")
    o.add_argument("--disable-blink-features=AutomationControlled")
    o.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36")
    d = webdriver.Chrome(options=o)
    d.set_script_timeout(30)
    return d


def fetch(u):
    try:
        urllib.request.urlopen(URL + u, timeout=5); return True
    except Exception:
        return False


def agent_check(sid):
    req = urllib.request.Request(URL + "/hp/agent-check",
                                 data=json.dumps({"sid": sid}).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())


def main():
    d = make()
    try:
        d.get(URL + "/agent.html")
        time.sleep(1.2)
        sid = d.execute_script("return window.HumanPhysicsTrap.sid")

        visible = [a.get_attribute("href") for a in d.find_elements("css selector", "a") if a.is_displayed()]
        alllinks = [a.get_attribute("href") for a in d.find_elements("css selector", "a")]
        inner_text = d.execute_script("return document.body.innerText")
        inner_html = d.execute_script("return document.body.innerHTML")
        try:
            d.execute_cdp_cmd("Accessibility.enable", {})
            ax = json.dumps(d.execute_cdp_cmd("Accessibility.getFullAXTree", {}), ensure_ascii=False)
        except Exception:
            ax = ""

        exposure = {
            "visible_links": traps_in(" ".join(x for x in visible if x)),
            "all_dom_links": traps_in(" ".join(x for x in alllinks if x)),
            "innerText": traps_in(inner_text),
            "innerHTML": traps_in(inner_html),
            "accessibility_tree": traps_in(ax),
        }

        # 現実的なscraper/agent: DOMリンク + ソースから見つけたURLを全部叩く
        harvested = set(traps_in(" ".join(x for x in alllinks if x)) + traps_in(inner_html) + traps_in(inner_text))
        for u in harvested:
            fetch(u)
        res = agent_check(sid)

        out = {
            "sid": sid,
            "channel_exposure (どの経路にどのトラップが映るか)": exposure,
            "realistic_crawler": {"trapped": res["trapped"], "verdict": res["verdict"]},
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))

        # 解析メモ
        print("\n--- 解析 ---")
        for ch, urls in exposure.items():
            kinds = sorted(set(re.search(r'c=(\w+)', u).group(1) for u in urls))
            print("  %-20s -> %s" % (ch, kinds if kinds else "（トラップ無し）"))
    finally:
        d.quit()


if __name__ == "__main__":
    main()
