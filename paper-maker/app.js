// 方眼紙・罫線プリント: grid paper, ruled lines, English four lines, kanji squares, coordinate
// planes and music staves as a PDF to print. The shapes come from sheets.js.
import { showStatus } from "../shared/js/status.js";
import { download, safeFileName } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { loadPdfLib, loadFontkit } from "../shared/js/pdf-lib.js";
import { subsetFont, preloadFont, EMBED_OPTIONS } from "../shared/js/font-jp.js";
import { hexToRgb } from "../shared/js/color.js";
import { pixelRatio } from "../shared/js/canvas.js";
import { registerOffline } from "../shared/js/offline.js";
import { KINDS, buildSheet } from "./sheets.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "paper-maker-v1";

const PT_PER_MM = 72 / 25.4;
const PREVIEW_MAX_HEIGHT = 530; // px on screen
const PREVIEW_MAX_WIDTH = 620; // px on screen
const INK = "#333333"; // axes and words
const LINE_COLORS = { gray: "#9aa0a6", blue: "#6fa8dc", black: "#333333" };
const TEXT_SHIFT = 0.35; // the baseline sits this many text sizes below the middle

const $ = (id) => document.getElementById(id);

const settings = {
  kind: "grid",
  size: KINDS.grid.size,
  paper: "A4",
  landscape: false,
  color: "gray",
  nameLine: false,
  title: "",
  ...loadJson(SETTINGS_KEY, {}),
};

/* ---------- choosing ---------- */

function buildKindButtons() {
  const buttons = Object.entries(KINDS).map(([kind, { name }]) => {
    const button = document.createElement("button");
    button.className = "kind";
    button.setAttribute("role", "radio");
    button.dataset.kind = kind;
    button.textContent = name;
    button.addEventListener("click", () => chooseKind(kind));
    return button;
  });
  $("kinds").replaceChildren(...buttons);
}

function fillSizes() {
  const { sizes } = KINDS[settings.kind];
  const options = Object.entries(sizes).map(([value, words]) => new Option(words, value));
  $("size").replaceChildren(...options);
  if (!(settings.size in sizes)) settings.size = KINDS[settings.kind].size;
  $("size").value = settings.size;
}

function chooseKind(kind) {
  settings.kind = kind;
  settings.size = KINDS[kind].size;
  fillSizes();
  changed();
}

function changed() {
  saveJson(SETTINGS_KEY, settings);
  render();
}

/* ---------- drawing ---------- */

function drawShape(ctx, shape, scale, lineColor) {
  if (shape.type === "line") {
    ctx.strokeStyle = shape.ink ? INK : lineColor;
    ctx.lineWidth = Math.max(0.5, shape.width * scale);
    ctx.setLineDash((shape.dash ?? []).map((mm) => mm * scale));
    ctx.beginPath();
    ctx.moveTo(shape.x1 * scale, shape.y1 * scale);
    ctx.lineTo(shape.x2 * scale, shape.y2 * scale);
    ctx.stroke();
    return;
  }
  if (shape.type === "dot") {
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(shape.x * scale, shape.y * scale, Math.max(0.6, shape.r * scale), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.fillStyle = INK;
  ctx.font = `${shape.size * scale}px system-ui, sans-serif`;
  ctx.textAlign = shape.align;
  ctx.fillText(shape.text, shape.x * scale, (shape.y + shape.size * TEXT_SHIFT) * scale);
}

function render() {
  for (const button of document.querySelectorAll(".kind")) button.setAttribute("aria-checked", String(button.dataset.kind === settings.kind));
  for (const button of document.querySelectorAll("[data-landscape]")) button.setAttribute("aria-checked", String(button.dataset.landscape === String(settings.landscape)));
  for (const button of document.querySelectorAll("[data-color]")) button.setAttribute("aria-checked", String(button.dataset.color === settings.color));
  const sheet = buildSheet(settings);
  const fit = Math.min(PREVIEW_MAX_HEIGHT / sheet.height, PREVIEW_MAX_WIDTH / sheet.width);
  const ratio = pixelRatio();
  const canvas = $("preview");
  canvas.width = Math.round(sheet.width * fit * ratio);
  canvas.height = Math.round(sheet.height * fit * ratio);
  canvas.style.width = `${Math.round(sheet.width * fit)}px`;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const shape of sheet.shapes) drawShape(ctx, shape, fit * ratio, LINE_COLORS[settings.color]);
  $("info").textContent = `${settings.paper}・${settings.landscape ? "横" : "縦"}　${KINDS[settings.kind].name}（${KINDS[settings.kind].sizes[settings.size]}）`;
}

/* ---------- PDF ---------- */

async function loadFonts(doc, sheet) {
  const { StandardFonts } = window.PDFLib;
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  const words = sheet.shapes.filter((shape) => shape.type === "text" && !shape.latin).map((shape) => shape.text).join("");
  if (!words) return { latin, japanese: latin };
  doc.registerFontkit(await loadFontkit());
  const japanese = await doc.embedFont(await subsetFont(words), EMBED_OPTIONS);
  return { latin, japanese };
}

function drawPdfText(page, shape, fonts, height, rgb) {
  const font = shape.latin ? fonts.latin : fonts.japanese;
  const size = shape.size * PT_PER_MM;
  const width = font.widthOfTextAtSize(shape.text, size);
  const offsets = { left: 0, center: width / 2, right: width };
  page.drawText(shape.text, {
    x: shape.x * PT_PER_MM - offsets[shape.align],
    y: height - (shape.y + shape.size * TEXT_SHIFT) * PT_PER_MM,
    size,
    font,
    color: rgb(0.2, 0.2, 0.2),
  });
}

function drawPdfShape(page, shape, fonts, height, colors) {
  if (shape.type === "line") {
    page.drawLine({
      start: { x: shape.x1 * PT_PER_MM, y: height - shape.y1 * PT_PER_MM },
      end: { x: shape.x2 * PT_PER_MM, y: height - shape.y2 * PT_PER_MM },
      thickness: shape.width * PT_PER_MM,
      color: shape.ink ? colors.ink : colors.line,
      dashArray: shape.dash?.map((mm) => mm * PT_PER_MM),
    });
    return;
  }
  if (shape.type === "dot") {
    page.drawCircle({ x: shape.x * PT_PER_MM, y: height - shape.y * PT_PER_MM, size: shape.r * PT_PER_MM, color: colors.line });
    return;
  }
  drawPdfText(page, shape, fonts, height, colors.rgb);
}

async function buildPdf() {
  const { PDFDocument, rgb } = await loadPdfLib();
  const sheet = buildSheet(settings);
  const doc = await PDFDocument.create();
  doc.setTitle(settings.title || KINDS[settings.kind].name);
  const height = sheet.height * PT_PER_MM;
  const page = doc.addPage([sheet.width * PT_PER_MM, height]);
  const fonts = await loadFonts(doc, sheet);
  const colors = { line: hexToRgb(LINE_COLORS[settings.color], rgb), ink: hexToRgb(INK, rgb), rgb };
  for (const shape of sheet.shapes) drawPdfShape(page, shape, fonts, height, colors);
  return doc.save();
}

function fileName() {
  const kind = KINDS[settings.kind];
  const size = kind.sizes[settings.size].replace(/（.*）/, "").replace(/\s+/g, "");
  const name = settings.title || `${kind.name}_${size}`;
  return safeFileName(`${name}_${settings.paper}.pdf`);
}

async function save() {
  showStatus("PDFを作成中…", { sticky: true });
  try {
    const bytes = await buildPdf();
    download(new Blob([bytes], { type: "application/pdf" }), fileName());
    showStatus("PDFを保存しました");
  } catch (err) {
    console.error(err);
    showStatus("PDFを作れませんでした", { error: true });
  }
}

/* ---------- events ---------- */

buildKindButtons();
fillSizes();
$("paper").value = settings.paper;
$("name-line").checked = settings.nameLine;
$("title").value = settings.title;

$("size").addEventListener("change", (e) => {
  settings.size = e.target.value;
  changed();
});
$("paper").addEventListener("change", (e) => {
  settings.paper = e.target.value;
  changed();
});
for (const button of document.querySelectorAll("[data-landscape]")) {
  button.addEventListener("click", () => {
    settings.landscape = button.dataset.landscape === "true";
    changed();
  });
}
for (const button of document.querySelectorAll("[data-color]")) {
  button.addEventListener("click", () => {
    settings.color = button.dataset.color;
    changed();
  });
}
$("name-line").addEventListener("change", (e) => {
  settings.nameLine = e.target.checked;
  if (settings.nameLine) preloadFont();
  changed();
});
$("title").addEventListener("input", (e) => {
  settings.title = e.target.value.trim();
  if (settings.title) preloadFont();
  changed();
});
$("save-btn").addEventListener("click", save);
render();

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "sheets.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js",
  "../shared/vendor/fontkit-1.1.1/fontkit.umd.min.js",
  "../shared/vendor/harfbuzz-1.6.3/harfbuzz-subset.wasm",
  "../shared/vendor/noto-sans-jp/NotoSansJP-Regular.ttf",
]);

// Hook for automated tests.
window.__paperMaker = { settings, buildPdf, buildSheet };
