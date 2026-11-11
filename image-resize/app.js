import { showStatus, hideStatus } from "../shared/js/status.js";
import { download, formatSize, onFileDrop, onFilePaste } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage, readableImage } from "../shared/js/heic.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { makeZip } from "../shared/js/zip.js";
import { registerOffline } from "../shared/js/offline.js";
import "../shared/js/guide.js";
import { compress, draw, examine, recipeFor, turnedSize } from "./compress.js";
import { createCompare } from "./compare.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "image-resize-settings-v1";
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const FORMAT_NAMES = { "image/jpeg": "JPG", "image/png": "PNG", "image/webp": "WebP" };
const THUMB = 64; // thumbnail size in the list (CSS pixels)

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
  workspace: $("workspace"),
  list: $("list"),
  formatButtons: [...document.querySelectorAll("#item-bar [data-format]")],
  qualityField: $("quality-field"),
  quality: $("quality"),
  qualityValue: $("quality-value"),
  colorsField: $("colors-field"),
  colors: $("colors"),
  autoNote: $("auto-note"),
  resetOwn: $("reset-own"),
  applyAll: $("apply-all"),
};

const compare = createCompare({
  wrap: $("compare"),
  scroll: $("compare-scroll"),
  stage: $("stage"),
  before: $("before-canvas"),
  after: $("after-image"),
  divider: $("divider"),
  beforeTag: $("before-tag"),
  afterTag: $("after-tag"),
  zoomOut: $("zoom-out"),
  zoomIn: $("zoom-in"),
  zoomLabel: $("zoom-label"),
});

const state = {
  // { id, file, name, bitmap, rotation, own, facts, el, result }
  //   own: settings for this picture only ({ format, quality, colors }) or null
  //   facts: what examine() found out about the original
  //   result: what compress() made, or null while it is being made
  items: [],
  selected: null, // the item shown in the 見くらべ view
  busy: false,
  running: null, // the current processAll() run, which save() waits for
};
let nextId = 1;
let runToken = 0; // bumped when a new run starts, so a stale run stops

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
  const fields = [
    [els.maxSide, saved.maxSide],
    [els.format, saved.format],
    [els.mode, saved.mode],
    [els.targetKb, saved.targetKb],
  ];
  for (const [el, value] of fields) {
    if (value === undefined) continue;
    if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === String(value))) continue;
    el.value = String(value);
  }
}

function settingsChanged() {
  const settings = readSettings();
  els.targetField.hidden = settings.mode !== "target";
  saveJson(SETTINGS_KEY, settings);
  for (const item of state.items) item.result = null;
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
      addItem(file, bitmap, await examine(file, bitmap));
    } catch (err) {
      console.error(err);
      failed.push(file.name);
    }
  }
  if (!state.selected && state.items.length) select(state.items[0]);
  updateUi();
  if (failed.length) showStatus(`${failed.join("、")} を読み込めませんでした`, { error: true });
  processAll();
}

function addItem(file, bitmap, facts) {
  const item = { id: nextId++, file, name: file.name || "画像", bitmap, rotation: 0, own: null, facts, el: null, result: null };
  createCard(item);
  state.items.push(item);
  els.list.append(item.el);
}

// Photos taken sideways are turned upright from their Exif orientation by the browser.
async function decode(file) {
  return createImageBitmap(await readableImage(file), { imageOrientation: "from-image" });
}

/* ---------- the list ---------- */

function createCard(item) {
  const li = document.createElement("li");
  li.className = "item";
  li.tabIndex = 0;
  li.innerHTML = `
    <div class="thumb"></div>
    <div class="info">
      <div class="name"></div>
      <div class="sizes"></div>
      <div class="recipe"></div>
    </div>
    <div class="actions">
      <button class="btn icon" data-act="rotate" title="右に90°回転" aria-label="右に90°回転"><svg class="i" aria-hidden="true"><use href="#i-rotate"/></svg></button>
      <button class="btn icon" data-act="remove" title="この画像を外す" aria-label="この画像を外す"><svg class="i" aria-hidden="true"><use href="#i-close"/></svg></button>
    </div>`;
  li.querySelector(".name").textContent = item.name;
  li.addEventListener("click", (e) => cardClicked(item, e));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target === li) select(item);
  });
  item.el = li;
  drawThumb(item);
}

function cardClicked(item, e) {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "rotate") rotate(item);
  else if (act === "remove") remove(item);
  else select(item);
}

function drawThumb(item) {
  const { width, height } = turnedSize(item.bitmap, item.rotation);
  const k = (THUMB * 2) / Math.max(width, height); // twice as sharp for high-density screens
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
  if (item === state.selected) showSelected();
  processAll();
}

function remove(item) {
  item.bitmap.close();
  item.el.remove();
  state.items = state.items.filter((i) => i !== item);
  if (state.selected === item) select(state.items[0] ?? null);
  updateUi();
}

function clearAll() {
  for (const item of state.items.slice()) remove(item);
  hideStatus();
}

/* ---------- compressing ---------- */

function processAll() {
  state.running = runAll();
  return state.running;
}

// Makes every picture that has no result yet, the one being looked at first.
async function runAll() {
  const token = ++runToken;
  const isCurrent = () => token === runToken;
  const settings = readSettings();
  updateUi();
  const waiting = state.items.filter((item) => !item.result);
  waiting.sort((a, b) => Number(b === state.selected) - Number(a === state.selected));
  for (const item of waiting) {
    if (!isCurrent()) return;
    if (!state.items.includes(item)) continue;
    showResult(item, "計算中…");
    try {
      const result = await compress(item, recipeFor(item, settings), isCurrent);
      if (!isCurrent() || !result) return;
      item.result = result;
      showResult(item);
    } catch (err) {
      console.error(err);
      showResult(item, "変換できませんでした");
    }
  }
  updateUi();
}

/* ---------- showing results ---------- */

// The share of the original that was saved, as a whole percent (0 when nothing was saved).
const savedPercent = (before, after) => Math.max(0, Math.round((1 - after / before) * 100));

function showResult(item, note) {
  const sizes = item.el.querySelector(".sizes");
  const recipe = item.el.querySelector(".recipe");
  const before = formatSize(item.file.size);
  if (note || !item.result) {
    sizes.textContent = `${before} → ${note ?? ""}`;
    recipe.textContent = "";
  } else {
    sizes.replaceChildren(`${before} → `, element("b", formatSize(item.result.blob.size)), savingBadge(item));
    recipe.replaceChildren(...recipeWords(item));
  }
  if (item === state.selected) showSelected();
}

function savingBadge(item) {
  const percent = savedPercent(item.file.size, item.result.blob.size);
  if (item.result.kept) return element("span", "元のまま", "badge keep");
  if (percent === 0) return element("span", "軽くならず", "badge keep");
  return element("span", `${percent}%軽く`, "badge");
}

// "1600×1200・JPG・画質 80" and notes such as the size not being reached.
function recipeWords(item) {
  const { width, height, format, quality, colors, hit, kept } = item.result;
  if (kept) return ["これ以上軽くならないので、情報だけ消した元のファイルにします"];
  const words = [`${width}×${height}・${FORMAT_NAMES[format]}`];
  if (format === "image/png") words.push(colors ? `・${colors}色` : "・色はそのまま");
  else words.push(`・画質 ${Math.round(quality * 100)}`);
  if (item.own) words.push(element("span", "（この画像だけの設定）", "own"));
  if (!hit) words.push(element("span", "（指定のサイズまで小さくできませんでした）", "warn"));
  return words;
}

function element(tag, text, className = "") {
  return Object.assign(document.createElement(tag), { textContent: text, className });
}

/* ---------- the picture being looked at ---------- */

function select(item) {
  state.selected = item;
  for (const other of state.items) other.el.classList.toggle("selected", other === item);
  if (!item) {
    compare.showOriginal(null);
    compare.showCompressed(null);
    return;
  }
  const { width, height } = turnedSize(item.bitmap, item.rotation);
  compare.showOriginal({ width, height, draw: (canvas) => draw(canvas.getContext("2d"), item.bitmap, item.rotation, width, height) });
  showSelected();
  // A picture whose turn has not come yet is made now, so the view does not wait for the others.
  if (!item.result) processAll();
}

// Shows the selected picture's result in the 見くらべ view and its settings in the bar below.
function showSelected() {
  const item = state.selected;
  if (!item) return;
  const { width, height } = turnedSize(item.bitmap, item.rotation);
  if (compare.view.width !== width || compare.view.height !== height) return select(item);
  const result = item.result;
  compare.showCompressed(result?.blob ?? null);
  const after = result ? `圧縮後 ${formatSize(result.blob.size)}（${savingText(item)}）` : "圧縮後 計算中…";
  compare.setTags(`元の画像 ${formatSize(item.file.size)}`, after);
  showItemBar(item);
}

function savingText(item) {
  if (item.result.kept) return "元のまま";
  const percent = savedPercent(item.file.size, item.result.blob.size);
  return percent ? `${percent}%軽く` : "軽くならず";
}

function showItemBar(item) {
  const settings = readSettings();
  const recipe = recipeFor(item, settings);
  const made = item.result && !item.result.kept ? item.result : null;
  const isPng = recipe.format === "image/png";
  const byTarget = settings.mode === "target";
  for (const button of els.formatButtons) button.setAttribute("aria-pressed", String(button.dataset.format === recipe.format));
  const quality = Math.round((made?.quality ?? recipe.quality) * 100);
  els.quality.value = String(quality);
  els.qualityValue.textContent = String(quality);
  els.colors.value = String(recipe.colors);
  els.qualityField.hidden = isPng;
  els.colorsField.hidden = !isPng;
  els.quality.disabled = els.colors.disabled = byTarget;
  els.autoNote.hidden = !byTarget;
  els.resetOwn.hidden = !item.own;
  els.applyAll.disabled = state.items.length < 2;
}

// Changes one setting of the selected picture only, and makes it again.
function setOwn(change) {
  const item = state.selected;
  if (!item) return;
  item.own = { ...item.own, ...change };
  item.result = null;
  showItemBar(item);
  processAll();
}

function resetOwn() {
  const item = state.selected;
  if (!item?.own) return;
  item.own = null;
  item.result = null;
  processAll();
}

// Gives every picture the format, quality and colors of the selected one.
function applyToAll() {
  const item = state.selected;
  if (!item) return;
  const { format, quality, colors } = recipeFor(item, readSettings());
  for (const other of state.items) {
    other.own = { format, quality, colors };
    other.result = null;
  }
  processAll();
  showStatus(`${state.items.length}枚とも ${FORMAT_NAMES[format]} にしました`);
}

/* ---------- saving ---------- */

function outputName(item, used) {
  const base = item.name.replace(/\.[^.]+$/, "") || "画像";
  const ext = EXT[item.result.blob.type] ?? EXT[item.result.format];
  let name = `${base}_小.${ext}`;
  for (let n = 2; used.has(name); n++) name = `${base}_小(${n}).${ext}`;
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
  const used = new Set();
  if (ready.length === 1) {
    download(ready[0].result.blob, outputName(ready[0], used));
  } else {
    const files = [];
    for (const item of ready) {
      files.push({ name: outputName(item, used), bytes: new Uint8Array(await item.result.blob.arrayBuffer()) });
    }
    download(makeZip(files), "画像_小.zip");
  }
  showStatus(ready.length === 1 ? "保存しました" : `${ready.length}枚をZIPにまとめて保存しました`);
}

/* ---------- ui ---------- */

function updateUi() {
  const n = state.items.length;
  els.welcome.hidden = n > 0;
  els.workspace.hidden = n === 0;
  els.clearBtn.disabled = n === 0;
  els.saveBtn.disabled = n === 0;
  const done = state.items.filter((i) => i.result);
  if (n && done.length === n) {
    const before = state.items.reduce((sum, i) => sum + i.file.size, 0);
    const after = done.reduce((sum, i) => sum + i.result.blob.size, 0);
    els.total.textContent = `${n}枚 ${formatSize(before)} → ${formatSize(after)}（${savedPercent(before, after)}%軽く）`;
  } else {
    els.total.textContent = n ? `${n}枚` : "";
  }
  if (state.selected) showItemBar(state.selected);
}

els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
for (const el of [els.maxSide, els.format, els.mode, els.targetKb]) el.addEventListener("change", settingsChanged);
els.clearBtn.addEventListener("click", clearAll);
els.saveBtn.addEventListener("click", save);
for (const button of els.formatButtons) button.addEventListener("click", () => setOwn({ format: button.dataset.format }));
els.quality.addEventListener("input", () => (els.qualityValue.textContent = els.quality.value));
els.quality.addEventListener("change", () => setOwn({ quality: Number(els.quality.value) / 100 }));
els.colors.addEventListener("change", () => setOwn({ colors: Number(els.colors.value) }));
els.resetOwn.addEventListener("click", resetOwn);
els.applyAll.addEventListener("click", applyToAll);
addNextTool({ saveBtn: els.saveBtn, save: save, kind: "image" });
onFilePaste(addFiles);
onFileDrop(addFiles);

restoreSettings();
els.targetField.hidden = els.mode.value !== "target";
updateUi();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "compress.js", "compare.js", "png.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__imageResize = { state, addFiles, processAll, save, select, compare };
