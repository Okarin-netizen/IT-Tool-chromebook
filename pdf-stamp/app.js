import { openPdf, isPasswordCancelled, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { makeZip } from "../shared/js/zip.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { subsetFont, EMBED_OPTIONS } from "../shared/js/font-jp.js";
import { createLazyRenderer } from "../shared/js/lazy.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib, loadFontkit } from "../shared/js/pdf-lib.js";
import { hexToRgb } from "../shared/js/color.js";
import { canvasToBlob, pixelRatio } from "../shared/js/canvas.js";
import { dateText } from "../shared/js/dates.js";

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
  wmType: $("wm-type"),
  wmTextOpts: $("wm-text-opts"),
  wmImageOpts: $("wm-image-opts"),
  wmImageInput: $("wm-image-input"),
  wmImageName: $("wm-image-name"),
  wmImageSize: $("wm-image-size"),
  wmImageSizeOut: $("wm-image-size-out"),
  wmSizeRow: $("wm-size-row"),
  wmColorRow: $("wm-color-row"),
  numScope: $("num-scope"),
  numScopeRow: $("num-scope-row"),
  hfOn: $("hf-on"),
  hfOpts: $("hf-opts"),
  hfTl: $("hf-tl"),
  hfTc: $("hf-tc"),
  hfTr: $("hf-tr"),
  hfBl: $("hf-bl"),
  hfBc: $("hf-bc"),
  hfBr: $("hf-br"),
  hfSize: $("hf-size"),
  hfColor: $("hf-color"),
  hfMargin: $("hf-margin"),
  hfSkipFirst: $("hf-skip-first"),
};

const state = {
  // { name, bytes (never handed to pdf.js, which detaches buffers), pdf (pdf.js), views }
  files: [],
  // every page of every file, in order:
  // { file, num (in its file), index (overall), viewport (scale 1), el, canvas, base (rendered page without stamps), rendered }
  pages: [],
  numPos: "bottom-center",
  wmImage: null, // { name, bytes (PNG), img } for an image watermark
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
    hf: {
      on: els.hfOn.checked && [els.hfTl, els.hfTc, els.hfTr, els.hfBl, els.hfBc, els.hfBr].some((el) => el.value.trim()),
      top: [els.hfTl.value, els.hfTc.value, els.hfTr.value],
      bottom: [els.hfBl.value, els.hfBc.value, els.hfBr.value],
      size: Number(els.hfSize.value),
      color: els.hfColor.value,
      margin: Number(els.hfMargin.value),
      skipFirst: els.hfSkipFirst.checked,
    },
    perFile: els.numScope.value === "file" && state.files.length > 1,
    wm: {
      on: els.wmOn.checked && (els.wmType.value === "image" ? !!state.wmImage : els.wmText.value.trim() !== ""),
      type: els.wmType.value,
      image: els.wmType.value === "image" ? state.wmImage : null,
      imageSize: Number(els.wmImageSize.value) / 100,
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
  "numSkipFirst", "wmOn", "wmText", "wmAngle", "wmLayout", "wmSize", "wmColor", "wmOpacity", "wmSkipFirst",
  "numScope", "hfOn", "hfTl", "hfTc", "hfTr", "hfBl", "hfBc", "hfBr", "hfSize", "hfColor", "hfMargin", "hfSkipFirst",
  "wmType", "wmImageSize"];

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
  els.hfOpts.classList.toggle("off", !els.hfOn.checked);
  els.wmOpts.classList.toggle("off", !els.wmOn.checked);
  els.numScopeRow.hidden = state.files.length < 2;
  const image = els.wmType.value === "image";
  els.wmTextOpts.hidden = image;
  els.wmImageOpts.hidden = !image;
  els.wmSizeRow.hidden = image;
  els.wmColorRow.hidden = image;
  els.wmImageSizeOut.textContent = `${els.wmImageSize.value}%`;
  els.wmSizeOut.textContent = els.wmSize.value;
  els.wmOpacityOut.textContent = `${els.wmOpacity.value}%`;
  for (const btn of document.querySelectorAll(".pos")) {
    const on = btn.dataset.pos === state.numPos;
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-checked", on);
  }
  const s = readSettings();
  els.saveBtn.disabled = !state.files.length || state.busy || (!s.num.on && !s.hf.on && !s.wm.on);
}

/* ---------- layout ---------- */

// Where a page stands in the numbering: overall, or within its own file when "PDFごとに1から"
// is chosen. index is 0-based, count is the number of pages counted together.
function pageInfo(view, settings) {
  if (settings.perFile) return { index: view.num - 1, count: view.file.views.length, file: view.file.name };
  return { index: view.index, count: state.pages.length, file: view.file.name };
}


// Returns everything to draw on one page, in page units (1 = 1pt) with a
// top-left origin as the page is seen on screen. `y` is the text baseline and
// `angle` is counter-clockwise degrees. Images are { image, x, y, w, h, angle, opacity } with
// (x, y) at their lower left corner. `measure(text, size)` gives text width.
function layoutPage(info, width, height, settings, measure) {
  const page = { ...info, width, height, measure };
  const { num, hf, wm } = settings;
  const shows = (part) => part.on && !(part.skipFirst && info.index === 0);
  return [
    ...(shows(num) ? layoutNumber(page, num) : []),
    ...(shows(hf) ? layoutHeaderFooter(page, hf) : []),
    ...(shows(wm) ? layoutWatermark(page, wm) : []),
  ];
}

// Where a line of text `w` wide starts, at the left or right margin or in the middle.
function alignX(align, w, width, margin) {
  if (align === "left") return margin;
  if (align === "right") return width - margin - w;
  return (width - w) / 2;
}

// The baseline of a line at the top or bottom margin.
function alignY(align, size, height, margin) {
  return align === "top" ? margin + size * ASCENT : height - margin;
}

function layoutNumber({ index, count, width, height, measure }, num) {
  const first = num.skipFirst ? 1 : 0;
  const n = num.start + index - first;
  const total = num.start + (count - first) - 1;
  const text = num.format.replaceAll("{n}", n).replaceAll("{total}", total);
  if (!text.trim()) return [];
  const w = measure(text, num.size);
  const [v, h] = num.pos.split("-");
  const x = alignX(h, w, width, num.margin);
  const y = alignY(v, num.size, height, num.margin);
  return [{ text, x, y, angle: 0, size: num.size, color: num.color, opacity: 1 }];
}

// Header and footer: three texts (left, middle, right) at the top and three at the bottom.
function layoutHeaderFooter({ index, count, file, width, height, measure }, hf) {
  const fill = (text) => text
    .replaceAll("{n}", index + 1)
    .replaceAll("{total}", count)
    .replaceAll("{date}", dateText(new Date(), "/"))
    .replaceAll("{file}", baseName(file))
    .trim();
  const draws = [];
  for (const [row, texts] of [["top", hf.top], ["bottom", hf.bottom]]) {
    texts.forEach((raw, col) => {
      const text = fill(raw);
      if (!text) return;
      const w = measure(text, hf.size);
      const x = alignX(["left", "center", "right"][col], w, width, hf.margin);
      const y = alignY(row, hf.size, height, hf.margin);
      draws.push({ text, x, y, angle: 0, size: hf.size, color: hf.color, opacity: 1 });
    });
  }
  return draws;
}

function layoutWatermark({ width, height, measure }, wm) {
  const angle = wm.angle === "diagonal" ? (Math.atan2(height, width) * 180) / Math.PI : Number(wm.angle);
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const image = wm.image;
  // An image is as wide as `imageSize` of the page; text is `size` points tall.
  const w = image ? width * wm.imageSize : measure(wm.text, wm.size);
  const h = image ? (w * image.img.naturalHeight) / image.img.naturalWidth : wm.size;
  // Screen y grows downward, so "counter-clockwise" flips the sign of sin.
  // Text is placed by the left end of its baseline, an image by its lower left corner.
  const place = (cx, cy) => {
    const lx = -w / 2;
    const ly = image ? h / 2 : wm.size * MID;
    return { x: cx + lx * cos + ly * sin, y: cy - lx * sin + ly * cos };
  };
  const stamp = ([cx, cy]) => (image
    ? { image, ...place(cx, cy), w, h, angle, opacity: wm.opacity }
    : { text: wm.text, ...place(cx, cy), angle, size: wm.size, color: wm.color, opacity: wm.opacity });
  if (wm.layout !== "tile") return [stamp([width / 2, height / 2])];
  const step = {
    along: w + (image ? w * 0.4 : wm.size * 1.5), // along the text
    across: image ? h * 1.6 : wm.size * 3, // across the lines
  };
  return tileCenters(width, height, w, step, cos, sin).map(stamp);
}

// The centres of the copies of a tiled watermark `w` wide: rows turned by the angle whose
// cos and sin are given, every other row shifted by half a step, all that touch the page.
function tileCenters(width, height, w, step, cos, sin) {
  const reach = Math.hypot(width, height) / 2 + w;
  const cols = Math.ceil(reach / step.along) + 1;
  const rows = Math.ceil(reach / step.across) + 1;
  const centers = [];
  for (let j = -rows; j <= rows; j++) {
    for (let i = -cols; i <= cols; i++) {
      const a = (i + (j & 1) / 2) * step.along;
      const b = j * step.across;
      const cx = width / 2 + a * cos + b * sin;
      const cy = height / 2 - a * sin + b * cos;
      const onPage = cx >= -w / 2 && cx <= width + w / 2 && cy >= -w / 2 && cy <= height + w / 2;
      if (onPage) centers.push([cx, cy]);
    }
  }
  return centers;
}

/* ---------- opening a PDF ---------- */

async function openFiles(list) {
  const files = [...list].filter(isPdf);
  if (!files.length) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  showStatus("PDFを読み込み中…", { sticky: true });
  const opened = [];
  const failed = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await openPdf(bytes.slice(), { name: file.name }).promise;
      opened.push({ name: file.name || "document.pdf", bytes, pdf, views: [] });
    } catch (err) {
      console.error(err);
      failed.push(isPasswordCancelled(err) ? `${file.name}（パスワードが入力されませんでした）` : file.name);
    }
  }
  if (!opened.length) {
    showStatus(`PDFを開けませんでした: ${failed.join("、")}`, { error: true });
    return;
  }

  resetDocument();
  state.files = opened;
  const total = opened.reduce((n, f) => n + f.pdf.numPages, 0);
  document.title = `${opened[0].name}${opened.length > 1 ? " など" : ""} - ページ番号・透かし入れ`;
  els.fileName.textContent = opened.length > 1
    ? `${opened.length}個のPDF（全${total}ページ）`
    : `${opened[0].name}（${total}ページ）`;
  for (const file of opened) {
    for (let num = 1; num <= file.pdf.numPages; num++) {
      const page = await file.pdf.getPage(num);
      const view = createPageView(file, num, page.getViewport({ scale: 1 }));
      file.views.push(view);
      state.pages.push(view);
    }
  }
  els.welcome.hidden = true;
  els.viewer.scrollTop = 0;
  syncControls();
  if (failed.length) showStatus(`開けなかったPDF: ${failed.join("、")}`, { error: true });
  else hideStatus();
}

function resetDocument() {
  previews.clear();
  for (const file of state.files) file.pdf.destroy();
  state.files = [];
  state.pages = [];
  els.pages.replaceChildren();
}

function createPageView(file, num, viewport) {
  const el = document.createElement("li");
  el.className = "page";
  // The canvas gets its pixels when it comes near the screen; its size on the page is fixed now.
  const canvas = document.createElement("canvas");
  const dpr = pixelRatio();
  const scale = PREVIEW_PX / viewport.width;
  const px = { w: Math.round(viewport.width * scale * dpr), h: Math.round(viewport.height * scale * dpr) };
  canvas.width = canvas.height = 0;
  canvas.style.width = `${PREVIEW_PX}px`;
  canvas.style.height = `${(px.h / px.w) * PREVIEW_PX}px`;
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = `${num} / ${file.pdf.numPages}`;
  if (state.files.length > 1 && num === 1) {
    label.prepend(Object.assign(document.createElement("span"), { className: "file", textContent: `${file.name}　` }));
  }
  el.append(canvas, label);
  els.pages.append(el);

  const view = { file, num, index: state.pages.length, viewport, el, canvas, px, base: null, rendered: false, stale: false };
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
  const pdf = view.file.pdf;
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
  if (!state.files.includes(view.file) || !view.rendered) return; // another PDF was opened, or scrolled far away
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
  const draws = layoutPage(pageInfo(view, settings), view.viewport.width, view.viewport.height,
    settings, measureOnScreen);
  for (const d of draws) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.translate(d.x, d.y);
    ctx.rotate((-d.angle * Math.PI) / 180);
    ctx.globalAlpha = d.opacity;
    if (d.image) {
      ctx.drawImage(d.image.img, 0, -d.h, d.w, d.h);
      continue;
    }
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


function suffixOf(settings) {
  const parts = [settings.num.on && "番号", settings.hf.on && "ヘッダー", settings.wm.on && "透かし"].filter(Boolean);
  return `${parts.join("・")}入り`;
}

const outputName = (file, settings) => `${baseName(file.name)}_${suffixOf(settings)}.pdf`;

// Writes the stamps on one file. Returns { bytes, rebuilt }.
async function stampFile(file, settings, font) {
  const { PDFDocument, rgb, degrees } = await loadPdfLib();
  const original = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const rebuilt = original.isEncrypted;
  const onPage = (num, count) => showStatus(`保護されたPDFのため、ページを画像にしています… (${num}/${count})`, { sticky: true });
  const doc = rebuilt ? await rasterizePdf(file.pdf, { onPage }) : original;
  doc.registerFontkit(await loadFontkit());
  const embedded = font ? await doc.embedFont(font, EMBED_OPTIONS) : null;
  const measure = (text, size) => embedded.widthOfTextAtSize(text, size);
  const image = settings.wm.on && settings.wm.image ? await doc.embedPng(settings.wm.image.bytes) : null;

  file.views.forEach((view, i) => {
    const page = doc.getPage(i);
    const { viewport } = view;
    // Maps screen coordinates (scale 1, top-left origin) onto the page.
    // Rebuilt pages are already upright, so only the y axis flips.
    const toPdf = rebuilt ? (x, y) => [x, viewport.height - y] : (x, y) => viewport.convertToPdfPoint(x, y);
    const rotation = rebuilt ? 0 : viewport.rotation;
    for (const d of layoutPage(pageInfo(view, settings), viewport.width, viewport.height, settings, measure)) {
      const [x, y] = toPdf(d.x, d.y);
      if (d.image) {
        page.drawImage(image, { x, y, width: d.w, height: d.h, opacity: d.opacity, rotate: degrees(d.angle + rotation) });
        continue;
      }
      page.drawText(d.text, {
        x, y, size: d.size, font: embedded,
        color: hexToRgb(d.color, rgb),
        opacity: d.opacity,
        rotate: degrees(d.angle + rotation),
      });
    }
  });
  return { bytes: await doc.save(), rebuilt };
}

async function save() {
  if (!state.files.length || state.busy) return;
  const settings = readSettings();
  if (!settings.num.on && !settings.hf.on && !settings.wm.on) return;
  state.busy = true;
  syncControls();
  showStatus("PDFを作成中…", { sticky: true });
  try {
    await Promise.all([loadPdfLib(), loadFontkit()]);
    // The font only needs the characters that actually get drawn, so lay out
    // with a rough width first just to collect them.
    const allText = state.pages
      .flatMap((v) => layoutPage(pageInfo(v, settings), v.viewport.width, v.viewport.height, settings, () => 0))
      .map((d) => d.text ?? "")
      .join("");
    const font = allText ? await subsetFont(allText + " ") : null;

    const outputs = [];
    let rebuiltCount = 0;
    for (const [i, file] of state.files.entries()) {
      if (state.files.length > 1) showStatus(`PDFを作成中… (${i + 1}/${state.files.length})`, { sticky: true });
      const { bytes, rebuilt } = await stampFile(file, settings, font);
      if (rebuilt) rebuiltCount++;
      outputs.push({ name: outputName(file, settings), bytes });
    }
    if (outputs.length === 1) download(new Blob([outputs[0].bytes], { type: "application/pdf" }), outputs[0].name);
    else download(makeZip(outputs), `${suffixOf(settings)}_${outputs.length}件.zip`);
    showStatus(rebuiltCount
      ? "保存しました（保護されたPDFは、元のページを画像として保存しています）"
      : "保存しました（ダウンロードフォルダを確認してください）");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。PDFが壊れているか、対応していない形式の可能性があります", { error: true });
  } finally {
    state.busy = false;
    syncControls();
  }
}

/* ---------- image watermark ---------- */

// Any picture becomes a PNG (keeping see-through parts) so pdf-lib can embed it.
async function setWatermarkImage(file) {
  if (!file?.type.startsWith("image/")) return showStatus("画像ファイルを選んでください", { error: true });
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    const k = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await canvasToBlob(canvas, "image/png");
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    state.wmImage = { name: file.name, bytes: new Uint8Array(await blob.arrayBuffer()), img };
    els.wmImageName.textContent = file.name;
    els.wmOn.checked = true;
    update();
  } catch (err) {
    console.error(err);
    showStatus("画像を読み込めませんでした", { error: true });
  }
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  openFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.wmImageInput.addEventListener("change", () => {
  setWatermarkImage(els.wmImageInput.files[0]);
  els.wmImageInput.value = "";
});
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save: save, kind: "pdf" });

for (const el of document.querySelectorAll(".panel input, .panel select")) {
  el.addEventListener("input", update);
  el.addEventListener("change", update);
}
// Touching a setting of a switched-off section switches it on.
for (const [opts, toggle] of [[els.numOpts, els.numOn], [els.hfOpts, els.hfOn], [els.wmOpts, els.wmOn]]) {
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
onFileDrop(openFiles);

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
