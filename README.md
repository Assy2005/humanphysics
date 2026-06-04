# HumanPhysics

**Zero-friction, passive bot detection — "physics over properties."**
ボタンも CAPTCHA も無し。ユーザー操作ゼロで、クライアントの*物理*（GPU・実行タイミング・ハードウェア能力）を計測し、サーバ側で判定する bot フィルタです。

---

## 何をするか

bot 検知の多くは「クライアントが**何を名乗るか**(properties: UA・navigator 値・fingerprint)」を見ますが、これらは宣言にすぎず**安く偽装**できます。

HumanPhysics は問いを変えます — 「クライアントの**実行が物理的にどう振る舞うか**(physics: GPU の実在・描画/計算速度・実行ジッタ・ハードウェア能力)」。物理は実ハードウェアに縛られ、**偽装に実体が要る**ため高コストです。判定は**サーバ側**で行い、クライアントの自己申告は信用しません。

## ⚠️ 正直なスコープ（最初に読んでください）

これは**リスクスコアリングであって、完全な二値オラクルではありません。**

- ✅ **確実に弾く（高精度・無操作）**: GPU 無し／ソフトレンダラ環境（クラウドサーバ・VM・データセンター）、Selenium/Playwright/Puppeteer 等の自動化フレームワーク、headless（GPU無し）、no-JS スクレイパ、Chrome-for-Testing。**＝安価・大量スクレイピングの大半。**
- ⏳ **時間軸で捕える**: 実ハードウェア上の bot も、スケールすればサーバ側集約（同一指紋の velocity・IP集中）で捕捉。
- ❌ **単発では捕えられない**: 実消費者ブラウザ＋実 GPU＋住宅IPで動く高度な AI エージェント。物理が“本物”なので 1 リクエストでは人間と区別不能。これは**クライアント側パッシブ検知の根本的な天井**で、正直に記録しています（[research/README.md](research/README.md)）。

要するに「**安価 bot を無操作で高精度に弾き、全員に計算コストを課し、スケールした抽象を時間軸で捕える**」——堅実で出荷できる設計です。

## どう動くか（3層 ＋ サーバ）

| 層 | 中身 | 主に捕えるもの |
|---|---|---|
| **GPU依存** (`gpu-detect.js`) | WebGL/WebGPU の実在・アダプタ・**描画/計算時間**、renderer文字列 vs 実測速度の不整合 | GPU無し・ソフトレンダラ・レンダラ詐称 |
| **Core A 実行物理** (`detector.js`) | タイマ分解能・計算ジッタ・数値精度・rAF周期・DRM(CDM)・HW復号 | エミュ・VM・自動化Chromium |
| **aux 痕跡** (`detector.js`) | `navigator.webdriver`・headless UA・automation グローバル・CDP red-pill | 単純 bot の足切り |
| **サーバ集約** (`serve.py`) | 安定フィンガープリント＋ velocity（頻度）＋ IP集中＋指紋ローテーション | スケールした bot |

判定（スコア合算）は **`serve.py` がサーバ側で計算**し、署名付き短命トークンを発行。サイトはそのトークンを検証してから処理します。

## リポジトリ構成

```
public/
  detector.js    Core A + aux の受動プローブ＋判定 (window.HumanPhysics)
  gpu-detect.js  GPU依存プローブ (window.GPUDetect)
  hp-embed.js    フォーム保護 (HumanPhysics.guardForm)
  hp-gate.js     サイトゲート (SHA-256 PoW + 判定)
  index.html     シグナル・ダッシュボード
  gate.html / home.html   サイトゲートのデモ
  demo.html      フォーム保護のデモ
  gpu.html       GPU検知のデモ
serve.py         静的配信 + スコアリングAPI + サーバ集約
research/        開発・検証スクリプト（製品ではない / research/README.md）
data/            実行時サンプル・サーバ秘密鍵（gitignore 済み）
LICENSE          MIT
```

## クイックスタート

```sh
python serve.py            # http://localhost:8000  （依存なし: Python 標準ライブラリのみ）
```

- `/`            … シグナル・ダッシュボード
- `/gate.html`   … サイトゲートのデモ
- `/demo.html`   … フォーム保護のデモ（「🤖自動入力で送信」で bot 遮断を確認）
- `/gpu.html`    … GPU検知のデモ

## 導入A: サイト全体をゲート（サーバ不要・静的ドロップイン）

```
アクセス → gate.html → 物理検知 + Proof-of-Work → 通過 / ブロック → 本体
```

1. `gpu-detect.js` `detector.js` `hp-gate.js` `gate.html` をホスティングに置く
2. 既存 `index.html` を `home.html` にリネーム（あなたの本体）
3. `gate.html` を `index.html` にリネーム。中の `dest` を本体に合わせる
4. 本体 `<head>` 先頭に: `<script>if(sessionStorage.getItem('hp_pass')!=='1')location.replace('index.html')</script>`

完全静的なので判定はクライアント側＝抑止フィルタ（JS非実行/安価botを弾く＋PoWでコスト賦課）。本気のブロックは `gate.html` の `verifyEndpoint` にサーバーレス関数を指定。

## 導入B: フォーム単位で保護（サーバ側判定）

```html
<script src="gpu-detect.js"></script>
<script src="detector.js"></script>
<script src="hp-embed.js"></script>
<form action="/signup" method="post" data-hp-guard>...</form>
```

送信時に受動シグナル＋入力中の自然な挙動を収集 → `/hp/verify` でサーバ採点 → human なら hidden `hp_token` を付けて送信、bot ならブロック。**バックエンドは必ず `hp_token` を検証**してから処理すること（`/hp/check` か、同じシークレットで HMAC 検証）。

## サーバ API

| エンドポイント | 役割 |
|---|---|
| `POST /hp/challenge` | single-use 署名 nonce 発行 |
| `POST /hp/verify` | サーバ側スコア＋集約 → 署名トークン |
| `POST /hp/check` | バックエンド用トークン検証 |
| `GET  /hp/stats` | 集約の可視化（top 指紋/IP） |

> PoC は in-memory・単一プロセス。本番は Redis/DB への永続化、IP/ASN 評判データ、しきい値の実トラフィック調整が必要。`data/secret.key` はサーバ秘密（漏洩でトークン偽造可・gitignore 済み）。

## ライセンス

MIT — [LICENSE](LICENSE) を参照。
