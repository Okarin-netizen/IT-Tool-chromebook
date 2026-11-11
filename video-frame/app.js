// 動画から写真: finds a moment in a video (play, slider, one frame or one second at a time) and
// keeps it as a photo. It can pick the sharpest frame near the chosen one (the Laplacian-variance
// score sharp-frames and sharp-frame-extractor use) and take a photo every few seconds, as
// LosslessCut's frame export does. The video is played by the browser's own <video>, so it opens
// whatever Chrome on the device can play; Mediabunny is only used to read the frame rate.
import { showStatus, hideStatus } from "../shared/js/status.js";
import { download, onFileDrop, safeFileName } from "../shared/js/files.js";
import { makeCanvas, fitWithin, stripExtension } from "../shared/js/photo.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { loadScript } from "../shared/js/pdf-lib.js";
import { makeZip } from "../shared/js/zip.js";
import { addNextTool } from "../shared/js/handoff.js";
import { registerOffline } from "../shared/js/offline.js";
import "../shared/js/guide.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "video-frame-settings-v1";
const MEDIABUNNY = "mediabunny-1.65.0/mediabunny.min.js";
const DEFAULT_FPS = 30; // frames per second, when the video does not say
const MAX_FPS = 240;
const MAX_SHOTS = 300; // photos kept at once
const THUMB_WIDTH = 320; // px
const JPEG_QUALITY = 0.92;
const SHARP_SPAN_SECONDS = 0.5; // ブレの少ないコマ looks this far before and after the frame
const SHARP_MAX_FRAMES = 7; // ...but at most this many frames each way
const SHARP_BATCH_FRAMES = 3; // ...and this many in まとめて切り出す, so it stays quick
const SHARP_WIDTH = 480; // px: frames are compared at this width
const SHARPER_BY = 1.1; // a farther frame must score this many times higher to be chosen
const SEEK_TIMEOUT_MS = 3000;
const FRAME_SHOWN_MS = 150; // wait at most this long for a frame to be shown after a seek
const NEW_MARK_MS = 1500; // a new photo is outlined this long

const FORMATS = {
  jpg: { type: "image/jpeg", ext: "jpg" },
  png: { type: "image/png", ext: "png" },
};

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  video: $("video"),
  seek: $("seek"),
  time: $("time"),
  playBtn: $("play-btn"),
  backSecond: $("back-second"),
  backFrame: $("back-frame"),
  nextFrame: $("next-frame"),
  nextSecond: $("next-second"),
  speed: $("speed"),
  shotBtn: $("shot-btn"),
  info: $("info"),
  fromText: $("from-text"),
  toText: $("to-text"),
  fromBtn: $("from-btn"),
  toBtn: $("to-btn"),
  every: $("every"),
  everyField: $("every-field"),
  count: $("count"),
  countField: $("count-field"),
  batchInfo: $("batch-info"),
  batchBtn: $("batch-btn"),
  size: $("size"),
  sharp: $("sharp"),
  shots: $("shots"),
  shotCount: $("shot-count"),
  shotsEmpty: $("shots-empty"),
  clearBtn: $("clear-btn"),
};
const video = els.video;

const settings = Object.assign(
  { format: "jpg", size: 0, sharp: false, mode: "every", every: 1, count: 10 },
  loadJson(SETTINGS_KEY, {}),
);
const state = {
  videoId: 0, // counts the videos opened, so a photo knows which video it came from
  name: "", // the video's file name without its extension
  url: "",
  fps: DEFAULT_FPS,
  duration: 0, // seconds
  from: 0, // まとめて切り出す: the first and last moment (seconds)
  to: 0,
  wanted: null, // the frame the step buttons are moving to
  shots: [], // { time, frame, blob, thumb, base, videoId, item }
  busy: "", // "shot" or "batch" while working
  stop: false, // まとめて切り出す was asked to stop
  dirty: false, // photos taken since the last save
};
let moving = null; // the running seek of the step buttons
let sharpCtx = null;

/* ---------- opening a video ---------- */

const isVideo = (file) => file.type.startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name);

async function openVideo(file) {
  if (!file || state.busy) return;
  if (!isVideo(file)) return showStatus("動画のファイル（MP4・MOV・WebM）を選んでください", { error: true });
  video.pause();
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  showStatus("動画を読み込んでいます…", { sticky: true });
  try {
    await loadVideo(state.url);
    state.duration = await knownDuration();
  } catch (err) {
    console.error(err);
    return showUnplayable();
  }
  state.videoId++;
  state.name = stripExtension(file.name);
  state.fps = await frameRate(file);
  state.from = 0;
  state.to = state.duration;
  state.wanted = null;
  els.welcome.hidden = true;
  els.work.hidden = false;
  els.info.classList.remove("warn");
  els.info.textContent = videoInfo();
  await seekTo(frameTime(0));
  hideStatus();
  render();
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const loaded = () => {
      cleanUp();
      // A file with sound only, or a picture the browser cannot decode, has no size.
      if (video.videoWidth > 0) resolve();
      else reject(new Error("no picture"));
    };
    const failed = () => {
      cleanUp();
      reject(video.error);
    };
    const cleanUp = () => {
      video.removeEventListener("loadeddata", loaded);
      video.removeEventListener("error", failed);
    };
    video.addEventListener("loadeddata", loaded);
    video.addEventListener("error", failed);
    video.src = url;
  });
}

// Videos recorded in a browser (WebM) may not say how long they are until the end is read.
async function knownDuration() {
  if (Number.isFinite(video.duration)) return video.duration;
  await new Promise((resolve) => {
    video.addEventListener("durationchange", resolve, { once: true });
    setTimeout(resolve, SEEK_TIMEOUT_MS);
    video.currentTime = Number.MAX_SAFE_INTEGER;
  });
  const duration = video.duration;
  video.currentTime = 0;
  if (!Number.isFinite(duration)) throw new Error("unknown duration");
  return duration;
}

// The frames per second, read from the file by Mediabunny. Phones record at a changing rate,
// so this is the average; stepping by it lands on each frame closely enough.
async function frameRate(file) {
  try {
    const MB = await loadScript(MEDIABUNNY, "Mediabunny");
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const stats = await track?.computePacketStats(120);
    input.dispose?.();
    const rate = stats?.averagePacketRate;
    if (rate > 1 && rate <= MAX_FPS) return rate;
  } catch (err) {
    console.warn("could not read the frame rate", err);
  }
  return DEFAULT_FPS;
}

function showUnplayable() {
  showStatus(
    "この動画は、このパソコンのブラウザでは開けません。iPhoneの動画なら、iPhoneの「設定」→「カメラ」→「フォーマット」を「互換性優先」にして撮ると開けます",
    { error: true, sticky: true },
  );
}

function videoInfo() {
  const fps = Math.round(state.fps * 10) / 10;
  return `${video.videoWidth}×${video.videoHeight}　長さ ${clockText(state.duration)}　1秒に約${fps}コマ`;
}

/* ---------- frames and time ---------- */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const lastFrame = () => Math.max(0, Math.ceil(state.duration * state.fps - 0.5) - 1);
const frameOf = (time) => clamp(Math.floor(time * state.fps + 1e-6), 0, lastFrame());
const frameStart = (frame) => frame / state.fps;
// Seeking to the middle of a frame shows that frame even when timestamps are a little off.
const frameTime = (frame) => Math.min((frame + 0.5) / state.fps, Math.max(0, state.duration - 0.001));
const currentFrame = () => frameOf(video.currentTime);

// "1:05.20"
function clockText(seconds) {
  const hundredths = Math.floor(seconds * 100 + 1e-6);
  const minutes = Math.floor(hundredths / 6000);
  const secs = String(Math.floor(hundredths / 100) % 60).padStart(2, "0");
  const rest = String(hundredths % 100).padStart(2, "0");
  return `${minutes}:${secs}.${rest}`;
}

// "1分05秒20", for file names
function nameTime(seconds) {
  const [minutes, rest] = clockText(seconds).split(":");
  const [secs, hundredths] = rest.split(".");
  return `${minutes}分${secs}秒${hundredths}`;
}

// Moves the video to `time` and waits until that frame is on screen.
function seekTo(time) {
  return new Promise((resolve) => {
    let seeked = false;
    let shown = false;
    const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
    function finish() {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      resolve();
    }
    function onSeeked() {
      seeked = true;
      if (shown) return finish();
      setTimeout(finish, FRAME_SHOWN_MS);
    }
    video.requestVideoFrameCallback?.(() => {
      shown = true;
      if (seeked) finish();
    });
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
  });
}

function goToFrame(frame) {
  video.pause();
  state.wanted = clamp(frame, 0, lastFrame());
  moving ??= followWanted().finally(() => {
    moving = null;
  });
  return moving;
}

// Steps queue up while a seek runs (holding down an arrow key), and only the last one is shown.
async function followWanted() {
  while (state.wanted !== null) {
    const frame = state.wanted;
    await seekTo(frameTime(frame));
    if (state.wanted === frame) state.wanted = null;
  }
  renderTime();
}

function step(frames) {
  if (state.busy) return;
  const from = state.wanted ?? currentFrame();
  goToFrame(from + frames);
}

const stepSeconds = (seconds) => step(Math.round(seconds * state.fps));

function togglePlay() {
  if (state.busy) return;
  if (video.paused) {
    state.wanted = null;
    if (video.currentTime >= state.duration - 0.05) video.currentTime = 0;
    video.play();
  } else {
    video.pause();
  }
}

/* ---------- ブレの少ないコマ ---------- */

// How sharp the frame on screen is: the variance of the Laplacian of its shades of gray.
// Blurred frames (moving fast, out of focus) have few sharp edges and score low.
function sharpness() {
  const width = Math.min(SHARP_WIDTH, video.videoWidth);
  const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
  sharpCtx ??= makeCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  sharpCtx.canvas.width = width;
  sharpCtx.canvas.height = height;
  sharpCtx.drawImage(video, 0, 0, width, height);
  const { data } = sharpCtx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += laplacian;
      sumOfSquares += laplacian * laplacian;
      count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumOfSquares / count - mean * mean;
}

// The frames from `reach` before `center` to `reach` after it, nearest first: 50, 49, 51, 48…
function framesAround(center, reach) {
  const frames = [center];
  for (let distance = 1; distance <= reach; distance++) frames.push(center - distance, center + distance);
  return frames.filter((frame) => frame >= 0 && frame <= lastFrame());
}

// The sharpest frame near `center`. A farther frame has to be clearly sharper to win, so of
// frames about as sharp the nearest one (closest to the moment chosen) is kept.
async function sharpestNear(center, reach) {
  let best = center;
  let bestScore = -1;
  for (const frame of framesAround(center, reach)) {
    await seekTo(frameTime(frame));
    const score = sharpness();
    if (score > bestScore * SHARPER_BY) {
      bestScore = score;
      best = frame;
    }
  }
  return best;
}

const singleReach = () => Math.min(SHARP_MAX_FRAMES, Math.round(SHARP_SPAN_SECONDS * state.fps));

/* ---------- taking photos ---------- */

function outputSize() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!settings.size) return { width, height };
  return fitWithin(width, height, settings.size);
}

function thumbnail(source) {
  const height = Math.round((THUMB_WIDTH * source.height) / source.width);
  const thumb = makeCanvas(THUMB_WIDTH, height);
  thumb.getContext("2d").drawImage(source, 0, 0, thumb.width, thumb.height);
  return thumb;
}

// Keeps the frame on screen as a photo.
async function addShot(frame) {
  const size = outputSize();
  const canvas = makeCanvas(size.width, size.height);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const format = FORMATS[settings.format];
  const blob = await canvasToBlob(canvas, format.type, JPEG_QUALITY);
  const shot = { time: frameStart(frame), frame, blob, thumb: thumbnail(canvas), base: state.name, videoId: state.videoId };
  shot.item = shotItem(shot);
  state.shots.push(shot);
  state.dirty = true;
  renderShots();
  markNew(shot);
  return shot;
}

async function takeShot() {
  if (state.busy || els.work.hidden) return;
  if (state.shots.length >= MAX_SHOTS) return showStatus(`写真は${MAX_SHOTS}枚までです。保存してから「全部外す」で空けてください`, { error: true });
  video.pause();
  await moving;
  setBusy("shot");
  try {
    let frame = currentFrame();
    if (settings.sharp) {
      showStatus("近くのコマから、くっきりしたコマをさがしています…", { sticky: true });
      frame = await sharpestNear(frame, singleReach());
    }
    await seekTo(frameTime(frame));
    await addShot(frame);
    showStatus(`${clockText(frameStart(frame))} の場面を写真にしました`);
  } catch (err) {
    console.error(err);
    showStatus("写真にできませんでした", { error: true });
  } finally {
    setBusy("");
  }
}

/* ---------- まとめて切り出す ---------- */

// The frames まとめて切り出す will take, from はじめ to おわり.
function batchFrames() {
  const first = frameOf(Math.min(state.from, state.to));
  const last = frameOf(Math.max(state.from, state.to));
  const frames = [];
  if (settings.mode === "every") {
    const gap = Math.max(1, Math.round(settings.every * state.fps));
    for (let frame = first; frame <= last; frame += gap) frames.push(frame);
    return frames;
  }
  const count = Math.max(1, Math.round(settings.count));
  if (count === 1) return [first];
  for (let i = 0; i < count; i++) frames.push(Math.round(first + (i * (last - first)) / (count - 1)));
  return [...new Set(frames)];
}

// How far ブレの少ないコマ may look in まとめて切り出す: never past halfway to the next photo.
function batchReach(frames) {
  if (frames.length < 2) return SHARP_BATCH_FRAMES;
  const gap = frames[1] - frames[0];
  return clamp(Math.floor((gap - 1) / 2), 0, SHARP_BATCH_FRAMES);
}

async function runBatch() {
  if (state.busy === "batch") {
    state.stop = true;
    return;
  }
  if (state.busy || els.work.hidden) return;
  const frames = batchFrames();
  const room = MAX_SHOTS - state.shots.length;
  if (frames.length > room) return showStatus(`写真は${MAX_SHOTS}枚までです（あと${room}枚）。間かくを広げるか、はじめとおわりをせまくしてください`, { error: true });
  video.pause();
  await moving;
  setBusy("batch");
  const reach = batchReach(frames);
  let taken = 0;
  try {
    for (const frame of frames) {
      if (state.stop) break;
      showStatus(`まとめて切り出しています… ${taken + 1} / ${frames.length}`, { sticky: true });
      let chosen = frame;
      if (settings.sharp) chosen = await sharpestNear(frame, reach);
      await seekTo(frameTime(chosen));
      await addShot(chosen);
      taken++;
    }
    const message = state.stop ? `とちゅうでやめました（${taken}枚）` : `${taken}枚の写真を切り出しました`;
    showStatus(message);
  } catch (err) {
    console.error(err);
    showStatus(`とちゅうで止まりました（${taken}枚）`, { error: true });
  } finally {
    setBusy("");
  }
}

/* ---------- the photos taken ---------- */

function shotItem(shot) {
  const li = document.createElement("li");
  li.className = "shot";
  const thumbButton = document.createElement("button");
  thumbButton.className = "thumb";
  thumbButton.title = "この場面にもどる";
  thumbButton.append(shot.thumb);
  thumbButton.addEventListener("click", () => showShot(shot));
  const meta = document.createElement("div");
  meta.className = "meta";
  const label = document.createElement("span");
  label.textContent = clockText(shot.time);
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  buttons.append(
    iconButton("i-save", "この写真だけ保存", () => saveOne(shot)),
    iconButton("i-close", "この写真を外す", () => removeShot(shot)),
  );
  meta.append(label, buttons);
  li.append(thumbButton, meta);
  return li;
}

function iconButton(icon, title, onClick) {
  const button = document.createElement("button");
  button.className = "btn icon";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg class="i" aria-hidden="true"><use href="#${icon}"/></svg>`;
  button.addEventListener("click", onClick);
  return button;
}

function markNew(shot) {
  shot.item.classList.add("new");
  shot.item.scrollIntoView({ block: "nearest" });
  setTimeout(() => shot.item.classList.remove("new"), NEW_MARK_MS);
}

function showShot(shot) {
  if (state.busy) return;
  if (shot.videoId !== state.videoId) return showStatus("この写真は、前に開いた動画のものです", { error: true });
  goToFrame(shot.frame);
}

function removeShot(shot) {
  state.shots = state.shots.filter((other) => other !== shot);
  renderShots();
}

function clearShots() {
  if (state.dirty && !confirm("保存していない写真があります。全部外しますか？")) return;
  state.shots = [];
  state.dirty = false;
  renderShots();
}

function renderShots() {
  els.shots.replaceChildren(...state.shots.map((shot) => shot.item));
  els.shotCount.textContent = state.shots.length;
  els.shotsEmpty.hidden = state.shots.length > 0;
  renderButtons();
}

/* ---------- saving ---------- */

// The photo in the chosen format (a photo taken as JPG can be saved as PNG and back).
async function inFormat(blob, format) {
  if (blob.type === format.type) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvasToBlob(canvas, format.type, JPEG_QUALITY);
}

// "運動会_0分12秒34.jpg"; a second photo of the same moment gets "(2)".
function fileNames(shots, ext) {
  const used = new Map();
  return shots.map((shot) => {
    const name = safeFileName(`${shot.base}_${nameTime(shot.time)}`);
    const times = (used.get(name) ?? 0) + 1;
    used.set(name, times);
    const suffix = times > 1 ? `(${times})` : "";
    return `${name}${suffix}.${ext}`;
  });
}

async function saveOne(shot) {
  const format = FORMATS[settings.format];
  const [name] = fileNames([shot], format.ext);
  download(await inFormat(shot.blob, format), name);
}

// One photo is saved as it is, more go in one ZIP.
async function save() {
  if (!state.shots.length) return;
  const format = FORMATS[settings.format];
  const names = fileNames(state.shots, format.ext);
  if (state.shots.length === 1) {
    download(await inFormat(state.shots[0].blob, format), names[0]);
    state.dirty = false;
    return;
  }
  showStatus("ZIPにまとめています…", { sticky: true });
  const files = [];
  for (const [index, shot] of state.shots.entries()) {
    const blob = await inFormat(shot.blob, format);
    files.push({ name: names[index], bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  const bases = new Set(state.shots.map((shot) => shot.base));
  const zipName = bases.size === 1 ? `${[...bases][0]}_写真.zip` : "動画から写真.zip";
  download(makeZip(files), safeFileName(zipName));
  state.dirty = false;
}

/* ---------- the screen ---------- */

function setBusy(kind) {
  state.busy = kind;
  state.stop = false;
  render();
}

function renderTime() {
  // While stopped, the time of the frame on screen (the video sits in the middle of it).
  const frame = state.wanted ?? currentFrame();
  const time = video.paused ? frameStart(frame) : video.currentTime;
  els.time.textContent = `${clockText(time)} / ${clockText(state.duration)}`;
  els.seek.max = String(state.duration || 1);
  if (document.activeElement !== els.seek || video.paused) els.seek.value = String(time);
}

function renderPlay() {
  const playing = !video.paused;
  els.playBtn.querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play");
  els.playBtn.querySelector(".mini-text").textContent = playing ? "止める" : "再生";
  els.playBtn.setAttribute("aria-label", playing ? "止める" : "再生");
}

function renderBatch() {
  els.fromText.textContent = clockText(Math.min(state.from, state.to));
  els.toText.textContent = clockText(Math.max(state.from, state.to));
  els.everyField.hidden = settings.mode !== "every";
  els.countField.hidden = settings.mode !== "count";
  const count = els.work.hidden ? 0 : batchFrames().length;
  els.batchInfo.textContent = `${count}枚の写真になります`;
  for (const tab of document.querySelectorAll("[data-mode]")) tab.setAttribute("aria-checked", String(tab.dataset.mode === settings.mode));
}

function renderButtons() {
  const busy = Boolean(state.busy);
  for (const button of [els.shotBtn, els.backSecond, els.backFrame, els.playBtn, els.nextFrame, els.nextSecond, els.fromBtn, els.toBtn, els.clearBtn]) {
    button.disabled = busy;
  }
  els.clearBtn.disabled = busy || !state.shots.length;
  els.saveBtn.disabled = busy || !state.shots.length;
  els.seek.disabled = busy;
  els.fileInput.disabled = busy;
  const stopping = state.busy === "batch";
  els.batchBtn.disabled = busy && !stopping;
  els.batchBtn.lastChild.textContent = stopping ? "とちゅうでやめる" : "まとめて切り出す";
}

function render() {
  renderTime();
  renderPlay();
  renderBatch();
  renderButtons();
  for (const tab of document.querySelectorAll("[data-format]")) tab.setAttribute("aria-checked", String(tab.dataset.format === settings.format));
  els.size.value = String(settings.size);
  els.sharp.checked = settings.sharp;
  els.every.value = String(settings.every);
  els.count.value = String(settings.count);
}

function changeSetting(changes) {
  Object.assign(settings, changes);
  saveJson(SETTINGS_KEY, settings);
  render();
}

function numberFrom(input, low, high, fallback) {
  const value = Number(input.value.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return clamp(value, low, high);
}

/* ---------- keys ---------- */

const KEYS = {
  ArrowLeft: (e) => (e.shiftKey ? stepSeconds(-1) : step(-1)),
  ArrowRight: (e) => (e.shiftKey ? stepSeconds(1) : step(1)),
  " ": () => togglePlay(),
  Enter: () => takeShot(),
};

function onKey(e) {
  if (els.work.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.querySelector("dialog[open]")) return;
  if (e.target.matches("input:not([type=range]), select, textarea")) return;
  // Enter on a button presses that button.
  if (e.key === "Enter" && e.target.closest("button, a, label")) return;
  const action = KEYS[e.key];
  if (!action) return;
  e.preventDefault();
  action(e);
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", (e) => {
  openVideo(e.target.files[0]);
  e.target.value = "";
});
onFileDrop((files) => openVideo([...files].find(isVideo) ?? files[0]));

video.addEventListener("timeupdate", renderTime);
video.addEventListener("seeked", renderTime);
video.addEventListener("play", renderPlay);
video.addEventListener("pause", renderPlay);
video.addEventListener("ended", renderPlay);
video.addEventListener("click", togglePlay);
els.seek.addEventListener("input", () => {
  video.pause();
  state.wanted = null;
  video.currentTime = Number(els.seek.value);
});
els.playBtn.addEventListener("click", togglePlay);
els.backFrame.addEventListener("click", () => step(-1));
els.nextFrame.addEventListener("click", () => step(1));
els.backSecond.addEventListener("click", () => stepSeconds(-1));
els.nextSecond.addEventListener("click", () => stepSeconds(1));
els.speed.addEventListener("change", () => (video.playbackRate = Number(els.speed.value)));
els.shotBtn.addEventListener("click", takeShot);
document.addEventListener("keydown", onKey);

els.fromBtn.addEventListener("click", () => {
  state.from = frameStart(state.wanted ?? currentFrame());
  if (state.from > state.to) state.to = state.duration;
  renderBatch();
});
els.toBtn.addEventListener("click", () => {
  state.to = frameStart(state.wanted ?? currentFrame());
  if (state.to < state.from) state.from = 0;
  renderBatch();
});
for (const tab of document.querySelectorAll("[data-mode]")) tab.addEventListener("click", () => changeSetting({ mode: tab.dataset.mode }));
for (const tab of document.querySelectorAll("[data-format]")) tab.addEventListener("click", () => changeSetting({ format: tab.dataset.format }));
els.every.addEventListener("change", () => changeSetting({ every: numberFrom(els.every, 0.1, 600, settings.every) }));
els.count.addEventListener("change", () => changeSetting({ count: Math.round(numberFrom(els.count, 1, MAX_SHOTS, settings.count)) }));
els.every.addEventListener("input", renderBatchPreview);
els.count.addEventListener("input", renderBatchPreview);
els.batchBtn.addEventListener("click", runBatch);
els.size.addEventListener("change", () => changeSetting({ size: Number(els.size.value) }));
els.sharp.addEventListener("change", () => changeSetting({ sharp: els.sharp.checked }));
els.clearBtn.addEventListener("click", clearShots);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: "image" });

// While a number is being typed, the photo count follows it without saving the setting yet.
function renderBatchPreview() {
  const every = numberFrom(els.every, 0.1, 600, settings.every);
  const count = Math.round(numberFrom(els.count, 1, MAX_SHOTS, settings.count));
  const saved = { every: settings.every, count: settings.count };
  Object.assign(settings, { every, count });
  els.batchInfo.textContent = `${batchFrames().length}枚の写真になります`;
  Object.assign(settings, saved);
}

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

render();
renderShots();

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest",
  `../shared/vendor/${MEDIABUNNY}`,
]);

// Hook for automated tests.
window.__videoFrame = { state, settings, openVideo, takeShot, runBatch, save, goToFrame, sharpness };
