import { openPdf, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, download, onFileDrop } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";

const { PDFDocument, degrees, BlendMode } = window.PDFLib;

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const INK_SCALE = 4; // 288 dpi for the ink layer in the saved PDF
const INK_MAX_PX = 4096; // longest side of a saved ink image
const MARKER_FACTOR = 6; // highlighter width = pen width × this
const SEAL_COLOR = "#d7261e";
const SIGN_PT = 0.4; // signature pad units → PDF points when first placed
const MAX_SIGNS = 5;
const SEAL_FONT = '"Noto Serif CJK JP", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif';
const TEXT_FONT = 'system-ui, "Noto Sans JP", sans-serif';
const STORE = { name: "pdf-sign-name", signs: "pdf-sign-signatures" };

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  tools: document.querySelectorAll(".btn.tool"),
  stampBtn: $("stamp-btn"),
  stampMenu: $("stamp-menu"),
  sealName: $("seal-name"),
  sealList: $("seal-list"),
  markList: $("mark-list"),
  signBtn: $("sign-btn"),
  signMenu: $("sign-menu"),
  signList: $("sign-list"),
  newSignBtn: $("new-sign-btn"),
  swatches: document.querySelectorAll(".toolbar .swatch"),
  width: $("width"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  deleteBtn: $("delete-btn"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomLabel: $("zoom-label"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  pages: $("pages"),
  signDialog: $("sign-dialog"),
  signPad: $("sign-pad"),
  padSwatches: document.querySelectorAll(".pad-swatch"),
  padClear: $("pad-clear"),
  padOk: $("pad-ok"),
};

const state = {
  fileName: "document.pdf",
  bytes: null, // original PDF bytes (never handed to pdf.js, which detaches buffers)
  pdf: null, // pdf.js document
  pages: [], // { num, viewport (scale 1), el, canvas, ink, selbox, rendered, task }
  // Everything is in page points with a top-left origin, as the page is shown (rotation applied).
  // stroke: { type, page, tool: "pen"|"marker", color, width, points: [[x, y], …] }
  // stamp:  { type, page, kind, text, color, x, y, w, h }
  // sign:   { type, page, sig: { strokes, w, h, width, color }, x, y, w, h }
  items: [],
  history: [[]],
  historyPos: 0,
  selected: null,
  drawing: null, // stroke being drawn
  tool: "pen",
  color: "#111111",
  width: 2,
  stamp: "name",
  signIndex: 0,
  signs: [],
  scale: 1,
  dirty: false,
};

/* ---------- stamps ---------- */

function today() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// Seals are always vermilion; marks use the current color.
const STAMPS = [
  { id: "name", label: "名前の印鑑", seal: true, shape: "circle", vertical: true, w: 40, h: 40, text: () => state.sealName.trim() || "印" },
  { id: "sumi", label: "済", seal: true, shape: "circle", w: 36, h: 36, text: () => "済" },
  { id: "kakunin", label: "確認", seal: true, shape: "circle", w: 40, h: 40, text: () => "確認" },
  { id: "teishutsu", label: "提出済", seal: true, shape: "rect", w: 66, h: 26, text: () => "提出済" },
  { id: "check", label: "チェック", shape: "check", w: 26, h: 26 },
  { id: "circle", label: "まる", shape: "ring", w: 28, h: 28 },
  { id: "cross", label: "ばつ", shape: "cross", w: 24, h: 24 },
  { id: "triangle", label: "さんかく", shape: "triangle", w: 28, h: 26 },
  { id: "date", label: "今日の日付", shape: "text", w: 0, h: 14, text: today },
];
const stampDef = (id) => STAMPS.find((s) => s.id === id);

function sealFont(size) {
  return `bold ${size}px ${SEAL_FONT}`;
}

function textWidth(text, font) {
  const ctx = measureCtx;
  ctx.font = font;
  return ctx.measureText(text).width;
}
const measureCtx = document.createElement("canvas").getContext("2d");

function drawStamp(ctx, item) {
  const def = stampDef(item.kind);
  const { x, y, w, h, text } = item;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = item.color;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = x + w / 2;
  const cy = y + h / 2;
  const s = Math.min(w, h);
  switch (def.shape) {
    case "circle": {
      const lw = s * 0.06;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2 - lw / 2, h / 2 - lw / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      const inner = s - lw * 2;
      const chars = [...text];
      if (def.vertical && chars.length === 4) {
        // Two columns, read right to left like a real seal.
        const fs = inner * 0.36;
        ctx.font = sealFont(fs);
        chars.forEach((ch, i) => {
          const col = i < 2 ? 1 : -1;
          const row = i % 2 ? 1 : -1;
          ctx.fillText(ch, cx + (col * fs) / 2, cy + (row * fs) / 2);
        });
      } else if (def.vertical && chars.length > 1) {
        const fs = Math.min(inner * 0.78 / chars.length, inner * 0.55);
        ctx.font = sealFont(fs);
        chars.forEach((ch, i) => ctx.fillText(ch, cx, cy + (i - (chars.length - 1) / 2) * fs));
      } else {
        const fs = Math.min(inner * 0.8 / chars.length, inner * 0.6);
        ctx.font = sealFont(fs);
        ctx.fillText(text, cx, cy);
      }
      break;
    }
    case "rect": {
      const lw = h * 0.07;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, h * 0.12);
      ctx.stroke();
      const fs = Math.min(h * 0.6, (w * 0.84) / [...text].length);
      ctx.font = sealFont(fs);
      ctx.fillText(text, cx, cy);
      break;
    }
    case "text": {
      ctx.font = `${h * 0.85}px ${TEXT_FONT}`;
      ctx.textAlign = "left";
      ctx.fillText(text, x, cy, w);
      break;
    }
    default: {
      ctx.lineWidth = s * 0.11;
      ctx.translate(x, y);
      ctx.scale(w, h);
      ctx.lineWidth /= s;
      ctx.beginPath();
      if (def.shape === "check") {
        ctx.moveTo(0.1, 0.55);
        ctx.lineTo(0.4, 0.84);
        ctx.lineTo(0.92, 0.14);
      } else if (def.shape === "ring") {
        ctx.arc(0.5, 0.5, 0.44, 0, Math.PI * 2);
      } else if (def.shape === "cross") {
        ctx.moveTo(0.12, 0.12);
        ctx.lineTo(0.88, 0.88);
        ctx.moveTo(0.88, 0.12);
        ctx.lineTo(0.12, 0.88);
      } else if (def.shape === "triangle") {
        ctx.moveTo(0.5, 0.08);
        ctx.lineTo(0.94, 0.9);
        ctx.lineTo(0.06, 0.9);
        ctx.closePath();
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

function newStamp(id, page, cx, cy) {
  const def = stampDef(id);
  const text = def.text?.() ?? "";
  let { w, h } = def;
  if (def.shape === "text") w = textWidth(text, `${h * 0.85}px ${TEXT_FONT}`) + 2;
  return {
    type: "stamp", page, kind: id, text,
    color: def.seal ? SEAL_COLOR : state.color,
    x: cx - w / 2, y: cy - h / 2, w, h,
  };
}

/* ---------- drawing items ---------- */

function lighten(hex, amount = 0.5) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function tracePath(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); // a dot
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function drawStroke(ctx, item) {
  ctx.save();
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = item.tool === "marker" ? lighten(item.color) : item.color;
  ctx.lineWidth = item.width;
  ctx.beginPath();
  tracePath(ctx, item.points);
  ctx.stroke();
  ctx.restore();
}

function drawSign(ctx, item) {
  const { sig } = item;
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.scale(item.w / sig.w, item.h / sig.h);
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = sig.color;
  ctx.lineWidth = sig.width;
  for (const pts of sig.strokes) {
    ctx.beginPath();
    tracePath(ctx, pts);
    ctx.stroke();
  }
  ctx.restore();
}

function drawItem(ctx, item) {
  if (item.type === "stroke") drawStroke(ctx, item);
  else if (item.type === "stamp") drawStamp(ctx, item);
  else if (item.type === "sign") drawSign(ctx, item);
}

// Highlighter goes underneath so it never covers pen ink (the layer is opaque within itself).
function drawItems(ctx, items) {
  const markers = items.filter((i) => i.type === "stroke" && i.tool === "marker");
  for (const item of markers) drawItem(ctx, item);
  for (const item of items) if (!markers.includes(item)) drawItem(ctx, item);
}

function bounds(item) {
  if (item.type !== "stroke") return { x: item.x, y: item.y, w: item.w, h: item.h };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of item.points) {
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  const r = item.width / 2;
  return { x: x1 - r, y: y1 - r, w: x2 - x1 + item.width, h: y2 - y1 + item.width };
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hits(item, x, y, tolerance) {
  if (item.type === "stroke") {
    const reach = item.width / 2 + tolerance;
    const pts = item.points;
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
    for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= reach) return true;
    return false;
  }
  return x >= item.x - tolerance && x <= item.x + item.w + tolerance &&
    y >= item.y - tolerance && y <= item.y + item.h + tolerance;
}

function itemAt(page, x, y, tolerance) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.page === page && hits(item, x, y, tolerance)) return item;
  }
  return null;
}

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (state.dirty && !confirm("書き込んだ内容は保存されていません。別のPDFを開きますか？")) return;
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(bytes.slice()).promise;

    resetDocument();
    state.bytes = bytes;
    state.pdf = pdf;
    state.fileName = file.name || "document.pdf";
    document.title = `${state.fileName} - PDFに手書き・署名`;

    for (let num = 1; num <= pdf.numPages; num++) {
      const page = await pdf.getPage(num);
      state.pages.push(createPageView(num, page.getViewport({ scale: 1 })));
    }
    els.welcome.hidden = true;
    setScale(fitWidthScale());
    els.viewer.scrollTop = 0;
    updateUi();
    hideStatus();
    showStatus(hintForTool());
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
  state.pages.forEach((p) => p.task?.cancel());
  state.pdf?.destroy();
  state.pages = [];
  state.items = [];
  state.history = [[]];
  state.historyPos = 0;
  state.selected = null;
  state.drawing = null;
  state.dirty = false;
  els.pages.replaceChildren();
}

function createPageView(num, viewport) {
  const el = document.createElement("div");
  el.className = "page";
  const canvas = document.createElement("canvas");
  const ink = document.createElement("canvas");
  ink.className = "ink";
  const selbox = document.createElement("div");
  selbox.className = "selbox";
  selbox.hidden = true;
  const resize = document.createElement("div");
  resize.className = "resize";
  resize.title = "ドラッグで大きさを変える";
  selbox.append(resize);
  const label = document.createElement("div");
  label.className = "page-num";
  label.textContent = `${num} / ${state.pdf.numPages}`;
  el.append(canvas, ink, selbox, label);
  els.pages.append(el);

  const view = { num, viewport, el, canvas, ink, selbox, rendered: false, task: null };
  ink.addEventListener("pointerdown", (e) => onPointerDown(e, view));
  resize.addEventListener("pointerdown", (e) => onResizeDown(e, view));
  observer.observe(el);
  return view;
}

/* ---------- rendering ---------- */

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const view = state.pages.find((p) => p.el === entry.target);
      if (view && !view.rendered) renderPage(view);
    }
  },
  { root: els.viewer, rootMargin: "600px 0px" },
);

async function renderPage(view) {
  view.rendered = true;
  view.task?.cancel();
  const dpr = window.devicePixelRatio || 1;
  view.ink.width = Math.floor(view.viewport.width * state.scale * dpr);
  view.ink.height = Math.floor(view.viewport.height * state.scale * dpr);
  renderInk(view);
  const page = await state.pdf.getPage(view.num);
  const viewport = page.getViewport({ scale: state.scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  view.task = task;
  try {
    await task.promise;
    view.canvas.replaceWith(canvas);
    view.canvas = canvas;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(err);
  } finally {
    if (view.task === task) view.task = null;
  }
}

function renderInk(view) {
  const { ink } = view;
  if (!ink.width) return;
  const ctx = ink.getContext("2d");
  const k = ink.width / view.viewport.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const items = state.items.filter((i) => i.page === view.num);
  if (state.drawing?.page === view.num) items.push(state.drawing);
  drawItems(ctx, items);
  updateSelbox(view);
}

function renderPageInk(num) {
  const view = state.pages[num - 1];
  if (view) renderInk(view);
}

function updateSelbox(view) {
  const item = state.selected;
  if (!item || item.page !== view.num) {
    view.selbox.hidden = true;
    return;
  }
  const b = bounds(item);
  const pad = 3;
  const s = state.scale;
  Object.assign(view.selbox.style, {
    left: `${b.x * s - pad}px`,
    top: `${b.y * s - pad}px`,
    width: `${b.w * s + pad * 2}px`,
    height: `${b.h * s + pad * 2}px`,
  });
  view.selbox.classList.toggle("no-resize", item.type === "stroke");
  view.selbox.hidden = false;
}

function fitWidthScale() {
  const maxWidth = Math.max(...state.pages.map((p) => p.viewport.width));
  const available = els.viewer.clientWidth - 90; // viewer + page list side padding
  return clampScale(Math.min(1.5, available / maxWidth));
}

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function setScale(scale) {
  const viewer = els.viewer;
  const ratio = scale / state.scale;
  const centerY = (viewer.scrollTop + viewer.clientHeight / 2) * ratio;
  state.scale = scale;
  els.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  for (const view of state.pages) {
    view.el.style.width = `${view.viewport.width * scale}px`;
    view.el.style.height = `${view.viewport.height * scale}px`;
    view.rendered = false;
    updateSelbox(view);
  }
  viewer.scrollTop = centerY - viewer.clientHeight / 2;
  // Re-render whatever is on screen now.
  for (const view of state.pages) {
    observer.unobserve(view.el);
    observer.observe(view.el);
  }
}

/* ---------- editing ---------- */

function pagePoint(e, view) {
  const rect = view.el.getBoundingClientRect();
  return [(e.clientX - rect.left) / state.scale, (e.clientY - rect.top) / state.scale];
}

// Follows one pointer until it is released; returns nothing, calls back with page points.
function track(e, view, onMove, onUp) {
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const events = ev.getCoalescedEvents?.() ?? [];
    for (const ce of events.length ? events : [ev]) onMove(pagePoint(ce, view), ce);
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    onUp?.(ev.type === "pointercancel");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

function onPointerDown(e, view) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  closeMenus();
  const [x, y] = pagePoint(e, view);
  const tolerance = 4 / state.scale;

  if (state.tool === "pen" || state.tool === "marker") {
    e.preventDefault();
    select(null);
    const width = state.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
    state.drawing = { type: "stroke", page: view.num, tool: state.tool, color: state.color, width, points: [[x, y]] };
    renderInk(view);
    const minStep = 0.6 / state.scale;
    track(e, view, ([px, py]) => {
      const pts = state.drawing.points;
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(px - lx, py - ly) < minStep) return;
      pts.push([px, py]);
      renderInk(view);
    }, (cancelled) => {
      const stroke = state.drawing;
      state.drawing = null;
      if (!cancelled) {
        state.items.push(stroke);
        commit();
      }
      renderInk(view);
    });
  } else if (state.tool === "eraser") {
    e.preventDefault();
    select(null);
    let erased = false;
    const erase = ([px, py]) => {
      const reach = 8 / state.scale;
      const before = state.items.length;
      state.items = state.items.filter((item) => item.page !== view.num || !hits(item, px, py, reach));
      if (state.items.length !== before) {
        erased = true;
        renderInk(view);
      }
    };
    erase([x, y]);
    track(e, view, erase, () => erased && commit());
  } else if (state.tool === "select") {
    const item = itemAt(view.num, x, y, tolerance);
    select(item);
    if (!item) return; // let touch scrolling happen
    e.preventDefault();
    let last = [x, y];
    let moved = false;
    track(e, view, ([px, py]) => {
      moveItem(item, px - last[0], py - last[1]);
      last = [px, py];
      moved = true;
      renderInk(view);
    }, () => moved && commit());
  } else if (state.tool === "stamp" || state.tool === "sign") {
    e.preventDefault();
    let item;
    if (state.tool === "stamp") {
      item = newStamp(state.stamp, view.num, x, y);
    } else {
      const sig = state.signs[state.signIndex];
      if (!sig) {
        openSignDialog();
        return;
      }
      let w = sig.w * SIGN_PT;
      let h = sig.h * SIGN_PT;
      const fit = Math.min(1, 180 / w, 70 / h);
      w *= fit;
      h *= fit;
      item = { type: "sign", page: view.num, sig: structuredClone(sig), x: x - w / 2, y: y - h / 2, w, h };
    }
    state.items.push(item);
    commit();
    select(item);
    // Keep dragging right away to fine-tune where it lands.
    let last = [x, y];
    track(e, view, ([px, py]) => {
      moveItem(item, px - last[0], py - last[1]);
      last = [px, py];
      renderInk(view);
    }, () => commit(true));
  }
}

function moveItem(item, dx, dy) {
  if (item.type === "stroke") {
    for (const p of item.points) {
      p[0] += dx;
      p[1] += dy;
    }
  } else {
    item.x += dx;
    item.y += dy;
  }
}

function onResizeDown(e, view) {
  const item = state.selected;
  if (!item || item.type === "stroke") return;
  e.preventDefault();
  e.stopPropagation();
  const [sx, sy] = pagePoint(e, view);
  const start = { w: item.w, h: item.h };
  const aspect = item.h / item.w;
  track(e, view, ([px, py]) => {
    const grow = Math.max((px - sx) / start.w, (py - sy) / start.h);
    const w = Math.max(8, start.w * (1 + grow));
    item.w = w;
    item.h = w * aspect;
    renderInk(view);
  }, () => commit());
}

function select(item) {
  const prev = state.selected;
  state.selected = item;
  if (prev && prev !== item) renderPageInk(prev.page);
  if (item) renderPageInk(item.page);
  updateUi();
}

function deleteSelected() {
  const item = state.selected;
  if (!item) return;
  state.items = state.items.filter((i) => i !== item);
  state.selected = null;
  commit();
  renderPageInk(item.page);
}

// Records the current items as a new undo step. `replace` folds a follow-up drag into the last step.
function commit(replace = false) {
  if (!replace) {
    state.history.length = state.historyPos + 1;
    state.historyPos++;
  }
  state.history[state.historyPos] = structuredClone(state.items);
  state.dirty = true;
  updateUi();
}

function restore(pos) {
  if (pos < 0 || pos >= state.history.length) return;
  state.historyPos = pos;
  state.items = structuredClone(state.history[pos]);
  state.selected = null;
  state.dirty = true;
  state.pages.forEach(renderInk);
  updateUi();
}
const undo = () => restore(state.historyPos - 1);
const redo = () => restore(state.historyPos + 1);

/* ---------- toolbar state ---------- */

function hintForTool() {
  switch (state.tool) {
    case "pen": return "ページの上をなぞって書いてください";
    case "marker": return "線を引きたいところをなぞってください";
    case "eraser": return "消したい線やハンコをなぞってください";
    case "stamp": return `押したい場所をクリックしてください（${stampDef(state.stamp).label}）`;
    case "sign": return "署名を入れたい場所をクリックしてください";
    default: return "ハンコや線をドラッグして動かせます";
  }
}

function setTool(tool, { hint = true } = {}) {
  state.tool = tool;
  document.body.dataset.tool = tool;
  if (tool !== "select") select(null);
  if (tool === "marker" && state.color === "#111111") setColor("#facc15");
  else if (["pen", "stamp", "sign"].includes(tool) && state.color === "#facc15") setColor("#111111");
  updateUi();
  if (hint && state.pdf) showStatus(hintForTool());
}

function setColor(color) {
  state.color = color;
  const item = state.selected;
  if (item && (item.type === "stroke" || (item.type === "stamp" && !stampDef(item.kind).seal))) {
    item.color = color;
    commit();
    renderPageInk(item.page);
  }
  renderStampChoices();
  updateUi();
}

function updateUi() {
  const open = !!state.pdf;
  for (const btn of els.tools) btn.classList.toggle("selected", btn.dataset.tool === state.tool);
  for (const sw of els.swatches) sw.classList.toggle("selected", sw.dataset.color === state.color);
  els.undoBtn.disabled = !open || state.historyPos === 0;
  els.redoBtn.disabled = !open || state.historyPos >= state.history.length - 1;
  els.deleteBtn.disabled = !state.selected;
  els.saveBtn.disabled = !open;
}

/* ---------- menus ---------- */

function closeMenus() {
  els.stampMenu.hidden = true;
  els.signMenu.hidden = true;
}

function toggleMenu(menu) {
  const show = menu.hidden;
  closeMenus();
  menu.hidden = !show;
}

function previewCanvas(draw, w, h, box = 50) {
  const dpr = window.devicePixelRatio || 1;
  const k = Math.min(box / w, box / h, 2.2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * k * dpr);
  canvas.height = Math.ceil(h * k * dpr);
  canvas.style.width = `${w * k}px`;
  canvas.style.height = `${h * k}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(k * dpr, k * dpr);
  draw(ctx);
  return canvas;
}

function renderStampChoices() {
  for (const [list, seal] of [[els.sealList, true], [els.markList, false]]) {
    list.replaceChildren(...STAMPS.filter((s) => !!s.seal === seal).map((def) => {
      const item = newStamp(def.id, 0, 0, 0);
      item.x = item.y = 0;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stamp-choice";
      btn.title = def.label;
      btn.setAttribute("aria-label", def.label);
      btn.classList.toggle("selected", state.stamp === def.id);
      btn.append(previewCanvas((ctx) => drawStamp(ctx, item), item.w, item.h, def.shape === "text" ? 62 : 46));
      btn.addEventListener("click", () => {
        state.stamp = def.id;
        closeMenus();
        renderStampChoices();
        setTool("stamp");
      });
      return btn;
    }));
    if (!seal) list.lastChild.style.gridColumn = "span 2";
  }
}

function renderSignChoices() {
  els.signList.replaceChildren(...state.signs.map((sig, i) => {
    const row = document.createElement("div");
    row.className = "sign-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sign-choice";
    btn.title = "この署名を使う";
    btn.classList.toggle("selected", i === state.signIndex);
    btn.append(previewCanvas((ctx) => drawSign(ctx, { sig, x: 0, y: 0, w: sig.w, h: sig.h }), sig.w, sig.h, 200));
    btn.style.height = "56px";
    btn.addEventListener("click", () => {
      state.signIndex = i;
      closeMenus();
      renderSignChoices();
      setTool("sign");
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn sign-del";
    del.textContent = "✕";
    del.title = "この署名を消す";
    del.addEventListener("click", () => {
      if (!confirm("この署名を消しますか？（PDFに入れた署名は消えません）")) return;
      state.signs.splice(i, 1);
      state.signIndex = 0;
      saveJson(STORE.signs, state.signs);
      renderSignChoices();
    });
    row.append(btn, del);
    return row;
  }));
}

/* ---------- signature pad ---------- */

const pad = {
  strokes: [],
  color: "#111111",
  width: 3,
  ctx: els.signPad.getContext("2d"),
  W: 560,
  H: 200,
};
els.signPad.width = pad.W * 2;
els.signPad.height = pad.H * 2;

function drawPad() {
  const { ctx } = pad;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, pad.W, pad.H);
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = pad.color;
  ctx.lineWidth = pad.width;
  for (const pts of pad.strokes) {
    ctx.beginPath();
    tracePath(ctx, pts);
    ctx.stroke();
  }
}

function padPoint(e) {
  const rect = els.signPad.getBoundingClientRect();
  return [(e.clientX - rect.left) * (pad.W / rect.width), (e.clientY - rect.top) * (pad.H / rect.height)];
}

els.signPad.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  els.signPad.setPointerCapture(e.pointerId);
  const pts = [padPoint(e)];
  pad.strokes.push(pts);
  drawPad();
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const events = ev.getCoalescedEvents?.() ?? [];
    for (const ce of events.length ? events : [ev]) pts.push(padPoint(ce));
    drawPad();
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    els.signPad.removeEventListener("pointermove", move);
    els.signPad.removeEventListener("pointerup", up);
    els.signPad.removeEventListener("pointercancel", up);
  };
  els.signPad.addEventListener("pointermove", move);
  els.signPad.addEventListener("pointerup", up);
  els.signPad.addEventListener("pointercancel", up);
});

function openSignDialog() {
  closeMenus();
  pad.strokes = [];
  drawPad();
  els.signDialog.showModal();
}

function finishSign() {
  const all = pad.strokes.flat();
  if (!all.length) {
    showStatus("枠の中にサインを書いてください", { error: true });
    return;
  }
  // Crop to the ink so the signature sits tight inside its box.
  const m = pad.width;
  const x1 = Math.min(...all.map((p) => p[0])) - m;
  const y1 = Math.min(...all.map((p) => p[1])) - m;
  const x2 = Math.max(...all.map((p) => p[0])) + m;
  const y2 = Math.max(...all.map((p) => p[1])) + m;
  const round = (v) => Math.round(v * 10) / 10;
  const sig = {
    strokes: pad.strokes.map((pts) => pts.map(([x, y]) => [round(x - x1), round(y - y1)])),
    w: round(x2 - x1),
    h: round(y2 - y1),
    width: pad.width,
    color: pad.color,
  };
  state.signs.unshift(sig);
  state.signs.length = Math.min(state.signs.length, MAX_SIGNS);
  state.signIndex = 0;
  saveJson(STORE.signs, state.signs);
  renderSignChoices();
  els.signDialog.close();
  setTool("sign", { hint: false });
  showStatus(state.pdf ? "署名を入れたい場所をクリックしてください" : "PDFを開いてから、署名を入れたい場所をクリックしてください");
}

for (const sw of els.padSwatches) {
  sw.addEventListener("click", () => {
    pad.color = sw.dataset.color;
    for (const s of els.padSwatches) s.classList.toggle("selected", s === sw);
    drawPad();
  });
}
els.padClear.addEventListener("click", () => {
  pad.strokes = [];
  drawPad();
});
els.padOk.addEventListener("click", finishSign);

/* ---------- saving ---------- */

function outputName() {
  const base = state.fileName.replace(/\.pdf$/i, "");
  return `${base}_書き込み済み.pdf`;
}

// Draws one page's ink onto a transparent PNG cropped to where the ink is.
async function renderInkImage(view, items) {
  const { width, height } = view.viewport;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const item of items) {
    const b = bounds(item);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  x1 = Math.max(0, Math.floor(x1 - 2));
  y1 = Math.max(0, Math.floor(y1 - 2));
  x2 = Math.min(width, Math.ceil(x2 + 2));
  y2 = Math.min(height, Math.ceil(y2 + 2));
  if (x2 <= x1 || y2 <= y1) return null;
  const box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  const k = Math.min(INK_SCALE, INK_MAX_PX / Math.max(box.w, box.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.w * k);
  canvas.height = Math.ceil(box.h * k);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(k, 0, 0, k, -box.x * k, -box.y * k);
  drawItems(ctx, items);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0;
  return { box, png: new Uint8Array(await blob.arrayBuffer()) };
}

let saving = false;
async function save() {
  if (!state.bytes || saving) return;
  saving = true;
  els.saveBtn.disabled = true;
  select(null);
  showStatus("PDFを作成中…", { sticky: true });
  try {
    await document.fonts.ready;
    const original = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    const rebuilt = original.isEncrypted;
    const onPage = (num, count) => showStatus(`保護されたPDFのため、ページを画像にしています… (${num}/${count})`, { sticky: true });
    const doc = rebuilt ? await rasterizePdf(state.pdf, { onPage }) : original;

    for (const view of state.pages) {
      const items = state.items.filter((i) => i.page === view.num);
      if (!items.length) continue;
      const ink = await renderInkImage(view, items);
      if (!ink) continue;
      const { box } = ink;
      const page = doc.getPage(view.num - 1);
      const image = await doc.embedPng(ink.png);
      // The image's bottom-left corner on screen is its origin in the PDF.
      // Rebuilt pages are already upright, so only the y axis flips.
      const [x, y] = rebuilt
        ? [box.x, view.viewport.height - (box.y + box.h)]
        : view.viewport.convertToPdfPoint(box.x, box.y + box.h);
      page.drawImage(image, {
        x, y, width: box.w, height: box.h,
        rotate: degrees(rebuilt ? 0 : view.viewport.rotation),
        blendMode: BlendMode.Multiply,
      });
    }

    const out = await doc.save();
    download(new Blob([out], { type: "application/pdf" }), outputName());
    state.dirty = false;
    showStatus(rebuilt
      ? "保存しました（保護されたPDFのため、元のページは画像として保存しています）"
      : "保存しました（ダウンロードフォルダを確認してください）");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。PDFが壊れているか、対応していない形式の可能性があります", { error: true });
  } finally {
    saving = false;
    updateUi();
  }
}

/* ---------- toolbar & global events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});

for (const btn of els.tools) {
  const tool = btn.dataset.tool;
  if (tool === "stamp" || tool === "sign") continue;
  btn.addEventListener("click", () => {
    closeMenus();
    setTool(tool);
  });
}
els.stampBtn.addEventListener("click", () => toggleMenu(els.stampMenu));
els.signBtn.addEventListener("click", () => {
  if (!state.signs.length) openSignDialog();
  else toggleMenu(els.signMenu);
});
els.newSignBtn.addEventListener("click", openSignDialog);
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".menu-wrap")) closeMenus();
});

els.sealName.addEventListener("input", () => {
  state.sealName = els.sealName.value;
  saveJson(STORE.name, state.sealName);
  renderStampChoices();
});
els.sealName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    state.stamp = "name";
    closeMenus();
    renderStampChoices();
    setTool("stamp");
  }
});

for (const sw of els.swatches) sw.addEventListener("click", () => setColor(sw.dataset.color));

els.width.addEventListener("change", () => {
  state.width = Number(els.width.value);
  const item = state.selected;
  if (item?.type === "stroke") {
    item.width = item.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
    commit();
    renderPageInk(item.page);
  }
});

els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.deleteBtn.addEventListener("click", deleteSelected);
els.zoomIn.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale * 1.2)));
els.zoomOut.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale / 1.2)));
els.saveBtn.addEventListener("click", save);

const SHORTCUTS = { v: "select", p: "pen", m: "marker", e: "eraser" };
document.addEventListener("keydown", (e) => {
  if (els.signDialog.open) return;
  const typing = e.target.closest("input, textarea, select");
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (key === "s") {
      e.preventDefault();
      save();
    } else if (typing) {
      return;
    } else if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
    return;
  }
  if (typing || e.altKey) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selected) {
      e.preventDefault();
      deleteSelected();
    }
  } else if (e.key === "Escape") {
    closeMenus();
    select(null);
  } else if (SHORTCUTS[key]) {
    setTool(SHORTCUTS[key]);
  } else if (key === "h") {
    setTool("stamp");
  } else if (key === "s") {
    if (state.signs.length) setTool("sign");
    else openSignDialog();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty && state.items.length) e.preventDefault();
});

// Drag & drop a PDF anywhere on the page.
onFileDrop((files) => {
  const pdf = files.find(isPdf);
  if (pdf) openFile(pdf);
  else showStatus("PDFファイルをドロップしてください", { error: true });
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
  "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs",
  "../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs",
]);

state.sealName = loadJson(STORE.name, "");
els.sealName.value = state.sealName;
state.signs = loadJson(STORE.signs, []).filter((s) => s?.strokes?.length && s.w > 0 && s.h > 0);
renderStampChoices();
renderSignChoices();
setTool("pen", { hint: false });
// Seal previews use the system's Japanese font, which may finish loading after first paint.
document.fonts.ready.then(renderStampChoices);

// Hook for automated tests.
window.__pdfSign = { state, openFile, save, setScale, setTool, undo, redo, commit, renderInk, finishSign, pad };
