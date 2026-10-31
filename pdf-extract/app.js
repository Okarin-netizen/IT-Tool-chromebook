import { openPdf, openPdfError, renderPage } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { createLazyRenderer, freeCanvas } from "../shared/js/lazy.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadScript } from "../shared/js/pdf-lib.js";
import { pixelRatio } from "../shared/js/canvas.js";
import { copyText } from "../shared/js/clipboard.js";

const asset = (path) => new URL(path, location.href).href;

const PREVIEW_PX = 280; // width of a page preview, in CSS pixels
const OCR_PX = 3000; // longest side of the page image given to OCR (about 260 dpi for A4)

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  fileName: $("file-name"),
  joinLines: $("join-lines"),
  pageHeaders: $("page-headers"),
  togglePreview: $("toggle-preview"),
  ocrLang: $("ocr-lang"),
  ocrEmpty: $("ocr-empty"),
  copyAll: $("copy-all"),
  saveTxt: $("save-txt"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  pages: $("pages"),
};

const state = {
  name: "",
  pdf: null,
  // { num, lines: [{ text, gapBefore }], ocr, edited, el, textarea, canvas, rendered }
  pages: [],
  busy: false,
  preview: true,
};

/* ---------- text clean-up ---------- */

// Some PDFs (often ones made from Word) map kanji to look-alike "Kangxi radical"
// characters, e.g. ⽇ (U+2F47) instead of 日. They look right but break search and
// copy-paste, so map them back to the normal kanji.
const fixRadicals = (s) => s.replace(/[⺀-⿟]/g, (c) => c.normalize("NFKC"));

const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々〆〇、。，．・「」『』（）【】〔〕〈〉《》！？：；…‥―～";
const CJK_SPACES = new RegExp(`([${CJK}])[ \\u3000]+(?=[${CJK}])`, "gu");
const CJK_CHAR = new RegExp(`[${CJK}]`, "u");
const isCjk = (c) => CJK_CHAR.test(c);

function cleanLine(s) {
  return fixRadicals(s).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\s+$/, "");
}

/* ---------- reading text from a PDF page ---------- */

// pdf.js gives text pieces with their positions. Put pieces that sit on the same
// baseline (横書き) or in the same column (縦書き) into one line, and remember where
// each line starts and ends so paragraphs can be found later.
async function readTextLines(page) {
  const content = await page.getTextContent();
  return describeLines(groupLines(content).filter((l) => l.text.trim()));
}

// The pieces of text joined into lines, each with the box it covers.
function groupLines(content) {
  const lines = [];
  let cur = null;
  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue; // marked-content markers, empty pieces
    const [, , c, d, x, y] = item.transform;
    const size = Math.hypot(c, d) || item.height || 10;
    const vertical = !!content.styles[item.fontName]?.vertical; // a real 縦書き font
    const blank = !item.str.trim();
    const step = cur && continues(cur, x, y, size);
    if (step) {
      if (step === "below") cur.vertical = true;
      else if (!blank && x - cur.endX > size * 0.8 && !/\s$/.test(cur.text)) cur.text += " ";
      cur.text += item.str;
    } else {
      if (blank) continue;
      cur = { text: item.str, x, y, size, vertical, minX: x, maxX: x, minY: y, maxY: y, endX: x };
      lines.push(cur);
    }
    if (!blank) growLine(cur, item, x, y, size, vertical);
  }
  for (const l of lines) {
    // A one-character line can't tell its own direction; it follows its neighbours.
    l.start = l.vertical ? l.maxY : l.minX;
    l.end = l.vertical ? l.minY : l.maxX;
  }
  return lines;
}

// Widens the box of line `cur` to take in a piece of text at (x, y).
function growLine(cur, item, x, y, size, vertical) {
  // Vertical fonts measure along the column: the piece runs down from (x, y).
  const down = vertical ? item.height || size : 0;
  cur.lastX = x;
  cur.lastY = y - down;
  cur.lastW = vertical ? size : item.width;
  cur.endX = Math.max(cur.endX, x + cur.lastW);
  cur.minX = Math.min(cur.minX, x);
  cur.maxX = Math.max(cur.maxX, x + cur.lastW);
  cur.minY = Math.min(cur.minY, y - down);
  cur.maxY = Math.max(cur.maxY, y);
}

// Each line's text, whether it starts a new block, and how much room is left after it.
function describeLines(lines) {
  const gaps = lines.slice(1).map((l, i) => (l.vertical ? lines[i].x - l.x : lines[i].y - l.y));
  const usual = median(gaps.filter((g) => g > 0));
  return lines.map((l, i) => {
    const gap = i ? gaps[i - 1] : 0;
    // How far a full line of this column reaches: the farthest end among lines that start in the same place.
    const peers = lines.filter((o) => o.vertical === l.vertical && Math.abs(o.start - l.start) < l.size * 3);
    const edge = l.vertical ? Math.min(...peers.map((o) => o.end)) : Math.max(...peers.map((o) => o.end));
    return {
      text: cleanLine(l.text),
      // A much bigger step than usual, or a jump backwards (a new column), starts a new block.
      gapBefore: i > 0 && usual > 0 && (gap > Math.max(usual * 1.5, l.size * 1.8) || gap < -l.size),
      room: Math.max(0, Math.abs(edge - l.end)) / l.size, // empty space after the line, in characters
    };
  });
}

// Whether a text piece at (x, y) carries on the current line: on the same baseline to
// the right, or (縦書き) in the same column further down. Only a narrow piece (a single
// character or a vertical column) can carry on downwards, so the next line of
// horizontal text is not mistaken for it.
function continues(line, x, y, size) {
  const dx = x - line.lastX;
  const dy = y - line.lastY;
  if (Math.abs(dy) < size * 0.5 && dx > -size * 0.5) return "right";
  if (line.lastW < size * 1.6 && Math.abs(dx) < size * 0.5 && dy < size * 0.5 && dy > -size * 2.5) return "below";
  return false;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/* ---------- formatting ---------- */

// How a list item or a numbered heading begins; such a line always starts a new paragraph.
const LIST_START = new RegExp(`^(${[
  "[・●○■□◆◇▪▶►※＊*\\-–—]", // a bullet
  "[0-9０-９]+[.．、)）]", // 1. 1、 1)
  "[（(][0-9０-９a-zA-Zａ-ｚア-ン一-十]+[)）]", // (1) (a) (ア)
  "[①-⑳⑴-⒇❶-❿]", // ① ⑴ ❶
  "第[0-9０-９一-十百]+[章節条項回問]", // 第1章
  "問[0-9０-９一-十]+", // 問1
].join("|")})`);

// Width of the first word of a line, in characters (Latin letters are about half as wide).
function firstWordWidth(text) {
  const t = text.trim();
  const word = isCjk(t[0] ?? "") ? t[0] : (t.match(/^\S+/)?.[0] ?? "");
  return [...word].reduce((w, ch) => w + (isCjk(ch) || /[^\x00-\x7F]/.test(ch) ? 1 : 0.55), 0);
}

// Joins lines that were only broken because the PDF line was full, keeping real
// paragraph breaks, list items and headings on their own lines.
function joinParagraphs(lines) {
  const out = [];
  let para = "";
  let prev = null;
  for (const line of lines) {
    const text = line.text.trim();
    const startsNew = !prev
      || line.gapBefore
      || LIST_START.test(text)
      || /^[\u3000 ]/.test(line.text) // indented: a new Japanese paragraph
      // The line before stopped early although this line's first word would have fit there
      // (with some slack for Japanese line-breaking rules, which can leave a gap).
      || (prev.room ?? 0) > firstWordWidth(text) + 1.2;
    if (startsNew) {
      if (prev) out.push(para);
      if (line.gapBefore && prev) out.push("");
      para = text;
    } else {
      para = joinTwo(para, text);
    }
    prev = line;
  }
  if (prev) out.push(para);
  return out.join("\n");
}

function joinTwo(a, b) {
  if (!a) return b;
  if (!b) return a;
  const last = a.at(-1);
  const first = b[0];
  if (last === "-" && /[a-z]/.test(first) && /[A-Za-z]-$/.test(a)) return a.slice(0, -1) + b;
  if (isCjk(last) || isCjk(first)) return a + b;
  return `${a} ${b}`;
}

function pageText(view) {
  if (!view.lines.length) return "";
  if (els.joinLines.checked) return joinParagraphs(view.lines);
  const out = [];
  for (const [i, line] of view.lines.entries()) {
    if (i && line.gapBefore) out.push("");
    out.push(line.text);
  }
  return out.join("\n");
}

function formatPage(view) {
  if (view.edited) return;
  view.textarea.value = pageText(view);
  updatePageUi(view);
}

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (!isPdf(file)) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  if (state.busy) return;
  if (state.pages.some((p) => p.edited) && !confirm("書き直した文字は消えます。別のPDFを開きますか？")) return;
  state.busy = true;
  updateUi();
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(bytes, { name: file.name }).promise;
    closeCurrent();
    state.pdf = pdf;
    state.name = file.name || "document.pdf";
    els.fileName.textContent = state.name;
    els.fileName.title = state.name;

    for (let num = 1; num <= pdf.numPages; num++) {
      if (pdf.numPages > 5) showStatus(`文字を取り出し中…（${num}/${pdf.numPages}ページ）`, { sticky: true });
      await addPage(pdf, num);
    }
    reportOpened();
  } catch (err) {
    console.error(err);
    showStatus(openPdfError(err), { error: true });
  } finally {
    state.busy = false;
    updateUi();
  }
}

// Reads the text of page `num` and adds its row to the list.
async function addPage(pdf, num) {
  const page = await pdf.getPage(num);
  const view = { num, lines: [], ocr: false, edited: false, rendered: false };
  try {
    view.lines = await readTextLines(page);
  } catch (err) {
    console.error(err);
  }
  createPageRow(view);
  state.pages.push(view);
  els.pages.append(view.el);
  formatPage(view);
}

// Says how many pages had text, and suggests OCR for those without.
function reportOpened() {
  const count = state.pages.length;
  const empty = state.pages.filter(isEmpty).length;
  if (empty === count) {
    showStatus("文字が入っていないPDFです（スキャンした画像など）。「文字のないページを読み取る」でOCRできます", { ms: 9000 });
  } else if (empty) {
    showStatus(`${count}ページ中${empty}ページは文字が入っていません。「文字のないページを読み取る」でOCRできます`, { ms: 7000 });
  } else {
    hideStatus();
    showStatus(`${count}ページの文字を取り出しました`);
  }
}

function closeCurrent() {
  previews.clear();
  state.pages = [];
  els.pages.replaceChildren();
  state.pdf?.destroy();
  state.pdf = null;
}

const isEmpty = (view) => !view.textarea.value.trim();

/* ---------- page rows ---------- */

// Previews far off screen are freed, so a long PDF does not fill up memory.
const previews = createLazyRenderer({
  root: els.viewer,
  renderMargin: "600px",
  releaseMargin: "2500px",
  render: renderPreview,
  release: (view) => freeCanvas(view.canvas),
});

function createPageRow(view) {
  const li = document.createElement("li");
  li.className = "page";

  const preview = document.createElement("div");
  preview.className = "preview";
  view.canvas = document.createElement("canvas");
  view.canvas.setAttribute("aria-hidden", "true");
  preview.append(view.canvas);

  view.empty = document.createElement("p");
  view.empty.className = "empty-note";
  view.empty.textContent = "このページには文字が入っていません。スキャンした画像や写真のページは「画像から読み取る（OCR）」で読み取れます。";
  view.empty.hidden = true;

  view.textarea = document.createElement("textarea");
  view.textarea.spellcheck = false;
  view.textarea.setAttribute("aria-label", `${view.num}ページの文字`);
  view.textarea.addEventListener("input", () => {
    view.edited = true;
    updatePageUi(view);
  });

  const body = document.createElement("div");
  body.className = "page-body";
  body.append(pageHead(view), view.empty, view.textarea);
  li.append(preview, body);
  view.el = li;
  previews.add(view);
}

// The page number with its badge (OCR, edited) and the page's buttons.
function pageHead(view) {
  const title = document.createElement("h2");
  title.textContent = `${view.num}ページ`;
  view.badge = document.createElement("span");
  view.badge.className = "badge";
  view.badge.hidden = true;
  title.append(" ", view.badge);

  const copy = () => copyWithMessage(view.textarea.value, `${view.num}ページをコピーしました`);
  const reset = () => {
    view.edited = false;
    formatPage(view);
    updateUi();
  };
  view.copyBtn = miniButton("コピー", "このページの文字をコピー", copy);
  view.ocrBtn = miniButton("画像から読み取る（OCR）", "このページを画像として文字を読み取ります", () => ocrPages([view], { confirmReplace: true }));
  view.resetBtn = miniButton("元に戻す", "書き直す前の文字に戻します", reset);
  view.resetBtn.hidden = true;
  const actions = document.createElement("div");
  actions.className = "page-actions";
  actions.append(view.copyBtn, view.ocrBtn, view.resetBtn);

  const head = document.createElement("div");
  head.className = "page-head";
  head.append(title, actions);
  return head;
}

function miniButton(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mini";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function updatePageUi(view) {
  const empty = isEmpty(view);
  view.empty.hidden = !empty || view.edited;
  view.el.classList.toggle("is-empty", empty && !view.edited);
  view.ocrBtn.classList.toggle("suggest", empty);
  view.copyBtn.disabled = empty;
  view.resetBtn.hidden = !view.edited;
  view.badge.hidden = !view.ocr && !view.edited;
  view.badge.textContent = view.edited ? "書き直し" : "OCR";
}

async function renderPreview(view) {
  view.rendered = true;
  try {
    const page = await state.pdf.getPage(view.num);
    const base = page.getViewport({ scale: 1 });
    const dpr = pixelRatio();
    const viewport = page.getViewport({ scale: (PREVIEW_PX / base.width) * dpr });
    view.canvas.width = Math.round(viewport.width);
    view.canvas.height = Math.round(viewport.height);
    view.canvas.style.width = `${PREVIEW_PX}px`;
    await page.render({ canvasContext: view.canvas.getContext("2d"), viewport }).promise;
  } catch (err) {
    console.error(err);
  }
}

/* ---------- OCR ---------- */

const loadTesseract = () => loadScript("tesseract-7.0.0/tesseract.min.js", "Tesseract");

let ocr = null; // { worker, lang }
let ocrProgress = () => {};

async function getOcrWorker(lang) {
  const Tesseract = await loadTesseract();
  if (!ocr) {
    const worker = await Tesseract.createWorker(lang, 1, {
      workerPath: asset("../shared/vendor/tesseract-7.0.0/worker.min.js"),
      // Every Chrome on a Chromebook supports WebAssembly SIMD, so only this core is bundled.
      corePath: asset("../shared/vendor/tesseract-7.0.0/tesseract-core-simd-lstm.wasm.js"),
      langPath: asset("../shared/vendor/tesseract-7.0.0/lang"),
      workerBlobURL: false,
      logger: (m) => ocrProgress(m),
      errorHandler: (err) => console.error(err),
    });
    ocr = { worker, lang };
  } else if (ocr.lang !== lang) {
    await ocr.worker.reinitialize(lang, 1);
    ocr.lang = lang;
  }
  // Vertical Japanese reads best as one block of top-to-bottom columns.
  await ocr.worker.setParameters({ tessedit_pageseg_mode: lang === "jpn_vert" ? "5" : "3", preserve_interword_spaces: "1" });
  return ocr.worker;
}

async function pageImage(num) {
  const page = await state.pdf.getPage(num);
  const base = page.getViewport({ scale: 1 });
  return renderPage(page, Math.min(5, OCR_PX / Math.max(base.width, base.height)));
}

// Tesseract puts spaces between Japanese characters and separates paragraphs with
// blank lines; turn that into the same line list the PDF text uses.
function ocrLines(text, lang) {
  const lines = [];
  let gap = false;
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\s+$/, "");
    if (lang !== "eng") line = line.replace(CJK_SPACES, "$1");
    if (!line.trim()) {
      gap = lines.length > 0;
      continue;
    }
    lines.push({ text: cleanLine(line), gapBefore: gap });
    gap = false;
  }
  return lines;
}

async function ocrPages(views, { confirmReplace = false } = {}) {
  if (state.busy || !views.length) return;
  if (confirmReplace && views.some((v) => !isEmpty(v)) && !confirm("今の文字を、画像から読み取った文字に置きかえますか？")) return;
  const lang = els.ocrLang.value;
  state.busy = true;
  updateUi();
  let done = 0;
  let failed = 0;
  const label = () => (views.length > 1 ? `（${done + 1}/${views.length}ページ）` : `（${views[done].num}ページ）`);
  try {
    showStatus("OCRの準備中…（初めてのときは少し時間がかかります）", { sticky: true });
    ocrProgress = (m) => {
      if (m.status === "recognizing text") {
        showStatus(`画像から文字を読み取り中…${label()} ${Math.round(m.progress * 100)}%`, { sticky: true });
      }
    };
    const worker = await getOcrWorker(lang);
    for (const view of views) {
      showStatus(`画像から文字を読み取り中…${label()}`, { sticky: true });
      try {
        const canvas = await pageImage(view.num);
        const { data } = await worker.recognize(canvas);
        view.lines = ocrLines(data.text, lang);
        view.ocr = true;
        view.edited = false;
        formatPage(view);
      } catch (err) {
        console.error(err);
        failed++;
      }
      done++;
    }
    const found = views.filter((v) => !isEmpty(v)).length;
    if (failed) showStatus(`${failed}ページを読み取れませんでした`, { error: true });
    else if (!found) showStatus("文字を読み取れませんでした。縦書き・横書きの設定を確かめてください", { error: true });
    else showStatus(`${found}ページを読み取りました。OCRは読みまちがいがあるので、確かめてから使ってください`, { ms: 6000 });
  } catch (err) {
    console.error(err);
    showStatus("OCRを始められませんでした。一度インターネットにつないで開き直してください", { error: true });
  } finally {
    ocrProgress = () => {};
    state.busy = false;
    updateUi();
  }
}

/* ---------- copy & save ---------- */

function allText() {
  const headers = els.pageHeaders.checked;
  const parts = [];
  for (const view of state.pages) {
    const text = view.textarea.value.trim();
    if (headers) parts.push(`― ${view.num}ページ ―${text ? `\n${text}` : ""}`);
    else if (text) parts.push(text);
  }
  return `${parts.join("\n\n")}\n`;
}

async function copyWithMessage(text, message) {
  if (!text.trim()) return;
  if (await copyText(text)) showStatus(message);
  else showStatus("コピーできませんでした。文字を選んで Ctrl+C でコピーしてください", { error: true });
}

function saveText() {
  const name = `${baseName(state.name) || "document"}.txt`;
  download(new Blob([allText()], { type: "text/plain;charset=utf-8" }), name);
  showStatus(`${name} を保存しました`);
}

/* ---------- UI state ---------- */

function updateUi() {
  const has = state.pages.length > 0;
  els.welcome.hidden = has;
  els.pages.hidden = !has;
  const anyText = state.pages.some((v) => !isEmpty(v));
  els.copyAll.disabled = state.busy || !anyText;
  els.saveTxt.disabled = state.busy || !anyText;
  els.ocrEmpty.disabled = state.busy || !state.pages.some(isEmpty);
  els.togglePreview.disabled = !has;
  els.fileInput.disabled = state.busy;
  for (const view of state.pages) view.ocrBtn.disabled = state.busy;
}

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.joinLines.addEventListener("change", () => {
  for (const view of state.pages) formatPage(view);
  updateUi();
  if (state.pages.some((p) => p.edited)) showStatus("書き直したページはそのままにしています（「元に戻す」で切りかわります）", { ms: 5000 });
});
els.togglePreview.addEventListener("click", () => {
  state.preview = !state.preview;
  els.pages.classList.toggle("no-preview", !state.preview);
  els.togglePreview.textContent = state.preview ? "ページを隠す" : "ページを表示";
});
els.ocrEmpty.addEventListener("click", () => ocrPages(state.pages.filter(isEmpty)));
els.copyAll.addEventListener("click", () => copyWithMessage(allText(), "全ページの文字をコピーしました"));
els.saveTxt.addEventListener("click", saveText);
els.pages.addEventListener("input", () => updateUi());

window.addEventListener("beforeunload", (e) => {
  if (state.pages.some((p) => p.edited)) e.preventDefault();
});

// Drag & drop a PDF anywhere on the page.
onFileDrop((files) => openFile(files[0]));

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs",
  "../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs",
]);

updateUi();

// Hook for automated tests.
window.__pdfExtract = { readTextLines, state, openFile, ocrPages, allText, joinParagraphs, ocrLines };
