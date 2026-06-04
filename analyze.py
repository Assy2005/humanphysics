#!/usr/bin/env python3
"""
samples.jsonl を読み、label=human と label=bot の「分離度」を測る分析スクリプト。
実験 H1（Core A 物理）/ H2（Core B 知覚-行動）の検証用。依存なし（標準ライブラリのみ）。

使い方:
    python analyze.py                 # data/samples.jsonl を分析
    python analyze.py path/to.jsonl

各メトリクスについて label 別の分布と AUC を出力する。
AUC = P(human値 > bot値)（タイは0.5）。0/1 に近いほど強い分離、0.5 は分離なし。
"""
import json
import os
import sys
from statistics import mean, median

# Windows の既定コンソール(cp932)でも壊れないよう UTF-8 出力に固定
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(ROOT, "data", "samples.jsonl")


def pluck(obj, path):
    cur = obj
    for k in path.split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return None
    return cur


def as_num(v):
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, list):
        return float(len(v))
    return None


# (表示名, JSONパス, 期待: human が大きい(+) / 小さい(-))
METRICS = [
    ("aux.webdriver",            "aux.webdriver",                       "-"),
    ("aux.headlessUA",           "aux.headlessUA",                      "-"),
    ("aux.automationGlobals(#)", "aux.automationGlobals",               "-"),
    ("aux.cdpStackGetter",       "aux.cdpStackGetter",                  "-"),
    ("aux.engineUAMismatch",     "aux.engineUAMismatch",                "-"),
    ("A.timerResMs",             "coreA.timer.effectiveResolutionMs",   "?"),
    ("A.intThroughput",          "coreA.compute.intThroughput",         "?"),
    ("A.floatThroughput",        "coreA.compute.floatThroughput",       "?"),
    ("A.int/floatRatio",         "coreA.compute.intOverFloatRatio",     "?"),
    ("A.computeCV",              "coreA.compute.int.stats.cv",          "+"),
    ("A.webglSoftware",          "coreA.webgl.software",                "-"),
    ("A.webglDrawMedianMs",      "coreA.webgl.drawMs.median",           "?"),
    ("A.rafMedianMs",            "coreA.scheduling.raf.median",         "?"),
    ("B.latencyMinMs",           "coreB.summary.latency.min",           "+"),
    ("B.latencyMedianMs",        "coreB.summary.latency.median",        "+"),
    ("B.latencyCV",              "coreB.summary.latency.cv",            "+"),
    ("B.belowHumanFloor(#)",     "coreB.summary.belowHumanFloor",       "-"),
    ("B.untrustedResponses(#)",  "coreB.summary.untrustedResponses",    "-"),
    ("B.accuracy",               "coreB.summary.accuracy",              "?"),
]


def auc(pos, neg):
    """AUC = P(pos > neg)、タイ=0.5。"""
    if not pos or not neg:
        return None
    wins = 0.0
    for p in pos:
        for q in neg:
            if p > q:
                wins += 1.0
            elif p == q:
                wins += 0.5
    return wins / (len(pos) * len(neg))


def fmt(x):
    if x is None:
        return "   -  "
    return ("%.3f" % x).rjust(6)


def summarize(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "n=0"
    return "n=%d mean=%.3f med=%.3f min=%.3f max=%.3f" % (
        len(vals), mean(vals), median(vals), min(vals), max(vals),
    )


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if not os.path.isfile(path):
        print("サンプルがありません: %s" % path)
        print("先に `python serve.py` で起動 → ブラウザでページを開き「サーバへ送信」、")
        print("または `python bot/collect_selenium.py` で bot サンプルを収集してください。")
        return

    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    groups = {"human": [], "bot": [], "unlabeled": []}
    for r in rows:
        groups.get(r.get("label") or "unlabeled", groups["unlabeled"]).append(r)

    print("=" * 78)
    print("HumanPhysics 分離度レポート  (%s)" % path)
    print("サンプル数: human=%d  bot=%d  unlabeled=%d  total=%d"
          % (len(groups["human"]), len(groups["bot"]), len(groups["unlabeled"]), len(rows)))
    print("=" * 78)
    print("%-26s %6s %6s  %s" % ("metric", "AUC", "|sep|", "期待 / 分布"))
    print("-" * 78)

    for name, path_, direction in METRICS:
        h = [as_num(pluck(r, path_)) for r in groups["human"]]
        b = [as_num(pluck(r, path_)) for r in groups["bot"]]
        h = [v for v in h if v is not None]
        b = [v for v in b if v is not None]
        a = auc(h, b)
        sep = abs(a - 0.5) * 2 if a is not None else None
        flag = ""
        if sep is not None and sep >= 0.8:
            flag = "  <== 強い分離"
        print("%-26s %s %s  期待:%s" % (name, fmt(a), fmt(sep), direction) + flag)
        print("    human: %s" % summarize(h))
        print("    bot  : %s" % summarize(b))

    print("-" * 78)
    print("読み方: AUC~=1 は『humanが大』で分離、AUC~=0 は『botが大』で分離、~=0.5 は分離なし。")
    print("        |sep| = |AUC-0.5|*2 （0=分離なし, 1=完全分離）。")


if __name__ == "__main__":
    main()
