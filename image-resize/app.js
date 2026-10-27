import { showStatus, hideStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage, readableImage } from "../shared/js/heic.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { makeZip } from "../shared/js/zip.js";
import { registerOffline } from "../shared/js/offline.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "image-resize-settings-v1";
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MIN_SIDE = 160; // never shrink below this to reach a target size
const THUMB = 96;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  maxSide: $("max-side"),
  format: $("format"),
  mode: $("mode"),
  targetField: $("target-field"),
  targetKb: $("target-kb"),
  clearBtn: $("clear-btn"),
  total: $("total"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  list: $("list"),
};

const state = {
  items: [], // { id, file, name, bitmap, rotation, el, result: { blob, width, height, hit } | null }
  busy: false,
  running: null, // the current processAll() run, which save() waits for
};
let nextId = 1;
let runToken = 0; // bumped when the settings change, so a stale run stops

/* ---------- settings ---------- */

function readSettings() {
  return {
    maxSide: Number(els.maxSide.value),
    format: els.format.value,
    mode: els.mode.value,
    targetKb: Math.max(10, Number(els.targetKb.value) || 200),
  };
}

function restoreSettings() {
  const saved = loadJson(SETTINGS_KEY, null);
  if (!saved) return;
  for (const [el, value] of [[els.maxSide, saved.maxSide], [els.format, saved.format], [els.mode, saved.mode], [els.targetKb, saved.targetKb]]) {
    if (value === undefined) continue;
    if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(value))) continue;
    el.value = String(value);
  }
}

function settingsChanged() {
  const s = readSettings();
  els.targetField.hidden = s.mode !== "target";
  saveJson(SETTINGS_KEY, s);
  processAll();
}

/* ---------- adding images ---------- */

async function addFiles(fileList) {
  const files = [...fileList].filter(isImage);
  if (!files.length) return showStatus("画像ファイルを選んでください", { error: true });
  const failed = [];
  for (const file of files) {
    try {
      const bitmap = await decode(file);
      const item = { id: nextId++, file, name: file.name || "画像", bitmap, rotation: 0, el: null, result: null };
      createCard(item);
      state.items.push(item);
      els.list.append(item.el);
    } catch (err) {
      console.error(err);
      failed.push(file.name);
    }
  }
  updateUi();
  if (failed.length) showStatus(`${failed.join("、")} を読み込めませんでした`, { error: true });
  processAll();
}

// Photos taken sideways are turned upright from their Exif orientation by the browser.
async function decode(file) {
  return createImageBitmap(await readableImage(file), { imageOrientation: "from-image" });
}

/* ---------- cards ---------- */

function createCard(item) {
  const li = document.createElement("li");
  li.className = "item";
  li.innerHTML = `
    <div class="thumb"></div>
    <div class="info">
      <div class="name"></div>
      <div class="sizes"></div>
    </div>
    <div class="actions">
      <button class="btn icon" data-act="rotate" title="右に90°回転" aria-label="右に90°回転"><svg class="i" aria-hidden="true"><use href="#i-rotate"/></svg></button>
      <button class="btn icon" data-act="remove" title="この画像を外す" aria-label="この画像を外す"><svg class="i" aria-hidden="true"><use href="#i-close"/></svg></button>
    </div>`;
  li.querySelector(".name").textContent = item.name;
  li.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "rotate") rotate(item);
    else if (act === "remove") remove(item);
  });
  item.el = li;
  drawThumb(item);
}

function drawThumb(item) {
  const { width, height } = turnedSize(item.bitmap, item.rotation);
  const k = THUMB / Math.max(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * k));
  canvas.height = Math.max(1, Math.round(height * k));
  draw(canvas.getContext("2d"), item.bitmap, item.rotation, canvas.width, canvas.height);
  item.el.querySelector(".thumb").replaceChildren(canvas);
}

function rotate(item) {
  item.rotation = (item.rotation + 90) % 360;
  drawThumb(item);
  item.result = null;
  processAll();
}

function remove(item) {
  item.bitmap.close();
  item.el.remove();
  state.items = state.items.filter((i) => i !== item);
  updateUi();
}

function clearAll() {
  for (const item of state.items.slice()) remove(item);
  hideStatus();
}

/* ---------- shrinking ---------- */

const turnedSize = (bitmap, rotation) =>
  rotation % 180 ? { width: bitmap.height, height: bitmap.width } : { width: bitmap.width, height: bitmap.height };

// Draws the bitmap turned by `rotation` to fill a w×h canvas.
function draw(ctx, bitmap, rotation, w, h) {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const [dw, dh] = rotation % 180 ? [h, w] : [w, h];
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function render(item, width, height, format) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (format === "image/jpeg") {
    // JPG has no transparency: see-through parts of a PNG would turn black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  draw(ctx, item.bitmap, item.rotation, width, height);
  return canvas;
}

const encode = (canvas, format, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, format, format === "image/png" ? undefined : quality));

function fit(item, maxSide) {
  const { width, height } = turnedSize(item.bitmap, item.rotation);
  const k = maxSide ? Math.min(1, maxSide / Math.max(width, height)) : 1;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// Fits the image under `bytes`: first by lowering the JPG/WebP quality (binary search between
// 0.35 and 0.95), and only when even the lowest quality is too big by making it smaller and
// trying again. PNG has no quality, so only its size changes. The same idea as the target-size
// mode of BrowseryTools and Squoosh's resize + quality, written for this tool.
async function shrinkToTarget(item, { maxSide, format, targetKb }, token) {
  const bytes = targetKb * 1024;
  let { width, height } = fit(item, maxSide);
  const aspect = height / width;
  let smallest = null;
  for (let pass = 0; pass < 6; pass++) {
    const canvas = render(item, width, height, format);
    let best = null;
    if (format === "image/png") {
      const blob = await encode(canvas, format);
      if (blob.size <= bytes) best = { blob, width, height };
      if (!smallest || blob.size < smallest.blob.size) smallest = { blob, width, height };
    } else {
      let lo = 0.35;
      let hi = 0.95;
      for (let probe = 0; probe < 7; probe++) {
        if (token !== runToken) return null;
        const quality = (lo + hi) / 2;
        const blob = await encode(canvas, format, quality);
        if (!smallest || blob.size < smallest.blob.size) smallest = { blob, width, height };
        if (blob.size > bytes) {
          hi = quality;
        } else {
          if (!best || blob.size > best.blob.size) best = { blob, width, height };
          if (blob.size > bytes * 0.9) break; // close enough
          lo = quality;
        }
      }
    }
    canvas.width = canvas.height = 0;
    if (best) return { ...best, hit: true };
    if (token !== runToken) return null;
    const longSide = Math.max(width, height);
    if (longSide <= MIN_SIDE) break;
    // Area shrinks with the square of the side, so shrink the side by the square root.
    const k = Math.max(0.3, Math.min(0.9, Math.sqrt(bytes / smallest.blob.size) * 0.95));
    width = Math.max(1, Math.round(width * k));
    height = Math.max(1, Math.round(width * aspect));
    if (Math.max(width, height) < MIN_SIDE) {
      const up = MIN_SIDE / Math.max(width, height);
      width = Math.round(width * up);
      height = Math.round(height * up);
    }
  }
  return { ...smallest, hit: false };
}

async function shrink(item, settings, token) {
  if (settings.mode === "target") return shrinkToTarget(item, settings, token);
  const { width, height } = fit(item, settings.maxSide);
  const canvas = render(item, width, height, settings.format);
  const blob = await encode(canvas, settings.format, Number(settings.mode));
  canvas.width = canvas.height = 0;
  return { blob, width, height, hit: true };
}

function processAll() {
  state.running = runAll();
  return state.running;
}

async function runAll() {
  const token = ++runToken;
  const settings = readSettings();
  for (const item of state.items) item.result = null;
  updateUi();
  for (const item of state.items.slice()) {
    if (token !== runToken) return;
    showSizes(item, "計算中…");
    try {
      const result = await shrink(item, settings, token);
      if (token !== runToken || !result) return;
      item.result = result;
      showSizes(item);
    } catch (err) {
      console.error(err);
      showSizes(item, "変換できませんでした");
    }
  }
  updateUi();
}

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function showSizes(item, note) {
  const el = item.el.querySelector(".sizes");
  const src = turnedSize(item.bitmap, item.rotation);
  const before = `${src.width}×${src.height}・${kb(item.file.size)}`;
  if (note || !item.result) {
    el.textContent = `${before} → ${note ?? ""}`;
    return;
  }
  const { blob, width, height, hit } = item.result;
  const smaller = blob.size < item.file.size;
  el.replaceChildren(
    `${before} → `,
    Object.assign(document.createElement("b"), { textContent: `${width}×${height}・${kb(blob.size)}` }),
    hit ? "" : Object.assign(document.createElement("span"), { className: "warn", textContent: "（指定のサイズまで小さくできませんでした）" }),
    hit && !smaller ? Object.assign(document.createElement("span"), { className: "warn", textContent: "（元より大きくなりました）" }) : "",
  );
}

/* ---------- saving ---------- */

function outputName(item, format, used) {
  const base = item.name.replace(/\.[^.]+$/, "") || "画像";
  let name = `${base}_小.${EXT[format]}`;
  for (let n = 2; used.has(name); n++) name = `${base}_小(${n}).${EXT[format]}`;
  used.add(name);
  return name;
}

async function save() {
  if (!state.items.length || state.busy) return;
  state.busy = true;
  try {
    // Changing a setting just before (the KB box loses focus on this click) starts a new run.
    for (let run; run !== state.running; ) await (run = state.running);
    await saveReady();
  } finally {
    state.busy = false;
  }
}

async function saveReady() {
  const ready = state.items.filter((i) => i.result);
  if (!ready.length) return;
  const format = readSettings().format;
  const used = new Set();
  if (ready.length === 1) {
    download(ready[0].result.blob, outputName(ready[0], format, used));
  } else {
    const files = [];
    for (const item of ready) {
      files.push({ name: outputName(item, format, used), bytes: new Uint8Array(await item.result.blob.arrayBuffer()) });
    }
    download(makeZip(files), "画像_小.zip");
  }
  showStatus(ready.length === 1 ? "保存しました" : `${ready.length}枚をZIPにまとめて保存しました`);
}

/* ---------- ui ---------- */

function updateUi() {
  const n = state.items.length;
  els.welcome.hidden = n > 0;
  els.clearBtn.disabled = n === 0;
  const done = state.items.filter((i) => i.result);
  els.saveBtn.disabled = n === 0;
  if (n && done.length === n) {
    const before = state.items.reduce((s, i) => s + i.file.size, 0);
    const after = done.reduce((s, i) => s + i.result.blob.size, 0);
    els.total.textContent = `${n}枚 ${kb(before)} → ${kb(after)}`;
  } else {
    els.total.textContent = n ? `${n}枚` : "";
  }
}

els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
for (const el of [els.maxSide, els.format, els.mode]) el.addEventListener("change", settingsChanged);
els.targetKb.addEventListener("change", settingsChanged);
els.clearBtn.addEventListener("click", clearAll);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save: save, kind: "image" });
window.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) addFiles(files);
});
onFileDrop(addFiles);

restoreSettings();
els.targetField.hidden = els.mode.value !== "target";
updateUi();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__imageResize = { state, addFiles, processAll, save };
