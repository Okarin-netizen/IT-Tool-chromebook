# IT-Tool-chromebook

学校のChromebookで、インストールなし・ブラウザだけで使える便利ツール集です。
GitHub Pages で公開して使います。

## ツール一覧

| フォルダ | ツール | 内容 |
| --- | --- | --- |
| [`pdf-text/`](pdf-text/) | PDF文字入れ | PDFに日本語の文字や写真を書き込み、新しいPDFとしてダウンロード |

トップページ（`index.html`）が共通の入り口で、ここから各ツールを選べます。

## 公開のしかた（GitHub Pages）

1. GitHub のリポジトリで **Settings → Pages** を開く
2. **Source** を「Deploy from a branch」、ブランチを `main`、フォルダを `/ (root)` にして保存
3. 数分後に `https://okarin-netizen.github.io/IT-Tool-chromebook/` で開けます

一度開くとブラウザにキャッシュされ、PDF文字入れはオフラインでも動きます。

## ツールの追加方法

1. ルートに新しいフォルダ（例: `timer/`）を作り、`index.html` を置く
2. ルートの `index.html` の `<ul class="tools">` に `<li>` を1つ追加する
3. この README の表に1行追加する

ビルド作業は不要です。外部ライブラリは CDN を使わずフォルダ内に同梱します（学校のネットワークで CDN がブロックされることがあるため）。

## PDF文字入れ

- PDFを開いて、文字を入れたい場所をクリックして入力
- 文字サイズ・色（黒/赤/青/緑）を変更可能、複数行OK
- 「✥」をドラッグして移動、「✕」で削除
- 「🖼 写真を追加」で写真・画像を貼り付け（ドラッグで移動、右下の角で拡大縮小）。大きな写真は自動で縮小されます
- 「💾 PDFを保存」で `元の名前_記入済み.pdf` をダウンロード
- 編集が制限された（保護付き）PDFも保存可能。この場合は元のページを画像にしてから書き込むため、元の文字は選択・検索できなくなります
- PDFはどこにも送信されず、ブラウザ内で処理されます

### 同梱ライブラリ

| ライブラリ | 用途 | ライセンス |
| --- | --- | --- |
| [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 | PDFの表示 | Apache-2.0 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 | PDFへの書き込み | MIT |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) 1.1.1 | フォント読み込み | MIT |
| [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs) 1.6.3 | 使う文字だけにフォントを縮小 | MIT |
| [Noto Sans JP](https://fonts.google.com/noto/specimen/Noto+Sans+JP) | 日本語フォント | SIL OFL 1.1 |
