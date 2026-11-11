import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop, onFilePaste } from "../shared/js/files.js";
import { isImage } from "../shared/js/heic.js";
import { loadPhoto, makeCanvas, fitWithin } from "../shared/js/photo.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { encodeGif } from "./gif.js";
import "../shared/js/guide.js";
import { iconButton } from "../shared/js/buttons.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "gif-maker-settings-v1";
const MAX_FRAMES = 120;
const FRAME_PX = 1000; // each photo is kept at most this big (long side)
const THUMB_WIDTH = 160; // px
const THUMB_HEIGHT = 120;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  cameraBtn: $("camera-btn"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  delay: $("delay"),
  size: $("size"),
  bounce: $("bounce"),
  count: $("count"),
  frames: $("frames"),
  camera: $("camera"),
  video: $("video"),
  onion: $("onion"),
  onionField: $("onion-field"),
  onionOn: $("onion-on"),
  preview: $("preview"),
  playBtn: $("play-btn"),
  shootBtn: $("shoot-btn"),
  cameraClose: $("camera-close"),
  info: $("info"),
};

const settings = Object.assign({ delay: 0.5, size: 480, loop: true, fit: "cover", bounce: false }, loadJson(SETTINGS_KEY, {}));
const state = {
  frames: [], // { bitmap, thumb }
  playing: true,
  shown: 0, // the step of the animation on screen
  stream: null, // the camera, while it is on
};
let timer = 0;

/* ---------- adding frames ---------- */

async function addFiles(fileList) {
  const files = [...fileList].filter(isImage).sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  if (!files.length) return showStatus("写真・画像のファイルを選んでください", { error: true });
  for (const file of files) {
    if (state.frames.length >= MAX_FRAMES) {
      showStatus(`コマは${MAX_FRAMES}コマまでです`, { error: true });
      break;
    }
    try {
      addFrame(await shrink(await loadPhoto(file)));
    } catch (err) {
      console.error(err);
      showStatus(`${file.name} を開けませんでした`, { error: true });
    }
  }
  changedFrames();
}

// A copy no larger than FRAME_PX; the original is let go.
async function shrink(source) {
  const size = fitWithin(source.width, source.height, FRAME_PX);
  const bitmap = await createImageBitmap(source, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "high" });
  source.close?.();
  return bitmap;
}

function addFrame(bitmap, at = state.frames.length) {
  state.frames.splice(at, 0, { bitmap });
}

/* ---------- the list of frames ---------- */

function renderList() {
  els.count.textContent = state.frames.length;
  els.frames.replaceChildren(...state.frames.map((frame, index) => frameCard(frame, index)));
}

function frameCard(frame, index) {
  const li = document.createElement("li");
  li.className = "frame";
  const thumb = makeCanvas(THUMB_WIDTH, THUMB_HEIGHT);
  drawFrame(thumb.getContext("2d"), frame.bitmap, THUMB_WIDTH, THUMB_HEIGHT);
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  buttons.append(
    iconButton("i-left", "前へ", () => move(index, -1), { disabled: index === 0 }),
    iconButton("i-copy", "このコマを増やす（長く見せる）", () => duplicate(index)),
    iconButton("i-right", "後ろへ", () => move(index, 1), { disabled: index === state.frames.length - 1 }),
    iconButton("i-close", "このコマを外す", () => remove(index)),
  );
  li.append(thumb, `${index + 1}`, buttons);
  return li;
}

function move(index, step) {
  const [frame] = state.frames.splice(index, 1);
  state.frames.splice(index + step, 0, frame);
  changedFrames();
}

function duplicate(index) {
  if (state.frames.length >= MAX_FRAMES) return;
  state.frames.splice(index + 1, 0, { bitmap: state.frames[index].bitmap });
  changedFrames();
}

function remove(index) {
  const [frame] = state.frames.splice(index, 1);
  if (!state.frames.some((f) => f.bitmap === frame.bitmap)) frame.bitmap.close();
  changedFrames();
}

function changedFrames() {
  state.shown = 0;
  renderList();
  render();
}

/* ---------- the animation ---------- */

// The size of the GIF: the first frame's shape, at most `settings.size` on its long side.
function outputSize() {
  const first = state.frames[0].bitmap;
  return fitWithin(first.width, first.height, settings.size);
}

// The frames in the order they play: there and back again for 行ったり来たり.
function sequence() {
  const order = state.frames.map((_, i) => i);
  if (!settings.bounce || order.length < 3) return order;
  return [...order, ...order.slice(1, -1).reverse()];
}

function drawFrame(ctx, bitmap, width, height) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  const pick = settings.fit === "cover" ? Math.max : Math.min;
  const k = pick(width / bitmap.width, height / bitmap.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (width - bitmap.width * k) / 2, (height - bitmap.height * k) / 2, bitmap.width * k, bitmap.height * k);
}

function render() {
  clearTimeout(timer);
  const has = state.frames.length > 0 || Boolean(state.stream);
  els.welcome.hidden = has;
  els.work.hidden = !has;
  els.saveBtn.disabled = state.frames.length === 0;
  syncControls();
  if (!state.frames.length || state.stream) return;
  const order = sequence();
  state.shown %= order.length;
  const index = order[state.shown];
  const { width, height } = outputSize();
  els.preview.width = width;
  els.preview.height = height;
  drawFrame(els.preview.getContext("2d"), state.frames[index].bitmap, width, height);
  els.frames.querySelectorAll(".frame").forEach((card, i) => card.classList.toggle("current", i === index));
  els.info.textContent = `${state.frames.length}コマ・1回 ${(order.length * settings.delay).toFixed(1)}秒・${width}×${height}`;
  if (state.playing && order.length > 1) {
    timer = setTimeout(() => {
      state.shown++;
      render();
    }, settings.delay * 1000);
  }
}

/* ---------- the camera (コマ撮り) ---------- */

async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (err) {
    console.error(err);
    showStatus("カメラを使えませんでした。ブラウザのカメラの許可を確かめてください", { error: true });
    return;
  }
  els.video.srcObject = state.stream;
  await els.video.play();
  drawOnion();
  render();
}

function stopCamera() {
  for (const track of state.stream?.getTracks() ?? []) track.stop();
  state.stream = null;
  els.video.srcObject = null;
  render();
}

async function shoot() {
  if (!state.stream || state.frames.length >= MAX_FRAMES) return;
  const bitmap = await shrink(await createImageBitmap(els.video));
  addFrame(bitmap);
  renderList();
  drawOnion();
  syncControls();
  els.saveBtn.disabled = false;
  els.info.textContent = `${state.frames.length}コマ目を撮りました`;
}

// The last frame, laid faintly over the camera, so the next one can be lined up with it.
function drawOnion() {
  const last = state.frames.at(-1);
  const width = els.video.videoWidth || 1;
  const height = els.video.videoHeight || 1;
  els.onion.width = width;
  els.onion.height = height;
  const ctx = els.onion.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  if (last && els.onionOn.checked) ctx.drawImage(last.bitmap, 0, 0, width, height);
}

/* ---------- settings ---------- */

function syncControls() {
  const camera = Boolean(state.stream);
  els.camera.hidden = !camera;
  els.preview.hidden = camera;
  els.playBtn.hidden = camera;
  els.shootBtn.hidden = !camera;
  els.onionField.hidden = !camera;
  els.cameraClose.hidden = !camera;
  els.cameraBtn.disabled = camera;
  els.delay.value = settings.delay;
  els.delay.nextElementSibling.textContent = `${settings.delay}秒`;
  els.size.value = settings.size;
  els.bounce.checked = settings.bounce;
  for (const button of document.querySelectorAll("[data-loop]")) button.setAttribute("aria-checked", String(button.dataset.loop === String(settings.loop)));
  for (const button of document.querySelectorAll("[data-fit]")) button.setAttribute("aria-checked", String(button.dataset.fit === settings.fit));
  els.playBtn.setAttribute("aria-pressed", String(state.playing));
  els.playBtn.querySelector("use").setAttribute("href", state.playing ? "#i-pause" : "#i-play");
  els.playBtn.querySelector("span").textContent = state.playing ? "止める" : "動かす";
}

function changed() {
  settings.delay = Number(els.delay.value);
  settings.size = Number(els.size.value);
  settings.bounce = els.bounce.checked;
  saveJson(SETTINGS_KEY, settings);
  renderList();
  render();
}

/* ---------- saving ---------- */

async function save() {
  if (!state.frames.length) return;
  els.saveBtn.disabled = true;
  showStatus("GIFを作っています…", { sticky: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the message show first
    const { width, height } = outputSize();
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const images = sequence().map((index) => {
      drawFrame(ctx, state.frames[index].bitmap, width, height);
      return ctx.getImageData(0, 0, width, height);
    });
    const bytes = encodeGif(images, { delayMs: settings.delay * 1000, loop: settings.loop });
    download(new Blob([bytes], { type: "image/gif" }), "GIFアニメ.gif");
    showStatus("GIFを保存しました");
  } catch (err) {
    console.error(err);
    showStatus("GIFを作れませんでした", { error: true });
  } finally {
    els.saveBtn.disabled = false;
  }
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.cameraBtn.addEventListener("click", startCamera);
els.cameraClose.addEventListener("click", stopCamera);
els.shootBtn.addEventListener("click", shoot);
els.onionOn.addEventListener("change", drawOnion);
els.playBtn.addEventListener("click", () => {
  state.playing = !state.playing;
  render();
});
els.delay.addEventListener("input", changed);
for (const el of [els.size, els.bounce]) el.addEventListener("change", changed);
for (const button of document.querySelectorAll("[data-loop]")) {
  button.addEventListener("click", () => {
    settings.loop = button.dataset.loop === "true";
    changed();
  });
}
for (const button of document.querySelectorAll("[data-fit]")) {
  button.addEventListener("click", () => {
    settings.fit = button.dataset.fit;
    changed();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== " " || !state.stream || e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  shoot();
});
els.saveBtn.addEventListener("click", save);
onFilePaste(addFiles);
onFileDrop(addFiles);
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "gif.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__gifMaker = { state, settings, addFiles, save, startCamera, shoot, stopCamera };
