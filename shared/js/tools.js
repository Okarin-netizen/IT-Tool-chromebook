// Every tool on the portal (index.html): its folder, its name, and what "次のツールで開く"
// (handoff.js) may hand it: "pdf", "image" or both. A tool with no `takes` is not offered there.
// The smoke test checks that this list and the portal agree.
// PDF tools are listed in the order the handoff menu shows them: the usual next step first.
export const TOOLS = [
  { id: "pdf-pages", name: "PDF結合・分割・回転", takes: ["pdf"] },
  { id: "pdf-text", name: "PDF文字入れ", takes: ["pdf"] },
  { id: "pdf-sign", name: "PDFに手書き・署名", takes: ["pdf"] },
  { id: "pdf-stamp", name: "ページ番号・透かし入れ", takes: ["pdf"] },
  { id: "pdf-booklet", name: "冊子印刷", takes: ["pdf"] },
  { id: "pdf-compress", name: "PDF圧縮", takes: ["pdf"] },
  { id: "pdf-image", name: "PDF→画像", takes: ["pdf"] },
  { id: "pdf-extract", name: "PDF文字取り出し", takes: ["pdf", "image"] },
  { id: "pdf-grade", name: "PDF一括採点" },
  { id: "image-pdf", name: "画像→PDF", takes: ["image"] },
  { id: "image-resize", name: "画像を小さく", takes: ["image"] },
  { id: "image-annotate", name: "画像に書き込み", takes: ["image"] },
  { id: "class-picker", name: "名前ルーレット・班分け" },
  { id: "class-screen", name: "授業の画面" },
  { id: "qr-maker", name: "QRコード作成" },
  { id: "typing", name: "タイピング練習" },
  { id: "calc", name: "関数電卓・グラフ" },
  { id: "todo", name: "時間割・課題チェックリスト" },
  { id: "timer", name: "タイマー・ポモドーロ" },
];
