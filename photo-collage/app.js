import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop, onFilePaste, safeFileName } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage } from "../shared/js/heic.js";
import { loadPhoto, stripExtension, makeCanvas, fitWithin } from "../shared/js/photo.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import "../shared/js/guide.js";
import { iconButton } from "../shared/js/buttons.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "photo-collage-settings-v1";
const MAX_PHOTOS = 30;
const PHOTO_PX = 2000; // each photo is kept at most this big (long side)
const PREVIEW_WIDTH = 1100; // px
const JPEG_QUALITY = 0.92;
const FIT_CELL = 800; // px, the width of one photo for "写真に合わせる"
// The finished picture, in px (A4 at 150 dpi).
const SHEETS = {
  wide: { width: 1920, height: 1080 },
  a4: { width: 1240, height: 1754 },
  "a4-landscape": { width: 1754, height: 1240 },
  square: { width: 1600, height: 1600 },
};
const TITLE_SHARE = 0.09; // of the shorter side: the height of the title band
const TITLE_MIN_SHARE = 0.035; // of the width: the title band is never thinner than this
const LABEL_SHARE = 0.13; // of a cell's height: the band for the name under a photo
const FONT = 'system-ui, "Noto Sans JP", sans-serif';

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  sheet: $("sheet"),
  gap: $("gap"),
  background: $("background"),
  rounded: $("rounded"),
  title: $("title"),
  labels: $("labels"),
  count: $("count"),
  photos: $("photos"),
  preview: $("preview"),
  info: $("info"),
};

const settings = Object.assign(
  { columns: "0", sheet: "wide", fit: "cover", gap: 16, background: "#ffffff", rounded: false, labels: false },
  loadJson(SETTINGS_KEY, {}),
);
const state = {
  photos: [], // { name, label, bitmap, thumb }
};
let frameRequest = 0;

/* ---------- adding photos ---------- */

async function addFiles(fileList) {
  const files = [...fileList].filter(isImage);
  if (!files.length) return showStatus("写真・画像のファイルを選んでください", { error: true });
  const room = MAX_PHOTOS - state.photos.length;
  if (files.length > room) showStatus(`並べられるのは${MAX_PHOTOS}枚までです`, { error: true });
  for (const file of files.slice(0, Math.max(0, room))) {
    try {
      state.photos.push(await openPhoto(file));
    } catch (err) {
      console.error(err);
      showStatus(`${file.name} を開けませんでした`, { error: true });
    }
  }
  renderList();
  render();
}

// Big photos are shrunk once here, so redrawing the preview stays quick.
async function openPhoto(file) {
  const original = await loadPhoto(file);
  const size = fitWithin(original.width, original.height, PHOTO_PX);
  const bitmap = await createImageBitmap(original, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
  original.close();
  return { name: file.name, label: stripExtension(file.name), bitmap };
}

/* ---------- the list of photos ---------- */

function renderList() {
  els.count.textContent = state.photos.length;
  els.photos.replaceChildren(...state.photos.map((photo, index) => photoRow(photo, index)));
}

function photoRow(photo, index) {
  const li = document.createElement("li");
  li.className = "photo";
  const thumb = makeCanvas(96, 96);
  drawPhoto(thumb.getContext("2d"), photo.bitmap, { x: 0, y: 0, width: 96, height: 96 }, "cover");
  const label = document.createElement("input");
  label.type = "text";
  label.value = photo.label;
  label.maxLength = 30;
  label.setAttribute("aria-label", `${index + 1}枚目の名前`);
  label.addEventListener("input", () => {
    photo.label = label.value;
    render();
  });
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  buttons.append(
    iconButton("i-up", "前へ", () => move(index, -1), { disabled: index === 0 }),
    iconButton("i-down", "後ろへ", () => move(index, 1), { disabled: index === state.photos.length - 1 }),
    iconButton("i-close", "この写真を外す", () => remove(index)),
  );
  li.append(thumb, label, buttons);
  return li;
}

function move(index, step) {
  const [photo] = state.photos.splice(index, 1);
  state.photos.splice(index + step, 0, photo);
  renderList();
  render();
}

function remove(index) {
  const [photo] = state.photos.splice(index, 1);
  photo.bitmap.close();
  renderList();
  render();
}

/* ---------- layout ---------- */

// How many columns, and the size of the finished picture.
function plan() {
  const count = state.photos.length;
  const aspect = averageAspect();
  if (settings.sheet === "fit") return fitPlan(count, aspect);
  const sheet = SHEETS[settings.sheet];
  const titleHeight = titleBand(sheet.width, sheet.height);
  const columns = columnCount(count, aspect, sheet.width, sheet.height - titleHeight);
  return { columns, width: sheet.width, height: sheet.height, titleHeight };
}

// "写真に合わせる": the cells take the photos' own shape and the picture grows to fit them.
function fitPlan(count, aspect) {
  const columns = columnCount(count, aspect, 4, 3);
  const rows = Math.ceil(count / columns);
  const gap = settings.gap;
  const labelHeight = settings.labels ? (FIT_CELL / aspect) * LABEL_SHARE : 0;
  const cellHeight = FIT_CELL / aspect + labelHeight;
  const width = columns * FIT_CELL + (columns + 1) * gap;
  const body = rows * cellHeight + (rows + 1) * gap;
  const titleHeight = titleBand(width, body);
  return { columns, width, height: body + titleHeight, titleHeight };
}

const titleBand = (width, height) => (els.title.value.trim() ? Math.round(Math.max(Math.min(width, height) * TITLE_SHARE, width * TITLE_MIN_SHARE)) : 0);

function averageAspect() {
  const sum = state.photos.reduce((total, p) => total + p.bitmap.width / p.bitmap.height, 0);
  return sum / Math.max(1, state.photos.length);
}

// The chosen number of columns, or (自動) the one where the photos come out largest.
function columnCount(count, aspect, width, height) {
  if (settings.columns === "row") return count;
  const chosen = Number(settings.columns);
  if (chosen) return Math.min(chosen, count);
  let best = 1;
  let bestArea = 0;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    const photoWidth = Math.min(cellWidth, cellHeight * aspect);
    const area = photoWidth * (photoWidth / aspect);
    if (area > bestArea * 1.0001) {
      best = columns;
      bestArea = area;
    }
  }
  return best;
}

// The box of each photo in a picture of the planned size, scaled by `scale`.
function cells({ columns, width, height, titleHeight }, scale) {
  const count = state.photos.length;
  const rows = Math.ceil(count / columns);
  const gap = settings.gap * scale;
  const top = titleHeight * scale;
  const cellWidth = (width * scale - gap * (columns + 1)) / columns;
  const cellHeight = (height * scale - top - gap * (rows + 1)) / rows;
  return state.photos.map((photo, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    // A last row with fewer photos is centered.
    const shift = ((columns - inRow) * (cellWidth + gap)) / 2;
    const column = index % columns;
    const x = gap + shift + column * (cellWidth + gap);
    const y = top + gap + row * (cellHeight + gap);
    return { photo, x, y, width: cellWidth, height: cellHeight };
  });
}

/* ---------- drawing ---------- */

// The finished picture, `scale` times its planned size.
function compose(scale) {
  const layout = plan();
  const canvas = makeCanvas(layout.width * scale, layout.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = settings.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  if (layout.titleHeight) drawTitle(ctx, canvas.width, layout.titleHeight * scale);
  for (const cell of cells(layout, scale)) drawCell(ctx, cell);
  return canvas;
}

function drawCell(ctx, cell) {
  const labelHeight = settings.labels ? cell.height * LABEL_SHARE : 0;
  const box = { x: cell.x, y: cell.y, width: cell.width, height: cell.height - labelHeight };
  ctx.save();
  if (settings.rounded) {
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, Math.min(box.width, box.height) * 0.05);
    ctx.clip();
  }
  drawPhoto(ctx, cell.photo.bitmap, box, settings.fit);
  ctx.restore();
  if (labelHeight) drawLabel(ctx, cell.photo.label, cell.x + cell.width / 2, box.y + box.height + labelHeight / 2, labelHeight, cell.width);
}

// Draws the photo into `box`: filling it and cutting what sticks out (cover), or whole (contain).
function drawPhoto(ctx, bitmap, box, fit) {
  const pick = fit === "cover" ? Math.max : Math.min;
  const k = pick(box.width / bitmap.width, box.height / bitmap.height);
  const width = bitmap.width * k;
  const height = bitmap.height * k;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.drawImage(bitmap, box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height);
  ctx.restore();
}

function drawTitle(ctx, width, height) {
  ctx.fillStyle = textColor();
  ctx.font = `bold ${Math.round(height * 0.55)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(els.title.value.trim(), width / 2, height * 0.6, width * 0.95);
}

function drawLabel(ctx, text, x, y, height, width) {
  ctx.fillStyle = textColor();
  ctx.font = `${Math.round(height * 0.62)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y, width * 0.96);
}

// Black on a light background, white on a dark one.
function textColor() {
  const hex = settings.background.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 140 ? "#1d2228" : "#ffffff";
}

function render() {
  cancelAnimationFrame(frameRequest);
  frameRequest = requestAnimationFrame(draw);
}

function draw() {
  const has = state.photos.length > 0;
  els.welcome.hidden = has;
  els.work.hidden = !has;
  els.saveBtn.disabled = !has;
  if (!has) return;
  const layout = plan();
  const canvas = compose(Math.min(1, PREVIEW_WIDTH / layout.width));
  els.preview.width = canvas.width;
  els.preview.height = canvas.height;
  els.preview.getContext("2d").drawImage(canvas, 0, 0);
  els.info.textContent = `できあがり ${Math.round(layout.width)}×${Math.round(layout.height)}`;
}

/* ---------- settings ---------- */

function syncControls() {
  for (const button of document.querySelectorAll("[data-columns]")) button.setAttribute("aria-checked", String(button.dataset.columns === settings.columns));
  for (const button of document.querySelectorAll("[data-fit]")) button.setAttribute("aria-checked", String(button.dataset.fit === settings.fit));
  els.sheet.value = settings.sheet;
  els.gap.value = settings.gap;
  els.gap.nextElementSibling.textContent = settings.gap;
  els.background.value = settings.background;
  els.rounded.checked = settings.rounded;
  els.labels.checked = settings.labels;
}

function changed() {
  settings.sheet = els.sheet.value;
  settings.gap = Number(els.gap.value);
  settings.background = els.background.value;
  settings.rounded = els.rounded.checked;
  settings.labels = els.labels.checked;
  saveJson(SETTINGS_KEY, settings);
  syncControls();
  render();
}

/* ---------- saving ---------- */

async function save() {
  if (!state.photos.length) return;
  try {
    const canvas = compose(1);
    const blob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
    canvas.width = canvas.height = 0;
    const title = els.title.value.trim();
    download(blob, `${safeFileName(title || "写真まとめ")}.jpg`);
    showStatus("保存しました");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした", { error: true });
  }
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
for (const button of document.querySelectorAll("[data-columns]")) {
  button.addEventListener("click", () => {
    settings.columns = button.dataset.columns;
    changed();
  });
}
for (const button of document.querySelectorAll("[data-fit]")) {
  button.addEventListener("click", () => {
    settings.fit = button.dataset.fit;
    changed();
  });
}
for (const el of [els.sheet, els.background, els.rounded, els.labels]) el.addEventListener("change", changed);
els.gap.addEventListener("input", changed);
els.title.addEventListener("input", render);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: "image" });
onFilePaste(addFiles);
onFileDrop(addFiles);
syncControls();
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__photoCollage = { state, settings, addFiles, save, plan };
