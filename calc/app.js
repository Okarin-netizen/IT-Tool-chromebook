import { compile, format, ExprError } from "./expr.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { pixelRatio } from "../shared/js/canvas.js";

const STORE_KEY = "calc-tool-v1";
const MAX_HISTORY = 50;
const KEY_SYMBOLS = { "*": "×", "/": "÷" }; // typed keys shown as the signs on the keypad
const ERROR_DELAY_MS = 700; // pause in typing before a formula's error shows
const MAX_FUNCS = 8;
const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#be185d", "#4d7c0f"];

const $ = (id) => document.getElementById(id);
const els = {
  tabCalc: $("tab-calc"),
  tabGraph: $("tab-graph"),
  calcPane: $("calc-pane"),
  graphPane: $("graph-pane"),
  angleBtn: $("angle-btn"),
  expr: $("expr"),
  result: $("result"),
  keys: $("keys"),
  historyList: $("history-list"),
  historyEmpty: $("history-empty"),
  historyClear: $("history-clear"),
  funcList: $("func-list"),
  funcAdd: $("func-add"),
  canvas: $("plot"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomReset: $("zoom-reset"),
  readout: $("readout"),
};

const state = {
  angle: "deg",
  ans: undefined,
  history: [], // { expr, text }
  justEvaluated: false,
  funcs: [], // { src, color, on, fn, error }
};

function save() {
  saveJson(STORE_KEY, {
    angle: state.angle,
    ans: state.ans,
    history: state.history,
    funcs: state.funcs.map(({ src, color, on }) => ({ src, color, on })),
  });
}

// ---------- タブ ----------

function showTab(name) {
  const graph = name === "graph";
  els.tabCalc.setAttribute("aria-selected", String(!graph));
  els.tabGraph.setAttribute("aria-selected", String(graph));
  els.calcPane.hidden = graph;
  els.graphPane.hidden = !graph;
  history.replaceState(null, "", graph ? "#graph" : location.pathname + location.search);
  if (graph) resizeCanvas();
  else els.expr.focus({ preventScroll: true });
}
els.tabCalc.addEventListener("click", () => showTab("calc"));
els.tabGraph.addEventListener("click", () => showTab("graph"));

// ---------- 電卓 ----------

function setAngle(angle) {
  state.angle = angle;
  els.angleBtn.textContent = angle === "deg" ? "DEG" : "RAD";
  els.angleBtn.title = angle === "deg" ? "いまは度（°）です。押すとラジアンに切りかえ" : "いまはラジアンです。押すと度（°）に切りかえ";
  preview();
}
els.angleBtn.addEventListener("click", () => {
  setAngle(state.angle === "deg" ? "rad" : "deg");
  save();
});

function evaluate(src) {
  const vars = state.ans === undefined ? {} : { ans: state.ans };
  return compile(src)(vars, state.angle);
}

function showResult(text, kind) {
  els.result.textContent = text;
  els.result.className = "result" + (kind ? " " + kind : "");
}

// Shows the answer in grey while typing; errors stay quiet until "=".
function preview() {
  const src = els.expr.value.trim();
  if (!src) return showResult("", "preview");
  try {
    showResult(format(evaluate(src)), "preview");
  } catch {
    showResult("", "preview");
  }
}

function commit() {
  const src = els.expr.value.trim();
  if (!src) return;
  try {
    const v = evaluate(src);
    const text = format(v);
    showResult(text);
    if (Number.isFinite(v)) state.ans = v;
    state.history.unshift({ expr: src, text });
    state.history.length = Math.min(state.history.length, MAX_HISTORY);
    state.justEvaluated = true;
    renderHistory();
    save();
  } catch (err) {
    showResult(err instanceof ExprError ? err.message : "計算できません", "error");
  }
}

const CONTINUES = /^[+\-×÷*/^!]/; // keys that keep working on the previous answer

function insert(text) {
  const input = els.expr;
  if (state.justEvaluated) {
    state.justEvaluated = false;
    input.value = CONTINUES.test(text) && state.ans !== undefined ? "ans" : "";
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (!input.value && CONTINUES.test(text) && text !== "-" && state.ans !== undefined) {
    input.value = "ans";
    input.setSelectionRange(3, 3);
  }
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.setRangeText(text, start, end, "end");
  preview();
}

function backspace() {
  const input = els.expr;
  state.justEvaluated = false;
  let start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  if (start === end) {
    if (start === 0) return;
    // Remove a whole function name like "sin(" or "ans" at once.
    const before = input.value.slice(0, start);
    const word = /(asin|acos|atan|sinh|cosh|tanh|sin|cos|tan|sqrt|cbrt|abs|ln|log|exp|ans)\(?$/.exec(before);
    start -= word ? word[0].length : 1;
  }
  input.setRangeText("", start, end, "end");
  preview();
}

function clearAll() {
  els.expr.value = "";
  state.justEvaluated = false;
  showResult("");
}

els.keys.addEventListener("click", (e) => {
  const key = e.target.closest(".key");
  if (!key) return;
  if (key.dataset.ins) insert(key.dataset.ins);
  else if (key.dataset.act === "back") backspace();
  else if (key.dataset.act === "clear") clearAll();
  else if (key.dataset.act === "eval") commit();
  // Keep the caret in the input so physical typing continues where the buttons left off.
  els.expr.focus({ preventScroll: true });
});
// Stop buttons from stealing focus (and the caret position) on press.
els.keys.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".key")) e.preventDefault();
});

els.expr.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "=") {
    e.preventDefault();
    commit();
  } else if (e.key === "Escape") {
    e.preventDefault();
    clearAll();
  } else if (state.justEvaluated && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    insert(KEY_SYMBOLS[e.key] ?? e.key);
  }
});
els.expr.addEventListener("input", () => {
  state.justEvaluated = false;
  preview();
});

function renderHistory() {
  els.historyList.replaceChildren(...state.history.map((h) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const ex = document.createElement("span");
    ex.className = "h-expr";
    ex.textContent = h.expr + " =";
    const val = document.createElement("span");
    val.className = "h-val";
    val.textContent = h.text;
    btn.append(ex, val);
    btn.title = "この式を呼び出す";
    btn.addEventListener("click", () => {
      els.expr.value = h.expr;
      state.justEvaluated = false;
      preview();
      els.expr.focus();
    });
    li.append(btn);
    return li;
  }));
  els.historyEmpty.hidden = state.history.length > 0;
  els.historyClear.hidden = state.history.length === 0;
}
els.historyClear.addEventListener("click", () => {
  state.history = [];
  renderHistory();
  save();
});

// ---------- グラフ ----------

const ctx = els.canvas.getContext("2d");
const view = { cx: 0, cy: 0, scale: 40 }; // scale = pixels per unit, same on both axes
let size = { w: 0, h: 0 };
let hover = null; // { x, y } in CSS pixels

function defaultScale() {
  return Math.max(10, Math.min(size.w, size.h) / 20); // about -10..10 on the shorter side
}

function resetView() {
  view.cx = 0;
  view.cy = 0;
  view.scale = defaultScale();
  draw();
}

let sized = false;
function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = pixelRatio();
  size = { w: rect.width, h: rect.height };
  els.canvas.width = Math.round(rect.width * dpr);
  els.canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!sized) {
    sized = true;
    view.scale = defaultScale();
  }
  draw();
}
new ResizeObserver(() => { if (!els.graphPane.hidden) resizeCanvas(); }).observe(els.canvas);

const toPx = (x) => size.w / 2 + (x - view.cx) * view.scale;
const toPy = (y) => size.h / 2 - (y - view.cy) * view.scale;
const fromPx = (px) => view.cx + (px - size.w / 2) / view.scale;
const fromPy = (py) => view.cy - (py - size.h / 2) / view.scale;

// Grid spacing of 1, 2 or 5 × 10^n that leaves at least `minPx` pixels between lines.
function niceStep(minPx) {
  const raw = minPx / view.scale;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function label(v, step) {
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const s = v.toFixed(digits);
  return s === "-0" ? "0" : s.replace(/^-/, "−");
}

function drawGrid() {
  const step = niceStep(70);
  // Grid lines between the labelled ones: quarters of a step of 2 (or 20, 0.2 …), fifths of 1 or 5.
  const leading = String(step / 10 ** Math.floor(Math.log10(step)))[0];
  const minor = step / (leading === "2" ? 4 : 5);
  ctx.lineWidth = 1;
  gridLines(minor, "#f3f4f6");
  gridLines(step, "#e5e7eb");
  // Axes, kept on screen at the edge when the origin is scrolled away so labels stay readable.
  const ax = Math.round(toPx(0)) + 0.5;
  const ay = Math.round(toPy(0)) + 0.5;
  drawAxes(ax, ay);
  axisNumbers(step, ax, ay);
  axisNames(ax, ay);
}

// Lines across the graph every `gap` in x and in y.
function gridLines(gap, color) {
  const { w, h } = size;
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (let x = Math.ceil(fromPx(0) / gap) * gap; x <= fromPx(w); x += gap) {
    const px = Math.round(toPx(x)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = Math.ceil(fromPy(h) / gap) * gap; y <= fromPy(0); y += gap) {
    const py = Math.round(toPy(y)) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();
}

// The axes through (ax, ay) in pixels, each only while it is on screen.
function drawAxes(ax, ay) {
  const { w, h } = size;
  ctx.strokeStyle = "#374151";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (ax >= 0 && ax <= w) {
    ctx.moveTo(ax, 0);
    ctx.lineTo(ax, h);
  }
  if (ay >= 0 && ay <= h) {
    ctx.moveTo(0, ay);
    ctx.lineTo(w, ay);
  }
  ctx.stroke();
}

// The numbers along the axes every `step`, and "O" at the origin.
function axisNumbers(step, ax, ay) {
  const { w, h } = size;
  ctx.fillStyle = "#4b5563";
  ctx.font = "12px system-ui, sans-serif";
  const ly = Math.min(Math.max(ay + 4, 4), h - 18);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let x = Math.ceil(fromPx(0) / step) * step; x <= fromPx(w); x += step) {
    if (Math.abs(x) < step / 2) continue;
    ctx.fillText(label(x, step), toPx(x), ly);
  }
  const lx = Math.min(Math.max(ax - 6, 30), w - 6);
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let y = Math.ceil(fromPy(h) / step) * step; y <= fromPy(0); y += step) {
    if (Math.abs(y) < step / 2) continue;
    ctx.fillText(label(y, step), lx, toPy(y));
  }
  if (ax >= 0 && ax <= w && ay >= 0 && ay <= h) {
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("O", ax - 4, ay + 4);
  }
}

// "x" at the right end of the x axis and "y" at the top of the y axis.
function axisNames(ax, ay) {
  const { w, h } = size;
  ctx.font = "italic 14px serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  if (ay >= 0 && ay <= h) ctx.fillText("x", w - 6, ay - 4);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  if (ax >= 0 && ax <= w) ctx.fillText("y", ax + 6, 6);
}

function safeEval(fn, x) {
  try {
    const y = fn({ x });
    return Number.isFinite(y) ? y : NaN;
  } catch {
    return NaN;
  }
}

function drawFunc(f) {
  const { w, h } = size;
  const clamp = (py) => Math.max(-h * 4, Math.min(h * 5, py));
  ctx.strokeStyle = f.color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  const step = 0.5; // half-pixel sampling keeps steep curves smooth
  let prev = null; // previous screen y, or null after a gap
  for (let px = -step; px <= w + step; px += step) {
    const x = fromPx(px);
    const y = safeEval(f.fn, x);
    if (Number.isNaN(y)) { prev = null; continue; }
    const py = toPy(y);
    if (prev === null) {
      ctx.moveTo(px, clamp(py));
    } else if (Math.abs(py - prev) > h) {
      // Big jump: a vertical asymptote (tan x, 1/x) has a midpoint outside both ends, a steep curve does not.
      const mid = toPy(safeEval(f.fn, fromPx(px - step / 2)));
      const between = mid >= Math.min(prev, py) && mid <= Math.max(prev, py);
      if (between) ctx.lineTo(px, clamp(py));
      else ctx.moveTo(px, clamp(py));
    } else {
      ctx.lineTo(px, clamp(py));
    }
    prev = py;
  }
  ctx.stroke();
}

function coordDigits() {
  return Math.max(0, Math.min(6, Math.ceil(Math.log10(view.scale)) + 1));
}

const SNAP_PX = 40; // the pointer snaps to a curve this close to it

function drawHover() {
  if (!hover) {
    els.readout.hidden = true;
    return;
  }
  const x = fromPx(hover.x);
  const d = coordDigits();
  const fmt = (v) => {
    const s = v.toFixed(d);
    return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
  };
  const best = nearestCurve(x);
  if (best) {
    drawSnapMark(toPy(best.y), best.f.color);
    els.readout.textContent = `y${subscript(best.i + 1)}: (${fmt(x)}, ${fmt(best.y)})`;
    els.readout.style.borderLeft = `4px solid ${best.f.color}`;
  } else {
    els.readout.textContent = `(${fmt(x)}, ${fmt(fromPy(hover.y))})`;
    els.readout.style.borderLeft = "";
  }
  els.readout.hidden = false;
}

// The shown curve nearest the pointer at `x`, if one is close: { f, i, y, dist }.
function nearestCurve(x) {
  let best = null;
  state.funcs.forEach((f, i) => {
    if (!f.on || !f.fn) return;
    const y = safeEval(f.fn, x);
    if (Number.isNaN(y)) return;
    const dist = Math.abs(toPy(y) - hover.y);
    if (dist < SNAP_PX && (!best || dist < best.dist)) best = { f, i, y, dist };
  });
  return best;
}

// A dashed line down through the pointer and a ring where it meets the curve.
function drawSnapMark(py, color) {
  ctx.strokeStyle = color;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hover.x, 0);
  ctx.lineTo(hover.x, size.h);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(hover.x, py, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

const SUBS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n) => String(n).replace(/\d/g, (c) => SUBS[c]);

let frame = 0;
function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!size.w) return;
    ctx.clearRect(0, 0, size.w, size.h);
    drawGrid();
    for (const f of state.funcs) if (f.on && f.fn) drawFunc(f);
    drawHover();
  });
}

function zoomAt(factor, px = size.w / 2, py = size.h / 2) {
  const x = fromPx(px);
  const y = fromPy(py);
  view.scale = Math.max(1e-4, Math.min(1e7, view.scale * factor));
  // Keep the point under the pointer fixed.
  view.cx = x - (px - size.w / 2) / view.scale;
  view.cy = y + (py - size.h / 2) / view.scale;
  draw();
}

els.zoomIn.addEventListener("click", () => zoomAt(1.5));
els.zoomOut.addEventListener("click", () => zoomAt(1 / 1.5));
els.zoomReset.addEventListener("click", resetView);

const localPoint = (e) => {
  const r = els.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

els.canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = localPoint(e);
  const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
  zoomAt(Math.exp(-delta * 0.0015), p.x, p.y);
}, { passive: false });

// One pointer pans, two pointers pinch-zoom.
const pointers = new Map();
let pinch = null;
els.canvas.addEventListener("pointerdown", (e) => {
  els.canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localPoint(e));
  els.canvas.classList.add("dragging");
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  if (e.pointerType !== "mouse") hover = localPoint(e);
  draw();
});
els.canvas.addEventListener("pointermove", (e) => {
  const p = localPoint(e);
  const last = pointers.get(e.pointerId);
  if (!last) {
    hover = p;
    draw();
    return;
  }
  if (pointers.size === 1) {
    view.cx -= (p.x - last.x) / view.scale;
    view.cy += (p.y - last.y) / view.scale;
    if (e.pointerType !== "mouse") hover = p;
  } else if (pinch) {
    pointers.set(e.pointerId, p);
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (pinch.dist > 0) zoomAt(dist / pinch.dist, mid.x, mid.y);
    pinch.dist = dist;
    hover = null;
  }
  pointers.set(e.pointerId, p);
  draw();
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) els.canvas.classList.remove("dragging");
}
els.canvas.addEventListener("pointerup", endPointer);
els.canvas.addEventListener("pointercancel", endPointer);
els.canvas.addEventListener("pointerleave", (e) => {
  if (e.pointerType === "mouse" && !pointers.size) {
    hover = null;
    draw();
  }
});

// ---------- 関数リスト ----------

function compileFunc(f) {
  // Accept "y = ..." and "f(x) = ..." as typed in a textbook.
  const src = f.src.replace(/^\s*(y|[a-z]\s*\(\s*x\s*\))\s*=/i, "").trim();
  f.fn = null;
  f.error = "";
  if (!src) return;
  try {
    const fn = compile(src);
    fn({ x: 1 }); // surfaces unknown names now rather than as a blank graph
    f.fn = fn;
  } catch (err) {
    f.error = err instanceof ExprError ? err.message : "式を読み取れません";
  }
}

function nextColor() {
  const used = new Set(state.funcs.map((f) => f.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[state.funcs.length % COLORS.length];
}

function addFunc(src = "", color = nextColor(), on = true) {
  const f = { src, color, on, fn: null, error: "" };
  compileFunc(f);
  state.funcs.push(f);
  return f;
}

function renderFuncs(focusIndex) {
  els.funcList.replaceChildren(...state.funcs.map(funcRow));
  if (focusIndex !== undefined) els.funcList.querySelectorAll('input[type="text"]')[focusIndex]?.focus();
  els.funcAdd.disabled = state.funcs.length >= MAX_FUNCS;
}

// The row for function `f`, the i-th: a check box to show it, its formula and a delete button,
// with the error message below.
function funcRow(f, i) {
  const row = document.createElement("div");
  row.className = "func" + (f.error ? " error" : "");
  row.style.setProperty("--c", f.color);
  const msg = document.createElement("p");
  msg.className = "func-msg";
  msg.textContent = f.error;
  msg.hidden = !f.error;

  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = f.on;
  check.title = "表示する";
  check.addEventListener("change", () => {
    f.on = check.checked;
    draw();
    save();
  });
  const id = `func-${i}`;
  const lab = document.createElement("label");
  lab.htmlFor = id;
  lab.textContent = `y${subscript(i + 1)} =`;
  const remove = document.createElement("button");
  remove.className = "remove";
  remove.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-close"/></svg>';
  remove.title = "この関数を消す";
  remove.setAttribute("aria-label", remove.title);
  remove.addEventListener("click", () => {
    state.funcs.splice(i, 1);
    if (!state.funcs.length) addFunc();
    renderFuncs();
    draw();
    save();
  });
  row.append(check, lab, formulaInput(f, i, id, row, msg), remove);

  const li = document.createElement("li");
  li.append(row, msg);
  return li;
}

// The text box for the formula of `f`: redraws as it is typed, and shows an error once the
// typing pauses, so half-typed input doesn't flash errors.
function formulaInput(f, i, id, row, msg) {
  const input = document.createElement("input");
  input.type = "text";
  input.id = id;
  input.value = f.src;
  input.placeholder = i === 0 ? "例: x^2-2x-3" : "式を入力";
  input.autocomplete = "off";
  input.spellcheck = false;
  let timer = 0;
  input.addEventListener("input", () => {
    f.src = input.value;
    compileFunc(f);
    row.classList.toggle("error", Boolean(f.error));
    draw();
    clearTimeout(timer);
    msg.hidden = true;
    timer = setTimeout(() => {
      msg.textContent = f.error;
      msg.hidden = !f.error;
    }, ERROR_DELAY_MS);
    save();
  });
  return input;
}

els.funcAdd.addEventListener("click", () => {
  if (state.funcs.length >= MAX_FUNCS) return;
  addFunc();
  renderFuncs(state.funcs.length - 1);
  save();
});

// ---------- はじめに ----------

const saved = loadJson(STORE_KEY);
setAngle(saved?.angle === "rad" ? "rad" : "deg");
if (typeof saved?.ans === "number") state.ans = saved.ans;
if (Array.isArray(saved?.history)) {
  state.history = saved.history.filter((h) => h && typeof h.expr === "string").slice(0, MAX_HISTORY);
}
if (Array.isArray(saved?.funcs) && saved.funcs.length) {
  for (const f of saved.funcs.slice(0, MAX_FUNCS)) {
    const color = COLORS.includes(f.color) ? f.color : nextColor();
    addFunc(String(f.src ?? ""), color, f.on !== false);
  }
} else {
  addFunc("x^2-2x-3");
  addFunc("2sin(x)");
}
renderHistory();
renderFuncs();
showTab(location.hash === "#graph" ? "graph" : "calc");

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "expr.js",
  "icon.svg",
  "manifest.webmanifest",
]);
