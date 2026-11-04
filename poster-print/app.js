import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { isImage } from "../shared/js/heic.js";
import { loadPhoto, stripExtension, makeCanvas } from "../shared/js/photo.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import "../shared/js/guide.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "poster-print-settings-v1";
const PAPERS = { A4: [210, 297], A3: [297, 420], B4: [257, 364], B5: [182, 257] }; // mm, portrait
const MARGIN = 10; // mm of white around each sheet: printers cannot print to the edge, and it takes the glue
const MAX_SHEETS = 64;
const SHRINK_TO_SAVE_ROW = 0.85; // the poster may shrink to this much of its width to save a row of sheets
const PX_PER_MM_MAX = 6; // ≈150 dpi: sharper than this adds size, not detail
const PX_PER_MM_MIN = 2;
const JPEG_QUALITY = 0.9;
const PT_PER_MM = 72 / 25.4;
const PREVIEW_PX = 1000;
const FONT = 'system-ui, "Noto Sans JP", sans-serif';

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  paper: $("paper"),
  across: $("across"),
  marks: $("marks"),
  summary: $("summary"),
  preview: $("preview"),
  info: $("info"),
};

const settings = Object.assign({ paper: "A4", orientation: "auto", across: 2, overlap: 10, marks: true }, loadJson(SETTINGS_KEY, {}));
const state = {
  file: null,
  bitmap: null,
};

/* ---------- opening ---------- */

async function openFile(file) {
  if (!file) return;
  if (!isImage(file)) return showStatus("写真・画像のファイルを選んでください", { error: true });
  try {
    const bitmap = await loadPhoto(file);
    state.bitmap?.close();
    state.file = file;
    state.bitmap = bitmap;
    render();
  } catch (err) {
    console.error(err);
    showStatus(`${file.name} を開けませんでした`, { error: true });
  }
}

/* ---------- how the picture is cut up ---------- */

// Everything in mm. Each sheet prints a `printWidth`×`printHeight` part of the poster; next to
// each other the parts share `overlap` mm, so they can be lined up by the picture and glued.
function plan() {
  const orientations = settings.orientation === "auto" ? ["portrait", "landscape"] : [settings.orientation];
  const plans = orientations.map((orientation) => planFor(orientation));
  // おまかせ: the way round that needs fewer sheets (and, if the same, gives the bigger poster).
  plans.sort((a, b) => a.across * a.down - b.across * b.down || b.posterWidth - a.posterWidth);
  return plans[0];
}

function planFor(orientation) {
  const [short, long] = PAPERS[settings.paper];
  const portrait = orientation === "portrait";
  const paperWidth = portrait ? short : long;
  const paperHeight = portrait ? long : short;
  const printWidth = paperWidth - MARGIN * 2;
  const printHeight = paperHeight - MARGIN * 2;
  const overlap = settings.overlap;
  const across = settings.across;
  const aspect = state.bitmap.height / state.bitmap.width;
  let posterWidth = across * printWidth - (across - 1) * overlap;
  let posterHeight = posterWidth * aspect;
  let down = Math.max(1, Math.ceil((posterHeight - overlap) / (printHeight - overlap)));
  // When the last row would hold only a thin strip, the poster is made a little smaller instead,
  // which saves a whole row of paper.
  const fewerRowsHeight = (down - 1) * printHeight - (down - 2) * overlap;
  if (down > 1 && fewerRowsHeight / posterHeight >= SHRINK_TO_SAVE_ROW) {
    down -= 1;
    posterHeight = fewerRowsHeight;
    posterWidth = posterHeight / aspect;
  }
  return { orientation, paperWidth, paperHeight, printWidth, printHeight, overlap, across, down, posterWidth, posterHeight };
}

// The part of the poster (mm) printed on the sheet in row `row`, column `column`.
function tileRect(layout, row, column) {
  return {
    x: column * (layout.printWidth - layout.overlap),
    y: row * (layout.printHeight - layout.overlap),
    width: layout.printWidth,
    height: layout.printHeight,
  };
}

/* ---------- preview ---------- */

function render() {
  const has = Boolean(state.bitmap);
  els.welcome.hidden = has;
  els.work.hidden = !has;
  els.saveBtn.disabled = !has;
  syncControls();
  if (!has) return;
  const layout = plan();
  drawPreview(layout);
  const sheets = layout.across * layout.down;
  const paperName = `${settings.paper}${layout.orientation === "portrait" ? "縦" : "横"}`;
  els.summary.textContent = `${paperName} ${sheets}枚（横${layout.across}枚 × 縦${layout.down}枚）`;
  els.info.textContent = `できあがり 約 ${cm(layout.posterWidth)} × ${cm(layout.posterHeight)} cm`;
  els.saveBtn.disabled = sheets > MAX_SHEETS;
  if (sheets > MAX_SHEETS) showStatus(`紙が${MAX_SHEETS}枚をこえます。横の枚数を減らすか、大きな紙にしてください`, { error: true });
}

const cm = (mm) => Math.round(mm / 10);

// The whole picture with each sheet drawn over it, numbered in reading order.
function drawPreview(layout) {
  const fullWidth = layout.across * layout.printWidth - (layout.across - 1) * layout.overlap;
  const fullHeight = layout.down * layout.printHeight - (layout.down - 1) * layout.overlap;
  const k = PREVIEW_PX / Math.max(fullWidth, fullHeight);
  const canvas = els.preview;
  canvas.width = Math.round(fullWidth * k);
  canvas.height = Math.round(fullHeight * k);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.bitmap, 0, 0, layout.posterWidth * k, layout.posterHeight * k);
  for (let row = 0; row < layout.down; row++) {
    for (let column = 0; column < layout.across; column++) {
      const rect = tileRect(layout, row, column);
      ctx.strokeStyle = "rgba(47,125,91,.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x * k + 1, rect.y * k + 1, rect.width * k - 2, rect.height * k - 2);
      drawNumber(ctx, row * layout.across + column + 1, (rect.x + rect.width / 2) * k, (rect.y + rect.height / 2) * k);
    }
  }
}

function drawNumber(ctx, number, x, y) {
  ctx.fillStyle = "rgba(47,125,91,.85)";
  ctx.beginPath();
  ctx.arc(x, y, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `bold 20px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), x, y + 1);
}

/* ---------- saving ---------- */

async function save() {
  if (!state.bitmap) return;
  els.saveBtn.disabled = true;
  showStatus("PDFを作っています…", { sticky: true });
  try {
    const { PDFDocument, rgb } = await loadPdfLib();
    const doc = await PDFDocument.create();
    const layout = plan();
    for (let row = 0; row < layout.down; row++) {
      for (let column = 0; column < layout.across; column++) await addSheet(doc, rgb, layout, row, column);
    }
    const bytes = await doc.save();
    download(new Blob([bytes], { type: "application/pdf" }), `${stripExtension(state.file.name)}_${settings.paper}${layout.across * layout.down}枚.pdf`);
    showStatus("PDFを保存しました。「実際のサイズ」で印刷してください");
  } catch (err) {
    console.error(err);
    showStatus("PDFを作れませんでした", { error: true });
  } finally {
    els.saveBtn.disabled = false;
  }
}

async function addSheet(doc, rgb, layout, row, column) {
  const page = doc.addPage([layout.paperWidth * PT_PER_MM, layout.paperHeight * PT_PER_MM]);
  const rect = tileRect(layout, row, column);
  const image = await doc.embedJpg(await tileJpeg(layout, rect));
  const pageHeight = layout.paperHeight * PT_PER_MM;
  page.drawImage(image, {
    x: MARGIN * PT_PER_MM,
    y: pageHeight - (MARGIN + rect.height) * PT_PER_MM,
    width: rect.width * PT_PER_MM,
    height: rect.height * PT_PER_MM,
  });
  if (!settings.marks) return;
  drawCutLines(page, rgb, layout, row, column);
  const label = await doc.embedPng(await labelPng(layout, row, column));
  const labelHeight = MARGIN * 0.55 * PT_PER_MM;
  const labelWidth = (labelHeight * label.width) / label.height;
  page.drawImage(label, { x: MARGIN * PT_PER_MM, y: pageHeight - MARGIN * 0.8 * PT_PER_MM, width: labelWidth, height: labelHeight });
}

// The part of the picture on one sheet, as JPEG bytes. Parts past the picture's edge stay white.
async function tileJpeg(layout, rect) {
  const sourcePerMm = state.bitmap.width / layout.posterWidth;
  const pxPerMm = Math.min(PX_PER_MM_MAX, Math.max(PX_PER_MM_MIN, sourcePerMm));
  const canvas = makeCanvas(rect.width * pxPerMm, rect.height * pxPerMm);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  const scale = canvas.width / rect.width; // px per mm on this canvas
  ctx.drawImage(state.bitmap, -rect.x * scale, -rect.y * scale, layout.posterWidth * scale, layout.posterHeight * scale);
  const blob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
  canvas.width = canvas.height = 0;
  return blob.arrayBuffer();
}

// Dotted lines to cut along: on every sheet but the first column (left side) and the first
// row (top), in the middle of the part shared with the sheet before.
function drawCutLines(page, rgb, layout, row, column) {
  const pageHeight = layout.paperHeight * PT_PER_MM;
  const cutAt = MARGIN + layout.overlap / 2;
  const line = { thickness: 0.8, color: rgb(0.45, 0.45, 0.45), dashArray: [4, 3] };
  if (column > 0) {
    const x = cutAt * PT_PER_MM;
    page.drawLine({ start: { x, y: 0 }, end: { x, y: pageHeight }, ...line });
  }
  if (row > 0) {
    const y = pageHeight - cutAt * PT_PER_MM;
    page.drawLine({ start: { x: 0, y }, end: { x: layout.paperWidth * PT_PER_MM, y }, ...line });
  }
}

// "3（上から2段目・左から1枚目）" as a picture, since the PDF has no Japanese font.
async function labelPng(layout, row, column) {
  const number = row * layout.across + column + 1;
  const text = `${number}　上から${row + 1}段目・左から${column + 1}枚目（全部で${layout.across * layout.down}枚）`;
  const canvas = makeCanvas(1400, 64);
  const ctx = canvas.getContext("2d");
  ctx.font = `44px ${FONT}`;
  const width = Math.ceil(ctx.measureText(text).width) + 8;
  canvas.width = width;
  ctx.font = `44px ${FONT}`;
  ctx.fillStyle = "#555";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 4, 34);
  const blob = await canvasToBlob(canvas, "image/png");
  return blob.arrayBuffer();
}

/* ---------- settings ---------- */

function syncControls() {
  els.paper.value = settings.paper;
  els.across.value = settings.across;
  els.across.nextElementSibling.textContent = `${settings.across}枚`;
  els.marks.checked = settings.marks;
  for (const button of document.querySelectorAll("[data-orientation]")) button.setAttribute("aria-checked", String(button.dataset.orientation === settings.orientation));
  for (const button of document.querySelectorAll("[data-overlap]")) button.setAttribute("aria-checked", String(Number(button.dataset.overlap) === settings.overlap));
}

function changed() {
  settings.paper = els.paper.value;
  settings.across = Number(els.across.value);
  settings.marks = els.marks.checked;
  saveJson(SETTINGS_KEY, settings);
  render();
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
for (const el of [els.paper, els.marks]) el.addEventListener("change", changed);
els.across.addEventListener("input", changed);
for (const button of document.querySelectorAll("[data-orientation]")) {
  button.addEventListener("click", () => {
    settings.orientation = button.dataset.orientation;
    changed();
  });
}
for (const button of document.querySelectorAll("[data-overlap]")) {
  button.addEventListener("click", () => {
    settings.overlap = Number(button.dataset.overlap);
    changed();
  });
}
els.saveBtn.addEventListener("click", save);
window.addEventListener("paste", (e) => {
  const file = e.clipboardData?.files?.[0];
  if (file) openFile(file);
});
onFileDrop((files) => openFile(files[0]));
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest", "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js"]);

// Hook for automated tests.
window.__posterPrint = { state, settings, openFile, save, plan };
