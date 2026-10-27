# 同梱ライブラリ

学校のネットワークでは CDN がブロックされることがあるため、外部ライブラリはすべてここに同梱しています。
各ツールはこのフォルダのファイルを共有して使います（ツールごとのコピーは置きません）。

フォルダ名に版を入れているので、中身は書きかえません。新しい版にするときは、新しいフォルダ（例: `pdfjs-5.0.0/`）を作り、
各ツールの参照先を新しいフォルダに直してから、古いフォルダを消します（手順は [開発の手引き](../../docs/開発の手引き.md) の「ライブラリを新しい版にする」）。サイト全体のサービスワーカー（`/sw.js`）は
このフォルダのファイルを一度保存したら使い続けるので、フォルダ名を変えれば新しい版が読み込まれます。

| フォルダ | ライブラリ | 用途 | 使っているツール | ライセンス |
| --- | --- | --- | --- | --- |
| `pdfjs-4.10.38/` | [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 | PDFの表示・文字の取り出し | PDF文字入れ、PDF結合・分割・回転、PDFに手書き・署名、PDF一括採点、PDF圧縮、PDF→画像、ページ番号・透かし入れ、PDF文字取り出し | Apache-2.0 |
| `pdf-lib-1.17.1/` | [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 | PDFの作成・書き込み | PDF文字入れ、PDF結合・分割・回転、PDFに手書き・署名、PDF一括採点、PDF圧縮、ページ番号・透かし入れ、画像→PDF | MIT |
| `fontkit-1.1.1/` | [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) 1.1.1 | フォントの読み込み | PDF文字入れ、ページ番号・透かし入れ | MIT |
| `harfbuzz-1.6.3/` | [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs) 1.6.3 | 使う文字だけにフォントを縮小 | PDF文字入れ、ページ番号・透かし入れ | MIT |
| `noto-sans-jp/` | [Noto Sans JP](https://fonts.google.com/noto/specimen/Noto+Sans+JP) | 日本語フォント | PDF文字入れ、ページ番号・透かし入れ | SIL OFL 1.1 |
| `tesseract-7.0.0/` | [tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 / tesseract.js-core 7.0.0（SIMD版のみ）、[tessdata_best](https://github.com/tesseract-ocr/tessdata_best)（`@tesseract.js-data` 1.0.0 の jpn / jpn_vert / eng、best_int） | OCR | PDF文字取り出し | Apache-2.0 |
| `heic-to-1.6.6/` | [heic-to](https://github.com/hoppergee/heic-to) 1.6.6（libheif を WebAssembly にしたもの。CSP 版） | iPhoneの写真（HEIC）をJPEGに変換。HEICを開いたときだけ読み込みます | 画像→PDF、画像を小さく、画像に書き込み | LGPL-3.0（libheif） |
| `qrcode-generator-2.0.4/` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4（ESM版 `qrcode.mjs`） | QRコードの作成 | QRコード作成 | MIT |

ライセンスの全文は各フォルダの `LICENSE`・`LICENSE.md`・`OFL.txt` などにあります。
