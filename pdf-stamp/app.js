import { openPdf, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, download, onFileDrop } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { subsetFont } from "../shared/js/font-jp.js";
import { createLazyRenderer } from "../shared/js/lazy.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib, loadFontkit } from "../shared/js/pdf-lib.js";

const FONT_FAMILY = "PdfStampJP";
const PREVIEW_PX = 300; // preview page width, in CSS pixels
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
  saveJson(SETTINGS_KEY, data);
}

function restoreSettings() {
  const data = loadJson(SETTINGS_KEY);
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
  if (!isPdf(file)) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(bytes.slice(), { name: file.name }).promise;

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
      ? "パスワードが入力されなかったので開けませんでした"
      : "PDFを開けませんでした";
    showStatus(msg, { error: true });
  }
}

function resetDocument() {
  previews.clear();
  state.pdf?.destroy();
  state.pdf = null;
  state.pages = [];
  els.pages.replaceChildren();
}

function createPageView(num, viewport) {
  const el = document.createElement("li");
  el.className = "page";
  // The canvas gets its pixels when it comes near the screen; its size on the page is fixed now.
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const scale = PREVIEW_PX / viewport.width;
  const px = { w: Math.round(viewport.width * scale * dpr), h: Math.round(viewport.height * scale * dpr) };
  canvas.width = canvas.height = 0;
  canvas.style.width = `${PREVIEW_PX}px`;
  canvas.style.height = `${(px.h / px.w) * PREVIEW_PX}px`;
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = `${num} / ${state.pdf.numPages}`;
  el.append(canvas, label);
  els.pages.append(el);

  const view = { num, viewport, el, canvas, px, base: null, rendered: false, stale: false };
  previews.add(view);
  return view;
}

/* ---------- preview ---------- */

// Pages far off screen are freed; a page that comes back is drawn with the current settings.
const previews = createLazyRenderer({
  root: els.viewer,
  renderMargin: "800px 0px",
  releaseMargin: "2500px 0px",
  render: renderPage,
  release: (view) => {
    view.base = null;
    view.canvas.width = view.canvas.height = 0;
  },
  show: (view) => view.stale && drawPreview(view),
});

async function renderPage(view) {
  view.rendered = true;
  const pdf = state.pdf;
  const page = await pdf.getPage(view.num);
  const base = document.createElement("canvas");
  base.width = view.px.w;
  base.height = view.px.h;
  const ctx = base.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, base.width, base.height);
  try {
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: base.width / view.viewport.width }) }).promise;
  } catch (err) {
    console.error(err);
  }
  if (state.pdf !== pdf || !view.rendered) return; // another PDF was opened, or scrolled far away
  view.base = base;
  view.canvas.width = base.width;
  view.canvas.height = base.height;
  drawPreview(view);
}

const measureCtx = document.createElement("canvas").getContext("2d");
function measureOnScreen(text, size) {
  measureCtx.font = `100px ${FONT_FAMILY}`;
  return (measureCtx.measureText(text).width * size) / 100;
}

function drawPreview(view, settings = readSettings()) {
  if (!view.base) return;
  view.stale = false;
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

// Typing in a setting redraws only the pages near the screen; the others are redrawn when they
// come back into view. The settings are stored once typing pauses.
let redrawQueued = false;
let storeTimer = 0;
function update() {
  syncControls();
  clearTimeout(storeTimer);
  storeTimer = setTimeout(storeSettings, 300);
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    const settings = readSettings();
    for (const view of state.pages) {
      if (previews.isNear(view)) drawPreview(view, settings);
      else view.stale = true;
    }
  });
}

// The preview needs the real font to show where text lands.
document.fonts.load(`100px ${FONT_FAMILY}`, "あ1").then(() => update());

/* ---------- saving ---------- */

function hexToRgb(hex, rgb) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function outputName(settings) {
  const base = state.fileName.replace(/\.pdf$/i, "");
  const suffix = settings.num.on && settings.wm.on ? "番号・透かし入り" : settings.num.on ? "番号入り" : "透かし入り";
  return `${base}_${suffix}.pdf`;
}

async function save() {
  if (!state.bytes || state.busy) return;
  const settings = readSettings();
  if (!settings.num.on && !settings.wm.on) return;
  state.busy = true;
  syncControls();
  showStatus("PDFを作成中…", { sticky: true });
  try {
    const [{ PDFDocument, rgb, degrees }, fontkit] = await Promise.all([loadPdfLib(), loadFontkit()]);
    const original = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    const rebuilt = original.isEncrypted;
    const onPage = (num, count) => showStatus(`保護されたPDFのため、ページを画像にしています… (${num}/${count})`, { sticky: true });
    const doc = rebuilt ? await rasterizePdf(state.pdf, { onPage }) : original;
    doc.registerFontkit(fontkit);
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
          color: hexToRgb(d.color, rgb),
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
onFileDrop((files) => openFile(files[0]));

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
