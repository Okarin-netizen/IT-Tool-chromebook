# 自動の動作確認（smoke テスト）

各ツールを Chromium で開き、代表的な操作をして保存し、ネットワークを切った状態でも開けるかを確かめます。
コードを直したあとに実行して、動きが変わっていないことを確かめるためのものです。サイトの動作には使いません。

## 必要なもの

- Node.js 22 以上
- Playwright（`npm install -g playwright` などで入れ、`npx playwright install chromium` でブラウザを入れる）

## 動かし方

```sh
node tests/smoke.cjs                  # 全ツール
node tests/smoke.cjs pdf-text calc    # 指定したツールだけ
node tests/smoke.cjs --ocr            # PDF文字取り出しの OCR も確かめる（少し時間がかかる）
node tests/smoke.cjs --headed         # ブラウザの画面を表示して動かす
```

すべて通ると `すべて通りました` と表示されます。失敗したツールは `NG` と理由が表示されます。

## 確かめていること

- ページを開いたときに、エラーや読み込みの失敗がないこと
- テスト用のPDFや画像（実行時に作ります）を開き、ツールごとの代表的な操作ができること
- 保存したファイルの名前と中身（PDFのページ数、ZIPの中身など）
- 同じドメインのほかのサイトのキャッシュを消さないこと
- ネットワークを切って再読み込みしても開けて、PDFや画像を開けること

## ファイル

- `smoke.cjs`: テスト本体。ツールごとの確認は `TOOLS` にまとまっています
- `lib/server.cjs`: テスト用のサーバー。本番と同じ `/IT-Tool-chromebook/` の下にリポジトリを配ります
- `lib/fixtures.cjs`: テスト用のPDF・PNGの作成と、ZIPの中身の読み取り
- `output/`: 実行したときの画面のスクリーンショット（Git には入れません）
