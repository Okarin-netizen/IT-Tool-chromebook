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
| `heic-to-1.6.6/` | [heic-to](https://github.com/hoppergee/heic-to) 1.6.6（libheif を WebAssembly にしたもの。CSP 版） | iPhoneの写真（HEIC）をJPEGに変換。HEICを開いたときだけ読み込みます | 画像→PDF、画像を小さく、画像に書き込み、かおトリ | LGPL-3.0（libheif） |
| `qrcode-generator-2.0.4/` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4（ESM版 `qrcode.mjs`） | QRコードの作成 | QRコード作成 | MIT |
| `mediapipe-tasks-vision-1.2.0/` | [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe)（`@mediapipe/tasks-vision` 1.2.0）。`vision.js` は本体（利用状況を送る処理を1か所無効にしたもの）、`wasm.js` は WebAssembly を base64 にして JavaScript に入れたもの | 顔の検出・顔の向き・人物の切り抜き | かおトリ、かおかくし | Apache-2.0 |
| `mediapipe-face-models/` | MediaPipe のモデル（base64）: BlazeFace（full range）の顔検出 `face-detector.js`、Face Landmarker `face-landmarker.js`、Selfie Segmenter `selfie-segmenter.js` | 同上 | 顔検出はかおトリ・かおかくし、ほかの2つはかおトリ | Apache-2.0 |
| `face-api-1.7.15/` | [@vladmandic/face-api](https://github.com/vladmandic/face-api) 1.7.15（TensorFlow.js 入り）と顔認識モデル（`face-recognition-model.js`、base64） | 写真を写っている人ごとに分ける。使うときだけ読み込みます | かおトリ | MIT |
| `jszip-3.10.2/` | [JSZip](https://github.com/Stuk/jszip) 3.10.2 | ZIPの作成 | かおトリ | MIT（MIT と GPLv3 のどちらかを選べる。MIT を選択） |
| `mediabunny-1.65.0/` | [Mediabunny](https://github.com/Vanilagy/mediabunny) 1.65.0（改変なし） | 動画の読み込みと書き出し | かおかくし | MPL-2.0 |

ライセンスの全文は各フォルダの `LICENSE`・`LICENSE.md`・`OFL.txt` などにあります。
