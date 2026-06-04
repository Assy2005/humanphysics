# research/ — 開発・検証用スクリプト（製品ではない）

製品（`public/` ＋ `serve.py`）の挙動を検証するための研究用ツール群。実行には Chrome と
`pip install selenium` が必要。すべて `python serve.py` 起動中（http://localhost:8000）に repo ルートから実行する。

| スクリプト | 目的 |
|---|---|
| `check_gpu.py` | GPU依存検知の弁別力を確認。`--headed` / `--software`（SwiftShader強制でGPU無し環境を模擬）。 |
| `check_drm.py` | DRM/Widevine と HW復号の環境差を確認。`--headed`。 |
| `collect_selenium.py` | bot サンプルを自動生成し `/collect` に送る（`analyze.py` 用）。 |
| `tuned_adversary.py` | 「実Chrome＋CDP Input(isTrusted=true)＋人間風RT＋DOM読み」で検知を攻撃する敵性スクリプト。 |
| `analyze.py` | `data/samples.jsonl` を読み human vs bot の分離度(AUC)を出す。 |

## 主要な検証で分かったこと（正直な記録）

- **GPU/DRM/物理シグナルは「GPU無し・ソフトレンダラ・自動化痕跡」を確実に弾く**（クラウドサーバ/VM/データセンター＝安価スクレイピングの大半）。
- **実ハードウェア上の bot（headless=new や実ブラウザの AI エージェント）は通る**。物理が本物だから単発では人間と区別不能＝クライアント側パッシブ検知の天井。
- それを補うのが **`serve.py` のサーバ側集約**（同一指紋の velocity・IP集中）。スケールした bot を時間軸で捕える。
