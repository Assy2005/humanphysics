# HumanPhysics — "Physics over Properties" bot 検知 PoC

CloudFlare / reCAPTCHA とは別路線の、**ボタンを押させない**新しい bot 検知の研究用 PoC。

## 中心となる仮説（テーゼ）

> 既存の検知は「クライアントが**何を名乗る / どう見える**か」＝ **性質(properties)** を見る。
> 性質は宣言なので**安く偽装できる**（fingerprint spoofing で回避され続ける負け戦）。
>
> 本 PoC は問いを変える：「クライアントの**実行と操作が物理的にどう振る舞うか**」＝
> タイミング・因果・数値精度＝ **物理(physics)** を測る。物理は実ハードウェアと人間の
> 神経系に縛られ、偽装には*実体*が要るため高コスト。**嘘をつけるのは性質、つけないのは物理。**

依存ゼロ・1スクリプト導入を志向（低コスト・簡単導入）。

## 構成

| ファイル | 役割 |
|---|---|
| `public/detector.js` | 計測ライブラリ。`window.HumanPhysics`。Core A / Core B / aux。 |
| `public/hp-embed.js` | 導入用レイヤ。`guardForm`/`verify`＋フォーム挙動の受動収集。 |
| `public/demo.html` | 導入デモ（保護されたサインアップフォーム）。 |
| `public/hp-gate.js` | サイト全体ゲート（SHA-256 PoW＋物理検知、**サーバ不要**）。 |
| `public/gate.html` / `public/home.html` | ゲート入口とサンプル本体（静的ドロップイン例）。 |
| `public/index.html` | 研究ハーネス（ダッシュボード＋反応テスト＋エクスポート／送信）。 |
| `serve.py` | 配信＋API サーバ。`/hp/challenge`・`/hp/verify`（**サーバ側採点**）・`/hp/check`・`/collect`。 |
| `analyze.py` | human と bot の**分離度(AUC)**を算出。実験 H1/H2 の評価。 |
| `bot/collect_selenium.py` | （任意）Selenium で bot サンプルを自動生成。 |

### 検知の3層

- **aux（安価なプロパティ痕跡・低重み）**：`navigator.webdriver`、Headless UA、automation グローバル
  （`__playwright__binding__` 等）、CDP red-pill（`Error.stack` getter）、エンジン詐称。単純 bot の足切り。
- **Core A（実行物理・ユーザー操作ゼロ）**：タイマ実効分解能、計算スループットのジッタ(cv)と int/float 比、
  数値精度ハッシュ、WebGL レンダラ種別＋描画時間、rAF/ setTimeout 周期。ステルス bot を物理で暴く。
- **Core B（知覚-行動タイミング・最小操作）**：ランダムな ◀/▶ 刺激への選択反応。
  遅延分布（人間下限 ~100ms）、因果（正答には描画の知覚が必須）、入力真正性（`isTrusted`）。
  **本物のブラウザを使う AI エージェント**狙い。

## クイックスタート

```sh
python serve.py                 # http://localhost:8000
```

ブラウザで http://localhost:8000 を開く →（Core A は自動実行）→「反応テスト開始」で Core B →
ラベルを `human` にして「サーバへ送信」。これを数人 / 数ブラウザで繰り返す。

## サイト全体をゲートする（サーバ不要・静的ドロップイン）

```
アクセス → gate.html → 物理検知 + Proof-of-Work → 通過 / ブロック → 本体(home.html)
```

`serve.py` を動かさず、**静的ファイルを置くだけ**でサイト全体に検問を挟みます。PoW（ブラウザ上の計算）で
全アクセスにコストを課し、JS 非実行・安価な bot を弾きます。デモ → http://localhost:8000/gate.html

### セットアップ（4ステップ）

1. `detector.js` `hp-gate.js` `gate.html` をホスティングに置く。
2. 既存の `index.html` を `home.html` にリネーム（＝あなたの本体）。
3. `gate.html` を `index.html` にリネーム（＝新しい入口）。`gate.html` 内の `dest` を本体に合わせる。
4. 本体 `home.html` の `<head>` 先頭に1行入れる:

```html
<script>if(sessionStorage.getItem('hp_pass')!=='1')location.replace('index.html')</script>
```

設定は `gate.html` 内の `HP_GATE_CONFIG`（`dest` と難易度 `powZeros`）だけ。

### ⚠️ 正直な限界（必読）

完全静的＝**判定はクライアント側**なので、JS を読めば原理的に突破できる（静的ホスティングは本体ファイルへの
直接アクセスを隠せない）。これは「**JS 非実行/安価な bot を弾き、全員に計算コストを課す**」*フィルタ/抑止*で
あり金庫ではない（Anubis 等の「ブラウザを確認しています」画面と同型）。

**本気のブロック**が要るなら `gate.html` の `verifyEndpoint` にサーバーレス関数（Cloudflare Workers /
Vercel / Netlify Functions 等）を指定し、そこで PoW と署名を検証して署名トークンを発行 → 本体配信を
トークンでゲートする（＝下の「フォーム単位で保護する」と同じ土台）。

## フォーム単位で保護する（サーバ側判定）

既存サイトのフォーム（サインアップ / ログイン / 問い合わせ等）を、CAPTCHA なしで保護できます。
動くデモ → `python serve.py` 起動後に http://localhost:8000/demo.html

### 1. クライアント: スクリプト2本を読み込む

```html
<script src="/path/to/detector.js"></script>
<script src="/path/to/hp-embed.js"></script>
```

### 2. 保護したいフォームに `data-hp-guard` を付ける（JS不要）

```html
<form action="/signup" method="post" data-hp-guard data-hp-endpoint="">
  ...入力欄...
  <button type="submit">登録</button>
</form>
```

送信時に「実行物理＋入力中の自然な挙動」を収集 → `/hp/verify` で**サーバ採点** →
human なら hidden の `hp_token` を付けて送信、bot なら送信をブロックします。専用ボタンは不要。

JS で細かく制御する場合:

```html
<script>
  HumanPhysics.guardForm(document.querySelector('#signup'), {
    endpoint: '',               // 検証サービスのオリジン（別ドメイン運用なら 'https://hp.example.com'）
    interactive: false,         // true で「怪しい時の知覚-行動チャレンジ(step-up)」を出す
    onResult: (r) => console.log('verdict', r.verdict, r.humanScore),
    onFail:   (r) => alert('自動化の疑いがあります'),
    policy:   (r) => r.verdict !== 'bot-likely',   // 通過条件（既定: bot-likely 以外は通す）
  });
</script>
```

### 3. サーバ: `hp_token` を検証してから処理する（最重要）

**判定はサーバ側で行い、バックエンドは必ず `hp_token` を検証**してから本処理を実行します
（クライアントの自己申告スコアは信用しない）。トークンは HMAC 署名＋有効期限付き。

```python
# 例: signup ハンドラ内で
import urllib.request, json
def hp_ok(token):
    req = urllib.request.Request("http://localhost:8000/hp/check",
        data=json.dumps({"token": token}).encode(),
        headers={"Content-Type": "application/json"})
    res = json.loads(urllib.request.urlopen(req).read())
    return res.get("valid") and res.get("verdict") != "bot-likely"

# if not hp_ok(request.form["hp_token"]): abort(403)
```

他言語でも同様: トークンは `"<base64url(payload)>.<hex(hmac_sha256(secret, base64url))>"`。
`payload` を復号し、HMAC と `exp`（UNIX秒）を検証するだけ。

### デプロイ形態

- **自前ホスト（同一オリジン）**: `serve.py` の `/hp/*`（`issue_challenge / check_challenge / hp_score /
  issue_token / check_token`）を自分のバックエンドに移植。`endpoint:''` のまま。
- **検証サービス（別オリジン）**: `serve.py` を専用ドメインで動かし `endpoint:'https://hp.example.com'` を指定。
  `/hp/*` は CORS 許可済み（本番では `Access-Control-Allow-Origin` を自サイトに限定すること）。

### 注意（red-team 済みの限界）

- `data/secret.key` は**サーバ秘密**。漏れるとトークン偽造可。リポジトリに含めない（`.gitignore` 済み）。
- 判定は**リスクスコア**であり完全な二値オラクルではない。実機ブラウザ＋OSレベル入力注入＋人間風タイミングの
  高度な bot は通り得る。重要操作は `interactive:true`（step-up）やレート制限と併用する。
- 人間の貼付/オートフィルは `input` イベントを発火するため誤検知しない（プログラム的 `.value=` のみ自動化と判定）。

## 実験プロトコル

研究目的は **human と bot の分布が分離するか** を実測すること。

- **H1（物理は分離するか）**：同一の Core A プローブを ①実ブラウザ ②headless ③ステルス で走らせ、
  `timerRes / intThroughput / int-floatRatio / computeCV / webglSoftware / webglDrawMedian / rafMedian`
  が統計的に分離するか。
- **H2（知覚-行動は分離するか）**：Core B の `latencyMin / latencyMedian / latencyCV /
  belowHumanFloor / untrustedResponses` が human と bot で分離するか（AUC で評価）。

### bot サンプルの収集（任意・Selenium）

```sh
pip install selenium
python bot/collect_selenium.py     # passive-headless / reaction-fast / reaction-humanlike を送信
```

### 分析

```sh
python analyze.py
# 従来コンソールで日本語が文字化けする場合は先に:  chcp 65001
```

`AUC≈1`→human が大で分離、`AUC≈0`→bot が大で分離、`≈0.5`→分離なし。`|sep|=|AUC-0.5|*2`。

## これまでの検証結果（実ブラウザで確認済み）

- **誤検知なし**：実 GPU(Intel Iris Xe)を持つ実ブラウザは Core A で妥当な物理値
  （`timerRes 0.1ms`、`rAF 16.7ms`、`WebGL描画 5.8ms`、`int/float比 5.54`、`computeCV 0.096`）を返し、
  `human-likely`（100点）。
- **合成 bot を捕捉**：DOM を読んで**正答率100%**の高速 bot でも、反応遅延 0.1〜10.8ms（人間下限未満）＋
  `isTrusted=false` で `bot-likely` 判定。**正しく知覚して答えても、人間の反応の"物理"には従えない。**

## 正直な限界（＝次の研究フロンティア）

- **aux / isTrusted は補助**：`chrome.debugger`(CDP) は `isTrusted=true` を出せる、CDP 痕跡は陳腐化が速い。
  単独に頼らず Core A/B の補助に留める。
- **Core B は操作が前提**：純粋無操作スクレイパは捕えられない（aux/Core A の担当）。役割分担で設計。
- **人間風遅延 + isTrusted偽装の合わせ技**が最難関。残る砦は **遅延分布の形（cv が低すぎる等）**、
  **ランダム刺激への因果依存**、**Core A 物理**。この境界を `analyze.py` で定量し、どこで分離が崩れるかを
  詰めるのが本 PoC の研究価値。

## 次の研究ステップ

1. 実機 human サンプルを複数集め、Selenium bot と AUC で分離を定量（まず Core B → Core A）。
2. 「人間風遅延 + 合成」bot に対し、遅延分布の形・因果依存でどこまで分離が残るかを測る。
3. 分離の強いシグナルだけを残し、軽量な production 版（1スクリプト＋短命トークン）へ蒸留。

## ライセンス

MIT License — 詳細は [LICENSE](LICENSE) を参照。
