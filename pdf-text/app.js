import { pdfjsLib, openPdf, openPdfError, rasterizePdf } from "../shared/js/pdf.js";
import { createPageViewer, clampScale } from "../shared/js/page-viewer.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { subsetFont, preloadFont, EMBED_OPTIONS } from "../shared/js/font-jp.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib, loadFontkit } from "../shared/js/pdf-lib.js";
import { hexToRgb } from "../shared/js/color.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { History } from "../shared/js/history.js";

const FONT_FAMILY = "PdfTextJP";
const LINE_HEIGHT = 1.25; // must match .tbox line-height in style.css
const MAX_IMAGE_PX = 2000; // longest side of a placed photo; keeps saved PDFs small
const MIN_WHITE = 4; // smallest side of a white box, in points; a plain click draws none

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  imageBtn: $("image-btn"),
  imageInput: $("image-input"),
  whiteBtn: $("white-btn"),
  fontSize: $("font-size"),
  deleteBtn: $("delete-btn"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomLabel: $("zoom-label"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  pages: $("pages"),
};

const state = {
  fileName: "document.pdf",
  bytes: null, // original PDF bytes (never handed to pdf.js, which detaches buffers)
  pdf: null, // pdf.js document
  pages: [], // { num, viewport (scale 1), el, canvas, layer, formLayer, rendered, task }
  hasForm: false, // the PDF has fill-in fields (AcroForm), shown as real input boxes
  // text: { type, page, x, y, size, color, text, el, box }  image: { type, page, x, y, w, h, bytes, format, url, el, box }
  // white (a white box hiding what is under it): { type, page, x, y, w, h, el, box }
  items: [],
  active: null,
  scale: 1,
  size: 12,
  color: "#000000",
  baselineRatio: 1.0, // first-line baseline / font size, measured from the real font
  dirty: false,
  whiteMode: false, // dragging on a page draws a white box instead of starting a text
};

/* ---------- font ---------- */

const fontReady = (async () => {
  await document.fonts.load(`100px ${FONT_FAMILY}`, "あA");
  // Measure where the first baseline sits inside a line box so the saved PDF
  // puts each line exactly where it appears on screen.
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;` +
    `font:100px/${LINE_HEIGHT} ${FONT_FAMILY};margin:0;padding:0;border:0`;
  const marker = document.createElement("span");
  marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  probe.append("あA", marker);
  document.body.append(probe);
  state.baselineRatio = marker.offsetTop / 100;
  probe.remove();
})();

// Saving needs the Japanese font and pdf-lib. They are fetched once the first PDF is open and
// the Chromebook is idle, so opening the tool stays quick and saving does not wait for them.
let preloaded = false;
function preloadForSaving() {
  if (preloaded) return;
  preloaded = true;
  requestIdleCallback(() => {
    preloadFont();
    loadPdfLib().catch(() => {});
    loadFontkit().catch(() => {});
  }, { timeout: 3000 });
}

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (state.dirty && !confirm("書き込んだ文字は保存されていません。別のPDFを開きますか？")) return;
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(bytes.slice(), { name: file.name }).promise;

    resetDocument();
    state.bytes = bytes;
    state.pdf = pdf;
    state.hasForm = !!(await pdf.getFieldObjects().catch(() => null));
    state.fileName = file.name || "document.pdf";
    document.title = `${state.fileName} - PDF文字入れ`;

    for (let num = 1; num <= pdf.numPages; num++) {
      const page = await pdf.getPage(num);
      state.pages.push(createPageView(num, page.getViewport({ scale: 1 })));
    }
    els.welcome.hidden = true;
    els.saveBtn.disabled = false;
    els.imageBtn.disabled = false;
    els.whiteBtn.disabled = false;
    setScale(viewer.fitWidthScale());
    els.viewer.scrollTop = 0;
    hideStatus();
    showStatus(state.hasForm
      ? "このPDFには入力欄があります。青い枠の中にそのまま入力できます。ほかの場所はクリックで文字を入れられます"
      : "文字を入れたい場所をクリックしてください", { ms: state.hasForm ? 7000 : undefined });
    preloadForSaving();
  } catch (err) {
    console.error(err);
    showStatus(openPdfError(err, "PDFを開けませんでした"), { error: true });
  }
}

function resetDocument() {
  viewer.clear();
  state.pdf?.destroy();
  state.pages = [];
  state.hasForm = false;
  // Photos taken out are kept for undo until another PDF is opened.
  for (const record of history.steps.flat()) if (record.item.url) URL.revokeObjectURL(record.item.url);
  state.items = [];
  state.active = null;
  state.dirty = false;
  history.reset();
  els.pages.replaceChildren();
  updateActiveUi();
}

function createPageView(num, viewport) {
  const el = document.createElement("div");
  el.className = "page";
  el.dataset.num = num;
  const canvas = document.createElement("canvas");
  const layer = document.createElement("div");
  layer.className = "layer";
  const label = document.createElement("div");
  label.className = "page-num";
  label.textContent = `${num} / ${state.pdf.numPages}`;
  el.append(canvas, layer, label);
  els.pages.append(el);

  const view = { num, viewport, el, canvas, layer, rendered: false, task: null };
  layer.addEventListener("pointerdown", (e) => {
    if (e.target !== layer || e.button !== 0) return;
    e.preventDefault();
    if (state.whiteMode) return drawWhite(view, e);
    const rect = layer.getBoundingClientRect();
    const x = (e.clientX - rect.left) / state.scale;
    const y = (e.clientY - rect.top) / state.scale - (state.size * LINE_HEIGHT) / 2;
    addItem(view, x, Math.max(0, y));
  });
  viewer.add(view);
  return view;
}

/* ---------- rendering ---------- */

const viewer = createPageViewer({
  state,
  viewer: els.viewer,
  zoomLabel: els.zoomLabel,
  views: () => state.pages,
  pdfOf: () => state.pdf,
  annotationMode: () => (state.hasForm ? pdfjsLib.AnnotationMode.ENABLE_FORMS : pdfjsLib.AnnotationMode.ENABLE),
  onRendered: (view, page) => state.hasForm && renderFormLayer(view, page),
  onRelease: (view) => {
    view.formLayer?.remove();
    view.formLayer = null;
  },
});

/* ---------- fill-in fields (AcroForm) ---------- */

// Fields are drawn by pdf.js's own AnnotationLayer as real <input>s, the way Mozilla's PDF
// viewer (and BentoPDF's form filler, which embeds it) does. What is typed is kept in the
// document's annotationStorage, so a page that is freed and drawn again keeps its values.
const WIDGET = 20; // pdf.js AnnotationType.WIDGET (not exported by the library build)
const linkService = {
  externalLinkEnabled: false,
  getDestinationHash: () => "#",
  getAnchorUrl: () => "#",
  addLinkAttributes() {},
  isInPresentationMode: false,
};

async function renderFormLayer(view, page) {
  const annotations = (await page.getAnnotations({ intent: "display" }))
    .filter((a) => a.annotationType === WIDGET);
  view.formLayer?.remove();
  view.formLayer = null;
  if (!annotations.length || !view.rendered) return;
  const div = document.createElement("div");
  div.className = "annotationLayer form-layer";
  view.el.style.setProperty("--scale-factor", state.scale);
  view.el.style.setProperty("--total-scale-factor", state.scale);
  view.el.append(div);
  view.formLayer = div;
  const viewport = page.getViewport({ scale: state.scale }).clone({ dontFlip: true });
  const layer = new pdfjsLib.AnnotationLayer({
    div, page, viewport,
    accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, structTreeLayer: null,
  });
  await layer.render({
    viewport,
    div,
    annotations,
    page,
    linkService,
    renderForms: true,
    annotationStorage: state.pdf.annotationStorage,
    imageResourcesPath: "",
    enableScripting: false,
    hasJSActions: false,
  });
  div.addEventListener("input", () => (state.dirty = true));
  div.addEventListener("change", () => (state.dirty = true));
}

// Copies what was typed into the fields over to the pdf-lib document, and redraws the
// fields with the Japanese font so the answers show in every viewer.
async function fillForm(doc) {
  const storage = state.pdf.annotationStorage;
  if (!storage.size) return;
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = await loadPdfLib();
  const form = doc.getForm();
  for (let num = 1; num <= state.pdf.numPages; num++) {
    const page = await state.pdf.getPage(num);
    for (const a of await page.getAnnotations({ intent: "display" })) {
      if (a.annotationType !== WIDGET || !a.fieldName) continue;
      const stored = storage.getRawValue(a.id);
      if (stored === undefined || !("value" in stored)) continue;
      const field = form.getFieldMaybe(a.fieldName);
      const { value } = stored;
      if (field instanceof PDFTextField) field.setText(String(value ?? ""));
      else if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck();
      else if (field instanceof PDFRadioGroup && value) field.select(a.buttonValue);
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const picked = [value].flat().filter((v) => v !== "" && v != null);
        if (picked.length) field.select(picked.length > 1 ? picked : picked[0]);
      }
    }
  }
  const texts = form.getFields().filter((f) => f instanceof PDFTextField).map((f) => f.getText() ?? "").join("");
  if (texts.trim()) {
    const font = await doc.embedFont(await subsetFont(texts + "0123456789"), EMBED_OPTIONS);
    form.updateFieldAppearances(font);
  }
}

function setScale(scale) {
  viewer.setScale(scale);
  state.items.forEach(layoutItem);
}

/* ---------- text items ---------- */

function addItem(view, x, y) {
  const item = { id: nextItemId++, type: "text", page: view.num, x, y, size: state.size, color: state.color, text: "" };
  const { box, ta, handle, del } = createTextBox();
  view.layer.append(box);
  Object.assign(item, { el: ta, box });
  state.items.push(item);
  layoutItem(item);

  ta.addEventListener("input", () => {
    item.text = ta.value;
    state.dirty = true;
    autosize(item);
  });
  ta.addEventListener("focus", () => setActive(item));
  ta.addEventListener("blur", () => {
    recordChange(); // leaving the box ends the typing: it becomes one undo step
    // Drop boxes that were opened but never typed into.
    setTimeout(() => {
      if (!item.text.trim() && document.activeElement !== ta) removeItem(item);
    }, 0);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ta.blur();
  });
  del.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    removeItem(item);
  });
  enableDrag(item, handle);

  ta.focus();
  return item;
}

// The box a text is typed into, with its handle for moving it and its delete button.
function createTextBox() {
  const box = document.createElement("div");
  box.className = "titem";
  box.style.position = "absolute";

  const ta = document.createElement("textarea");
  ta.className = "tbox";
  ta.spellcheck = false;
  ta.wrap = "off";
  ta.rows = 1;
  ta.setAttribute("aria-label", "文字");

  const handle = document.createElement("div");
  handle.className = "handle";
  handle.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-move"/></svg>';
  handle.title = "ドラッグで移動";

  const del = document.createElement("div");
  del.className = "tdel";
  del.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-close"/></svg>';
  del.title = "削除";
  box.append(ta, handle, del);
  return { box, ta, handle, del };
}

function layoutItem(item) {
  const s = state.scale;
  item.box.style.left = `${item.x * s}px`;
  item.box.style.top = `${item.y * s}px`;
  if (item.type !== "text") {
    item.el.style.width = `${item.w * s}px`;
    item.el.style.height = `${item.h * s}px`;
    item.box.querySelector(".tdel").style.left = `${item.w * s + 4}px`;
    return;
  }
  item.el.style.fontSize = `${item.size * s}px`;
  item.el.style.color = item.color;
  autosize(item);
}

function autosize(item) {
  const ta = item.el;
  ta.style.width = "0px";
  ta.style.height = "0px";
  ta.style.width = `${ta.scrollWidth + 2}px`;
  ta.style.height = `${ta.scrollHeight}px`;
  // Keep the controls clear of the text itself.
  const handle = item.box.querySelector(".handle");
  const del = item.box.querySelector(".tdel");
  handle.style.left = "-26px";
  handle.style.top = "-2px";
  del.style.left = `${ta.offsetWidth + 4}px`;
  del.style.top = "-2px";
}

function removeItem(item) {
  const i = state.items.indexOf(item);
  if (i === -1) return;
  state.items.splice(i, 1);
  item.box.remove();
  if (state.active === item) setActive(null);
  if (item.type !== "text" || item.text.trim()) state.dirty = true;
  recordChange();
}

/* ---------- undo / redo ---------- */

// A step is each item with where it was and what it said; the items and their boxes are reused.
// Empty text boxes (just opened, nothing typed yet) are left out.
const history = new History(state, {
  take: () => state.items
    .filter((item) => item.type !== "text" || item.text.trim())
    .map((item) => item.type === "text"
      ? { item, x: item.x, y: item.y, size: item.size, color: item.color, text: item.text }
      : { item, x: item.x, y: item.y, w: item.w, h: item.h }),
  apply: restore,
});

let nextItemId = 1;
let restoring = false; // taking a focused box away while undoing must not record a step
const stepKey = (step) => JSON.stringify(step.map(({ item, ...values }) => [item.id, values]));

// Records a new step, unless nothing changed since the last one.
function recordChange() {
  if (restoring) return;
  if (stepKey(history.take()) !== stepKey(history.steps[history.pos])) history.record();
  updateUndoUi();
}

function restore(step) {
  const kept = new Set(step.map((r) => r.item));
  restoring = true;
  for (const item of state.items) if (!kept.has(item)) item.box.remove();
  restoring = false;
  for (const { item, ...values } of step) {
    Object.assign(item, values);
    if (item.type === "text") item.el.value = item.text;
    if (!item.box.isConnected) state.pages[item.page - 1].layer.append(item.box);
    layoutItem(item);
  }
  state.items = step.map((r) => r.item);
  if (state.active && !kept.has(state.active)) setActive(null);
  state.dirty = true;
}

function undo() {
  recordChange(); // what was typed in the box that has focus
  if (history.undo()) showStatus("元に戻しました");
  updateUndoUi();
}

function redo() {
  recordChange();
  if (history.redo()) showStatus("やり直しました");
  updateUndoUi();
}

function updateUndoUi() {
  els.undoBtn.disabled = !history.canUndo;
  els.redoBtn.disabled = !history.canRedo;
}

function setActive(item) {
  state.active?.box.classList.remove("active");
  state.active = item;
  if (item) item.box.classList.add("active");
  if (item?.type === "text") {
    state.size = item.size;
    state.color = item.color;
  }
  updateActiveUi();
}

function updateActiveUi() {
  els.deleteBtn.disabled = !state.active;
  els.fontSize.value = String(state.size);
  if (els.fontSize.value !== String(state.size)) {
    const opt = new Option(String(state.size), String(state.size));
    els.fontSize.add(opt);
    els.fontSize.value = String(state.size);
  }
  document.querySelectorAll(".swatch").forEach((b) => {
    b.classList.toggle("selected", b.dataset.color === state.color);
  });
}

function enableDrag(item, handle) {
  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    start = { px: e.clientX, py: e.clientY, x: item.x, y: item.y };
    setActive(item);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    item.x = start.x + (e.clientX - start.px) / state.scale;
    item.y = start.y + (e.clientY - start.py) / state.scale;
    layoutItem(item);
    state.dirty = true;
  });
  const end = () => {
    if (!start) return;
    start = null;
    focusItem(item);
    recordChange();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function focusItem(item) {
  (item.type === "text" ? item.el : item.box).focus();
}

/* ---------- photos ---------- */

// Re-encode the photo: applies EXIF rotation, shrinks big camera shots, and
// turns any browser-readable format into JPEG/PNG, the two that PDFs accept.
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const keepAlpha = file.type === "image/png" || file.type === "image/gif";
  if (!keepAlpha) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const type = keepAlpha ? "image/png" : "image/jpeg";
  const blob = await canvasToBlob(canvas, type, 0.9);
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    format: keepAlpha ? "png" : "jpg",
    url: URL.createObjectURL(blob),
    width,
    height,
  };
}

// The page that fills most of the screen right now.
function visiblePage() {
  const box = els.viewer.getBoundingClientRect();
  let best = state.pages[0];
  let bestArea = -1;
  for (const view of state.pages) {
    const r = view.el.getBoundingClientRect();
    const w = Math.min(r.right, box.right) - Math.max(r.left, box.left);
    const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
    const area = Math.max(0, w) * Math.max(0, h);
    if (area > bestArea) [best, bestArea] = [view, area];
  }
  return best;
}

async function addImageFile(file) {
  if (!state.pdf || !file) return;
  let img;
  try {
    img = await prepareImage(file);
  } catch (err) {
    console.error(err);
    showStatus("この画像は読み込めませんでした（JPEG・PNGなどを使ってください）", { error: true });
    return;
  }
  const view = visiblePage();
  const { width: pw, height: ph } = view.viewport;
  // Start at half the page width (or less for small images), centred on the visible part of the page.
  const w = Math.min(pw * 0.5, ph * 0.5 * (img.width / img.height), img.width);
  const h = w * (img.height / img.width);
  const r = view.el.getBoundingClientRect();
  const v = els.viewer.getBoundingClientRect();
  const midY = ((Math.max(r.top, v.top) + Math.min(r.bottom, v.bottom)) / 2 - r.top) / state.scale;
  const x = (pw - w) / 2;
  const y = Math.min(Math.max(0, midY - h / 2), Math.max(0, ph - h));
  addImageItem(view, img, x, y, w, h);
  showStatus("写真をドラッグで移動、右下の角で大きさを変えられます");
}

function addImageItem(view, img, x, y, w, h) {
  const item = { id: nextItemId++, type: "image", page: view.num, x, y, w, h, bytes: img.bytes, format: img.format, url: img.url };

  const box = document.createElement("div");
  box.className = "titem iitem";
  box.style.position = "absolute";
  box.tabIndex = 0;
  box.setAttribute("aria-label", "写真");

  const el = document.createElement("img");
  el.src = img.url;
  el.alt = "";
  el.draggable = false;

  const del = document.createElement("div");
  del.className = "tdel";
  del.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-close"/></svg>';
  del.title = "削除";

  const resize = document.createElement("div");
  resize.className = "resize";
  resize.title = "ドラッグで大きさを変える";

  box.append(el, del, resize);
  view.layer.append(box);
  Object.assign(item, { el, box });
  state.items.push(item);
  state.dirty = true;
  layoutItem(item);
  recordChange();

  box.addEventListener("focus", () => setActive(item));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeItem(item);
    }
  });
  del.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    removeItem(item);
  });
  enableDrag(item, el);
  enableResize(item, resize);

  box.focus();
  return item;
}

// Photos keep their proportions; a white box (`free`) takes any shape.
function enableResize(item, handle, { free = false } = {}) {
  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    start = { px: e.clientX, py: e.clientY, w: item.w, h: item.h, aspect: item.h / item.w };
    setActive(item);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    // Follow whichever direction the pointer moved further, keeping the photo's proportions.
    const dw = (e.clientX - start.px) / state.scale;
    const dh = (e.clientY - start.py) / state.scale / start.aspect;
    if (free) {
      item.w = Math.max(MIN_WHITE, start.w + dw);
      item.h = Math.max(MIN_WHITE, start.h + dh * start.aspect);
    } else {
      item.w = Math.max(10, start.w + (Math.abs(dw) > Math.abs(dh) ? dw : dh));
      item.h = item.w * start.aspect;
    }
    layoutItem(item);
    state.dirty = true;
  });
  const end = () => {
    if (!start) return;
    start = null;
    item.box.focus();
    recordChange();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/* ---------- white boxes ---------- */

// A white box only covers what is under it: the text stays in the PDF and can still be copied
// out. That is fine for a mistake or a blank to fill in again, not for a secret, so the tool says
// to use 墨消し in 手書き・署名, which turns the page into a picture.
function setWhiteMode(on) {
  state.whiteMode = on;
  els.whiteBtn.classList.toggle("selected", on);
  els.whiteBtn.setAttribute("aria-pressed", on);
  els.pages.classList.toggle("white-mode", on);
  if (on) {
    showStatus("消したい所をドラッグで囲んでください。白い四角は上に重ねるだけで、下の文字はPDFに残ります。" +
      "名前などの秘密の情報は「手書き・署名」の墨消しを使ってください", { ms: 8000 });
  } else hideStatus();
}

// Drags out a white box on `view`, from the pointer that went down in `down`.
function drawWhite(view, down) {
  const layer = view.layer;
  const rect = layer.getBoundingClientRect();
  const at = (e) => [
    Math.min(Math.max(0, (e.clientX - rect.left) / state.scale), view.viewport.width),
    Math.min(Math.max(0, (e.clientY - rect.top) / state.scale), view.viewport.height),
  ];
  const [x0, y0] = at(down);
  const ghost = document.createElement("div");
  ghost.className = "wghost";
  layer.append(ghost);
  let box = { x: x0, y: y0, w: 0, h: 0 };
  const show = () => Object.assign(ghost.style, {
    left: `${box.x * state.scale}px`, top: `${box.y * state.scale}px`,
    width: `${box.w * state.scale}px`, height: `${box.h * state.scale}px`,
  });
  show();
  layer.setPointerCapture(down.pointerId);
  const move = (e) => {
    const [x1, y1] = at(e);
    box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    show();
  };
  const end = () => {
    layer.removeEventListener("pointermove", move);
    layer.removeEventListener("pointerup", end);
    layer.removeEventListener("pointercancel", end);
    ghost.remove();
    if (box.w >= MIN_WHITE && box.h >= MIN_WHITE) addWhiteItem(view, box.x, box.y, box.w, box.h);
  };
  layer.addEventListener("pointermove", move);
  layer.addEventListener("pointerup", end);
  layer.addEventListener("pointercancel", end);
}

function addWhiteItem(view, x, y, w, h) {
  const item = { id: nextItemId++, type: "white", page: view.num, x, y, w, h };
  const box = document.createElement("div");
  box.className = "titem witem";
  box.style.position = "absolute";
  box.tabIndex = 0;
  box.setAttribute("aria-label", "白い四角");
  const el = document.createElement("div");
  el.className = "wrect";
  el.title = "ドラッグで移動";
  const del = document.createElement("div");
  del.className = "tdel";
  del.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-close"/></svg>';
  del.title = "削除";
  const resize = document.createElement("div");
  resize.className = "resize";
  resize.title = "ドラッグで大きさを変える";
  box.append(el, del, resize);
  view.layer.append(box);
  Object.assign(item, { el, box });
  state.items.push(item);
  state.dirty = true;
  layoutItem(item);
  recordChange();

  box.addEventListener("focus", () => setActive(item));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeItem(item);
    }
  });
  del.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    removeItem(item);
  });
  enableDrag(item, el);
  enableResize(item, resize, { free: true });
  box.focus();
  return item;
}

/* ---------- saving ---------- */

function outputName() {
  const base = state.fileName.replace(/\.pdf$/i, "");
  return `${base}_記入済み.pdf`;
}

async function save() {
  if (!state.bytes) return;
  els.saveBtn.disabled = true;
  showStatus("PDFを作成中…", { sticky: true });
  try {
    await fontReady;
    const { bytes, rebuilt } = await buildPdf();
    download(new Blob([bytes], { type: "application/pdf" }), outputName());
    state.dirty = false;
    showStatus(rebuilt
      ? "保存しました（保護されたPDFのため、元のページは画像として保存しています）"
      : "保存しました（ダウンロードフォルダを確認してください）");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。PDFが壊れているか、対応していない形式の可能性があります", { error: true });
  } finally {
    els.saveBtn.disabled = false;
  }
}

// The PDF with the texts and photos on it. `rebuilt` tells whether its pages had to be made
// from pictures (a protected PDF).
async function buildPdf() {
  const [{ PDFDocument, degrees }, fontkit] = await Promise.all([loadPdfLib(), loadFontkit()]);
  const original = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
  const rebuilt = original.isEncrypted;
  const onPage = (num, count) => showStatus(`保護されたPDFのため、ページを画像にしています… (${num}/${count})`, { sticky: true });
  const doc = rebuilt ? await rasterizePdf(state.pdf, { onPage }) : original;
  doc.registerFontkit(fontkit);
  if (state.hasForm && !rebuilt) await fillForm(doc);
  // Maps screen coordinates (scale 1, top-left origin) onto a page of `doc`.
  // Rebuilt pages are already upright, so only the y axis flips.
  const placement = (pageNum) => {
    const viewport = state.pages[pageNum - 1].viewport;
    return rebuilt
      ? { toPdf: (x, y) => [x, viewport.height - y], rotate: degrees(0) }
      : { toPdf: (x, y) => viewport.convertToPdfPoint(x, y), rotate: degrees(viewport.rotation) };
  };
  await drawWhites(doc, placement);
  await drawImages(doc, placement);
  await drawTexts(doc, placement);
  return { bytes: await doc.save(), rebuilt };
}

// White boxes go first, so photos and texts can be put on top of them.
async function drawWhites(doc, placement) {
  const { rgb } = await loadPdfLib();
  for (const item of state.items) {
    if (item.type !== "white") continue;
    const { toPdf, rotate } = placement(item.page);
    const [x, y] = toPdf(item.x, item.y + item.h);
    doc.getPage(item.page - 1).drawRectangle({ x, y, width: item.w, height: item.h, color: rgb(1, 1, 1), rotate });
  }
}

async function drawImages(doc, placement) {
  for (const item of state.items) {
    if (item.type !== "image") continue;
    const page = doc.getPage(item.page - 1);
    const { toPdf, rotate } = placement(item.page);
    const image = item.format === "png" ? await doc.embedPng(item.bytes) : await doc.embedJpg(item.bytes);
    // The photo's bottom-left corner on screen is its origin in the PDF.
    const [x, y] = toPdf(item.x, item.y + item.h);
    page.drawImage(image, { x, y, width: item.w, height: item.h, rotate });
  }
}

// The texts, in a font cut down to the characters they use.
async function drawTexts(doc, placement) {
  const { rgb } = await loadPdfLib();
  const items = state.items.filter((item) => item.type === "text" && item.text.trim());
  if (!items.length) return;
  const font = await doc.embedFont(await subsetFont(items.map((i) => i.text).join("")), EMBED_OPTIONS);
  for (const item of items) {
    const page = doc.getPage(item.page - 1);
    const { toPdf, rotate } = placement(item.page);
    const color = hexToRgb(item.color, rgb);
    item.text.split("\n").forEach((line, i) => {
      if (!line) return;
      const baseline = item.y + item.size * (state.baselineRatio + i * LINE_HEIGHT);
      const [x, y] = toPdf(item.x, baseline);
      page.drawText(line, { x, y, size: item.size, font, color, rotate });
    });
  }
}

/* ---------- toolbar & global events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});

els.fontSize.addEventListener("change", () => {
  state.size = Number(els.fontSize.value);
  if (state.active?.type === "text") {
    state.active.size = state.size;
    layoutItem(state.active);
    state.active.el.focus();
    state.dirty = true;
  }
});

document.querySelectorAll(".swatch").forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the text box
  btn.addEventListener("click", () => {
    state.color = btn.dataset.color;
    if (state.active?.type === "text") {
      state.active.color = state.color;
      layoutItem(state.active);
      state.dirty = true;
    }
    updateActiveUi();
  });
});

els.imageBtn.addEventListener("click", () => els.imageInput.click());
els.imageInput.addEventListener("change", async () => {
  for (const file of els.imageInput.files) await addImageFile(file);
  els.imageInput.value = "";
});

els.whiteBtn.addEventListener("click", () => setWhiteMode(!state.whiteMode));

els.deleteBtn.addEventListener("pointerdown", (e) => e.preventDefault());
els.deleteBtn.addEventListener("click", () => state.active && removeItem(state.active));
els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);

els.zoomIn.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale * 1.2)));
els.zoomOut.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale / 1.2)));
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save: save, kind: "pdf" });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.whiteMode && !e.target.closest("textarea, input, select")) setWhiteMode(false);
  if (!e.ctrlKey && !e.metaKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") {
    e.preventDefault();
    save();
  } else if (e.target.closest("textarea, input, select")) {
    // Inside a text box, Ctrl+Z undoes the typing there, as usual.
  } else if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (key === "y" || (key === "z" && e.shiftKey)) {
    e.preventDefault();
    redo();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// Drag & drop a PDF (or, once one is open, photos) anywhere on the page.
onFileDrop((files) => {
  const pdf = files.find(isPdf);
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (pdf) openFile(pdf);
  else if (images.length && state.pdf) images.reduce((p, f) => p.then(() => addImageFile(f)), Promise.resolve());
  else showStatus(state.pdf ? "PDFか画像ファイルをドロップしてください" : "PDFファイルをドロップしてください", { error: true });
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
  "../shared/vendor/fontkit-1.1.1/fontkit.umd.min.js",
  "../shared/vendor/harfbuzz-1.6.3/harfbuzz-subset.wasm",
  "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs",
  "../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs",
  "../shared/vendor/noto-sans-jp/NotoSansJP-Regular.ttf",
]);

// Hook for automated tests.
window.__pdfText = { state, openFile, addItem, addImageFile, save, setScale, fontReady, undo, redo, buildPdf };
