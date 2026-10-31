import { openPdf, openPdfError, renderPage } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { loadText, saveText } from "../shared/js/storage.js";
import { makeZip } from "../shared/js/zip.js";
import { createLazyRenderer, freeCanvas } from "../shared/js/lazy.js";
import { registerOffline } from "../shared/js/offline.js";
import { canvasToBlob, pixelRatio } from "../shared/js/canvas.js";
import { copyImage } from "../shared/js/clipboard.js";

const THUMB_PX = 150; // longest side of a thumbnail, in CSS pixels
const MAX_PIXELS = 25_000_000; // keep huge pages from exhausting memory
const JPEG_QUALITY = 0.9;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  format: $("format"),
  dpi: $("dpi"),
  selectAll: $("select-all"),
  selectNone: $("select-none"),
  count: $("count"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  grid: $("grid"),
};

const state = {
  name: "", // file name of the open PDF
  pdf: null, // pdf.js document
  pages: [], // { index (0-based), selected, el, rendered }
  lastClicked: null, // for shift-click range selection
  busy: false,
};

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file || !isPdf(file)) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  if (state.busy) return;
  showStatus("PDFを読み込み中…", { sticky: true });
  let pdf;
  try {
    pdf = await openPdf(new Uint8Array(await file.arrayBuffer()), { name: file.name }).promise;
  } catch (err) {
    console.error(err);
    showStatus(openPdfError(err), { error: true });
    return;
  }

  closePdf();
  state.pdf = pdf;
  state.name = file.name || "document.pdf";
  for (let index = 0; index < pdf.numPages; index++) {
    const view = { index, selected: false, el: null, rendered: false };
    createCard(view);
    state.pages.push(view);
    els.grid.append(view.el);
  }
  updateUi();
  hideStatus();
  showStatus(`${pdf.numPages}ページのPDFを開きました`);
}

function closePdf() {
  thumbs.clear();
  els.grid.replaceChildren();
  state.pages = [];
  state.lastClicked = null;
  state.pdf?.destroy();
  state.pdf = null;
}

/* ---------- page cards ---------- */

// Thumbnails far off screen are freed, so a long PDF does not fill up memory.
const thumbs = createLazyRenderer({
  root: els.viewer,
  renderMargin: "400px",
  releaseMargin: "2500px",
  render: renderThumb,
  release: (view) => {
    const canvas = view.el.querySelector(".thumb canvas");
    if (canvas) freeCanvas(canvas);
  },
});

function createCard(view) {
  const li = document.createElement("li");
  li.className = "card";
  li.tabIndex = 0;
  li.innerHTML = `
    <span class="check" aria-hidden="true">✓</span>
    <div class="thumb"><div class="placeholder"></div></div>
    <div class="label"><b>${view.index + 1}</b> ページ</div>
    <div class="card-actions">
      <button class="mini" data-act="save" title="このページを画像で保存" aria-label="このページを画像で保存"><svg class="i" aria-hidden="true"><use href="#i-save"/></svg></button>
      <button class="mini" data-act="copy" title="このページをコピー（スライドやドキュメントに貼り付けできます）" aria-label="このページをコピー"><svg class="i" aria-hidden="true"><use href="#i-copy"/></svg></button>
    </div>`;
  view.el = li;

  li.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "save") saveViews([view]);
    else if (act === "copy") copyPage(view);
    else toggleSelect(view, e.shiftKey);
  });
  li.addEventListener("keydown", (e) => {
    if (e.target !== li) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggleSelect(view, e.shiftKey);
    }
  });
  thumbs.add(view);
}

async function renderThumb(view) {
  view.rendered = true;
  const pdf = state.pdf;
  try {
    const page = await pdf.getPage(view.index + 1);
    const base = page.getViewport({ scale: 1 });
    const canvas = await renderPage(page, (THUMB_PX / Math.max(base.width, base.height)) * pixelRatio());
    if (pdf !== state.pdf || !view.rendered) return; // another PDF was opened, or scrolled far away
    view.el.querySelector(".thumb").replaceChildren(canvas);
  } catch (err) {
    console.error(err);
    view.rendered = false;
  }
}

/* ---------- selection ---------- */

function toggleSelect(view, range) {
  if (range && state.lastClicked && state.lastClicked !== view) {
    const a = state.pages.indexOf(state.lastClicked);
    const b = state.pages.indexOf(view);
    const [from, to] = a < b ? [a, b] : [b, a];
    for (let i = from; i <= to; i++) setSelected(state.pages[i], true);
  } else {
    setSelected(view, !view.selected);
  }
  state.lastClicked = view;
  updateUi();
}

function setSelected(view, selected) {
  view.selected = selected;
  view.el.classList.toggle("selected", selected);
  view.el.setAttribute("aria-selected", String(selected));
}

function setAllSelected(selected) {
  for (const view of state.pages) setSelected(view, selected);
  updateUi();
}

function updateUi() {
  const total = state.pages.length;
  const chosen = state.pages.filter((p) => p.selected).length;
  els.welcome.hidden = total > 0;
  els.selectAll.disabled = !total || state.busy;
  els.selectNone.disabled = !chosen || state.busy;
  els.saveBtn.disabled = !total || state.busy;
  els.fileInput.disabled = state.busy;
  els.count.textContent = total ? (chosen ? `${chosen}/${total}ページ選択中` : `全${total}ページ`) : "";
  els.saveBtn.innerHTML = `<svg class="i" aria-hidden="true"><use href="#i-save"/></svg>${chosen ? `選んだ${chosen}ページを保存` : "全ページを保存"}`;
}

/* ---------- making images ---------- */

function settings() {
  const type = els.format.value === "jpeg" ? "image/jpeg" : "image/png";
  return { type, ext: type === "image/jpeg" ? "jpg" : "png", dpi: Number(els.dpi.value) };
}

async function pageCanvas(index, dpi) {
  const page = await state.pdf.getPage(index + 1);
  let scale = dpi / 72;
  const base = page.getViewport({ scale: 1 });
  const pixels = base.width * base.height * scale * scale;
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
  const canvas = await renderPage(page, scale);
  page.cleanup();
  return canvas;
}

function pageFileName(index, ext) {
  const digits = String(state.pages.length).length;
  return `${baseName(state.name)}_${String(index + 1).padStart(digits, "0")}.${ext}`;
}

async function withBusy(task) {
  if (state.busy) return;
  state.busy = true;
  updateUi();
  try {
    await task();
  } catch (err) {
    console.error(err);
    showStatus("画像を作れませんでした。画質を下げてもう一度ためしてください", { error: true });
  } finally {
    state.busy = false;
    updateUi();
  }
}

function saveViews(views) {
  return withBusy(async () => {
    const { type, ext, dpi } = settings();
    if (views.length === 1) {
      showStatus("画像を作成中…", { sticky: true });
      const blob = await canvasToBlob(await pageCanvas(views[0].index, dpi), type, JPEG_QUALITY);
      download(blob, pageFileName(views[0].index, ext));
      hideStatus();
      showStatus("画像を保存しました");
      return;
    }
    const files = [];
    for (const [i, view] of views.entries()) {
      showStatus(`画像を作成中…（${i + 1}/${views.length}）`, { sticky: true });
      const blob = await canvasToBlob(await pageCanvas(view.index, dpi), type, JPEG_QUALITY);
      files.push({ name: pageFileName(view.index, ext), bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    download(makeZip(files), `${baseName(state.name)}_画像.zip`);
    hideStatus();
    showStatus(`${views.length}枚の画像をZIPにまとめて保存しました`);
  });
}

function saveSelectedOrAll() {
  const chosen = state.pages.filter((p) => p.selected);
  return saveViews(chosen.length ? chosen : state.pages);
}

function copyPage(view) {
  return withBusy(async () => {
    showStatus("コピー中…", { sticky: true });
    // The clipboard only takes PNG.
    const png = pageCanvas(view.index, Number(els.dpi.value)).then((canvas) => canvasToBlob(canvas, "image/png"));
    const copied = await copyImage(png);
    hideStatus();
    if (copied) showStatus(`${view.index + 1}ページをコピーしました。Ctrl+V で貼り付けできます`);
    else showStatus("コピーできませんでした。保存ボタンで保存してください", { error: true });
  });
}

/* ---------- wiring ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.selectAll.addEventListener("click", () => setAllSelected(true));
els.selectNone.addEventListener("click", () => setAllSelected(false));
els.saveBtn.addEventListener("click", saveSelectedOrAll);
addNextTool({ saveBtn: els.saveBtn, save: saveSelectedOrAll, kind: "image" });

// Remember the chosen format and quality.
for (const select of [els.format, els.dpi]) {
  const key = `pdf-image.${select.id}`;
  const saved = loadText(key);
  if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;
  select.addEventListener("change", () => saveText(key, select.value));
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "a" && state.pages.length && !e.target.closest("input, textarea, select")) {
    e.preventDefault();
    setAllSelected(true);
  } else if (e.key === "Escape") {
    setAllSelected(false);
  }
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
window.__pdfImage = { state, openFile, pageCanvas, makeZip };
