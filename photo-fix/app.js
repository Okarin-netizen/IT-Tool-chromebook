import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage } from "../shared/js/heic.js";
import { loadPhoto, stripExtension, outputType } from "../shared/js/photo.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { detectCorners } from "../shared/js/straighten.js";
import { registerOffline } from "../shared/js/offline.js";
import { shape, turned, recolor } from "./adjust.js";
import "../shared/js/guide.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "photo-fix-settings-v1";
const PREVIEW_PX = 1200; // the preview is worked out on a copy this big (long side)
const SAVE_PX = 4096; // the saved photo is at most this big (long side), to keep memory in check
const JPEG_QUALITY = 0.92;
const WHOLE = [[0, 0], [1, 0], [1, 1], [0, 1]];

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  compareBtn: $("compare-btn"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  photoPanel: $("photo-panel"),
  boardPanel: $("board-panel"),
  autoBtn: $("auto-btn"),
  invertField: $("invert-field"),
  invert: $("invert"),
  flipBtn: $("flip-btn"),
  stage: $("stage"),
  preview: $("preview"),
  frame: $("frame"),
  cornerBar: $("corner-bar"),
  info: $("info"),
};
const SLIDERS = {
  brightness: ["photo", "brightness"],
  contrast: ["photo", "contrast"],
  saturation: ["photo", "saturation"],
  warmth: ["photo", "warmth"],
  strength: ["board", "strength"],
  tilt: [null, "tilt"],
};

const saved = loadJson(SETTINGS_KEY, {});
const state = {
  file: null,
  bitmap: null,
  previewBase: null, // the photo shrunk to PREVIEW_PX, which the preview is made from
  settings: freshSettings(),
  cornerEdit: null, // [[x, y] × 4] as fractions while the corner handles are shown
  comparing: false,
};
let frameRequest = 0;

function freshSettings() {
  return {
    mode: "photo",
    photo: { auto: false, brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
    board: { kind: saved.kind ?? "paper", strength: saved.strength ?? 50, color: saved.color ?? "color", invert: Boolean(saved.invert) },
    rotation: 0,
    flip: false,
    corners: null,
    tilt: 0,
  };
}

/* ---------- opening ---------- */

async function openFile(file) {
  if (!file) return;
  if (!isImage(file)) return showStatus("写真・画像のファイルを選んでください", { error: true });
  try {
    const bitmap = await loadPhoto(file);
    state.bitmap?.close();
    state.file = file;
    state.bitmap = bitmap;
    state.previewBase = turned(bitmap, 0, false, PREVIEW_PX);
    const mode = state.settings.mode;
    state.settings = freshSettings();
    state.settings.mode = mode; // a teacher fixing a pile of board photos keeps the mode
    state.cornerEdit = null;
    syncControls();
    render();
  } catch (err) {
    console.error(err);
    showStatus(`${file.name} を開けませんでした`, { error: true });
  }
}

/* ---------- controls ---------- */

// Brings every control in line with state.settings.
function syncControls() {
  const s = state.settings;
  for (const [id, [group, key]] of Object.entries(SLIDERS)) {
    const input = $(id);
    input.value = group ? s[group][key] : s[key];
    showValue(input);
  }
  checkTab("[data-mode]", (b) => b.dataset.mode === s.mode);
  checkTab("[data-kind]", (b) => b.dataset.kind === s.board.kind);
  checkTab("[data-color]", (b) => b.dataset.color === s.board.color);
  els.autoBtn.setAttribute("aria-pressed", String(s.photo.auto));
  els.flipBtn.setAttribute("aria-pressed", String(s.flip));
  els.invert.checked = s.board.invert;
  els.photoPanel.hidden = s.mode !== "photo";
  els.boardPanel.hidden = s.mode !== "board";
  els.invertField.hidden = s.board.kind !== "blackboard";
}

function checkTab(selector, isOn) {
  for (const button of document.querySelectorAll(selector)) button.setAttribute("aria-checked", String(isOn(button)));
}

function showValue(input) {
  const value = Number(input.value);
  const sign = value > 0 && input.id !== "strength" ? "+" : "";
  input.nextElementSibling.textContent = input.id === "tilt" ? `${sign}${value}°` : `${sign}${value}`;
}

function sliderMoved(input) {
  const [group, key] = SLIDERS[input.id];
  const target = group ? state.settings[group] : state.settings;
  target[key] = Number(input.value);
  showValue(input);
  if (group === "board") rememberBoard();
  render();
}

function chooseTab(button) {
  const s = state.settings;
  if (button.dataset.mode) s.mode = button.dataset.mode;
  if (button.dataset.kind) s.board.kind = button.dataset.kind;
  if (button.dataset.color) s.board.color = button.dataset.color;
  rememberBoard();
  syncControls();
  render();
}

function rememberBoard() {
  const { kind, strength, color, invert } = state.settings.board;
  saveJson(SETTINGS_KEY, { kind, strength, color, invert });
}

function turn(quarter) {
  const s = state.settings;
  s.rotation = (s.rotation + quarter * 90 + 360) % 360;
  s.corners = null; // the corners were placed on the photo as it was turned before
  render();
}

function reset() {
  const mode = state.settings.mode;
  state.settings = freshSettings();
  state.settings.mode = mode;
  state.settings.board = { ...state.settings.board, strength: 50, invert: false };
  syncControls();
  render();
}

/* ---------- the four corners ---------- */

function startCorners() {
  state.cornerEdit = (state.settings.corners ?? WHOLE).map((p) => [...p]);
  if (!state.settings.corners) autoCorners();
  render();
}

function autoCorners() {
  const s = state.settings;
  const canvas = turned(state.previewBase, s.rotation, s.flip, PREVIEW_PX);
  const found = detectCorners(canvas);
  if (!found) {
    showStatus("紙や黒板の角を見つけられませんでした。丸を動かして合わせてください");
    return;
  }
  state.cornerEdit = found.map(([x, y]) => [x / canvas.width, y / canvas.height]);
  render();
}

function endCorners(apply) {
  if (apply) {
    const isWhole = state.cornerEdit.every(([x, y], i) => x === WHOLE[i][0] && y === WHOLE[i][1]);
    state.settings.corners = isWhole ? null : state.cornerEdit;
  }
  state.cornerEdit = null;
  render();
}

function placeHandles() {
  els.stage.querySelectorAll(".handle").forEach((h) => h.remove());
  els.frame.hidden = !state.cornerEdit;
  if (!state.cornerEdit) return;
  const { width, height } = els.preview.getBoundingClientRect();
  els.frame.setAttribute("viewBox", `0 0 ${width} ${height}`);
  els.frame.querySelector("polygon").setAttribute("points", state.cornerEdit.map(([x, y]) => `${x * width},${y * height}`).join(" "));
  state.cornerEdit.forEach(([x, y], i) => {
    const handle = document.createElement("div");
    handle.className = "handle";
    handle.tabIndex = 0;
    handle.setAttribute("aria-label", ["左上の角", "右上の角", "右下の角", "左下の角"][i]);
    handle.style.left = `${x * 100}%`;
    handle.style.top = `${y * 100}%`;
    handle.addEventListener("pointerdown", (e) => dragHandle(e, i));
    els.stage.append(handle);
  });
}

function dragHandle(e, index) {
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const rect = els.preview.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
    state.cornerEdit[index] = [x, y];
    handle.style.left = `${x * 100}%`;
    handle.style.top = `${y * 100}%`;
    const { width, height } = rect;
    els.frame.querySelector("polygon").setAttribute("points", state.cornerEdit.map(([px, py]) => `${px * width},${py * height}`).join(" "));
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

/* ---------- drawing ---------- */

function render() {
  cancelAnimationFrame(frameRequest);
  frameRequest = requestAnimationFrame(draw);
}

// The preview: the photo as it will be saved, or (while comparing or placing the corners) the
// photo only turned.
function draw() {
  const has = Boolean(state.bitmap);
  els.welcome.hidden = has;
  els.work.hidden = !has;
  els.saveBtn.disabled = !has || Boolean(state.cornerEdit);
  els.compareBtn.disabled = !has || Boolean(state.cornerEdit);
  els.cornerBar.hidden = !state.cornerEdit;
  if (!has) return;
  const s = state.settings;
  const plain = state.comparing || state.cornerEdit;
  const canvas = plain ? turned(state.previewBase, s.rotation, s.flip, PREVIEW_PX) : recolor(shape(state.previewBase, s, PREVIEW_PX), s);
  els.preview.width = canvas.width;
  els.preview.height = canvas.height;
  els.preview.getContext("2d").drawImage(canvas, 0, 0);
  placeHandles();
  const full = finalSize();
  els.info.textContent = state.cornerEdit ? "" : `${state.file.name}（保存すると ${full.width}×${full.height}）`;
}

// The size of the saved photo.
function finalSize() {
  const base = state.previewBase;
  const k = Math.min(SAVE_PX, Math.max(state.bitmap.width, state.bitmap.height)) / Math.max(base.width, base.height);
  return { width: Math.round(els.preview.width * k), height: Math.round(els.preview.height * k) };
}

/* ---------- saving ---------- */

async function save() {
  if (!state.bitmap) return;
  els.saveBtn.disabled = true;
  showStatus("保存しています…", { sticky: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the message show first
    const canvas = recolor(shape(state.bitmap, state.settings, SAVE_PX), state.settings);
    const { type, ext } = outputType(state.file);
    const blob = await canvasToBlob(canvas, type, JPEG_QUALITY);
    canvas.width = canvas.height = 0;
    download(blob, `${stripExtension(state.file.name)}_補正.${ext}`);
    showStatus("保存しました");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。写真が大きすぎるかもしれません", { error: true });
  } finally {
    els.saveBtn.disabled = false;
  }
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
for (const id of Object.keys(SLIDERS)) $(id).addEventListener("input", (e) => sliderMoved(e.target));
for (const button of document.querySelectorAll(".tab")) button.addEventListener("click", () => chooseTab(button));
els.autoBtn.addEventListener("click", () => {
  state.settings.photo.auto = !state.settings.photo.auto;
  syncControls();
  render();
});
els.invert.addEventListener("change", () => {
  state.settings.board.invert = els.invert.checked;
  rememberBoard();
  render();
});
$("left-btn").addEventListener("click", () => turn(-1));
$("right-btn").addEventListener("click", () => turn(1));
els.flipBtn.addEventListener("click", () => {
  state.settings.flip = !state.settings.flip;
  state.settings.corners = null;
  syncControls();
  render();
});
$("corners-btn").addEventListener("click", startCorners);
$("corners-auto").addEventListener("click", autoCorners);
$("corners-whole").addEventListener("click", () => {
  state.cornerEdit = WHOLE.map((p) => [...p]);
  render();
});
$("corners-cancel").addEventListener("click", () => endCorners(false));
$("corners-ok").addEventListener("click", () => endCorners(true));
$("reset-btn").addEventListener("click", reset);
const compare = (on) => {
  if (state.comparing === on) return;
  state.comparing = on;
  render();
};
els.compareBtn.addEventListener("pointerdown", () => compare(true));
for (const type of ["pointerup", "pointerleave", "pointercancel"]) els.compareBtn.addEventListener(type, () => compare(false));
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: "image" });
window.addEventListener("resize", () => placeHandles());
window.addEventListener("paste", (e) => {
  const file = e.clipboardData?.files?.[0];
  if (file) openFile(file);
});
onFileDrop((files) => openFile(files[0]));
syncControls();
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "adjust.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__photoFix = { state, openFile, save, render, finalSize };
