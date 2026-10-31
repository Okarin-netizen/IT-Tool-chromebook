import { pdfjsLib, openPdf, openPdfError, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, formatSize, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";
import { pixelRatio } from "../shared/js/canvas.js";

// "画像だけ軽くする": embedded images are shrunk to maxPx on their longest side and re-saved as JPEG.
const IMAGE_LEVELS = [
  { maxPx: 2200, quality: 0.8 },
  { maxPx: 1600, quality: 0.7 },
  { maxPx: 1100, quality: 0.55 },
  { maxPx: 800, quality: 0.45 }, // only tried when aiming for a target size
];
// "ページ全体を画像にする": every page is rendered at this resolution and saved as a JPEG.
const RASTER_LEVELS = [
  { dpi: 150, quality: 0.75 },
  { dpi: 110, quality: 0.65 },
  { dpi: 80, quality: 0.5 },
  { dpi: 60, quality: 0.4 }, // only tried when aiming for a target size
];
const MB = 1000 * 1000; // submission forms count in decimal megabytes

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  welcome: $("welcome"),
  work: $("work"),
  fileName: $("file-name"),
  fileInfo: $("file-info"),
  targetRow: $("target-row"),
  targetMb: $("target-mb"),
  compressBtn: $("compress-btn"),
  result: $("result"),
  sizeBefore: $("size-before"),
  sizeAfter: $("size-after"),
  sizeRate: $("size-rate"),
  resultNote: $("result-note"),
  previewLabel: $("preview-label"),
  prevPage: $("prev-page"),
  nextPage: $("next-page"),
  preview: $("preview"),
  saveBtn: $("save-btn"),
};
const methodInputs = [...document.querySelectorAll('input[name="method"]')];
const levelInputs = [...document.querySelectorAll('input[name="level"]')];

const state = {
  file: null, // { name, bytes, pdf (pdf.js), encrypted }
  result: null, // { bytes, pdf (pdf.js), smaller }
  previewPage: 1,
  busy: false,
};

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (!isPdf(file)) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  if (state.busy) return;
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const { PDFDocument } = await loadPdfLib();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(bytes.slice(), { name: file.name }).promise;
    // pdf-lib can't decrypt, so a protected PDF can only be shrunk by rendering its pages.
    const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    await state.file?.pdf.destroy();
    clearResult();
    state.file = { name: file.name || "document.pdf", bytes, pdf, encrypted: probe.isEncrypted };
  } catch (err) {
    console.error(err);
    showStatus(openPdfError(err), { error: true });
    return;
  }

  const { name, bytes, pdf, encrypted } = state.file;
  els.fileName.textContent = name;
  els.fileInfo.textContent = `${pdf.numPages}ページ ・ ${formatSize(bytes.length)}`;
  const imagesInput = methodInputs.find((i) => i.value === "images");
  imagesInput.disabled = encrypted;
  imagesInput.closest(".option").title = encrypted ? "保護（編集制限）がかかったPDFでは使えません" : "";
  methodInputs.find((i) => i.value === (encrypted ? "raster" : "images")).checked = true;
  els.welcome.hidden = true;
  els.work.hidden = false;
  if (encrypted) {
    showStatus("保護されたPDFなので「ページ全体を画像にする」で圧縮します", { ms: 6000 });
  } else {
    hideStatus();
  }
}

/* ---------- the two ways to compress ---------- */

// "画像だけ軽くする" lives in images.js, which needs pdf-lib; it is imported on first use.
async function compressImages(bytes, level, onProgress) {
  const images = await import("./images.js");
  return images.compressImages(bytes, level, onProgress);
}

// "ページ全体を画像にする": every page becomes one JPEG. Form fields are drawn with what was typed in.
async function rasterize(pdf, { dpi, quality }, onProgress) {
  const doc = await rasterizePdf(pdf, {
    scale: dpi / 72,
    quality,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
    onPage: onProgress,
  });
  return { bytes: await doc.save({ useObjectStreams: true }) };
}

/* ---------- compressing ---------- */

async function compress() {
  if (!state.file || state.busy) return;
  const method = methodInputs.find((i) => i.checked).value;
  const levelValue = levelInputs.find((i) => i.checked).value;
  const levels = method === "images" ? IMAGE_LEVELS : RASTER_LEVELS;
  const target = levelValue === "target" ? parseFloat(els.targetMb.value) * MB : null;
  if (target !== null && !(target > 0)) {
    showStatus("目標のサイズを数字で入れてください", { error: true });
    els.targetMb.focus();
    return;
  }
  const tries = target !== null ? levels : [levels[Number(levelValue)]];

  setBusy(true);
  clearResult();
  const { bytes, pdf } = state.file;
  let best = null;
  try {
    for (const [t, level] of tries.entries()) {
      const prefix = tries.length > 1 ? `${t + 1}回目: ` : "";
      const progress = (i, n) => showStatus(
        `${prefix}${method === "images" ? "画像" : "ページ"}を圧縮中…（${i}/${n}）`, { sticky: true },
      );
      const out = method === "images" ? await compressImages(bytes, level, progress) : await rasterize(pdf, level, progress);
      if (!best || out.bytes.length < best.bytes.length) best = out;
      if (target !== null && out.bytes.length <= target) break;
    }
    await showResult(best, { method, target });
    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus("圧縮できませんでした。「ページ全体を画像にする」も試してみてください", { error: true, ms: 8000 });
  } finally {
    setBusy(false);
  }
}

async function showResult(out, { method, target }) {
  const before = state.file.bytes.length;
  const after = out.bytes.length;
  const smaller = after < before;
  els.sizeBefore.textContent = formatSize(before);
  els.sizeAfter.textContent = formatSize(after);
  els.sizeRate.textContent = smaller ? `${Math.round((1 - after / before) * 100)}% 小さくなりました` : "小さくなりませんでした";
  els.sizeRate.classList.toggle("bad", !smaller);

  const notes = [];
  let warn = false;
  if (!smaller) {
    warn = true;
    notes.push(method === "images" && !out.replaced
      ? "このPDFには小さくできる写真やスキャン画像がありませんでした。もとのファイルをそのまま使ってください。"
      : "もとのファイルのほうが小さいので、そのまま使ってください。");
  } else if (target !== null && after > target) {
    warn = true;
    notes.push(`目標の ${formatSize(target)} 以下にはできませんでした（いちばん小さくてこのサイズです）。`);
    if (method === "images") notes.push("「ページ全体を画像にする」を選ぶと、もっと小さくなるかもしれません。");
  } else if (method === "images") {
    notes.push(out.replaced ? `${out.replaced}枚の画像を小さくしました。文字はそのままです。` : "画像はそのままで、PDFの中の不要なデータを整理しました。");
  } else {
    notes.push("ページを画像にしました。文字の選択・検索はできません。");
  }
  els.resultNote.textContent = notes.join(" ");
  els.resultNote.classList.toggle("warn", warn);

  state.result = { bytes: out.bytes, pdf: await openPdf(out.bytes.slice()).promise, smaller };
  state.previewPage = 1;
  els.result.hidden = false;
  await renderPreview();
  els.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearResult() {
  state.result?.pdf.destroy();
  state.result = null;
  els.result.hidden = true;
}

let previewTask = null;
async function renderPreview() {
  const { pdf } = state.result;
  const n = state.previewPage;
  els.previewLabel.textContent = `${n} / ${pdf.numPages} ページ`;
  els.prevPage.disabled = n <= 1;
  els.nextPage.disabled = n >= pdf.numPages;
  previewTask?.cancel();
  const page = await pdf.getPage(n);
  const width = Math.min(els.preview.parentElement.clientWidth - 20, 800);
  const base = page.getViewport({ scale: 1 });
  const dpr = pixelRatio();
  const viewport = page.getViewport({ scale: (width / base.width) * dpr });
  const canvas = els.preview;
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${Math.round(viewport.width / dpr)}px`;
  previewTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  try {
    await previewTask.promise;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") throw err;
  }
}

function setBusy(busy) {
  state.busy = busy;
  els.compressBtn.disabled = busy;
  els.saveBtn.disabled = busy || !state.result?.smaller;
  els.fileInput.disabled = busy;
}

function save() {
  if (!state.result?.smaller) return;
  download(new Blob([state.result.bytes], { type: "application/pdf" }), `${baseName(state.file.name)}_圧縮.pdf`);
  showStatus("保存しました");
}

/* ---------- wiring ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.compressBtn.addEventListener("click", compress);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save: save, kind: "pdf" });
els.prevPage.addEventListener("click", () => {
  state.previewPage--;
  renderPreview();
});
els.nextPage.addEventListener("click", () => {
  state.previewPage++;
  renderPreview();
});
for (const input of [...methodInputs, ...levelInputs]) {
  input.addEventListener("change", () => {
    els.targetRow.hidden = levelInputs.find((i) => i.checked).value !== "target";
    if (!state.busy) clearResult(); // the shown result no longer matches the settings
  });
}
els.targetMb.addEventListener("input", () => !state.busy && clearResult());

// Drag & drop a PDF anywhere on the page.
onFileDrop((files) => openFile(files[0]));

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "images.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js",
  "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs",
  "../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs",
]);

// Hook for automated tests.
window.__pdfCompress = { state, openFile, compress, compressImages, rasterize };
