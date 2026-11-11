import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop, onFilePaste } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage } from "../shared/js/heic.js";
import { loadPhoto, stripExtension, makeCanvas, fitWithin } from "../shared/js/photo.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { loadScript } from "../shared/js/load-script.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import "../shared/js/guide.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "bg-remove-settings-v1";
const WORK_PX = 2048; // the photo is worked on at most this big (long side)
const JPEG_QUALITY = 0.92;
// MediaPipe and its person-finding model, the same files かおトリ uses (shared/vendor).
const LIBRARIES = [
  ["mediapipe-tasks-vision-1.2.0/vision.js", "MPVision"],
  ["mediapipe-tasks-vision-1.2.0/wasm.js", "KAO_WASM_B64"],
  ["mediapipe-face-models/selfie-segmenter.js", "KAO_MODEL_SEGMENTER"],
];

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  aiStatus: $("ai-status"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  colorField: $("color-field"),
  color: $("color"),
  blurField: $("blur-field"),
  blur: $("blur"),
  photoField: $("photo-field"),
  backgroundInput: $("background-input"),
  backgroundName: $("background-name"),
  spread: $("spread"),
  soft: $("soft"),
  brushSize: $("brush-size"),
  clearEdits: $("clear-edits"),
  preview: $("preview"),
  info: $("info"),
};

const settings = Object.assign({ background: "clear", color: "#ffffff", blur: 14, spread: 0, soft: 3, brushSize: 40 }, loadJson(SETTINGS_KEY, {}));
const state = {
  file: null,
  source: null, // the photo at WORK_PX
  confidence: null, // { width, height, values: Float32Array }: how sure the AI is that each spot is a person
  keep: null, // canvas: where the 残すペン painted (white)
  erase: null, // canvas: where the 消すペン painted (white)
  edited: false,
  backgroundPhoto: null, // ImageBitmap for 別の写真
  brush: "none",
};
let segmenter = null;
let segmenterLoading = null;
let frameRequest = 0;

/* ---------- the AI ---------- */

async function base64ToBytes(base64) {
  const response = await fetch(`data:application/octet-stream;base64,${base64}`);
  return new Uint8Array(await response.arrayBuffer());
}

// MediaPipe's image segmenter with the selfie model, made once. The WebAssembly is kept as
// base64 JavaScript (as in かおトリ) so it also works when the page is opened from a file.
function loadSegmenter() {
  segmenterLoading ??= (async () => {
    for (const [path, name] of LIBRARIES) await loadScript(path, name);
    const loader = new Blob([window.KAO_WASM_LOADER], { type: "text/javascript" });
    const wasm = new Blob([await base64ToBytes(window.KAO_WASM_B64)], { type: "application/wasm" });
    const fileset = { wasmLoaderPath: URL.createObjectURL(loader), wasmBinaryPath: URL.createObjectURL(wasm) };
    segmenter = await window.MPVision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: await base64ToBytes(window.KAO_MODEL_SEGMENTER), delegate: "CPU" },
      runningMode: "IMAGE",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    return segmenter;
  })();
  return segmenterLoading;
}

async function prepareAi() {
  try {
    await loadSegmenter();
    els.aiStatus.textContent = "";
  } catch (err) {
    console.error(err);
    els.aiStatus.textContent = "人を見つけるAIを読み込めませんでした";
    els.aiStatus.classList.add("error");
  }
}

// How sure the AI is, for each spot of the photo, that it shows a person.
function findPerson(canvas) {
  const result = segmenter.segment(canvas);
  try {
    const mask = result.confidenceMasks.at(-1);
    return { width: mask.width, height: mask.height, values: Float32Array.from(mask.getAsFloat32Array()) };
  } finally {
    result.close?.();
  }
}

/* ---------- opening ---------- */

async function openFile(file) {
  if (!file) return;
  if (!isImage(file)) return showStatus("写真・画像のファイルを選んでください", { error: true });
  showStatus("人をさがしています…", { sticky: true });
  try {
    const bitmap = await loadPhoto(file);
    const size = fitWithin(bitmap.width, bitmap.height, WORK_PX);
    const source = makeCanvas(size.width, size.height);
    source.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    await loadSegmenter();
    state.file = file;
    state.source = source;
    state.confidence = findPerson(source);
    state.keep = makeCanvas(size.width, size.height);
    state.erase = makeCanvas(size.width, size.height);
    state.edited = false;
    showStatus("人を切り抜きました");
    render();
  } catch (err) {
    console.error(err);
    showStatus(`${file.name} を開けませんでした`, { error: true });
  }
}

async function openBackground(file) {
  if (!file || !isImage(file)) return;
  try {
    state.backgroundPhoto?.close();
    state.backgroundPhoto = await loadPhoto(file);
    els.backgroundName.textContent = file.name;
    render();
  } catch (err) {
    console.error(err);
    showStatus(`${file.name} を開けませんでした`, { error: true });
  }
}

/* ---------- cutting out ---------- */

// The part to keep, as the alpha of a canvas the size of the photo: the AI's answer made sharper
// or wider by 残す広さ, softened by やわらかさ, then the pen strokes.
function alphaMask() {
  const { width, height, values } = state.confidence;
  const small = makeCanvas(width, height);
  const sctx = small.getContext("2d");
  const image = sctx.createImageData(width, height);
  const middle = 0.5 - settings.spread * 0.04;
  for (let i = 0; i < values.length; i++) {
    const alpha = (values[i] - middle) * 4 + 0.5;
    image.data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  }
  sctx.putImageData(image, 0, 0);
  const { width: w, height: h } = state.source;
  const mask = makeCanvas(w, h);
  const ctx = mask.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.filter = `blur(${(settings.soft * Math.max(w, h)) / 1500}px)`;
  ctx.drawImage(small, 0, 0, w, h);
  ctx.filter = "none";
  ctx.drawImage(state.keep, 0, 0);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(state.erase, 0, 0);
  return mask;
}

// The finished picture: the chosen background, then the person on top.
function compose() {
  const { width, height } = state.source;
  const person = makeCanvas(width, height);
  const pctx = person.getContext("2d");
  pctx.drawImage(state.source, 0, 0);
  pctx.globalCompositeOperation = "destination-in";
  pctx.drawImage(alphaMask(), 0, 0);
  const out = makeCanvas(width, height);
  const ctx = out.getContext("2d");
  drawBackground(ctx, width, height);
  ctx.drawImage(person, 0, 0);
  return out;
}

function drawBackground(ctx, width, height) {
  if (settings.background === "color") {
    ctx.fillStyle = settings.color;
    ctx.fillRect(0, 0, width, height);
  } else if (settings.background === "blur") {
    // Drawn a little larger so the blurred edges do not fade in from transparent.
    const blur = (settings.blur * Math.max(width, height)) / 1000;
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(state.source, -blur * 2, -blur * 2, width + blur * 4, height + blur * 4);
    ctx.filter = "none";
  } else if (settings.background === "photo" && state.backgroundPhoto) {
    const photo = state.backgroundPhoto;
    const k = Math.max(width / photo.width, height / photo.height);
    ctx.drawImage(photo, (width - photo.width * k) / 2, (height - photo.height * k) / 2, photo.width * k, photo.height * k);
  }
}

/* ---------- the pens ---------- */

function paint(e, last) {
  const rect = els.preview.getBoundingClientRect();
  const scale = state.source.width / rect.width;
  const x = (e.clientX - rect.left) * scale;
  const y = (e.clientY - rect.top) * scale;
  const radius = (settings.brushSize * scale) / 2;
  const [paintOn, clearFrom] = state.brush === "keep" ? [state.keep, state.erase] : [state.erase, state.keep];
  strokeTo(paintOn.getContext("2d"), "source-over", last ?? [x, y], [x, y], radius);
  strokeTo(clearFrom.getContext("2d"), "destination-out", last ?? [x, y], [x, y], radius);
  state.edited = true;
  render();
  return [x, y];
}

function strokeTo(ctx, operation, from, to, radius) {
  ctx.globalCompositeOperation = operation;
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineWidth = radius * 2;
  ctx.beginPath();
  ctx.moveTo(...from);
  ctx.lineTo(...to);
  ctx.stroke();
}

function startPainting(e) {
  if (state.brush === "none" || !state.source) return;
  e.preventDefault();
  els.preview.setPointerCapture(e.pointerId);
  let last = paint(e, null);
  const move = (ev) => (last = paint(ev, last));
  const up = () => {
    els.preview.removeEventListener("pointermove", move);
    els.preview.removeEventListener("pointerup", up);
    els.preview.removeEventListener("pointercancel", up);
  };
  els.preview.addEventListener("pointermove", move);
  els.preview.addEventListener("pointerup", up);
  els.preview.addEventListener("pointercancel", up);
}

function clearEdits() {
  for (const canvas of [state.keep, state.erase]) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  state.edited = false;
  render();
}

/* ---------- screen ---------- */

function render() {
  cancelAnimationFrame(frameRequest);
  frameRequest = requestAnimationFrame(draw);
}

function draw() {
  const has = Boolean(state.source);
  els.welcome.hidden = has;
  els.work.hidden = !has;
  els.saveBtn.disabled = !has;
  els.clearEdits.disabled = !state.edited;
  syncControls();
  if (!has) return;
  const canvas = compose();
  els.preview.width = canvas.width;
  els.preview.height = canvas.height;
  els.preview.getContext("2d").drawImage(canvas, 0, 0);
  els.preview.classList.toggle("painting", state.brush !== "none");
  els.info.textContent = `${state.file.name}（${canvas.width}×${canvas.height}）`;
}

function syncControls() {
  for (const button of document.querySelectorAll("[data-background]")) button.setAttribute("aria-checked", String(button.dataset.background === settings.background));
  for (const button of document.querySelectorAll("[data-brush]")) button.setAttribute("aria-checked", String(button.dataset.brush === state.brush));
  els.colorField.hidden = settings.background !== "color";
  els.blurField.hidden = settings.background !== "blur";
  els.photoField.hidden = settings.background !== "photo";
  els.color.value = settings.color;
  for (const key of ["blur", "spread", "soft", "brushSize"]) {
    els[key].value = settings[key];
    els[key].nextElementSibling.textContent = settings[key];
  }
}

function changed() {
  settings.color = els.color.value;
  for (const key of ["blur", "spread", "soft", "brushSize"]) settings[key] = Number(els[key].value);
  saveJson(SETTINGS_KEY, settings);
  render();
}

/* ---------- saving ---------- */

async function save() {
  if (!state.source) return;
  try {
    const clear = settings.background === "clear";
    const blob = await canvasToBlob(compose(), clear ? "image/png" : "image/jpeg", JPEG_QUALITY);
    const name = stripExtension(state.file.name);
    download(blob, clear ? `${name}_背景なし.png` : `${name}_背景.jpg`);
    showStatus("保存しました");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした", { error: true });
  }
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.backgroundInput.addEventListener("change", () => {
  openBackground(els.backgroundInput.files[0]);
  els.backgroundInput.value = "";
});
for (const button of document.querySelectorAll("[data-background]")) {
  button.addEventListener("click", () => {
    settings.background = button.dataset.background;
    changed();
    if (settings.background === "photo" && !state.backgroundPhoto) els.backgroundInput.click();
  });
}
for (const button of document.querySelectorAll("[data-brush]")) {
  button.addEventListener("click", () => {
    state.brush = button.dataset.brush;
    render();
  });
}
els.color.addEventListener("input", changed);
for (const key of ["blur", "spread", "soft", "brushSize"]) els[key].addEventListener("input", changed);
els.clearEdits.addEventListener("click", clearEdits);
els.preview.addEventListener("pointerdown", startPainting);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: "image" });
onFilePaste((files) => openFile(files[0]));
onFileDrop((files) => openFile(files[0]));
render();
prepareAi();

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/mediapipe-tasks-vision-1.2.0/vision.js",
  "../shared/vendor/mediapipe-tasks-vision-1.2.0/wasm.js",
  "../shared/vendor/mediapipe-face-models/selfie-segmenter.js",
]);

// Hook for automated tests.
window.__bgRemove = { state, settings, openFile, save, compose, loadSegmenter };
