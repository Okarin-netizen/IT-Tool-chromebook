// Writing on PDF pages: pen and highlighter strokes, stamps, picking, moving and resizing.
// Shared by PDFに手書き・署名 (pdf-sign) and PDF一括採点 (pdf-grade).
//
// Items are in page points with a top-left origin, as the page is shown (rotation applied):
//   stroke: { type, page, tool: "pen"|"marker", color, width, points: [[x, y], …] }
//   stamp:  { type, page, kind, text, color, x, y, w, h }
// plus the tool's own types, which only need x, y, w, h. `page` is the id of a page view.

import { canvasToBlob, pixelRatio } from "./canvas.js";

export const MARKER_FACTOR = 6; // highlighter width = pen width × this
export const SEAL_COLOR = "#d7261e";
export const TEXT_FONT = 'system-ui, "Noto Sans JP", sans-serif';
const SEAL_FONT = '"Noto Serif CJK JP", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif';
const INK_SCALE = 4; // 288 dpi for the ink layer in the saved PDF
const INK_MAX_PX = 4096; // longest side of a saved ink image

const sealFont = (size) => `bold ${size}px ${SEAL_FONT}`;

const measureCtx = document.createElement("canvas").getContext("2d");
export function textWidth(text, font) {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/* ---------- drawing ---------- */

function lighten(hex, amount = 0.5) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

// A smooth line through the points.
export function tracePath(ctx, pts) {
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

export function drawStroke(ctx, item) {
  ctx.save();
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = item.tool === "marker" ? lighten(item.color) : item.color;
  ctx.lineWidth = item.width;
  ctx.beginPath();
  tracePath(ctx, item.points);
  ctx.stroke();
  ctx.restore();
}

// `def` is the stamp's entry in the tool's list: { shape, vertical?, fit? }.
//   circle: round seal with text (`vertical`: written top to bottom, 4 characters in 2 columns)
//   rect:   rounded box with text; `fit` is how much of the width the text may take
//   text:   plain text (the date)
//   check, ring, cross, triangle, hanamaru: marks drawn in the current color
export function drawStamp(ctx, item, def) {
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
      const fs = Math.min(h * 0.6, (w * (def.fit ?? 0.84)) / [...text].length);
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
      ctx.translate(x, y);
      ctx.scale(w, h);
      ctx.lineWidth = def.shape === "hanamaru" ? 0.045 : 0.11;
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
      } else if (def.shape === "hanamaru") {
        // A spiral in the middle, ringed with petals.
        for (let t = 0; t <= 1; t += 0.01) {
          const a = t * Math.PI * 4.6 - Math.PI / 2;
          const r = 0.03 + t * 0.25;
          const px = 0.5 + r * Math.cos(a);
          const py = 0.5 + r * Math.sin(a);
          if (t === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        const n = 9;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          const px = 0.5 + 0.34 * Math.cos(a);
          const py = 0.5 + 0.34 * Math.sin(a);
          ctx.moveTo(px + 0.12 * Math.cos(a - 1.9), py + 0.12 * Math.sin(a - 1.9));
          ctx.arc(px, py, 0.12, a - 1.9, a + 1.9);
        }
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Highlighter goes underneath so it never covers pen ink (the layer is opaque within itself).
export function drawItems(ctx, items, drawItem) {
  const markers = items.filter((i) => i.type === "stroke" && i.tool === "marker");
  for (const item of markers) drawItem(ctx, item);
  for (const item of items) if (!markers.includes(item)) drawItem(ctx, item);
}

// A small canvas showing `draw` (in units of w × h) fitted into a `box` pixel square.
export function previewCanvas(draw, w, h, box = 50) {
  const dpr = pixelRatio();
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

// Draws one page's items onto a transparent PNG cropped to where the ink is.
// Returns { box (page points), png } or null when nothing lands on the page.
export async function renderInkImage(items, { width, height }, drawItem) {
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
  drawItems(ctx, items, drawItem);
  const blob = await canvasToBlob(canvas, "image/png");
  canvas.width = canvas.height = 0;
  return { box, png: new Uint8Array(await blob.arrayBuffer()) };
}

/* ---------- geometry ---------- */

export function bounds(item) {
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

export function hits(item, x, y, tolerance) {
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

/* ---------- the editor ---------- */

// Ties the drawing to a tool's pages. The tool keeps in `state`:
//   items, selected, drawing, editing (optional), tool, color, width, scale, dirty
// and gives page views { id, viewport (scale 1), el, ink, selbox }.
//   viewOf(id)      the page view with that id
//   allViews()      every page view
//   drawItem        draws one item (shared types and the tool's own)
//   updateUi()      refreshes the toolbar
//   onChange()      after the items changed (optional)
//   beforeRestore() before undo/redo (optional)
export function createInkEditor({ state, history, viewOf, allViews, drawItem, updateUi, onChange = () => {}, beforeRestore = () => {} }) {
  function renderInk(view) {
    const { ink } = view;
    updateSelbox(view);
    if (!ink.width) return;
    const ctx = ink.getContext("2d");
    const k = ink.width / view.viewport.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ink.width, ink.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const items = state.items.filter((i) => i.page === view.id && i !== state.editing?.item);
    if (state.drawing?.page === view.id) items.push(state.drawing);
    drawItems(ctx, items, drawItem);
  }

  function renderPageInk(id) {
    const view = viewOf(id);
    if (view) renderInk(view);
  }

  function updateSelbox(view) {
    const item = state.selected;
    if (!item || item.page !== view.id) {
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

  function itemAt(page, x, y, tolerance, types) {
    for (let i = state.items.length - 1; i >= 0; i--) {
      const item = state.items[i];
      if (item.page === page && (!types || types.includes(item.type)) && hits(item, x, y, tolerance)) return item;
    }
    return null;
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
    history.record(replace);
    state.dirty = true;
    onChange();
    updateUi();
  }

  function restore(pos) {
    beforeRestore();
    if (!history.go(pos)) return;
    state.selected = null;
    state.dirty = true;
    allViews().forEach((view) => renderInk(view));
    onChange();
    updateUi();
  }

  // Changes the selected item (if `allowed`) with `change(copy)`, as one undo step.
  function changeSelected(allowed, change) {
    const item = state.selected;
    if (!item || !allowed(item)) return;
    change(history.edit(item));
    commit();
    renderPageInk(item.page);
  }

  /* ---------- pointer ---------- */

  function pagePoint(e, view) {
    const rect = view.el.getBoundingClientRect();
    return [(e.clientX - rect.left) / state.scale, (e.clientY - rect.top) / state.scale];
  }

  // Follows one pointer until it is released; calls back with page points.
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

  // Pen or highlighter, following the pointer.
  function drawStrokeFrom(e, view, [x, y]) {
    e.preventDefault();
    select(null);
    const width = state.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
    state.drawing = { type: "stroke", page: view.id, tool: state.tool, color: state.color, width, points: [[x, y]] };
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
  }

  // A box dragged out from corner to corner. `make(x, y, w, h)` builds the item.
  function drawBoxFrom(e, view, [x, y], make) {
    e.preventDefault();
    select(null);
    state.drawing = make(x, y, 0, 0);
    track(e, view, ([px, py]) => {
      Object.assign(state.drawing, { x: Math.min(x, px), y: Math.min(y, py), w: Math.abs(px - x), h: Math.abs(py - y) });
      renderInk(view);
    }, (cancelled) => {
      const box = state.drawing;
      state.drawing = null;
      if (!cancelled && box.w > 2 && box.h > 2) {
        state.items.push(box);
        commit();
      }
      renderInk(view);
    });
  }

  // Removes whatever the pointer passes over.
  function eraseFrom(e, view, point) {
    e.preventDefault();
    select(null);
    let erased = false;
    const erase = ([px, py]) => {
      const reach = 8 / state.scale;
      const before = state.items.length;
      state.items = state.items.filter((item) => item.page !== view.id || !hits(item, px, py, reach));
      if (state.items.length !== before) {
        erased = true;
        renderInk(view);
      }
    };
    erase(point);
    track(e, view, erase, () => erased && commit());
  }

  // Moves `item` with the pointer. `replace` adds the move to the last undo step (a stamp
  // that was just placed) instead of making a new one.
  function dragItem(e, view, item, [x, y], { replace = false } = {}) {
    e.preventDefault();
    let last = [x, y];
    let moving = null;
    track(e, view, ([px, py]) => {
      moving ??= history.edit(item);
      moveItem(moving, px - last[0], py - last[1]);
      last = [px, py];
      renderInk(view);
    }, () => (replace || moving) && commit(replace));
  }

  // Selects what is under the pointer and lets it be dragged. Returns false when nothing is there.
  function selectFrom(e, view, point) {
    const item = itemAt(view.id, ...point, 4 / state.scale);
    select(item);
    if (!item) return false; // let touch scrolling happen
    dragItem(e, view, item, point);
    return true;
  }

  // Adds a new stamp-like item where the pointer went down; dragging fine-tunes where it lands.
  function placeFrom(e, view, item, point) {
    state.items.push(item);
    commit();
    select(item);
    dragItem(e, view, item, point, { replace: true });
  }

  // The handle at the corner of the selection box.
  function onResizeDown(e, view) {
    if (!state.selected || state.selected.type === "stroke") return;
    e.preventDefault();
    e.stopPropagation();
    const item = history.edit(state.selected);
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

  return {
    renderInk, renderPageInk, updateSelbox, itemAt, select, deleteSelected, commit, changeSelected,
    undo: () => restore(history.pos - 1),
    redo: () => restore(history.pos + 1),
    pagePoint, drawStrokeFrom, drawBoxFrom, eraseFrom, selectFrom, placeFrom, onResizeDown,
  };
}
