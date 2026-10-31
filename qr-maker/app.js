import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { makeZip } from "../shared/js/zip.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";
import { addNextTool } from "../shared/js/handoff.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { copyImage, copyText } from "../shared/js/clipboard.js";
import qrcode from "../shared/vendor/qrcode-generator-2.0.4/qrcode.mjs";

// Never change a key (or the shape of what is saved) once the tool is in use. Add a new key instead.
const SETTINGS_KEY = "qr-maker-settings-v1"; // { text, caption, ecc, size }
const QUIET = 4; // white border around the code, in modules (the standard asks for 4)
const MAX_BATCH = 200; // codes made at once from "まとめて作る"
const BATCH_PX = 600; // each code's picture for the PDF and the ZIP
const A4 = [595.28, 841.89]; // points
const PAGE_MARGIN = 28; // points
const SCAN_MS = 250; // how often the camera picture is checked for a code

// Byte mode with UTF-8, so Japanese text works; phones' camera apps read it as UTF-8.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"),
  caption: $("caption"),
  ecc: $("ecc"),
  size: $("size"),
  preview: $("preview"),
  info: $("info"),
  saveBtn: $("save-btn"),
  copyBtn: $("copy-btn"),
};

const saved = loadJson(SETTINGS_KEY, {});
els.text.value = typeof saved.text === "string" ? saved.text : "";
els.caption.value = typeof saved.caption === "string" ? saved.caption : "";
if (["L", "M", "Q", "H"].includes(saved.ecc)) els.ecc.value = saved.ecc;
if (["256", "512", "1024"].includes(String(saved.size))) els.size.value = String(saved.size);

// The QR code for `text`, or null when it is too long to fit in one.
function makeCode(text, ecc) {
  try {
    const qr = qrcode(0, ecc); // 0: the smallest version that fits
    qr.addData(text, "Byte");
    qr.make();
    return qr;
  } catch {
    return null;
  }
}

// Draws the code (and the caption under it) black on white, about `size` pixels wide.
function draw(canvas, qr, size, caption) {
  const n = qr.getModuleCount();
  const cell = Math.max(2, Math.floor(size / (n + QUIET * 2)));
  const width = cell * (n + QUIET * 2);
  const fontSize = Math.round(width / 14);
  const captionHeight = caption ? Math.round(fontSize * 1.6) : 0;
  canvas.width = width;
  canvas.height = width + captionHeight;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + QUIET) * cell, (r + QUIET) * cell, cell, cell);
    }
  }
  if (caption) {
    ctx.font = `600 ${fontSize}px system-ui, "Noto Sans JP", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Sits in the bottom quiet zone and the strip below it, shrunk to fit the width.
    const maxWidth = width - cell * 2;
    const scale = Math.min(1, maxWidth / ctx.measureText(caption).width);
    ctx.font = `600 ${Math.floor(fontSize * scale)}px system-ui, "Noto Sans JP", sans-serif`;
    ctx.fillText(caption, width / 2, width - cell * QUIET / 2 + captionHeight / 2);
  }
}

let current = null; // the QR code shown now

function update() {
  const text = els.text.value;
  const caption = els.caption.value.trim();
  saveJson(SETTINGS_KEY, { text, caption, ecc: els.ecc.value, size: Number(els.size.value) });
  current = text ? makeCode(text, els.ecc.value) : null;
  els.saveBtn.disabled = els.copyBtn.disabled = !current;
  els.preview.classList.toggle("empty", !current);
  els.info.classList.toggle("error", !!text && !current);
  if (!text) {
    els.info.textContent = "左にURLや文字を入れると、ここにQRコードができます。";
    return;
  }
  if (!current) {
    els.info.textContent = "長すぎてQRコードに入りません。文字を減らすか、「読み取りやすさ」を下げてください";
    return;
  }
  draw(els.preview, current, Number(els.size.value), caption);
  const n = current.getModuleCount();
  els.info.textContent = `${new TextEncoder().encode(text).length}バイト・${n}×${n}マス。スマートフォンのカメラで読み取れるか確かめてから配ってください。`;
}

const toBlob = () => canvasToBlob(els.preview, "image/png");

async function save() {
  if (!current) return;
  const caption = els.caption.value.trim().replace(/[\\/:*?"<>|]/g, "_");
  download(await toBlob(), `${caption || "QRコード"}.png`);
  showStatus("PNG画像を保存しました");
}

async function copy() {
  if (!current) return;
  if (await copyImage(toBlob())) showStatus("コピーしました。ドキュメントやスライドに Ctrl+V で貼り付けられます");
  else showStatus("コピーできませんでした。「PNGで保存」を使ってください", { error: true });
}

for (const el of [els.text, els.caption]) el.addEventListener("input", update);
for (const el of [els.ecc, els.size]) el.addEventListener("change", update);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: "image" });
els.copyBtn.addEventListener("click", copy);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});

/* ---------- tabs ---------- */

function showPane(name) {
  for (const tab of document.querySelectorAll(".tab")) tab.setAttribute("aria-selected", tab.dataset.pane === name);
  for (const pane of ["make", "batch", "read"]) $(`${pane}-pane`).hidden = pane !== name;
  $("make-actions").hidden = name !== "make";
  if (name !== "read") stopCamera();
}
for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showPane(tab.dataset.pane));

/* ---------- まとめて作る ---------- */

// One code per line. A line pasted from two spreadsheet columns ("1組<TAB>https://…") puts the
// first column under the code.
function batchEntries() {
  return $("batch-text").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, MAX_BATCH)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab > 0 ? { caption: line.slice(0, tab).trim(), text: line.slice(tab + 1).trim() } : { caption: "", text: line };
    })
    .filter((e) => e.text);
}

let batch = []; // { caption, text, qr (null when too long), canvas }

function updateBatch() {
  const ecc = $("batch-ecc").value;
  batch = batchEntries().map((e) => ({ ...e, qr: makeCode(e.text, ecc) }));
  const list = $("batch-list");
  list.replaceChildren(...batch.map((e) => {
    if (!e.qr) {
      const bad = document.createElement("div");
      bad.className = "bad";
      bad.textContent = `長すぎて入りません: ${e.caption || e.text.slice(0, 20)}`;
      return bad;
    }
    e.canvas = document.createElement("canvas");
    draw(e.canvas, e.qr, BATCH_PX, e.caption);
    e.canvas.title = e.text;
    return e.canvas;
  }));
  const good = batch.filter((e) => e.qr);
  const bad = batch.length - good.length;
  $("batch-pdf").disabled = $("batch-zip").disabled = !good.length;
  const info = $("batch-info");
  info.classList.toggle("error", bad > 0);
  info.textContent = !batch.length
    ? "左に1行に1つずつ入れると、ここに並びます。"
    : `${good.length}こ作りました${bad ? `（${bad}こは長すぎて入りません）` : ""}。`;
}

const fileSafe = (name) => name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);

async function saveBatchZip() {
  const good = batch.filter((e) => e.qr);
  if (!good.length) return;
  const files = [];
  for (const [i, e] of good.entries()) {
    const blob = await canvasToBlob(e.canvas, "image/png");
    files.push({ name: `${String(i + 1).padStart(3, "0")}_${fileSafe(e.caption || "QRコード")}.png`, bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  download(makeZip(files), `QRコード_${good.length}こ.zip`);
  showStatus("ZIPで保存しました");
}

// The codes in a grid on A4 pages, with light lines to cut along.
async function batchPdf() {
  const { PDFDocument, rgb } = await loadPdfLib();
  const good = batch.filter((e) => e.qr);
  const [cols, rows] = $("batch-grid").value.split("x").map(Number);
  const doc = await PDFDocument.create();
  const cellW = (A4[0] - PAGE_MARGIN * 2) / cols;
  const cellH = (A4[1] - PAGE_MARGIN * 2) / rows;
  let page = null;
  for (const [i, e] of good.entries()) {
    const k = i % (cols * rows);
    if (k === 0) page = doc.addPage(A4);
    const image = await doc.embedPng(await (await canvasToBlob(e.canvas, "image/png")).arrayBuffer());
    const x = PAGE_MARGIN + (k % cols) * cellW;
    const y = A4[1] - PAGE_MARGIN - (Math.floor(k / cols) + 1) * cellH;
    page.drawRectangle({ x, y, width: cellW, height: cellH, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5, borderDashArray: [3, 3] });
    const scale = Math.min((cellW - 12) / image.width, (cellH - 12) / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    page.drawImage(image, { x: x + (cellW - w) / 2, y: y + (cellH - h) / 2, width: w, height: h });
  }
  return doc.save();
}

async function saveBatchPdf() {
  if (!batch.some((e) => e.qr)) return;
  showStatus("PDFを作成中…", { sticky: true });
  try {
    const bytes = await batchPdf();
    download(new Blob([bytes], { type: "application/pdf" }), `QRコード_${batch.filter((e) => e.qr).length}こ.pdf`);
    showStatus("印刷用のPDFを保存しました");
  } catch (err) {
    console.error(err);
    showStatus("PDFを作れませんでした", { error: true });
  }
}

$("batch-text").addEventListener("input", updateBatch);
$("batch-ecc").addEventListener("change", updateBatch);
$("batch-pdf").addEventListener("click", saveBatchPdf);
$("batch-zip").addEventListener("click", saveBatchZip);

/* ---------- 読み取る ---------- */

// BarcodeDetector is built into Chrome on Chromebooks, Android and Mac; elsewhere there is no
// reader, and the tool only says so (no library is added for it).
const canRead = "BarcodeDetector" in window;
let detector = null;
async function getDetector() {
  detector ||= new window.BarcodeDetector({ formats: ["qr_code"] });
  return detector;
}

function showRead(text) {
  $("read-result").hidden = false;
  $("read-text").textContent = text;
  const open = $("read-open");
  const isUrl = /^https?:\/\/\S+$/i.test(text.trim());
  open.hidden = !isUrl;
  if (isUrl) open.href = text.trim();
}

// Reads the first QR code in an image file (or a pasted screenshot).
async function readImage(file) {
  if (!canRead) return;
  showPane("read");
  try {
    const bitmap = await createImageBitmap(file);
    const codes = await (await getDetector()).detect(bitmap);
    bitmap.close();
    if (codes.length) {
      showRead(codes[0].rawValue);
      showStatus("読み取りました");
    } else {
      showStatus("QRコードが見つかりませんでした。もっと大きく、はっきり写った画像で試してください", { error: true, ms: 5000 });
    }
  } catch (err) {
    console.error(err);
    showStatus("この画像は読み取れませんでした", { error: true });
  }
}

let stream = null;
let scanTimer = 0;

async function startCamera() {
  if (!canRead || stream) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch {
    showStatus("カメラを使えませんでした。ブラウザのカメラの許可を確かめてください", { error: true, ms: 5000 });
    return;
  }
  const video = $("camera");
  video.srcObject = stream;
  video.hidden = false;
  await video.play().catch(() => {});
  $("camera-btn").textContent = "カメラを止める";
  const scan = async () => {
    if (!stream) return;
    try {
      const codes = video.readyState >= 2 ? await (await getDetector()).detect(video) : [];
      if (codes.length) {
        showRead(codes[0].rawValue);
        showStatus("読み取りました");
        stopCamera();
        return;
      }
    } catch { /* try the next picture */ }
    scanTimer = setTimeout(scan, SCAN_MS);
  };
  scan();
}

function stopCamera() {
  clearTimeout(scanTimer);
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
  $("camera").hidden = true;
  $("camera").srcObject = null;
  $("camera-btn").innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-camera"/></svg>カメラで読む';
}

$("read-unsupported").hidden = canRead;
$("read-actions").hidden = !canRead;
$("camera-btn").addEventListener("click", () => (stream ? stopCamera() : startCamera()));
$("read-file").addEventListener("change", () => {
  const file = $("read-file").files[0];
  if (file) readImage(file);
  $("read-file").value = "";
});
$("read-copy").addEventListener("click", async () => {
  if (await copyText($("read-text").textContent)) showStatus("コピーしました");
});
onFileDrop((files) => {
  const image = files.find((f) => f.type.startsWith("image/"));
  if (image && canRead) readImage(image);
  else showStatus(canRead ? "画像ファイルをドロップしてください" : "この端末では読み取れません", { error: true });
});
document.addEventListener("paste", (e) => {
  if (e.target.closest("textarea, input")) return;
  const file = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"))?.getAsFile();
  if (file && canRead) {
    e.preventDefault();
    readImage(file);
  }
});
document.addEventListener("visibilitychange", () => document.hidden && stopCamera());

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/qrcode-generator-2.0.4/qrcode.mjs",
  "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js",
]);

update();

// Hook for automated tests.
window.__qrMaker = { update, makeCode, readImage, batchPdf, get current() { return current; }, get batch() { return batch; } };
