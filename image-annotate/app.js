import { hideStatus, showStatus } from "../shared/js/status.js";
import { download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage, isHeic, readableImage } from "../shared/js/heic.js";
import { registerOffline } from "../shared/js/offline.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { copyImage } from "../shared/js/clipboard.js";
import { History } from "../shared/js/history.js";

const MAX_IMAGE_PX = 4000; // longest side; larger photos are shrunk so the canvas stays responsive
const BLANK_SIZE = [1600, 1000];
const HIT_PX = 8; // how close (in screen pixels) a click must be to pick something
const HANDLE_PX = 7;
const FONT = 'bold {size}px system-ui, "Noto Sans JP", sans-serif';
const LINE_HEIGHT = 1.25; // must match .text-editor line-height in style.css
const TWO_POINT = new Set(["arrow", "line", "rect", "ellipse", "mosaic"]);

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  tools: [...document.querySelectorAll(".tool")],
  swatches: [...document.querySelectorAll(".swatch")],
  width: $("width"),
  fill: $("fill"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  deleteBtn: $("delete-btn"),
  copyBtn: $("copy-btn"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  stage: $("stage"),
  canvas: $("canvas"),
  editor: $("text-editor"),
};
const ctx = els.canvas.getContext("2d");

const state = {
  fileName: "image",
  base: null, // canvas holding the opened image
  W: 0,
  H: 0,
  unit: 2, // base stroke unit in image pixels, scaled to the image size
  items: [],
  // arrow/line/rect/ellipse/mosaic: { type, x1, y1, x2, y2, color, mul, fill }
  // pen/marker: { type, points: [[x, y], ...], color, mul }
  // text: { type, x, y, text, color, mul }
  selected: null,
  tool: "select",
  color: "#e11d48",
  mul: 1,
  fill: false,
  editing: null, // text item open in the editor
  dirty: false,
};

/* ---------- opening an image ---------- */

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode"));
    };
    img.src = url;
  });
}

function confirmDiscard() {
  return !state.dirty || confirm("書き込み中の画像があります。保存せずに新しい画像を開きますか？");
}

async function openImage(blob, name) {
  if (!confirmDiscard()) return;
  let img;
  try {
    if (blob.name && isHeic(blob)) showStatus("iPhoneの写真（HEIC）を変換中…", { sticky: true });
    img = await loadImage(blob.name ? await readableImage(blob) : blob);
  } catch {
    showStatus("この画像は開けませんでした。PNGやJPEGの画像を選んでください", { error: true });
    return;
  }
  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const base = document.createElement("canvas");
  base.width = w;
  base.height = h;
  base.getContext("2d").drawImage(img, 0, 0, w, h);
  start(base, name);
  if (scale < 1) showStatus("大きな画像なので、少し縮小して開きました");
  else if (isHeic(blob)) hideStatus();
}

function openBlank() {
  if (!confirmDiscard()) return;
  const base = document.createElement("canvas");
  [base.width, base.height] = BLANK_SIZE;
  const b = base.getContext("2d");
  b.fillStyle = "#ffffff";
  b.fillRect(0, 0, base.width, base.height);
  start(base, "白紙");
}

function start(base, name) {
  closeEditor(false);
  state.base = base;
  state.W = base.width;
  state.H = base.height;
  state.unit = Math.max(1, Math.round(Math.max(state.W, state.H) / 400));
  state.fileName = (name || "image").replace(/\.[^.]+$/, "");
  state.items = [];
  state.selected = null;
  history.reset();
  state.dirty = false;
  els.canvas.width = state.W;
  els.canvas.height = state.H;
  els.welcome.hidden = true;
  els.stage.hidden = false;
  fitToView();
  render();
  updateButtons();
}

function fitToView() {
  if (!state.base) return;
  const avail = els.viewer.clientWidth - 32;
  const s = Math.min(1, avail / state.W);
  els.canvas.style.width = `${Math.round(state.W * s)}px`;
  els.canvas.style.height = `${Math.round(state.H * s)}px`;
  if (state.editing) positionEditor();
}

/* ---------- sizes ---------- */

const strokeWidth = (it) => state.unit * 1.5 * it.mul;
const markerWidth = (it) => state.unit * 6 * it.mul;
const fontSize = (it) => Math.round(Math.max(14, state.unit * 8) * Math.sqrt(it.mul));
const mosaicBlock = () => Math.max(10, state.unit * 4);
// image pixels per screen pixel
const pxRatio = () => state.W / els.canvas.getBoundingClientRect().width;

/* ---------- drawing ---------- */

function render() {
  if (!state.base) return;
  draw(ctx, true);
}

// Pointer moves can arrive faster than the screen refreshes, so dragging draws once per frame.
let frame = 0;
function renderSoon() {
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function draw(c, overlay) {
  c.clearRect(0, 0, state.W, state.H);
  c.drawImage(state.base, 0, 0);
  for (const it of state.items) {
    if (it === state.editing) continue;
    c.save();
    drawItem(c, it);
    c.restore();
  }
  if (overlay && state.selected && state.selected !== state.editing) drawSelection(c, state.selected);
}

function box(it) {
  return {
    x: Math.min(it.x1, it.x2),
    y: Math.min(it.y1, it.y2),
    w: Math.abs(it.x2 - it.x1),
    h: Math.abs(it.y2 - it.y1),
  };
}

function drawItem(c, it) {
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = it.color;
  c.fillStyle = it.color;
  DRAW[it.type](c, it);
}

// How each kind of item is drawn, once its color is set.
const DRAW = {
  line(c, it) {
    c.lineWidth = strokeWidth(it);
    c.beginPath();
    c.moveTo(it.x1, it.y1);
    c.lineTo(it.x2, it.y2);
    c.stroke();
  },
  arrow: (c, it) => drawArrow(c, it),
  rect(c, it) {
    const b = box(it);
    if (it.fill) c.fillRect(b.x, b.y, b.w, b.h);
    else {
      c.lineWidth = strokeWidth(it);
      c.strokeRect(b.x, b.y, b.w, b.h);
    }
  },
  ellipse(c, it) {
    const b = box(it);
    c.beginPath();
    c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    if (it.fill) c.fill();
    else {
      c.lineWidth = strokeWidth(it);
      c.stroke();
    }
  },
  pen(c, it) {
    c.lineWidth = strokeWidth(it);
    strokePath(c, it.points);
  },
  marker(c, it) {
    c.globalAlpha = 0.4;
    c.globalCompositeOperation = "multiply";
    c.lineCap = "butt";
    c.lineWidth = markerWidth(it);
    strokePath(c, it.points);
  },
  mosaic: (c, it) => drawMosaic(c, it),
  text: (c, it) => drawText(c, it),
};

function drawArrow(c, it) {
  const lw = strokeWidth(it);
  const dx = it.x2 - it.x1;
  const dy = it.y2 - it.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const head = Math.min(lw * 3 + state.unit * 6, len * 0.6);
  const ang = Math.atan2(dy, dx);
  const spread = 0.45;
  const bx = it.x2 - Math.cos(ang) * head * 0.8;
  const by = it.y2 - Math.sin(ang) * head * 0.8;
  c.lineWidth = lw;
  c.beginPath();
  c.moveTo(it.x1, it.y1);
  c.lineTo(bx, by);
  c.stroke();
  c.beginPath();
  c.moveTo(it.x2, it.y2);
  c.lineTo(it.x2 - Math.cos(ang - spread) * head, it.y2 - Math.sin(ang - spread) * head);
  c.lineTo(it.x2 - Math.cos(ang + spread) * head, it.y2 - Math.sin(ang + spread) * head);
  c.closePath();
  c.lineWidth = lw / 2;
  c.fill();
  c.stroke();
}

// Smooth freehand line through the midpoints of the recorded points.
function strokePath(c, pts) {
  if (!pts.length) return;
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) c.lineTo(pts[0][0] + 0.01, pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  if (pts.length > 1) c.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  c.stroke();
}

// Pixelates whatever is already drawn under the area, so it is unreadable in the saved PNG too.
const mosaicTmp = document.createElement("canvas");
function drawMosaic(c, it) {
  const b = box(it);
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const w = Math.min(state.W, Math.ceil(b.x + b.w)) - x;
  const h = Math.min(state.H, Math.ceil(b.y + b.h)) - y;
  if (w < 1 || h < 1) return;
  const block = mosaicBlock();
  const sw = Math.max(1, Math.ceil(w / block));
  const sh = Math.max(1, Math.ceil(h / block));
  mosaicTmp.width = sw;
  mosaicTmp.height = sh;
  const t = mosaicTmp.getContext("2d");
  t.imageSmoothingEnabled = true;
  t.drawImage(c.canvas, x, y, w, h, 0, 0, sw, sh);
  // the last row/column of blocks may be larger than the area, so clip to it
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  c.imageSmoothingEnabled = false;
  c.drawImage(mosaicTmp, 0, 0, sw, sh, x, y, sw * block, sh * block);
}

function textLines(it) {
  return it.text.split("\n");
}

function textBox(it) {
  const size = fontSize(it);
  ctx.save();
  ctx.font = FONT.replace("{size}", size);
  const w = Math.max(...textLines(it).map((l) => ctx.measureText(l).width), size * 0.5);
  ctx.restore();
  return { x: it.x, y: it.y, w, h: textLines(it).length * size * LINE_HEIGHT };
}

function drawText(c, it) {
  const size = fontSize(it);
  c.font = FONT.replace("{size}", size);
  c.textBaseline = "middle";
  // outline in the opposite tone keeps the text readable on any background
  c.strokeStyle = isLight(it.color) ? "#000000" : "#ffffff";
  c.lineWidth = Math.max(2, size * 0.18);
  textLines(it).forEach((line, i) => {
    const y = it.y + size * LINE_HEIGHT * (i + 0.5);
    c.strokeText(line, it.x, y);
    c.fillText(line, it.x, y);
  });
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 > 160;
}

function bounds(it) {
  if (TWO_POINT.has(it.type)) return box(it);
  if (it.type === "text") return textBox(it);
  const xs = it.points.map((p) => p[0]);
  const ys = it.points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function isLine(it) {
  return it.type === "arrow" || it.type === "line";
}

function handles(it) {
  if (isLine(it)) {
    return [
      { x: it.x1, y: it.y1, kx: "x1", ky: "y1" },
      { x: it.x2, y: it.y2, kx: "x2", ky: "y2" },
    ];
  }
  if (TWO_POINT.has(it.type)) {
    return [
      { x: it.x1, y: it.y1, kx: "x1", ky: "y1" },
      { x: it.x2, y: it.y1, kx: "x2", ky: "y1" },
      { x: it.x1, y: it.y2, kx: "x1", ky: "y2" },
      { x: it.x2, y: it.y2, kx: "x2", ky: "y2" },
    ];
  }
  return [];
}

// The width of a pen or marker stroke; 0 for other items.
function freehandWidth(it) {
  if (it.type === "pen") return strokeWidth(it);
  if (it.type === "marker") return markerWidth(it);
  return 0;
}

function drawSelection(c, it) {
  const r = pxRatio();
  c.save();
  c.lineWidth = 1.5 * r;
  c.strokeStyle = "#2563eb";
  if (!isLine(it)) {
    const b = bounds(it);
    const pad = freehandWidth(it) / 2 + 4 * r;
    c.setLineDash([5 * r, 4 * r]);
    c.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    c.setLineDash([]);
  }
  c.fillStyle = "#ffffff";
  for (const h of handles(it)) {
    c.beginPath();
    c.arc(h.x, h.y, HANDLE_PX * r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
  c.restore();
}

/* ---------- hit testing ---------- */

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hits(it, x, y, tol) {
  switch (it.type) {
    case "line":
    case "arrow":
      return distToSegment(x, y, it.x1, it.y1, it.x2, it.y2) <= strokeWidth(it) / 2 + tol;
    case "pen":
    case "marker": {
      const reach = (it.type === "pen" ? strokeWidth(it) : markerWidth(it)) / 2 + tol;
      const p = it.points;
      if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= reach;
      for (let i = 1; i < p.length; i++) {
        if (distToSegment(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= reach) return true;
      }
      return false;
    }
    case "text": {
      const b = textBox(it);
      return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
    }
    case "ellipse": {
      const b = box(it);
      const rx = b.w / 2;
      const ry = b.h / 2;
      if (rx < 1 || ry < 1) return distToSegment(x, y, b.x, b.y, b.x + b.w, b.y + b.h) <= tol;
      const r = Math.hypot((x - b.x - rx) / rx, (y - b.y - ry) / ry);
      if (it.fill) return r <= 1 + tol / Math.min(rx, ry);
      return Math.abs(r - 1) * Math.min(rx, ry) <= strokeWidth(it) / 2 + tol;
    }
    default: {
      // rect, mosaic
      const b = box(it);
      const inOuter = x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
      if (!inOuter) return false;
      if (it.fill || it.type === "mosaic") return true;
      const edge = strokeWidth(it) / 2 + tol;
      return x <= b.x + edge || x >= b.x + b.w - edge || y <= b.y + edge || y >= b.y + b.h - edge;
    }
  }
}

function itemAt(x, y) {
  const tol = HIT_PX * pxRatio();
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (hits(state.items[i], x, y, tol)) return state.items[i];
  }
  return null;
}

function handleAt(x, y) {
  if (!state.selected) return null;
  const tol = (HANDLE_PX + 4) * pxRatio();
  return handles(state.selected).find((h) => Math.hypot(x - h.x, y - h.y) <= tol) || null;
}

/* ---------- undo / redo ---------- */

// Items are changed in place, so each step keeps them as JSON.
const history = new History(state, {
  take: () => JSON.stringify(state.items),
  apply: (step) => (state.items = JSON.parse(step)),
  limit: 100,
});

// Records the items as a new step, unless nothing changed since the last one.
function recordChange() {
  if (history.take() === history.steps[history.pos]) return;
  history.record();
  state.dirty = true;
  updateButtons();
}

function undo() {
  closeEditor(true);
  if (history.undo()) afterRestore();
}

function redo() {
  closeEditor(true);
  if (history.redo()) afterRestore();
}

function afterRestore() {
  state.selected = null;
  state.dirty = true;
  render();
  updateButtons();
}

/* ---------- pointer interaction ---------- */

function toImage(e) {
  const r = els.canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (state.W / r.width), (e.clientY - r.top) * (state.H / r.height)];
}

let drag = null; // { mode: "move" | "handle" | "draw", ... }

els.canvas.addEventListener("pointerdown", (e) => {
  if (!state.base || e.button !== 0) return;
  e.preventDefault(); // keeps focus in the text editor instead of moving it to the canvas
  if (state.editing) {
    closeEditor(true);
    if (state.tool === "text") return; // the click just finishes the text being typed
  }
  const [x, y] = toImage(e);
  const handle = handleAt(x, y);
  if (handle) {
    drag = { mode: "handle", handle };
  } else if (state.tool === "select") {
    const hit = itemAt(x, y);
    state.selected = hit;
    if (hit) drag = { mode: "move", last: [x, y] };
    render();
    updateButtons();
  } else if (state.tool === "text") {
    const hit = itemAt(x, y);
    if (hit && hit.type === "text") openEditor(hit);
    else openEditor(null, x, y - fontSize({ mul: state.mul }) * LINE_HEIGHT / 2);
    return;
  } else {
    const it = { type: state.tool, color: state.color, mul: state.mul };
    if (TWO_POINT.has(state.tool)) Object.assign(it, { x1: x, y1: y, x2: x, y2: y, fill: state.fill });
    else it.points = [[x, y]];
    state.items.push(it);
    state.selected = null;
    drag = { mode: "draw", item: it };
  }
  if (drag) els.canvas.setPointerCapture(e.pointerId);
});

els.canvas.addEventListener("pointermove", (e) => {
  if (!state.base) return;
  const [x, y] = toImage(e);
  if (!drag) {
    const over = handleAt(x, y) || (state.tool === "select" && itemAt(x, y));
    els.canvas.classList.toggle("over-item", !!over);
    return;
  }
  if (drag.mode === "move") {
    const dx = x - drag.last[0];
    const dy = y - drag.last[1];
    drag.last = [x, y];
    moveItem(state.selected, dx, dy);
  } else if (drag.mode === "handle") {
    dragHandle(e, x, y);
  } else if (TWO_POINT.has(drag.item.type)) {
    dragSecondPoint(e, x, y);
  } else {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) drag.item.points.push(toImage(ev));
  }
  renderSoon();
});

// Moves the handle being dragged to (x, y). With Shift, a line keeps to steps of 45°.
function dragHandle(e, x, y) {
  const it = state.selected;
  let [nx, ny] = [x, y];
  if (e.shiftKey && isLine(it)) {
    const ox = drag.handle.kx === "x1" ? it.x2 : it.x1;
    const oy = drag.handle.ky === "y1" ? it.y2 : it.y1;
    [nx, ny] = snapAngle(ox, oy, x, y);
  }
  it[drag.handle.kx] = nx;
  it[drag.handle.ky] = ny;
  drag.handle.x = nx;
  drag.handle.y = ny;
}

// Moves the end of the line or box being drawn to (x, y). With Shift, a line keeps to steps
// of 45° and a box becomes a square.
function dragSecondPoint(e, x, y) {
  const it = drag.item;
  let [nx, ny] = [x, y];
  if (e.shiftKey && isLine(it)) {
    [nx, ny] = snapAngle(it.x1, it.y1, x, y);
  } else if (e.shiftKey) {
    const side = Math.max(Math.abs(x - it.x1), Math.abs(y - it.y1));
    nx = it.x1 + Math.sign(x - it.x1 || 1) * side;
    ny = it.y1 + Math.sign(y - it.y1 || 1) * side;
  }
  it.x2 = nx;
  it.y2 = ny;
}

// A line or box drawn by a slip of the pointer, too small to be meant.
function isTooSmall(it) {
  if (!TWO_POINT.has(it.type)) return false;
  const tiny = HIT_PX * pxRatio();
  if (isLine(it)) return Math.hypot(it.x2 - it.x1, it.y2 - it.y1) < tiny;
  return Math.abs(it.x2 - it.x1) < tiny / 2 || Math.abs(it.y2 - it.y1) < tiny / 2;
}

function endDrag() {
  if (!drag) return;
  if (drag.mode === "draw") {
    const it = drag.item;
    if (isTooSmall(it)) {
      state.items.pop();
    } else if (it.type !== "pen" && it.type !== "marker") {
      state.selected = it;
    }
  }
  drag = null;
  recordChange();
  render();
  updateButtons();
}
els.canvas.addEventListener("pointerup", endDrag);
els.canvas.addEventListener("pointercancel", endDrag);

els.canvas.addEventListener("dblclick", (e) => {
  if (!state.base) return;
  const hit = itemAt(...toImage(e));
  if (hit && hit.type === "text") openEditor(hit);
});

function snapAngle(ox, oy, x, y) {
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(y - oy, x - ox) / step) * step;
  const len = Math.hypot(x - ox, y - oy);
  return [ox + Math.cos(ang) * len, oy + Math.sin(ang) * len];
}

function moveItem(it, dx, dy) {
  if (TWO_POINT.has(it.type)) {
    it.x1 += dx;
    it.x2 += dx;
    it.y1 += dy;
    it.y2 += dy;
  } else if (it.type === "text") {
    it.x += dx;
    it.y += dy;
  } else {
    for (const p of it.points) {
      p[0] += dx;
      p[1] += dy;
    }
  }
}

/* ---------- text editing ---------- */

function openEditor(item, x, y) {
  if (!item) {
    item = { type: "text", x, y, text: "", color: state.color, mul: state.mul, isNew: true };
  }
  state.editing = item;
  state.selected = item.isNew ? null : item;
  els.editor.value = item.text;
  els.editor.hidden = false;
  positionEditor();
  render();
  els.editor.focus();
  els.editor.setSelectionRange(item.text.length, item.text.length);
}

function positionEditor() {
  const it = state.editing;
  const s = 1 / pxRatio();
  const size = fontSize(it) * s;
  Object.assign(els.editor.style, {
    left: `${it.x * s}px`,
    top: `${it.y * s}px`,
    fontSize: `${size}px`,
    color: it.color,
    textShadow: isLight(it.color) ? "0 0 2px #000" : "0 0 2px #fff",
  });
  els.editor.style.width = "0";
  els.editor.style.height = "0";
  els.editor.style.width = `${els.editor.scrollWidth + size * 0.5}px`;
  els.editor.style.height = `${els.editor.scrollHeight}px`;
}

function closeEditor(commit) {
  const it = state.editing;
  if (!it) return;
  state.editing = null;
  els.editor.hidden = true;
  const text = els.editor.value.replace(/\s+$/, "");
  if (commit && text !== it.text) {
    if (it.isNew) {
      delete it.isNew;
      it.text = text;
      if (text) state.items.push(it);
    } else if (text) {
      it.text = text;
    } else {
      state.items = state.items.filter((i) => i !== it);
    }
    state.selected = text ? it : null;
  }
  recordChange();
  render();
  updateButtons();
}

els.editor.addEventListener("input", positionEditor);
els.editor.addEventListener("blur", () => closeEditor(true));
els.editor.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    closeEditor(true);
  }
});

/* ---------- toolbar ---------- */

function setTool(tool) {
  closeEditor(true);
  state.tool = tool;
  els.stage.dataset.tool = tool;
  for (const b of els.tools) {
    b.classList.toggle("selected", b.dataset.tool === tool);
    b.setAttribute("aria-checked", b.dataset.tool === tool);
  }
  if (tool !== "select" && state.selected) {
    state.selected = null;
    render();
    updateButtons();
  }
}

for (const b of els.tools) b.addEventListener("click", () => setTool(b.dataset.tool));

// Changing color, width or fill also restyles whatever is selected.
function restyleSelected(apply) {
  const it = state.editing || state.selected;
  if (!it) return;
  apply(it);
  if (state.editing) positionEditor();
  else recordChange();
  render();
}

for (const s of els.swatches) {
  s.addEventListener("click", () => {
    state.color = s.dataset.color;
    for (const o of els.swatches) o.classList.toggle("selected", o === s);
    restyleSelected((it) => (it.color = state.color));
    if (state.editing) els.editor.focus();
  });
}

els.width.addEventListener("change", () => {
  state.mul = Number(els.width.value);
  restyleSelected((it) => (it.mul = state.mul));
  if (state.editing) els.editor.focus();
});

els.fill.addEventListener("change", () => {
  state.fill = els.fill.checked;
  const it = state.selected;
  if (it && (it.type === "rect" || it.type === "ellipse")) restyleSelected((i) => (i.fill = state.fill));
});

function deleteSelected() {
  if (!state.selected) return;
  state.items = state.items.filter((i) => i !== state.selected);
  state.selected = null;
  recordChange();
  render();
  updateButtons();
}

els.deleteBtn.addEventListener("click", deleteSelected);
els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);

function updateButtons() {
  const open = !!state.base;
  els.undoBtn.disabled = !history.canUndo;
  els.redoBtn.disabled = !history.canRedo;
  els.deleteBtn.disabled = !state.selected;
  els.copyBtn.disabled = !open;
  els.saveBtn.disabled = !open;
}

/* ---------- export ---------- */

function exportBlob() {
  closeEditor(true);
  const out = document.createElement("canvas");
  out.width = state.W;
  out.height = state.H;
  draw(out.getContext("2d"), false);
  return canvasToBlob(out, "image/png");
}

async function save() {
  if (!state.base) return;
  download(await exportBlob(), `${state.fileName}_書き込み.png`);
  state.dirty = false;
  showStatus("PNG画像を保存しました");
}

async function copyToClipboard() {
  if (!state.base) return;
  if (await copyImage(exportBlob())) showStatus("コピーしました。ドキュメントやスライドに Ctrl+V で貼り付けられます");
  else showStatus("コピーできませんでした。「保存」を使ってください", { error: true });
}

els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save: save, kind: "image" });
els.copyBtn.addEventListener("click", copyToClipboard);

/* ---------- opening files ---------- */

els.fileInput.addEventListener("change", () => {
  const f = els.fileInput.files[0];
  if (f) openImage(f, f.name);
  els.fileInput.value = "";
});

$("blank-btn").addEventListener("click", openBlank);

// Paste a screenshot straight from the clipboard.
document.addEventListener("paste", (e) => {
  if (state.editing) return;
  const file = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"))?.getAsFile();
  if (!file) return;
  e.preventDefault();
  openImage(file, "スクリーンショット");
});

onFileDrop((files) => {
  const img = files.find(isImage);
  if (img) openImage(img, img.name);
  else showStatus("画像ファイルをドロップしてください", { error: true });
});

/* ---------- keyboard ---------- */

const TOOL_KEYS = { v: "select", a: "arrow", t: "text", r: "rect", o: "ellipse", l: "line", p: "pen", m: "marker", b: "mosaic" };

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (k === "s") {
      e.preventDefault();
      save();
    } else if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (k === "y" || (k === "z" && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
    return;
  }
  if (!state.base) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelected();
  } else if (e.key === "Escape") {
    state.selected = null;
    render();
    updateButtons();
  } else if (e.key.startsWith("Arrow") && state.selected) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * pxRatio();
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    moveItem(state.selected, ...d);
    recordChange();
    render();
  } else if (TOOL_KEYS[k] && !e.altKey) {
    setTool(TOOL_KEYS[k]);
  }
});

window.addEventListener("resize", () => {
  fitToView();
  render();
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

els.stage.dataset.tool = state.tool;

// For the automated checks in tests/.
window.__imageAnnotate = { state, undo, redo };

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);
