import * as pdfjsLib from "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs";
import { registerOffline } from "../shared/js/offline.js";

const { PDFDocument, rgb, degrees } = window.PDFLib;

const asset = (path) => new URL(path, location.href).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = asset("../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs");

const FONT_URL = asset("../shared/vendor/noto-sans-jp/NotoSansJP-Regular.ttf");
const SUBSET_WASM_URL = asset("../shared/vendor/harfbuzz-1.6.3/harfbuzz-subset.wasm");
const FONT_FAMILY = "PdfStampJP";
const PREVIEW_PX = 300; // preview page width, in CSS pixels
const RASTER_SCALE = 2; // 144 dpi page images when a protected PDF has to be rebuilt
const ASCENT = 0.88; // Noto Sans JP ascender / font size, to keep top numbers inside the margin
const MID = 0.36; // baseline-to-visual-middle of a line / font size, to center watermarks
const SETTINGS_KEY = "pdf-stamp-settings";

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  fileName: $("file-name"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  pages: $("pages"),
  status: $("status"),
  dropOverlay: $("drop-overlay"),
  numOn: $("num-on"),
  numOpts: $("num-opts"),
  numFormat: $("num-format"),
  numCustom: $("num-custom"),
  numCustomRow: $("num-custom-row"),
  numCustomHelp: $("num-custom-help"),
  numSize: $("num-size"),
  numColor: $("num-color"),
  numMargin: $("num-margin"),
  numStart: $("num-start"),
  numSkipFirst: $("num-skip-first"),
  wmOn: $("wm-on"),
  wmOpts: $("wm-opts"),
  wmText: $("wm-text"),
  wmAngle: $("wm-angle"),
  wmLayout: $("wm-layout"),
  wmSize: $("wm-size"),
  wmSizeOut: $("wm-size-out"),
  wmColor: $("wm-color"),
  wmOpacity: $("wm-opacity"),
  wmOpacityOut: $("wm-opacity-out"),
  wmSkipFirst: $("wm-skip-first"),
};

const state = {
  fileName: "document.pdf",
  bytes: null, // original PDF bytes (never handed to pdf.js, which detaches buffers)
  pdf: null, // pdf.js document
  pages: [], // { num, viewport (scale 1), el, canvas, base (rendered page without stamps), rendered }
  numPos: "bottom-center",
  busy: false,
};

/* ---------- status messages ---------- */

let statusTimer = 0;
function showStatus(text, { error = false, sticky = false } = {}) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle("error", error);
  els.status.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => (els.status.hidden = true), error ? 6000 : 2500);
}
function hideStatus() {
  clearTimeout(statusTimer);
  els.status.hidden = true;
}

/* ---------- settings ---------- */

function readSettings() {
  const format = els.numFormat.value === "custom" ? els.numCustom.value : els.numFormat.value;
  return {
    num: {
      on: els.numOn.checked,
      format,
      pos: state.numPos,
      size: Number(els.numSize.value),
      color: els.numColor.value,
      margin: Number(els.numMargin.value),
      start: Math.trunc(Number(els.numStart.value)) || 0,
      skipFirst: els.numSkipFirst.checked,
    },
    wm: {
      on: els.wmOn.checked && els.wmText.value.trim() !== "",
      text: els.wmText.value.trim(),
      angle: els.wmAngle.value,
      layout: els.wmLayout.value,
      size: Number(els.wmSize.value),
      color: els.wmColor.value,
      opacity: Number(els.wmOpacity.value) / 100,
      skipFirst: els.wmSkipFirst.checked,
    },
  };
}

// The form controls are the source of truth; this only remembers them between visits.
const SAVED_FIELDS = ["numOn", "numFormat", "numCustom", "numSize", "numColor", "numMargin", "numStart",
  "numSkipFirst", "wmOn", "wmText", "wmAngle", "wmLayout", "wmSize", "wmColor", "wmOpacity", "wmSkipFirst"];

function storeSettings() {
  const data = { numPos: state.numPos };
  for (const key of SAVED_FIELDS) data[key] = els[key].type === "checkbox" ? els[key].checked : els[key].value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    // Storage can be unavailable (e.g. guest mode); settings just won't be remembered.
  }
}

function restoreSettings() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return;
  }
  if (!data) return;
  for (const key of SAVED_FIELDS) {
    if (!(key in data)) continue;
    if (els[key].type === "checkbox") els[key].checked = !!data[key];
    else if (els[key].tagName !== "SELECT" || [...els[key].options].some((o) => o.value === data[key])) {
      els[key].value = data[key];
    }
  }
  if (document.querySelector(`.pos[data-pos="${data.numPos}"]`)) state.numPos = data.numPos;
}

function syncControls() {
  const custom = els.numFormat.value === "custom";
  els.numCustomRow.hidden = !custom;
  els.numCustomHelp.hidden = !custom;
  els.numOpts.classList.toggle("off", !els.numOn.checked);
  els.wmOpts.classList.toggle("off", !els.wmOn.checked);
  els.wmSizeOut.textContent = els.wmSize.value;
  els.wmOpacityOut.textContent = `${els.wmOpacity.value}%`;
  for (const btn of document.querySelectorAll(".pos")) {
    const on = btn.dataset.pos === state.numPos;
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-checked", on);
  }
  const s = readSettings();
  els.saveBtn.disabled = !state.pdf || state.busy || (!s.num.on && !s.wm.on);
}

/* ---------- layout ---------- */

// Returns everything to draw on one page, in page units (1 = 1pt) with a
// top-left origin as the page is seen on screen. `y` is the text baseline and
// `angle` is counter-clockwise degrees. `measure(text, size)` gives text width.
function layoutPage(index, pageCount, width, height, settings, measure) {
  const draws = [];
  const { num, wm } = settings;

  if (num.on && !(num.skipFirst && index === 0)) {
    const first = num.skipFirst ? 1 : 0;
    const n = num.start + index - first;
    const total = num.start + (pageCount - first) - 1;
    const text = num.format.replaceAll("{n}", n).replaceAll("{total}", total);
    if (text.trim()) {
      const w = measure(text, num.size);
      const [v, h] = num.pos.split("-");
      const x = h === "left" ? num.margin : h === "right" ? width - num.margin - w : (width - w) / 2;
      const y = v === "top" ? num.margin + num.size * ASCENT : height - num.margin;
      draws.push({ text, x, y, angle: 0, size: num.size, color: num.color, opacity: 1 });
    }
  }

  if (wm.on && !(wm.skipFirst && index === 0)) {
    const angle = wm.angle === "diagonal" ? (Math.atan2(height, width) * 180) / Math.PI : Number(wm.angle);
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const w = measure(wm.text, wm.size);
    // Screen y grows downward, so "counter-clockwise" flips the sign of sin.
    const place = (cx, cy) => {
      const lx = -w / 2;
      const ly = wm.size * MID;
      return { x: cx + lx * cos + ly * sin, y: cy - lx * sin + ly * cos };
    };
    const stamp = (cx, cy) =>
      draws.push({ text: wm.text, ...place(cx, cy), angle, size: wm.size, color: wm.color, opacity: wm.opacity });

    if (wm.layout === "tile") {
      const stepX = w + wm.size * 1.5; // along the text
      const stepY = wm.size * 3; // across the lines
      const reach = Math.hypot(width, height) / 2 + w;
      const cols = Math.ceil(reach / stepX) + 1;
      const rows = Math.ceil(reach / stepY) + 1;
      for (let j = -rows; j <= rows; j++) {
        for (let i = -cols; i <= cols; i++) {
          const a = (i + (j & 1) / 2) * stepX;
          const b = j * stepY;
          const cx = width / 2 + a * cos + b * sin;
          const cy = height / 2 - a * sin + b * cos;
          if (cx < -w / 2 || cx > width + w / 2 || cy < -w / 2 || cy > height + w / 2) continue;
          stamp(cx, cy);
        }
      }
    } else {
      stamp(width / 2, height / 2);
    }
  }
  return draws;
}

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: asset("../shared/vendor/pdfjs-4.10.38/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: asset("../shared/vendor/pdfjs-4.10.38/standard_fonts/"),
    }).promise;

    resetDocument();
    state.bytes = bytes;
    state.pdf = pdf;
    state.fileName = file.name || "document.pdf";
    document.title = `${state.fileName} - ページ番号・透かし入れ`;
    els.fileName.textContent = `${state.fileName}（${pdf.numPages}ページ）`;

    for (let num = 1; num <= pdf.numPages; num++) {
      const page = await pdf.getPage(num);
      state.pages.push(createPageView(num, page.getViewport({ scale: 1 })));
    }
    els.welcome.hidden = true;
    els.viewer.scrollTop = 0;
    syncControls();
    hideStatus();
  } catch (err) {
    console.error(err);
    const msg = err?.name === "PasswordException"
      ? "パスワード付きのPDFは開けません"
      : "PDFを開けませんでした";
    showStatus(msg, { error: true });
  }
}

function resetDocument() {
  observer.disconnect();
  state.pdf?.destroy();
  state.pdf = null;
  state.pages = [];
  els.pages.replaceChildren();
}

function createPageView(num, viewport) {
  const el = document.createElement("li");
  el.className = "page";
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const scale = PREVIEW_PX / viewport.width;
  canvas.width = Math.round(viewport.width * scale * dpr);
  canvas.height = Math.round(viewport.height * scale * dpr);
  canvas.style.width = `${PREVIEW_PX}px`;
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = `${num} / ${state.pdf.numPages}`;
  el.append(canvas, label);
  els.pages.append(el);

  const view = { num, viewport, el, canvas, base: null, rendered: false };
  observer.observe(el);
  return view;
}

/* ---------- preview ---------- */

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const view = state.pages.find((p) => p.el === entry.target);
      if (view && !view.rendered) renderPage(view);
    }
  },
  { root: els.viewer, rootMargin: "800px 0px" },
);

async function renderPage(view) {
  view.rendered = true;
  const pdf = state.pdf;
  const page = await pdf.getPage(view.num);
  const base = document.createElement("canvas");
  base.width = view.canvas.width;
  base.height = view.canvas.height;
  const ctx = base.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, base.width, base.height);
  try {
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: base.width / view.viewport.width }) }).promise;
  } catch (err) {
    console.error(err);
  }
  if (state.pdf !== pdf) return; // another PDF was opened meanwhile
  view.base = base;
  drawPreview(view);
}

const measureCtx = document.createElement("canvas").getContext("2d");
function measureOnScreen(text, size) {
  measureCtx.font = `100px ${FONT_FAMILY}`;
  return (measureCtx.measureText(text).width * size) / 100;
}

function drawPreview(view, settings = readSettings()) {
  if (!view.base) return;
  const ctx = view.canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(view.base, 0, 0);
  const scale = view.canvas.width / view.viewport.width;
  const draws = layoutPage(view.num - 1, state.pages.length, view.viewport.width, view.viewport.height,
    settings, measureOnScreen);
  for (const d of draws) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.translate(d.x, d.y);
    ctx.rotate((-d.angle * Math.PI) / 180);
    ctx.globalAlpha = d.opacity;
    ctx.fillStyle = d.color;
    ctx.font = `${d.size}px ${FONT_FAMILY}`;
    ctx.fillText(d.text, 0, 0);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

let redrawQueued = false;
function update() {
  syncControls();
  storeSettings();
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    const settings = readSettings();
    state.pages.forEach((view) => drawPreview(view, settings));
  });
}

// The preview needs the real font to show where text lands.
document.fonts.load(`100px ${FONT_FAMILY}`, "あ1").then(() => update());

/* ---------- font for the saved PDF ---------- */

let fontBytesPromise = null;
function loadFontBytes() {
  fontBytesPromise ??= fetch(FONT_URL).then((r) => {
    if (!r.ok) throw new Error("フォントを読み込めませんでした");
    return r.arrayBuffer();
  });
  return fontBytesPromise;
}

// pdf-lib's built-in subsetting drops glyphs from Noto Sans JP, so the font is
// cut down to just the characters in use with HarfBuzz and embedded as-is.
let subsetterPromise = null;
function loadSubsetter() {
  subsetterPromise ??= fetch(SUBSET_WASM_URL)
    .then((r) => r.arrayBuffer())
    .then((buf) => WebAssembly.instantiate(buf))
    .then(({ instance }) => instance.exports);
  return subsetterPromise;
}

async function subsetFont(text) {
  const [hb, fontBytes] = await Promise.all([loadSubsetter(), loadFontBytes()]);
  const ptr = hb.malloc(fontBytes.byteLength);
  new Uint8Array(hb.memory.buffer).set(new Uint8Array(fontBytes), ptr);
  const blob = hb.hb_blob_create(ptr, fontBytes.byteLength, 2 /* writable */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0));
  const sub = hb.hb_subset_or_fail(face, input);
  hb.hb_subset_input_destroy(input);
  try {
    if (!sub) throw new Error("フォントの準備に失敗しました");
    const out = hb.hb_face_reference_blob(sub);
    const data = hb.hb_blob_get_data(out, 0);
    const bytes = new Uint8Array(hb.memory.buffer).slice(data, data + hb.hb_blob_get_length(out));
    hb.hb_blob_destroy(out);
    return bytes;
  } finally {
    if (sub) hb.hb_face_destroy(sub);
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
}

/* ---------- saving ---------- */

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function outputName(settings) {
  const base = state.fileName.replace(/\.pdf$/i, "");
  const suffix = settings.num.on && settings.wm.on ? "番号・透かし入り" : settings.num.on ? "番号入り" : "透かし入り";
  return `${base}_${suffix}.pdf`;
}

// pdf-lib cannot decrypt, so a protected (encrypted) PDF is rebuilt from page
// images rendered by pdf.js, the same as printing it, and stamped on top of that.
async function rasterizeDocument() {
  const doc = await PDFDocument.create();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  for (const view of state.pages) {
    showStatus(`保護されたPDFのため、ページを画像にしています… (${view.num}/${state.pages.length})`, { sticky: true });
    const page = await state.pdf.getPage(view.num);
    const viewport = page.getViewport({ scale: RASTER_SCALE });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const { width, height } = view.viewport;
    doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  canvas.width = canvas.height = 0;
  return doc;
}

async function save() {
  if (!state.bytes || state.busy) return;
  const settings = readSettings();
  if (!settings.num.on && !settings.wm.on) return;
  state.busy = true;
  syncControls();
  showStatus("PDFを作成中…", { sticky: true });
  try {
    const original = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    const rebuilt = original.isEncrypted;
    const doc = rebuilt ? await rasterizeDocument() : original;
    doc.registerFontkit(window.fontkit);
    showStatus("PDFを作成中…", { sticky: true });

    // The font only needs the characters that actually get drawn, so lay out
    // with a rough width first just to collect them.
    const pageCount = state.pages.length;
    const allText = state.pages
      .flatMap((v, i) => layoutPage(i, pageCount, v.viewport.width, v.viewport.height, settings, () => 0))
      .map((d) => d.text)
      .join("");
    const font = await doc.embedFont(await subsetFont(allText + " "), { subset: false });
    const measure = (text, size) => font.widthOfTextAtSize(text, size);

    state.pages.forEach((view, i) => {
      const page = doc.getPage(i);
      const { viewport } = view;
      // Maps screen coordinates (scale 1, top-left origin) onto the page.
      // Rebuilt pages are already upright, so only the y axis flips.
      const toPdf = rebuilt ? (x, y) => [x, viewport.height - y] : (x, y) => viewport.convertToPdfPoint(x, y);
      const rotation = rebuilt ? 0 : viewport.rotation;
      for (const d of layoutPage(i, pageCount, viewport.width, viewport.height, settings, measure)) {
        const [x, y] = toPdf(d.x, d.y);
        page.drawText(d.text, {
          x, y, size: d.size, font,
          color: hexToRgb(d.color),
          opacity: d.opacity,
          rotate: degrees(d.angle + rotation),
        });
      }
    });

    const out = await doc.save();
    download(new Blob([out], { type: "application/pdf" }), outputName(settings));
    showStatus(rebuilt
      ? "保存しました（保護されたPDFのため、元のページは画像として保存しています）"
      : "保存しました（ダウンロードフォルダを確認してください）");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。PDFが壊れているか、対応していない形式の可能性があります", { error: true });
  } finally {
    state.busy = false;
    syncControls();
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});
els.saveBtn.addEventListener("click", save);

for (const el of document.querySelectorAll(".panel input, .panel select")) {
  el.addEventListener("input", update);
  el.addEventListener("change", update);
}
// Touching a setting of a switched-off section switches it on.
for (const [opts, toggle] of [[els.numOpts, els.numOn], [els.wmOpts, els.wmOn]]) {
  opts.addEventListener("input", () => (toggle.checked = true), true);
  opts.addEventListener("click", (e) => {
    if (e.target.closest("button")) toggle.checked = true;
  }, true);
}
for (const btn of document.querySelectorAll(".pos")) {
  btn.addEventListener("click", () => {
    state.numPos = btn.dataset.pos;
    update();
  });
}
for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    els.wmText.value = chip.textContent;
    update();
  });
}
els.numFormat.addEventListener("change", () => {
  if (els.numFormat.value === "custom") els.numCustom.focus();
});

// Drag & drop a PDF anywhere on the page.
let dragDepth = 0;
const isFileDrag = (e) => [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropOverlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  if (e.dataTransfer.files.length) openFile(e.dataTransfer.files[0]);
});

restoreSettings();
syncControls();

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js",
  "../shared/vendor/fontkit-1.1.1/fontkit.umd.min.js",
  "../shared/vendor/harfbuzz-1.6.3/harfbuzz-subset.wasm",
  "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs",
  "../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs",
  "../shared/vendor/noto-sans-jp/NotoSansJP-Regular.ttf",
]);
