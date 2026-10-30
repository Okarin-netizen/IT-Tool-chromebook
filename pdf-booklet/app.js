import { openPdf, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { createLazyRenderer } from "../shared/js/lazy.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their settings. Add a new key instead.
const SETTINGS_KEY = "pdf-booklet-settings-v1";
const PREVIEW_PX = 340; // preview width of a sideways sheet, in CSS pixels
const A4 = { width: 595, height: 842 }; // shown in the help before a PDF is opened

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  fileName: $("file-name"),
  saveBtn: $("save-btn"),
  printBtn: $("print-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  sheets: $("sheets"),
  paper: $("paper"),
  paperHelp: $("paper-help"),
  bindingHelp: $("binding-help"),
  backCover: $("back-cover"),
  summary: $("summary"),
  summaryText: $("summary-text"),
};
const bindingInputs = [...document.querySelectorAll("input[name=binding]")];

const state = {
  // { name, bytes (never handed to pdf.js, which detaches buffers), pdf (pdf.js) }
  file: null,
  // each page's size as shown (scale 1, turned by its /Rotate): { width, height }
  pages: [],
  // the sides of the sheets in printing order: { sheet, back, slots: [page index or null, …], el, canvas, rendered }
  sides: [],
  busy: false,
  generation: 0, // bumped when the preview is rebuilt, so late drawings of old sides are dropped
};

/* ---------- settings ---------- */

function readSettings() {
  return {
    binding: bindingInputs.find((el) => el.checked)?.value ?? "left",
    paper: els.paper.value,
    backCover: els.backCover.checked,
  };
}

function restoreSettings() {
  const saved = loadJson(SETTINGS_KEY, {});
  if (saved.binding) for (const el of bindingInputs) el.checked = el.value === saved.binding;
  if ([...els.paper.options].some((o) => o.value === saved.paper)) els.paper.value = saved.paper;
  els.backCover.checked = !!saved.backCover;
}

/* ---------- the order of the pages ---------- */

// Saddle stitching: every sheet holds 4 pages, 2 on each side, and the sheets are stacked and
// folded in the middle. The outer sheet carries the first 2 and the last 2 pages, the next one
// the 2 after and the 2 before those, and so on. Returns the sides in printing order (front of
// sheet 1, back of sheet 1, front of sheet 2, …), each as [left, right] page indexes (or
// [top, bottom] for wide pages), with null for an added blank page.
// Printed on both sides flipping on the short edge, the back of each half is the next page.
function planBooklet(count, { binding = "left", backCover = false } = {}) {
  const total = Math.max(4, Math.ceil(count / 4) * 4);
  const blanks = total - count;
  const order = [...Array(count).keys()];
  const pad = Array(blanks).fill(null);
  // A back cover stays the very last page; the blanks go just before it.
  if (backCover && count > 1) order.splice(count - 1, 0, ...pad);
  else order.push(...pad);
  const sides = [];
  for (let i = 0; i < total / 4; i++) {
    const front = [order[total - 1 - 2 * i], order[2 * i]];
    const back = [order[2 * i + 1], order[total - 2 - 2 * i]];
    // Bound on the right (vertical Japanese text), the book opens the other way.
    if (binding === "right") {
      front.reverse();
      back.reverse();
    }
    sides.push(front, back);
  }
  return { sides, total, blanks };
}

// The sheet the pages are printed on, and the two halves of it (in PDF points, origin at the
// lower left). Upright pages go side by side on a sideways sheet; wide pages go one above the
// other on an upright sheet, making a booklet bound at the top. "same" uses paper the size of
// the first page (A4 pages shrink onto A4 paper, an A5 booklet); "double" fits two pages at
// their own size (A4 pages on A3 paper, an A4 booklet).
function sheetLayout(first, paper) {
  const { width: w, height: h } = first;
  const stacked = w > h;
  let sheetW, sheetH;
  if (paper === "double") [sheetW, sheetH] = stacked ? [w, h * 2] : [w * 2, h];
  else [sheetW, sheetH] = [h, w];
  const cells = stacked
    ? [{ x: 0, y: sheetH / 2, w: sheetW, h: sheetH / 2 }, { x: 0, y: 0, w: sheetW, h: sheetH / 2 }]
    : [{ x: 0, y: 0, w: sheetW / 2, h: sheetH }, { x: sheetW / 2, y: 0, w: sheetW / 2, h: sheetH }];
  return { stacked, width: sheetW, height: sheetH, cells };
}

// Where a page of the shown size lands in a cell: as large as fits, in the middle.
function fit(cell, width, height) {
  const k = Math.min(cell.w / width, cell.h / height);
  const w = width * k;
  const h = height * k;
  return { k, x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

const PAPER_NAMES = [["A3", 842, 1191], ["A4", 595, 842], ["A5", 420, 595], ["B4", 729, 1032], ["B5", 516, 729], ["レター", 612, 792]];

function paperName(width, height, { turn = true } = {}) {
  const [short, long] = width < height ? [width, height] : [height, width];
  const match = PAPER_NAMES.find(([, s, l]) => Math.abs(s - short) < 6 && Math.abs(l - long) < 6);
  const name = match ? match[0] : `${Math.round((width * 25.4) / 72)}×${Math.round((height * 25.4) / 72)} mm`;
  return match && turn && width > height ? `${name} 横` : name;
}

/* ---------- opening a PDF ---------- */

async function openFiles(list) {
  const file = [...list].find(isPdf);
  if (!file) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  showStatus("PDFを読み込み中…", { sticky: true });
  let bytes, pdf;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await openPdf(bytes.slice(), { name: file.name }).promise;
  } catch (err) {
    console.error(err);
    showStatus(err?.name === "PasswordException" ? "パスワードが入力されなかったので開けませんでした" : `PDFを開けませんでした: ${file.name}`, { error: true });
    return;
  }
  const pages = [];
  for (let num = 1; num <= pdf.numPages; num++) {
    const { width, height } = (await pdf.getPage(num)).getViewport({ scale: 1 });
    pages.push({ width, height });
  }
  state.file?.pdf.destroy();
  state.file = { name: file.name || "document.pdf", bytes, pdf };
  state.pages = pages;
  document.title = `${state.file.name} - 冊子印刷`;
  els.fileName.textContent = `${state.file.name}（${pages.length}ページ）`;
  els.welcome.hidden = true;
  update();
  els.viewer.scrollTop = 0;
  hideStatus();
}

/* ---------- preview ---------- */

const previews = createLazyRenderer({
  root: els.viewer,
  render: renderSide,
  release: (side) => (side.canvas.width = side.canvas.height = 0),
});

function rebuildPreview(settings) {
  previews.clear();
  state.generation++;
  els.sheets.replaceChildren();
  state.sides = [];
  if (!state.file) return;
  const layout = sheetLayout(state.pages[0], settings.paper);
  const { sides } = planBooklet(state.pages.length, settings);
  const cssW = layout.width > layout.height ? PREVIEW_PX : PREVIEW_PX * 0.7;
  const cssH = (cssW * layout.height) / layout.width;
  sides.forEach((slots, i) => {
    const el = document.createElement("li");
    el.className = "side";
    const canvas = document.createElement("canvas");
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = canvas.height = 0;
    const label = document.createElement("div");
    label.className = "label";
    const sheet = Math.floor(i / 2) + 1;
    const nums = slots.map((p) => (p === null ? "白紙" : `${p + 1}`)).join(layout.stacked ? "／" : "｜");
    label.innerHTML = `<b>${sheet}枚目の${i % 2 ? "裏" : "表"}</b>　`;
    label.append(nums);
    el.append(canvas, label);
    els.sheets.append(el);
    const side = { sheet, back: i % 2 === 1, slots, layout, el, canvas, cssW, rendered: false };
    state.sides.push(side);
    previews.add(side);
  });
}

async function renderSide(side) {
  side.rendered = true;
  const generation = state.generation;
  const { layout, canvas } = side;
  const scale = (side.cssW * (window.devicePixelRatio || 1)) / layout.width;
  const out = document.createElement("canvas");
  out.width = Math.round(layout.width * scale);
  out.height = Math.round(layout.height * scale);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  for (const [slot, index] of side.slots.entries()) {
    const cell = layout.cells[slot];
    if (index === null) {
      // An added blank page: a faint note, so it is clear the space is meant to be empty.
      ctx.fillStyle = "#b8bec8";
      ctx.font = `${Math.round(14 * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("白紙", (cell.x + cell.w / 2) * scale, (layout.height - cell.y - cell.h / 2) * scale);
      continue;
    }
    const size = state.pages[index];
    const at = fit(cell, size.width, size.height);
    try {
      const page = await state.file.pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: at.k * scale });
      const pic = document.createElement("canvas");
      pic.width = Math.ceil(viewport.width);
      pic.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: pic.getContext("2d"), viewport }).promise;
      if (generation !== state.generation || !side.rendered) return;
      ctx.drawImage(pic, at.x * scale, (layout.height - at.y - at.h) * scale, at.w * scale, at.h * scale);
      pic.width = pic.height = 0;
    } catch (err) {
      console.error(err);
    }
  }
  if (generation !== state.generation || !side.rendered) return;
  // The fold.
  ctx.strokeStyle = "#c5cad3";
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  if (layout.stacked) {
    ctx.moveTo(0, out.height / 2);
    ctx.lineTo(out.width, out.height / 2);
  } else {
    ctx.moveTo(out.width / 2, 0);
    ctx.lineTo(out.width / 2, out.height);
  }
  ctx.stroke();
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.getContext("2d").drawImage(out, 0, 0);
  out.width = out.height = 0;
}

/* ---------- controls ---------- */

function syncControls(settings = readSettings()) {
  const ready = !!state.file && !state.busy;
  els.saveBtn.disabled = !ready;
  els.printBtn.disabled = !ready;
  const first = state.pages[0] ?? A4;
  const layout = sheetLayout(first, settings.paper);
  for (const el of bindingInputs) el.disabled = layout.stacked;
  els.bindingHelp.hidden = !layout.stacked;
  const half = layout.cells[0];
  const sheet = paperName(layout.width, layout.height);
  const book = paperName(half.w, half.h, { turn: false });
  const pages = state.file ? `${paperName(first.width, first.height, { turn: false })}のページ` : "A4のPDFなら、ページ";
  els.paperHelp.textContent = settings.paper === "double"
    ? `${pages}を元の大きさのまま、${sheet}の紙に2ページずつ入れます（${book}の冊子になります）。`
    : `${pages}を縮小して、${sheet}の紙に2ページずつ入れます（${book}の冊子になります）。`;
  els.summary.hidden = !state.file;
  if (!state.file) return;
  const { total, blanks } = planBooklet(state.pages.length, settings);
  els.summaryText.textContent = `${state.pages.length}ページ → ${sheet}の紙${total / 4}枚（両面）。`
    + (blanks ? `ページ数を4の倍数にするため、白紙を${blanks}ページ足しました。` : "");
}

function update() {
  const settings = readSettings();
  saveJson(SETTINGS_KEY, settings);
  syncControls(settings);
  rebuildPreview(settings);
}

/* ---------- saving ---------- */

async function buildPdf(settings) {
  const { PDFDocument, degrees } = await loadPdfLib();
  let src = await PDFDocument.load(state.file.bytes, { ignoreEncryption: true });
  const rebuilt = src.isEncrypted;
  if (rebuilt) {
    const onPage = (num, count) => showStatus(`保護されたPDFのため、ページを画像にしています… (${num}/${count})`, { sticky: true });
    src = await rasterizePdf(state.file.pdf, { onPage });
    showStatus("PDFを作成中…", { sticky: true });
  }
  const out = await PDFDocument.create();
  const pages = src.getPages();
  // A page with nothing on it (no content stream, like a blank page) cannot be embedded; its
  // half of the sheet is left empty.
  const embedded = [];
  for (const page of pages) embedded.push(page.node.Contents() ? await out.embedPage(page) : null);
  const shown = pages.map((page) => {
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const { width, height } = page.getSize();
    return { angle, width: angle % 180 ? height : width, height: angle % 180 ? width : height };
  });
  const layout = sheetLayout(shown[0], settings.paper);
  for (const slots of planBooklet(pages.length, settings).sides) {
    const sheet = out.addPage([layout.width, layout.height]);
    slots.forEach((index, slot) => {
      if (index === null || !embedded[index]) return;
      const { angle, width, height } = shown[index];
      const { k, x, y, w, h } = fit(layout.cells[slot], width, height);
      // A page turned by /Rotate (clockwise) is drawn turned the same way. pdf-lib turns the
      // drawing counterclockwise around its lower left corner, so that corner moves.
      const at = { 0: [x, y], 90: [x, y + h], 180: [x + w, y + h], 270: [x + w, y] }[angle];
      sheet.drawPage(embedded[index], { x: at[0], y: at[1], xScale: k, yScale: k, rotate: degrees(-angle) });
    });
  }
  return { bytes: await out.save(), rebuilt };
}

// Builds the booklet PDF; returns { blob, name, rebuilt }, or null when it failed (and said so).
async function makeBooklet() {
  if (!state.file || state.busy) return null;
  state.busy = true;
  syncControls();
  showStatus("PDFを作成中…", { sticky: true });
  try {
    const { bytes, rebuilt } = await buildPdf(readSettings());
    return { blob: new Blob([bytes], { type: "application/pdf" }), name: `${baseName(state.file.name)}_冊子.pdf`, rebuilt };
  } catch (err) {
    console.error(err);
    showStatus("PDFを作れませんでした", { error: true });
    return null;
  } finally {
    state.busy = false;
    syncControls();
  }
}

async function save() {
  const result = await makeBooklet();
  if (!result) return;
  download(result.blob, result.name);
  showStatus(result.rebuilt
    ? "保存しました（保護されたPDFは、元のページを画像として保存しています）"
    : "保存しました（ダウンロードフォルダを確認してください）");
}

// Opens the booklet in a new tab, where Chrome's PDF viewer can print it.
async function openForPrint() {
  if (!state.file || state.busy) return;
  // The tab is opened right away, while the click still counts, so it is not blocked as a pop-up.
  const tab = window.open("", "_blank");
  const result = await makeBooklet();
  if (!result) {
    tab?.close();
    return;
  }
  if (!tab) {
    download(result.blob, result.name);
    showStatus("新しいタブを開けなかったので、保存しました。保存したPDFを開いて印刷してください");
    return;
  }
  const url = URL.createObjectURL(result.blob);
  tab.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  showStatus("新しいタブで開きました。両面印刷・短辺とじで印刷してください", { ms: 6000 });
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  openFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.saveBtn.addEventListener("click", save);
els.printBtn.addEventListener("click", openForPrint);
addNextTool({ saveBtn: els.saveBtn, save, kind: "pdf" });
for (const el of [...bindingInputs, els.paper, els.backCover]) el.addEventListener("change", update);

// Drag & drop a PDF anywhere on the page.
onFileDrop(openFiles);

restoreSettings();
syncControls();

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js",
  "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs",
  "../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs",
]);

// Hook for automated tests.
window.__pdfBooklet = { state, planBooklet, buildPdf, save };
