import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { isImage, isHeic, readableImage } from "../shared/js/heic.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";

const MAX_IMAGE_PX = 2400; // longest side kept per photo; enough to read handwriting, keeps PDFs small
const JPEG_QUALITY = 0.88;
const PREVIEW_PX = 160; // longest side of a page preview in the grid
// Paper sizes in PDF points (1/72 inch), portrait.
const PAPER = {
  a4: [595.28, 841.89],
  b5: [515.91, 728.5], // JIS B5, the size Japanese schools use
  letter: [612, 792],
};
const FIT_LONG_SIDE = PAPER.a4[1]; // "画像に合わせる" pages are as long as A4

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  cameraBtn: $("camera-btn"),
  pageSize: $("page-size"),
  orientation: $("orientation"),
  margin: $("margin"),
  colorMode: $("color-mode"),
  sortBtn: $("sort-btn"),
  clearBtn: $("clear-btn"),
  fileName: $("file-name"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  grid: $("grid"),
  camera: $("camera"),
  cameraVideo: $("camera-video"),
  cameraSwitch: $("camera-switch"),
  cameraShot: $("camera-shot"),
  cameraClose: $("camera-close"),
  cameraCount: $("camera-count"),
};

const state = {
  images: [], // { id, name, bytes, url, width, height, rotation }
  nextId: 1,
  dirty: false,
  busy: false,
};

/* ---------- loading images ---------- */

// Re-encode the photo: applies EXIF rotation, shrinks big camera shots, and
// turns any browser-readable format into JPEG, which PDFs can hold as-is.
async function prepareImage(blob) {
  const bitmap = await createImageBitmap(blob);
  const ratio = Math.min(1, MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent parts of PNGs become paper white
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const jpeg = await canvasToJpeg(canvas);
  return { bytes: new Uint8Array(await jpeg.arrayBuffer()), url: URL.createObjectURL(jpeg), width, height };
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", JPEG_QUALITY),
  );
}

async function addFiles(files) {
  const list = [...files].filter(isImage);
  if (!list.length) return;
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    if (list.length > 1 || isHeic(list[i])) showStatus(`読み込み中… ${i + 1} / ${list.length}`, { sticky: true });
    try {
      const img = await prepareImage(await readableImage(list[i]));
      state.images.push({ id: state.nextId++, name: list[i].name || "画像", rotation: 0, ...img });
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  state.dirty = true;
  render();
  if (failed) {
    showStatus(`${failed}枚の画像を読み込めませんでした（JPEG・PNG・HEICの画像を使ってください）`, { error: true });
  } else {
    showStatus(`${list.length}枚追加しました`);
  }
}

/* ---------- page layout ---------- */

function settings() {
  return {
    paper: els.pageSize.value,
    orientation: els.orientation.value,
    margin: Number(els.margin.value),
    gray: els.colorMode.value === "gray",
  };
}

// Where an image goes on its page, in PDF points: the page size and the
// image box (after rotation), centred and as large as the margins allow.
function layout(img, opts) {
  const turned = img.rotation % 180 !== 0;
  const iw = turned ? img.height : img.width;
  const ih = turned ? img.width : img.height;
  const m = opts.margin;

  let pw, ph;
  if (opts.paper === "fit") {
    const s = (FIT_LONG_SIDE - 2 * m) / Math.max(iw, ih);
    pw = iw * s + 2 * m;
    ph = ih * s + 2 * m;
  } else {
    const [a, b] = PAPER[opts.paper];
    const landscape = opts.orientation === "landscape" || (opts.orientation === "auto" && iw > ih);
    [pw, ph] = landscape ? [b, a] : [a, b];
  }

  const s = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
  const w = iw * s;
  const h = ih * s;
  return { pw, ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h };
}

/* ---------- grid ---------- */

function render() {
  const opts = settings();
  const has = state.images.length > 0;
  els.welcome.hidden = has;
  els.saveBtn.disabled = !has || state.busy;
  els.sortBtn.disabled = state.images.length < 2;
  els.clearBtn.disabled = !has;

  els.grid.replaceChildren(...state.images.map((img, i) => card(img, i, opts)));
}

function card(img, index, opts) {
  const li = document.createElement("li");
  li.className = "card";
  li.draggable = true;
  li.dataset.id = img.id;

  const { pw, ph, w, h } = layout(img, opts);
  const k = PREVIEW_PX / Math.max(pw, ph);
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.classList.toggle("gray", opts.gray);
  sheet.style.width = `${pw * k}px`;
  sheet.style.height = `${ph * k}px`;

  // The <img> keeps the unrotated size and is turned with CSS; flex centring
  // keeps it in the middle of the sheet either way.
  const turned = img.rotation % 180 !== 0;
  const pic = document.createElement("img");
  pic.src = img.url;
  pic.alt = img.name;
  pic.style.width = `${(turned ? h : w) * k}px`;
  pic.style.height = `${(turned ? w : h) * k}px`;
  pic.style.transform = `rotate(${img.rotation}deg)`;
  sheet.append(pic);

  const num = document.createElement("span");
  num.className = "card-num";
  num.textContent = index + 1;
  num.title = `${index + 1}ページ目: ${img.name}`;
  const bar = document.createElement("div");
  bar.className = "card-bar";
  bar.append(
    button("◀", "前へ移動", () => move(img.id, -1), index === 0),
    button("▶", "後ろへ移動", () => move(img.id, 1), index === state.images.length - 1),
    button("⟳", "右に90°回転", () => rotate(img.id)),
    button("✕", "このページを消す", () => remove(img.id), false, "del"),
  );

  li.append(num, sheet, bar);
  return li;
}

function button(label, title, onClick, disabled = false, extra = "") {
  const b = document.createElement("button");
  b.className = `btn ${extra}`.trim();
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

const indexOf = (id) => state.images.findIndex((img) => img.id === id);

function move(id, delta) {
  const i = indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.images.length) return;
  const [img] = state.images.splice(i, 1);
  state.images.splice(j, 0, img);
  state.dirty = true;
  render();
}

function rotate(id) {
  const img = state.images[indexOf(id)];
  img.rotation = (img.rotation + 90) % 360;
  state.dirty = true;
  render();
}

function remove(id) {
  const [img] = state.images.splice(indexOf(id), 1);
  URL.revokeObjectURL(img.url);
  state.dirty = state.images.length > 0;
  render();
}

// Drag a card onto another to reorder. Uses its own data type so it is not
// mistaken for files dropped from outside.
const CARD_TYPE = "application/x-image-pdf-card";
let dragId = 0;

els.grid.addEventListener("dragstart", (e) => {
  const li = e.target.closest(".card");
  if (!li) return;
  dragId = Number(li.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(CARD_TYPE, li.dataset.id);
  li.classList.add("dragging");
});

els.grid.addEventListener("dragend", () => {
  dragId = 0;
  clearDropMarks();
  els.grid.querySelector(".dragging")?.classList.remove("dragging");
});

function dropSide(e, li) {
  const r = li.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? "before" : "after";
}

function clearDropMarks() {
  els.grid.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
}

els.grid.addEventListener("dragover", (e) => {
  if (!dragId) return;
  const li = e.target.closest(".card");
  e.preventDefault();
  e.stopPropagation();
  clearDropMarks();
  if (li && Number(li.dataset.id) !== dragId) li.classList.add(`drop-${dropSide(e, li)}`);
});

els.grid.addEventListener("drop", (e) => {
  if (!dragId) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest(".card");
  clearDropMarks();
  if (!li || Number(li.dataset.id) === dragId) return;
  const [img] = state.images.splice(indexOf(dragId), 1);
  const target = indexOf(Number(li.dataset.id));
  state.images.splice(dropSide(e, li) === "before" ? target : target + 1, 0, img);
  state.dirty = true;
  render();
});

/* ---------- camera ---------- */

const camera = { stream: null, facing: "environment", shots: 0, total: 0 };

async function startCamera() {
  stopCamera();
  camera.stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: camera.facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  els.cameraVideo.srcObject = camera.stream;
}

function stopCamera() {
  camera.stream?.getTracks().forEach((t) => t.stop());
  camera.stream = null;
  els.cameraVideo.srcObject = null;
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showStatus("このブラウザではカメラを使えません", { error: true });
    return;
  }
  camera.shots = 0;
  els.cameraCount.textContent = "";
  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    showStatus("カメラを使えませんでした（カメラの使用を許可しているか確認してください）", { error: true });
    return;
  }
  els.camera.showModal();
}

async function takeShot() {
  const video = els.cameraVideo;
  if (!video.videoWidth) return;
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const blob = await canvasToJpeg(canvas);
  camera.shots++;
  const name = `カメラ_${String(++camera.total).padStart(3, "0")}.jpg`;
  await addFiles([new File([blob], name, { type: "image/jpeg" })]);
  els.cameraCount.textContent = `${camera.shots}枚撮影しました。続けて撮るか「完了」を押してください`;
}

els.cameraBtn.addEventListener("click", openCamera);
els.cameraShot.addEventListener("click", takeShot);
els.cameraClose.addEventListener("click", () => els.camera.close());
els.camera.addEventListener("close", stopCamera);
els.cameraSwitch.addEventListener("click", async () => {
  camera.facing = camera.facing === "environment" ? "user" : "environment";
  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    showStatus("カメラを切り替えられませんでした", { error: true });
  }
});

/* ---------- saving ---------- */

// The bytes to put in the PDF: the stored JPEG when nothing changed, otherwise
// redrawn with the rotation and black-and-white filter applied.
async function pageJpeg(img, gray) {
  if (!img.rotation && !gray) return img.bytes;
  const bitmap = await createImageBitmap(new Blob([img.bytes], { type: "image/jpeg" }));
  const turned = img.rotation % 180 !== 0;
  const canvas = document.createElement("canvas");
  canvas.width = turned ? img.height : img.width;
  canvas.height = turned ? img.width : img.height;
  const ctx = canvas.getContext("2d");
  if (gray) ctx.filter = "grayscale(1) contrast(1.25)";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((img.rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -img.width / 2, -img.height / 2);
  bitmap.close();
  return new Uint8Array(await (await canvasToJpeg(canvas)).arrayBuffer());
}

function outputName() {
  const base = els.fileName.value.trim().replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]/g, "_") || "まとめ";
  return `${base}.pdf`;
}

async function save() {
  if (!state.images.length || state.busy) return;
  state.busy = true;
  els.saveBtn.disabled = true;
  const opts = settings();
  try {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();
    doc.setTitle(outputName().replace(/\.pdf$/, ""));
    doc.setCreator("Chromebook便利ツール 画像→PDF");
    for (let i = 0; i < state.images.length; i++) {
      showStatus(`PDFを作成中… ${i + 1} / ${state.images.length}`, { sticky: true });
      const img = state.images[i];
      const { pw, ph, x, y, w, h } = layout(img, opts);
      const image = await doc.embedJpg(await pageJpeg(img, opts.gray));
      const page = doc.addPage([pw, ph]);
      page.drawImage(image, { x, y: ph - y - h, width: w, height: h });
    }
    const out = await doc.save();
    download(new Blob([out], { type: "application/pdf" }), outputName());
    state.dirty = false;
    showStatus(`${state.images.length}ページのPDFを保存しました（ダウンロードフォルダを確認してください）`);
  } catch (err) {
    console.error(err);
    showStatus("PDFを作れませんでした。画像の枚数を減らして試してください", { error: true });
  } finally {
    state.busy = false;
    render();
  }
}

/* ---------- toolbar & global events ---------- */

els.fileInput.addEventListener("change", async () => {
  await addFiles(els.fileInput.files);
  els.fileInput.value = "";
});

for (const el of [els.pageSize, els.orientation, els.margin, els.colorMode]) el.addEventListener("change", render);

els.sortBtn.addEventListener("click", () => {
  const collator = new Intl.Collator("ja", { numeric: true });
  state.images.sort((a, b) => collator.compare(a.name, b.name));
  state.dirty = true;
  render();
});

els.clearBtn.addEventListener("click", () => {
  if (!confirm("すべての画像を外しますか？")) return;
  state.images.forEach((img) => URL.revokeObjectURL(img.url));
  state.images = [];
  state.dirty = false;
  render();
});

els.saveBtn.addEventListener("click", save);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});

// Paste a screenshot (Ctrl+V) to add it as a page.
document.addEventListener("paste", (e) => {
  if (e.target === els.fileName) return;
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// Drag & drop image files anywhere on the page.
onFileDrop((files) => {
  if (files.some((f) => f.type.startsWith("image/"))) addFiles(files);
  else if (files.length) showStatus("画像ファイルをドロップしてください", { error: true });
});

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js",
]);

render();

// Hook for automated tests.
window.__imagePdf = { state, addFiles, layout, settings, save, move, rotate, remove };
