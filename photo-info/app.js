import { showStatus, hideStatus } from "../shared/js/status.js";
import { download, onFileDrop, onFilePaste } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage, readableImage } from "../shared/js/heic.js";
import { loadPhoto, stripExtension, makeCanvas, fitWithin } from "../shared/js/photo.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { makeZip } from "../shared/js/zip.js";
import { registerOffline } from "../shared/js/offline.js";
import { readInfo, cleanJpeg, cleanPng } from "../shared/js/exif.js";
import "../shared/js/guide.js";

const THUMB = 120; // px, the longer side of a thumbnail
const WEBP_QUALITY = 0.92; // WebP is drawn again: keep it close to the original
const ORIENTATION_WORDS = { 3: "上下が逆", 6: "右に90°", 8: "左に90°" };

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  clearBtn: $("clear-btn"),
  summary: $("summary"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  list: $("list"),
};

const state = {
  items: [], // { file, info, el }
};

/* ---------- adding photos ---------- */

async function addFiles(fileList) {
  const files = [...fileList].filter(isImage);
  if (!files.length) return showStatus("写真・画像のファイルを選んでください", { error: true });
  const failed = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const item = { file, info: readInfo(bytes), el: null };
      item.el = await createCard(item);
      state.items.push(item);
      els.list.append(item.el);
    } catch (err) {
      console.error(err);
      failed.push(file.name);
    }
  }
  render();
  if (failed.length) showStatus(`${failed.join("、")} を読み込めませんでした`, { error: true });
}

/* ---------- cards ---------- */

async function createCard(item) {
  const li = document.createElement("li");
  li.className = "item";
  li.innerHTML = `
    <div class="thumb"></div>
    <div class="body">
      <div class="name"></div>
      <div class="badges"></div>
      <dl class="facts"></dl>
    </div>
    <button class="btn icon" title="この写真を外す" aria-label="この写真を外す"><svg class="i" aria-hidden="true"><use href="#i-close"/></svg></button>`;
  li.querySelector(".name").textContent = item.file.name;
  li.querySelector("button").addEventListener("click", () => remove(item));
  fillFacts(li, item.info);
  li.querySelector(".thumb").append(await thumbnail(item.file));
  return li;
}

async function thumbnail(file) {
  try {
    const bitmap = await loadPhoto(file);
    const size = fitWithin(bitmap.width, bitmap.height, THUMB * 2);
    const canvas = makeCanvas(size.width, size.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    return canvas;
  } catch {
    return document.createTextNode("（見本なし）");
  }
}

// The rows of the card: what was found in the file, in plain words.
function facts(info) {
  const exif = info.exif ?? {};
  const rows = [];
  if (exif.gps) rows.push(["撮った場所", positionText(exif.gps), true]);
  const taken = exif.dateTimeOriginal || exif.dateTime;
  if (taken) rows.push(["撮った日時", dateText(taken)]);
  const camera = [exif.make, exif.model].filter(Boolean).join(" ");
  if (camera) rows.push(["スマホ・カメラ", camera]);
  if (exif.lensModel) rows.push(["レンズ", exif.lensModel]);
  if (exif.software) rows.push(["ソフト", exif.software]);
  const person = [exif.artist, exif.ownerName, exif.copyright].filter(Boolean).join("・");
  if (person) rows.push(["作った人・持ち主", person, true]);
  if (exif.serialNumber) rows.push(["カメラの製造番号", exif.serialNumber, true]);
  if (ORIENTATION_WORDS[exif.orientation]) rows.push(["向き", `${ORIENTATION_WORDS[exif.orientation]}（保存しても向きは残します）`]);
  for (const extra of info.extras) rows.push(["そのほか", extra]);
  return rows;
}

function fillFacts(li, info) {
  const rows = facts(info);
  const badges = li.querySelector(".badges");
  const hasPlace = Boolean(info.exif?.gps);
  if (hasPlace) badges.append(badge("位置情報あり：撮った場所が分かります", "danger"));
  if (!rows.length) badges.append(badge("情報は入っていません", "ok"));
  else if (!hasPlace) badges.append(badge(`${rows.length}つの情報が入っています`, ""));
  if (info.kind === "heic") badges.append(badge("iPhoneの写真（保存するとJPGになります）", ""));
  const list = li.querySelector(".facts");
  for (const [name, value, danger] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (danger) dd.className = "danger";
    list.append(dt, dd);
  }
}

function badge(text, kind) {
  const span = document.createElement("span");
  span.className = `badge ${kind}`.trim();
  span.textContent = text;
  return span;
}

function positionText({ lat, lon, alt }) {
  const northSouth = lat >= 0 ? "北緯" : "南緯";
  const eastWest = lon >= 0 ? "東経" : "西経";
  const height = alt === null ? "" : `、高さ ${Math.round(alt)} m`;
  return `${northSouth} ${Math.abs(lat).toFixed(5)}°、${eastWest} ${Math.abs(lon).toFixed(5)}°${height}（地図で家や学校の場所が分かる細かさです）`;
}

// "2026:11:04 08:15:30" → "2026年11月4日 8:15"
function dateText(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(text);
  if (!m) return text;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日 ${Number(m[4])}:${m[5]}`;
}

function remove(item) {
  item.el.remove();
  state.items = state.items.filter((i) => i !== item);
  render();
}

function clearAll() {
  for (const item of state.items.slice()) remove(item);
  hideStatus();
}

/* ---------- saving ---------- */

// The photo without its information: { blob, ext }.
async function cleaned(item) {
  const { file, info } = item;
  if (info.kind === "jpeg") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { blob: new Blob([cleanJpeg(bytes, info.exif?.orientation)], { type: "image/jpeg" }), ext: "jpg" };
  }
  if (info.kind === "png") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { blob: new Blob([cleanPng(bytes)], { type: "image/png" }), ext: "png" };
  }
  if (info.kind === "heic") {
    // The JPEG made from a HEIC has no information in it; cleaning it again makes sure.
    const jpeg = new Uint8Array(await (await readableImage(file)).arrayBuffer());
    return { blob: new Blob([cleanJpeg(jpeg)], { type: "image/jpeg" }), ext: "jpg" };
  }
  return redrawn(file, info.kind);
}

// Other kinds (WebP, GIF, BMP) are drawn on a canvas and saved again, which keeps only the picture.
async function redrawn(file, kind) {
  const bitmap = await loadPhoto(file);
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const webp = kind === "webp";
  const blob = await canvasToBlob(canvas, webp ? "image/webp" : "image/png", WEBP_QUALITY);
  return { blob, ext: webp ? "webp" : "png" };
}

function outputName(item, ext, used) {
  const base = stripExtension(item.file.name);
  let name = `${base}_情報なし.${ext}`;
  for (let n = 2; used.has(name); n++) name = `${base}_情報なし(${n}).${ext}`;
  used.add(name);
  return name;
}

async function save() {
  if (!state.items.length) return;
  els.saveBtn.disabled = true;
  try {
    const used = new Set();
    const files = [];
    for (const item of state.items) {
      const { blob, ext } = await cleaned(item);
      files.push({ name: outputName(item, ext, used), blob });
    }
    if (files.length === 1) {
      download(files[0].blob, files[0].name);
    } else {
      const entries = [];
      for (const { name, blob } of files) entries.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) });
      download(makeZip(entries), "写真_情報なし.zip");
    }
    showStatus(files.length === 1 ? "情報を消して保存しました" : `${files.length}枚の情報を消して、ZIPにまとめて保存しました`);
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした", { error: true });
  } finally {
    render();
  }
}

/* ---------- screen ---------- */

function render() {
  const count = state.items.length;
  const withPlace = state.items.filter((i) => i.info.exif?.gps).length;
  els.welcome.hidden = count > 0;
  els.clearBtn.disabled = count === 0;
  els.saveBtn.disabled = count === 0;
  let summary = "";
  if (count) summary = withPlace ? `${count}枚のうち ${withPlace}枚に位置情報` : `${count}枚・位置情報なし`;
  els.summary.textContent = summary;
}

els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.clearBtn.addEventListener("click", clearAll);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: "image" });
onFilePaste(addFiles);
onFileDrop(addFiles);
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__photoInfo = { state, addFiles, save };
