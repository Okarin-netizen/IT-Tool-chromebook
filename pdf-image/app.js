import { pdfjsLib, openPdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, download, onFileDrop } from "../shared/js/files.js";
import { loadText, saveText } from "../shared/js/storage.js";
import { makeZip } from "../shared/js/zip.js";
import { registerOffline } from "../shared/js/offline.js";

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
    const task = openPdf(new Uint8Array(await file.arrayBuffer()));
    task.onPassword = (update, reason) => {
      const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const password = prompt(retry ? "パスワードがちがいます。もう一度入力してください" : "このPDFはパスワードで保護されています。パスワードを入力してください");
      if (password === null) task.destroy();
      else update(password);
    };
    pdf = await task.promise;
  } catch (err) {
    console.error(err);
    showStatus(err?.name === "PasswordException" ? "パスワードが必要なPDFは開けませんでした" : "PDFを読み込めませんでした", { error: true });
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
  for (const view of state.pages) thumbObserver.unobserve(view.el);
  els.grid.replaceChildren();
  state.pages = [];
  state.lastClicked = null;
  state.pdf?.destroy();
  state.pdf = null;
}

/* ---------- page cards ---------- */

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const view = state.pages.find((p) => p.el === entry.target);
    if (view && !view.rendered) renderThumb(view);
  }
}, { root: els.viewer, rootMargin: "400px" });

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
  thumbObserver.observe(li);
}

async function renderThumb(view) {
  view.rendered = true;
  const pdf = state.pdf;
  try {
    const page = await pdf.getPage(view.index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = (THUMB_PX / Math.max(base.width, base.height)) * (window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    const viewport = page.getViewport({ scale });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (pdf !== state.pdf) return; // another PDF was opened meanwhile
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

async function renderPage(index, dpi) {
  const page = await state.pdf.getPage(index + 1);
  let scale = dpi / 72;
  const base = page.getViewport({ scale: 1 });
  const pixels = base.width * base.height * scale * scale;
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // JPG has no transparency; keep the paper white either way
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas;
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), type, JPEG_QUALITY);
  });
}

function baseName(name) {
  return name.replace(/\.pdf$/i, "") || "document";
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
      const blob = await canvasToBlob(await renderPage(views[0].index, dpi), type);
      download(blob, pageFileName(views[0].index, ext));
      hideStatus();
      showStatus("画像を保存しました");
      return;
    }
    const files = [];
    for (const [i, view] of views.entries()) {
      showStatus(`画像を作成中…（${i + 1}/${views.length}）`, { sticky: true });
      const blob = await canvasToBlob(await renderPage(view.index, dpi), type);
      files.push({ name: pageFileName(view.index, ext), bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
    download(makeZip(files), `${baseName(state.name)}_画像.zip`);
    hideStatus();
    showStatus(`${views.length}枚の画像をZIPにまとめて保存しました`);
  });
}

function saveSelectedOrAll() {
  const chosen = state.pages.filter((p) => p.selected);
  saveViews(chosen.length ? chosen : state.pages);
}

function copyPage(view) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    showStatus("このブラウザではコピーできません。保存ボタンで保存してください", { error: true });
    return;
  }
  return withBusy(async () => {
    showStatus("コピー中…", { sticky: true });
    // The clipboard only takes PNG. Pass a promise so the write starts while the click still counts as a user gesture.
    const blob = renderPage(view.index, Number(els.dpi.value)).then((canvas) => canvasToBlob(canvas, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    hideStatus();
    showStatus(`${view.index + 1}ページをコピーしました。Ctrl+V で貼り付けできます`);
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
window.__pdfImage = { state, openFile, renderPage, makeZip };
