import * as pdfjsLib from "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs";
import { registerOffline } from "../shared/js/offline.js";

const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFStream, decodePDFRawStream } = window.PDFLib;

const asset = (path) => new URL(path, location.href).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = asset("../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs");

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
const MIN_IMAGE_BYTES = 8 * 1024; // smaller images aren't worth re-encoding
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
  status: $("status"),
  dropOverlay: $("drop-overlay"),
};
const methodInputs = [...document.querySelectorAll('input[name="method"]')];
const levelInputs = [...document.querySelectorAll('input[name="level"]')];

const state = {
  file: null, // { name, bytes, pdf (pdf.js), encrypted }
  result: null, // { bytes, pdf (pdf.js), smaller }
  previewPage: 1,
  busy: false,
};

/* ---------- status messages ---------- */

let statusTimer = 0;
function showStatus(text, { error = false, sticky = false, ms = error ? 6000 : 2500 } = {}) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle("error", error);
  els.status.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => (els.status.hidden = true), ms);
}
function hideStatus() {
  clearTimeout(statusTimer);
  els.status.hidden = true;
}

function formatSize(bytes) {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 2 : 1)} MB`;
}

const baseName = (name) => name.replace(/\.pdf$/i, "");

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  if (state.busy) return;
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await loadPdfJs(bytes);
    // pdf-lib can't decrypt, so a protected PDF can only be shrunk by rendering its pages.
    const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    await state.file?.pdf.destroy();
    clearResult();
    state.file = { name: file.name || "document.pdf", bytes, pdf, encrypted: probe.isEncrypted };
  } catch (err) {
    console.error(err);
    showStatus(err?.name === "PasswordException" ? "開くのにパスワードが必要なPDFは使えません" : "PDFを読み込めませんでした", { error: true });
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

function loadPdfJs(bytes) {
  return pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js detaches the buffer it is given
    cMapUrl: asset("../shared/vendor/pdfjs-4.10.38/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("../shared/vendor/pdfjs-4.10.38/standard_fonts/"),
  }).promise;
}

/* ---------- method 1: re-encode the embedded images ---------- */

const N = (name) => PDFName.of(name);
const DECODABLE = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);

async function compressImages(bytes, level, onProgress) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;

  const images = [];
  const masks = new Set(); // soft masks hold transparency, which JPEG would smear
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(N("Subtype")) !== N("Image")) continue;
    images.push([ref, obj]);
    for (const key of ["SMask", "Mask"]) {
      const mask = obj.dict.get(N(key));
      if (mask instanceof PDFRef) masks.add(mask.tag);
    }
  }

  const targets = images.filter(([ref]) => !masks.has(ref.tag));
  let replaced = 0;
  for (const [i, [ref, obj]] of targets.entries()) {
    onProgress(i + 1, targets.length);
    try {
      const jpeg = await reencodeImage(obj, level);
      if (!jpeg) continue;
      const dict = obj.dict.clone(ctx);
      dict.set(N("Width"), ctx.obj(jpeg.width));
      dict.set(N("Height"), ctx.obj(jpeg.height));
      dict.set(N("ColorSpace"), N("DeviceRGB"));
      dict.set(N("BitsPerComponent"), ctx.obj(8));
      dict.set(N("Filter"), N("DCTDecode"));
      dict.delete(N("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(dict, jpeg.bytes));
      replaced++;
    } catch (err) {
      console.warn("skipped an image", err); // leave anything unusual untouched
    }
  }

  removeUnusedObjects(doc);
  return { bytes: await doc.save({ useObjectStreams: true }), replaced, images: targets.length };
}

// Returns { bytes, width, height } of a smaller JPEG, or null when the image is left as it is.
async function reencodeImage(stream, { maxPx, quality }) {
  const dict = stream.dict;
  const original = stream.getContents();
  if (original.length < MIN_IMAGE_BYTES) return null;
  if (String(dict.lookup(N("ImageMask"))) === "true") return null;
  if (dict.has(N("Decode")) || dict.lookup(N("Mask")) instanceof PDFArray) return null;
  if (numberOf(dict, "BitsPerComponent") !== 8) return null;
  const width = numberOf(dict, "Width");
  const height = numberOf(dict, "Height");
  const comps = colorComponents(dict.lookup(N("ColorSpace")));
  if (!width || !height || !comps) return null;

  const filters = filterNames(dict.lookup(N("Filter")));
  let source;
  if (filters.length === 1 && filters[0] === "DCTDecode") {
    source = new Blob([stripExif(original)], { type: "image/jpeg" });
  } else if (filters.every((f) => DECODABLE.has(f))) {
    let raw = filters.length ? decodePDFRawStream(stream).decode() : original;
    const predictor = numberOf(decodeParms(dict), "Predictor") || 1;
    if (predictor >= 10) raw = unPng(raw, width * comps, comps);
    else if (predictor !== 1) return null;
    if (!raw || raw.length < width * height * comps) return null;
    source = toImageData(raw, width, height, comps);
  } else {
    return null; // JBIG2, CCITT, JPEG 2000 … are already compact
  }

  const scale = Math.min(1, maxPx / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > original.length * 0.9) return null;
  return { bytes, width: w, height: h };
}

function numberOf(dict, key) {
  const value = dict?.lookup(N(key));
  return typeof value?.asNumber === "function" ? value.asNumber() : 0;
}

function decodeParms(dict) {
  const parms = dict.lookup(N("DecodeParms"));
  if (parms instanceof PDFArray) return parms.size() ? dict.context.lookup(parms.get(0)) : null;
  return parms instanceof PDFDict ? parms : null;
}

function filterNames(filter) {
  if (!filter) return [];
  if (filter instanceof PDFArray) return filter.asArray().map((f) => String(f).slice(1));
  return [String(filter).slice(1)];
}

// 1 for gray, 3 for RGB; null for anything that needs more care (CMYK, indexed, Lab…).
function colorComponents(cs) {
  if (!cs) return null;
  if (cs instanceof PDFName) {
    const name = String(cs).slice(1);
    return name === "DeviceGray" || name === "CalGray" ? 1 : name === "DeviceRGB" || name === "CalRGB" ? 3 : null;
  }
  if (cs instanceof PDFArray && cs.size()) {
    const kind = String(cs.lookup(0)).slice(1);
    if (kind === "CalGray") return 1;
    if (kind === "CalRGB") return 3;
    if (kind === "ICCBased") {
      const profile = cs.lookup(1);
      const n = profile instanceof PDFStream ? numberOf(profile.dict, "N") : 0;
      return n === 1 || n === 3 ? n : null;
    }
  }
  return null;
}

// Undo PNG row filters (PDF predictors 10–15).
function unPng(data, rowBytes, bpp) {
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y++) {
    const type = data[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[dst - rowBytes + x] : 0;
      const c = x >= bpp && y ? out[dst - rowBytes + x - bpp] : 0;
      let v = data[src + x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (type !== 0) return null;
      out[dst + x] = v;
    }
  }
  return out;
}

function toImageData(raw, width, height, comps) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += comps) {
    rgba[i * 4] = raw[j];
    rgba[i * 4 + 1] = raw[j + (comps === 3 ? 1 : 0)];
    rgba[i * 4 + 2] = raw[j + (comps === 3 ? 2 : 0)];
    rgba[i * 4 + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

// PDF viewers ignore EXIF rotation inside a JPEG but the browser applies it, so drop the EXIF block.
function stripExif(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const parts = [jpeg.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1];
    if (marker === 0xda || marker < 0xe0 || marker > 0xef) break; // stop at the first non-APPn segment
    const len = (jpeg[pos + 2] << 8) | jpeg[pos + 3];
    if (marker !== 0xe1) parts.push(jpeg.subarray(pos, pos + 2 + len));
    pos += 2 + len;
  }
  parts.push(jpeg.subarray(pos));
  return new Blob(parts);
}

// Drop objects nothing points to (leftovers from earlier edits of the PDF).
function removeUnusedObjects(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt, ctx.trailerInfo.ID];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) continue;
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue;
      seen.add(obj.tag);
      stack.push(ctx.lookup(obj));
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) ctx.delete(ref);
  }
}

/* ---------- method 2: render every page to a JPEG ---------- */

async function rasterize(pdf, { dpi, quality }, onProgress) {
  const out = await PDFDocument.create();
  for (let n = 1; n <= pdf.numPages; n++) {
    onProgress(n, pdf.numPages);
    const page = await pdf.getPage(n);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    const image = await out.embedJpg(await blob.arrayBuffer());
    out.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    page.cleanup();
    canvas.width = canvas.height = 0;
  }
  return { bytes: await out.save({ useObjectStreams: true }) };
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

  state.result = { bytes: out.bytes, pdf: await loadPdfJs(out.bytes), smaller };
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
  const dpr = window.devicePixelRatio || 1;
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
  const url = URL.createObjectURL(new Blob([state.result.bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName(state.file.name)}_圧縮.pdf`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  showStatus("保存しました");
}

/* ---------- wiring ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.compressBtn.addEventListener("click", compress);
els.saveBtn.addEventListener("click", save);
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
let dragDepth = 0;
const isFileDrag = (e) => [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropOverlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!isFileDrag(e)) return;
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  openFile(e.dataTransfer.files[0]);
});

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
window.__pdfCompress = { state, openFile, compress, compressImages, rasterize };
