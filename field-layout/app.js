// 校庭の配置図: put cones, arrows, tents and words on a school yard and save the figure as an
// image or PDF for a handout (運動会 and other events). One file can hold several figures: the
// first, 全体の配置, holds what every figure shares (tents, gates, seats); the others are one per
// event and show it underneath. Positions and sizes are in meters (drawing.js, parts.js).
import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop, safeFileName } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { History } from "../shared/js/history.js";
import { createMenus } from "../shared/js/menus.js";
import { copyImage } from "../shared/js/clipboard.js";
import { dateText } from "../shared/js/dates.js";
import { registerOffline } from "../shared/js/offline.js";
import { OFFLINE } from "../shared/js/vendor.js";
import { PARTS, MARKS, LINE_DEFAULTS, TEXT_SIZES, NUMBER_SIZE } from "./parts.js";
import { newDoc, figureMarkup, drawItem, DEFS, BASE_INDEX, halfSize, turnedHalfSize, isStraight } from "./drawing.js";
import { renderPanel } from "./panel.js";
import { figurePng, figuresPdf } from "./save.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const DOC_KEY = "field-layout-doc-v1";
const SETTINGS_KEY = "field-layout-settings-v1";
const FILE_APP = "field-layout"; // written in つづき files, to know them again

const SNAP_STEP = 1; // m
const SIZE_SNAP = 0.5; // m, sizes of stretchable parts while snapping
const ANGLE_STEP = 15; // degrees the rotate handle snaps to (Alt for free turning)
const NUDGE = 0.5; // m per arrow key (5 m with Shift)
const NUDGE_BIG = 5;
const DRAG_START_PX = 5; // a press that moves less than this is a click
const HANDLE_PX = 7; // px, the radius of the handles
const ROTATE_GAP_PX = 26; // px from the top of the item to the rotate handle
const SHORT_LINE = 1; // m: a line shorter than this was a click, so it gets the default length
const DEFAULT_LINE = 10; // m
const CURVE_BEND = 0.25; // how far a new curved arrow bends, as a part of its length
const PASTE_OFFSET = 2; // m
const MIN_SIZE = 0.3; // m
const ZOOMS = [1, 1.5, 2, 3, 4];
const BASE_HINT = "これは「全体の配置」の部品です。動かすときは、下の「全体の配置」の図を開いてください";

const $ = (id) => document.getElementById(id);
const board = $("board");
const wrap = $("board-wrap");

const state = {
  doc: loadDoc(),
  figure: 0, // which figure is shown
  tool: "select", // "select" or the key of a part or mark being placed
  selection: [], // ids of chosen items in the shown figure
  drag: null,
  clipboard: null, // { items, figure }
  zoom: 1,
};
const settings = { snap: true, arrange: { layout: "row", count: 5, gap: 3 }, ...loadJson(SETTINGS_KEY, {}) };
const history = new History(state, {
  take: () => JSON.stringify(state.doc),
  apply: (step) => {
    state.doc = JSON.parse(step);
    afterDocChange();
  },
});
const menus = createMenus($("more-menu"), $("save-menu"));

function loadDoc() {
  const saved = loadJson(DOC_KEY, null);
  if (saved?.version !== 1 || !Array.isArray(saved.figures) || !saved.figures.length) return newDoc();
  return { ...newDoc(), ...saved };
}

/* ---------- the document ---------- */

const figure = () => state.doc.figures[state.figure];
const items = () => figure().items;
const findItem = (id) => items().find((item) => item.id === id);
const selectedItems = () => state.selection.map(findItem).filter(Boolean);
const newId = () => Math.random().toString(36).slice(2, 10);
const snap = (value, step = SNAP_STEP) => (settings.snap ? Math.round(value / step) * step : Math.round(value * 100) / 100);

function persist() {
  saveJson(DOC_KEY, state.doc);
}

// Call after every finished change: one undo step, saved, everything drawn again.
function commit() {
  history.record();
  persist();
  renderAll();
}

// After undo, redo or opening a file the chosen items or the figure may be gone.
function afterDocChange() {
  state.figure = Math.min(state.figure, state.doc.figures.length - 1);
  state.selection = state.selection.filter((id) => findItem(id));
  persist();
  renderAll();
}

function moveItem(item, dx, dy) {
  if (item.type === "line") {
    for (const key of ["x1", "x2", "cx"]) item[key] += dx;
    for (const key of ["y1", "y2", "cy"]) item[key] += dy;
    return;
  }
  item.x += dx;
  item.y += dy;
}

function copyOf(item, dx = 0, dy = 0) {
  const copy = structuredClone(item);
  copy.id = newId();
  moveItem(copy, dx, dy);
  return copy;
}

function nextNumber() {
  const numbers = items().filter((item) => item.type === "number").map((item) => Number(item.n) || 0);
  return numbers.length ? Math.max(...numbers) + 1 : 1;
}

/* ---------- new items ---------- */

function newPart(type, point) {
  const part = PARTS[type];
  return { id: newId(), type, x: point.x, y: point.y, rot: 0, w: part.w, h: part.h, color: part.color, label: "" };
}

function newMark(type, point) {
  if (type === "text") return { id: newId(), type, x: point.x, y: point.y, rot: 0, text: "文字", size: TEXT_SIZES.normal, color: "#333333" };
  return { id: newId(), type: "number", x: point.x, y: point.y, w: NUMBER_SIZE, h: NUMBER_SIZE, n: nextNumber(), color: "#333333" };
}

function newLine(kind, point) {
  return { id: newId(), type: "line", kind, x1: point.x, y1: point.y, x2: point.x, y2: point.y, cx: point.x, cy: point.y, label: "", ...LINE_DEFAULTS[kind] };
}

// Puts the middle of a line halfway between its ends, or off to one side for a curved arrow.
function setBend(line, curved) {
  const midX = (line.x1 + line.x2) / 2;
  const midY = (line.y1 + line.y2) / 2;
  const bend = curved ? CURVE_BEND : 0;
  line.cx = midX + (line.y1 - line.y2) * bend;
  line.cy = midY + (line.x2 - line.x1) * bend;
}

function place(type, point) {
  const spot = { x: snap(point.x), y: snap(point.y) };
  const item = PARTS[type] ? newPart(type, spot) : newMark(type, spot);
  items().push(item);
  state.selection = [item.id];
  commit();
  if (type !== "text") return;
  // One text at a time: go back to choosing, and type the words on the right. Waits until the
  // press is over, or the press would take the focus away again.
  setTool("select");
  setTimeout(() => $("text-input")?.select(), 0);
}

/* ---------- drawing the board ---------- */

function boardScale() {
  const { width, height } = state.doc;
  const room = { width: wrap.clientWidth - 28, height: wrap.clientHeight - 16 };
  return Math.max(1, Math.min(room.width / width, room.height / height)) * state.zoom;
}

const pxToMeters = (px) => px / boardScale();

function handle(name, x, y, shape = "circle") {
  const r = pxToMeters(HANDLE_PX);
  const look = `class="handle" data-handle="${name}" fill="#fff" stroke="#3565c9" stroke-width="${pxToMeters(1.6)}"`;
  if (shape === "square") return `<rect ${look} x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}"/>`;
  return `<circle ${look} cx="${x}" cy="${y}" r="${r}"/>`;
}

function lineOverlay(item, single) {
  const dashed = `stroke="#3565c9" stroke-width="${pxToMeters(1.5)}" stroke-dasharray="${pxToMeters(4)} ${pxToMeters(3)}" fill="none"`;
  const guide = `<path d="M${item.x1} ${item.y1}L${item.cx} ${item.cy}L${item.x2} ${item.y2}" ${dashed} pointer-events="none" opacity=".5"/>`;
  if (!single) return `<path d="M${item.x1} ${item.y1}Q${item.cx} ${item.cy} ${item.x2} ${item.y2}" ${dashed} pointer-events="none"/>`;
  let markup = handle("p1", item.x1, item.y1) + handle("p2", item.x2, item.y2);
  if (item.kind !== "measure") markup = guide + markup + handle("bend", item.cx, item.cy, "square");
  return markup;
}

function boxOverlay(item, single) {
  const pad = pxToMeters(4);
  const { hw, hh } = halfSize(item);
  const dashed = `stroke="#3565c9" stroke-width="${pxToMeters(1.5)}" stroke-dasharray="${pxToMeters(4)} ${pxToMeters(3)}" fill="none" pointer-events="none"`;
  let markup = `<rect x="${-hw - pad}" y="${-hh - pad}" width="${(hw + pad) * 2}" height="${(hh + pad) * 2}" ${dashed}/>`;
  if (single) {
    markup += handle("resize", hw + pad, hh + pad, "square");
    if (item.type !== "number") {
      const top = -hh - pad - pxToMeters(ROTATE_GAP_PX);
      markup += `<path d="M0 ${-hh - pad}V${top}" stroke="#3565c9" stroke-width="${pxToMeters(1.5)}" pointer-events="none"/>` + handle("rotate", 0, top);
    }
  }
  return `<g transform="translate(${item.x} ${item.y}) rotate(${item.rot ?? 0})">${markup}</g>`;
}

function overlayMarkup() {
  const chosen = selectedItems();
  const single = chosen.length === 1;
  let markup = chosen.map((item) => (item.type === "line" ? lineOverlay(item, single) : boxOverlay(item, single))).join("");
  const band = state.drag?.kind === "band" ? state.drag : null;
  if (band) {
    const x = Math.min(band.start.x, band.end.x);
    const y = Math.min(band.start.y, band.end.y);
    markup += `<rect x="${x}" y="${y}" width="${Math.abs(band.end.x - band.start.x)}" height="${Math.abs(band.end.y - band.start.y)}" fill="rgba(53,101,201,.1)" stroke="#3565c9" stroke-width="${pxToMeters(1)}"/>`;
  }
  return `<g class="overlay">${markup}</g>`;
}

function render() {
  const { width, height } = state.doc;
  const scale = boardScale();
  board.setAttribute("viewBox", `0 0 ${width} ${height}`);
  board.style.width = `${Math.round(width * scale)}px`;
  board.style.height = `${Math.round(height * scale)}px`;
  board.classList.toggle("placing", state.tool !== "select");
  board.innerHTML = DEFS + figureMarkup(state.doc, state.figure, { editor: true, grid: settings.snap }) + overlayMarkup();
}

function renderTabs() {
  const tabs = state.doc.figures.map((one, index) => {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(index === state.figure));
    tab.textContent = one.name;
    tab.addEventListener("click", () => showFigure(index));
    return tab;
  });
  $("tabs").replaceChildren(...tabs);
}

function syncToolbar() {
  $("undo-btn").disabled = !history.canUndo;
  $("redo-btn").disabled = !history.canRedo;
  $("snap-btn").setAttribute("aria-pressed", String(settings.snap));
  $("bw-btn").setAttribute("aria-pressed", String(state.doc.bw));
  $("zoom-text").textContent = `${Math.round(state.zoom * 100)}%`;
  for (const tile of document.querySelectorAll("[data-tool]")) tile.setAttribute("aria-pressed", String(tile.dataset.tool === state.tool));
}

function renderAll() {
  render();
  renderTabs();
  renderPanel($("panel"), api);
  syncToolbar();
}

/* ---------- the parts column ---------- */

// A small picture of each part, drawn the same way as on the yard.
function tileIcon(type) {
  const sample = { x: 0, y: 0, rot: 0 };
  let item;
  if (PARTS[type]) item = { ...newPart(type, sample), w: PARTS[type].w, h: PARTS[type].h };
  else if (MARKS[type].line) item = { ...newLine(MARKS[type].line, sample), x1: -1.7, y1: 1.2, x2: 1.7, y2: -1.2, label: " " };
  else item = { ...newMark(type, sample), n: 1, text: "文", size: 3 };
  if (item.type === "line") {
    setBend(item, MARKS[type].curved);
    if (item.color === "#ffffff") item.color = "#868e96";
  }
  const { hw, hh } = item.type === "line" ? { hw: 2, hh: 1.6 } : turnedHalfSize(item);
  const half = Math.max(hw, hh * 1.1) * 1.12;
  return `<svg viewBox="${-half} ${-half} ${half * 2} ${half * 2}" aria-hidden="true">${drawItem(item, null, false)}</svg>`;
}

function buildPalette() {
  const groups = new Map();
  for (const [type, part] of [...Object.entries(PARTS), ...Object.entries(MARKS)]) {
    if (!groups.has(part.group)) groups.set(part.group, []);
    groups.get(part.group).push([type, part]);
  }
  const sections = [];
  for (const [name, parts] of groups) {
    const heading = document.createElement("h3");
    heading.textContent = name;
    const grid = document.createElement("div");
    grid.className = "parts";
    for (const [type, part] of parts) {
      const tile = document.createElement("button");
      tile.className = "tile";
      tile.dataset.tool = type;
      tile.title = `${part.name}を置く`;
      tile.innerHTML = `${tileIcon(type)}<span>${part.name}</span>`;
      grid.append(tile);
    }
    sections.push(heading, grid);
  }
  $("palette").replaceChildren(...sections);
}

function setTool(tool) {
  state.tool = tool;
  syncToolbar();
  render();
}

// A tile can be clicked (then click on the yard), or dragged onto the yard.
function onTileDown(e) {
  const tile = e.target.closest("[data-tool]");
  if (!tile) return;
  e.preventDefault();
  tile.setPointerCapture(e.pointerId);
  const start = { x: e.clientX, y: e.clientY };
  const wasOn = state.tool === tile.dataset.tool;
  const up = (end) => {
    tile.removeEventListener("pointerup", up);
    const moved = Math.hypot(end.clientX - start.x, end.clientY - start.y) > DRAG_START_PX;
    const type = tile.dataset.tool;
    if (!moved) return setTool(wasOn && type !== "select" ? "select" : type);
    const over = document.elementFromPoint(end.clientX, end.clientY)?.closest("#board");
    if (over && type !== "select" && !MARKS[type]?.line) {
      setTool(type);
      place(type, toMeters(end));
    }
  };
  tile.addEventListener("pointerup", up);
}

/* ---------- pressing and dragging on the yard ---------- */

function toMeters(e) {
  const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(board.getScreenCTM().inverse());
  return { x: point.x, y: point.y };
}

function onBoardDown(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  menus.close();
  const point = toMeters(e);
  const handleEl = e.target.closest("[data-handle]");
  const own = e.target.closest("[data-id]");
  board.setPointerCapture(e.pointerId);
  if (handleEl) return startHandle(handleEl.dataset.handle, point);
  if (own) return startMove(own.dataset.id, point, e);
  if (e.target.closest("[data-base]")) showStatus(BASE_HINT);
  if (MARKS[state.tool]?.line) return startLine(point);
  if (state.tool !== "select") return place(state.tool, point);
  if (e.pointerType === "touch" && state.zoom > 1) return startPan(e);
  startBand(point, e.shiftKey);
}

function startMove(id, point, e) {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (additive) {
    state.selection = state.selection.includes(id) ? state.selection.filter((one) => one !== id) : [...state.selection, id];
    renderAll();
    return;
  }
  if (!state.selection.includes(id)) state.selection = [id];
  const before = new Map(selectedItems().map((item) => [item.id, structuredClone(item)]));
  state.drag = { kind: "move", start: point, client: { x: e.clientX, y: e.clientY }, before, lead: id, moved: false };
  renderAll();
}

function dragMove(drag, point, e) {
  if (!drag.moved && Math.hypot(e.clientX - drag.client.x, e.clientY - drag.client.y) < DRAG_START_PX) return;
  drag.moved = true;
  const lead = drag.before.get(drag.lead);
  const leadX = lead.type === "line" ? lead.x1 : lead.x;
  const leadY = lead.type === "line" ? lead.y1 : lead.y;
  const dx = snap(leadX + point.x - drag.start.x) - leadX;
  const dy = snap(leadY + point.y - drag.start.y) - leadY;
  for (const item of selectedItems()) {
    const original = drag.before.get(item.id);
    Object.assign(item, structuredClone(original));
    moveItem(item, dx, dy);
  }
}

function startHandle(name, point) {
  const [item] = selectedItems();
  state.drag = { kind: name, item, before: structuredClone(item), straight: item.type === "line" && isStraight(item), moved: false, start: point };
}

// Where `point` is in the item's own turned frame, measured from its middle.
function localPoint(item, point) {
  const angle = (-(item.rot ?? 0) * Math.PI) / 180;
  const dx = point.x - item.x;
  const dy = point.y - item.y;
  return { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
}

function dragResize(drag, point) {
  const { item, before } = drag;
  const local = localPoint(item, point);
  const { hw, hh } = halfSize(before);
  const grow = Math.max(Math.abs(local.x) / hw, Math.abs(local.y) / hh);
  if (item.type === "text") {
    item.size = Math.max(0.6, Math.round(before.size * grow * 10) / 10);
  } else if (PARTS[item.type]?.stretch) {
    item.w = Math.max(MIN_SIZE, snap(Math.abs(local.x) * 2, SIZE_SNAP));
    item.h = Math.max(MIN_SIZE, snap(Math.abs(local.y) * 2, SIZE_SNAP));
  } else {
    item.w = Math.max(MIN_SIZE, before.w * grow);
    item.h = Math.max(MIN_SIZE, before.h * grow);
  }
}

function dragRotate(drag, point, e) {
  const { item } = drag;
  let angle = (Math.atan2(point.y - item.y, point.x - item.x) * 180) / Math.PI + 90;
  if (!e.altKey) angle = Math.round(angle / ANGLE_STEP) * ANGLE_STEP;
  item.rot = ((angle % 360) + 360) % 360;
}

function dragLinePoint(drag, point) {
  const { item } = drag;
  const spot = { x: snap(point.x), y: snap(point.y) };
  if (drag.kind === "bend") {
    [item.cx, item.cy] = [point.x, point.y];
    return;
  }
  const end = drag.kind === "p1" ? ["x1", "y1"] : ["x2", "y2"];
  [item[end[0]], item[end[1]]] = [spot.x, spot.y];
  if (drag.straight || item.kind === "measure") setBend(item, false);
}

function startLine(point) {
  const spot = { x: snap(point.x), y: snap(point.y) };
  const line = newLine(MARKS[state.tool].line, spot);
  items().push(line);
  state.selection = [line.id];
  state.drag = { kind: "create", item: line, curved: Boolean(MARKS[state.tool].curved) };
  render();
}

function dragCreate(drag, point) {
  const { item } = drag;
  item.x2 = snap(point.x);
  item.y2 = snap(point.y);
  setBend(item, drag.curved);
}

function finishCreate(drag) {
  const { item } = drag;
  if (Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < SHORT_LINE) {
    item.x2 = item.x1 + DEFAULT_LINE;
    item.y2 = item.y1;
    setBend(item, drag.curved);
  }
  commit();
}

function startBand(point, additive) {
  const keep = additive ? state.selection.slice() : [];
  state.drag = { kind: "band", start: point, end: point, keep };
  if (!additive && state.selection.length) {
    state.selection = [];
    renderAll();
  }
}

function itemCenter(item) {
  if (item.type === "line") return { x: (item.x1 + item.x2) / 2, y: (item.y1 + item.y2) / 2 };
  return { x: item.x, y: item.y };
}

function finishBand(drag) {
  const left = Math.min(drag.start.x, drag.end.x);
  const right = Math.max(drag.start.x, drag.end.x);
  const top = Math.min(drag.start.y, drag.end.y);
  const bottom = Math.max(drag.start.y, drag.end.y);
  const inside = items().filter((item) => {
    const { x, y } = itemCenter(item);
    return x >= left && x <= right && y >= top && y <= bottom;
  });
  state.selection = [...new Set([...drag.keep, ...inside.map((item) => item.id)])];
  renderAll();
}

function startPan(e) {
  state.drag = { kind: "pan", client: { x: e.clientX, y: e.clientY }, scroll: { x: wrap.scrollLeft, y: wrap.scrollTop } };
}

const DRAGS = {
  move: dragMove,
  resize: dragResize,
  rotate: dragRotate,
  p1: dragLinePoint,
  p2: dragLinePoint,
  bend: dragLinePoint,
  create: dragCreate,
  band: (drag, point) => (drag.end = point),
  pan: (drag, point, e) => {
    wrap.scrollLeft = drag.scroll.x - (e.clientX - drag.client.x);
    wrap.scrollTop = drag.scroll.y - (e.clientY - drag.client.y);
  },
};

function onBoardMove(e) {
  const { drag } = state;
  if (!drag) return;
  DRAGS[drag.kind](drag, toMeters(e), e);
  if (drag.kind !== "move" || drag.moved) drag.moved = true;
  if (drag.kind !== "pan") render();
}

function onBoardUp() {
  const { drag } = state;
  if (!drag) return;
  state.drag = null;
  if (drag.kind === "create") return finishCreate(drag);
  if (drag.kind === "band") return finishBand(drag);
  if (drag.kind === "pan") return;
  if (drag.moved) commit();
}

/* ---------- changing the chosen items ---------- */

function editSelected(change) {
  for (const item of selectedItems()) change(item);
}

function duplicate() {
  const copies = selectedItems().map((item) => copyOf(item, PASTE_OFFSET, PASTE_OFFSET));
  items().push(...copies);
  state.selection = copies.map((item) => item.id);
  commit();
}

function remove() {
  if (!state.selection.length) return;
  figure().items = items().filter((item) => !state.selection.includes(item.id));
  state.selection = [];
  commit();
}

function copy() {
  const chosen = selectedItems();
  if (!chosen.length) return;
  state.clipboard = { items: structuredClone(chosen), figure: state.figure };
  showStatus(`${chosen.length}こ コピーしました。ほかの図を開いて「貼り付け」（Ctrl+V）で置けます`);
  renderPanel($("panel"), api);
}

function paste() {
  const { clipboard } = state;
  if (!clipboard) return;
  const offset = clipboard.figure === state.figure ? PASTE_OFFSET : 0;
  const copies = clipboard.items.map((item) => copyOf(item, offset, offset));
  if (offset) clipboard.items = structuredClone(copies);
  items().push(...copies);
  state.selection = copies.map((item) => item.id);
  commit();
}

function restack(toFront) {
  const chosen = items().filter((item) => state.selection.includes(item.id));
  const others = items().filter((item) => !state.selection.includes(item.id));
  figure().items = toFront ? [...others, ...chosen] : [...chosen, ...others];
  commit();
}

function rotateBy(degrees) {
  editSelected((item) => (item.rot = ((((item.rot ?? 0) + degrees) % 360) + 360) % 360));
  commit();
}

function straighten() {
  editSelected((item) => item.type === "line" && setBend(item, false));
  commit();
}

function nudge(dx, dy) {
  editSelected((item) => moveItem(item, dx, dy));
  commit();
}

/* ---------- まとめて置く ---------- */

// Where `count` copies go, the first one where the item already is.
function arrangedSpots(origin, { layout, count, gap }) {
  const spots = [];
  const columns = Math.ceil(Math.sqrt(count));
  const radius = (count * gap) / (Math.PI * 2);
  for (let i = 0; i < count; i++) {
    if (layout === "row") spots.push({ x: origin.x + i * gap, y: origin.y });
    if (layout === "column") spots.push({ x: origin.x, y: origin.y + i * gap });
    if (layout === "grid") spots.push({ x: origin.x + (i % columns) * gap, y: origin.y + Math.floor(i / columns) * gap });
    if (layout === "circle") {
      const angle = -Math.PI / 2 + (i * Math.PI * 2) / count;
      spots.push({ x: origin.x + radius * Math.cos(angle), y: origin.y + radius + radius * Math.sin(angle) });
    }
  }
  return spots;
}

function arrange() {
  const [item] = selectedItems();
  if (!item || item.type === "line") return;
  const spots = arrangedSpots(item, settings.arrange);
  const copies = spots.slice(1).map((spot, i) => {
    const one = copyOf(item, spot.x - item.x, spot.y - item.y);
    if (one.type === "number") one.n = Number(item.n) + i + 1;
    return one;
  });
  const at = items().indexOf(item);
  items().splice(at + 1, 0, ...copies);
  state.selection = [item.id, ...copies.map((one) => one.id)];
  commit();
  showStatus(`${spots.length}こ並べました。まとめて引っぱって動かせます`);
}

function setArrange(change) {
  Object.assign(settings.arrange, change);
  saveJson(SETTINGS_KEY, settings);
  renderPanel($("panel"), api);
}

/* ---------- figures ---------- */

function showFigure(index) {
  state.figure = index;
  state.selection = [];
  renderAll();
}

function addFigure() {
  const number = state.doc.figures.length + 1;
  state.doc.figures.push({ id: newId(), name: `図${number}`, items: [], showBase: true });
  state.figure = state.doc.figures.length - 1;
  state.selection = [];
  commit();
  $("figure-name")?.select();
  showStatus("図を足しました。右で名前（種目）を付けてください");
}

function duplicateFigure() {
  const source = figure();
  const copy = { id: newId(), name: `${source.name}（コピー）`, items: source.items.map((item) => copyOf(item)), showBase: state.figure !== BASE_INDEX };
  state.doc.figures.splice(state.figure + 1, 0, copy);
  state.figure++;
  state.selection = [];
  commit();
}

function deleteFigure() {
  if (state.figure === BASE_INDEX) return;
  const { name } = figure();
  state.doc.figures.splice(state.figure, 1);
  state.figure--;
  state.selection = [];
  commit();
  showStatus(`「${name}」を消しました（「元に戻す」で戻せます）`);
}

function clearFigure() {
  menus.close();
  figure().items = [];
  state.selection = [];
  commit();
  showStatus("この図を空にしました（「元に戻す」で戻せます）");
}

function startOver() {
  menus.close();
  state.doc = newDoc();
  state.figure = 0;
  state.selection = [];
  commit();
  showStatus("はじめからにしました（「元に戻す」で戻せます）");
}

/* ---------- saving ---------- */

const figureFileName = (index, extension) => safeFileName(`${state.doc.figures[index].name || "校庭の配置図"}.${extension}`);

function deselectForSaving() {
  menus.close();
  setTool("select");
}

async function savePng() {
  deselectForSaving();
  try {
    download(await figurePng(state.doc, state.figure), figureFileName(state.figure, "png"));
  } catch (err) {
    console.error(err);
    showStatus("画像を作れませんでした", { error: true });
  }
}

async function copyFigure() {
  deselectForSaving();
  const copied = await copyImage(figurePng(state.doc, state.figure));
  if (copied) showStatus("図をコピーしました。説明書（Googleドキュメントやスライド）に Ctrl+V で貼り付けます");
  else showStatus("コピーできませんでした。「画像で保存」を使ってください", { error: true });
}

async function savePdf(all) {
  deselectForSaving();
  showStatus("PDFを作成中…", { sticky: true });
  try {
    const indices = all ? state.doc.figures.map((_, i) => i) : [state.figure];
    const bytes = await figuresPdf(state.doc, indices);
    const name = all ? safeFileName("校庭の配置図.pdf") : figureFileName(state.figure, "pdf");
    download(new Blob([bytes], { type: "application/pdf" }), name);
    showStatus("PDFを保存しました");
  } catch (err) {
    console.error(err);
    showStatus("PDFを作れませんでした", { error: true });
  }
}

function saveData() {
  menus.close();
  const data = JSON.stringify({ app: FILE_APP, version: 1, doc: state.doc }, null, 1);
  download(new Blob([data], { type: "application/json" }), `校庭の配置図_${dateText(new Date(), "-")}.json`);
}

async function openData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== FILE_APP || !Array.isArray(data.doc?.figures)) throw new Error("not a field-layout file");
    state.doc = { ...newDoc(), ...data.doc };
    state.figure = 0;
    state.selection = [];
    commit();
    showStatus(`${file.name} を開きました`);
  } catch (err) {
    console.error(err);
    showStatus("このファイルは開けません。「つづきを保存」で保存したファイルを選んでください", { error: true });
  }
}

/* ---------- zoom ---------- */

function zoomTo(zoom) {
  state.zoom = Math.min(ZOOMS.at(-1), Math.max(ZOOMS[0], zoom));
  render();
  syncToolbar();
}

function zoomStep(direction) {
  const next = direction > 0 ? ZOOMS.find((one) => one > state.zoom) : ZOOMS.findLast((one) => one < state.zoom);
  if (next) zoomTo(next);
}

/* ---------- keys ---------- */

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const CTRL_KEYS = {
  z: (e) => (e.shiftKey ? history.redo() : history.undo()),
  y: () => history.redo(),
  c: copy,
  v: paste,
  d: duplicate,
  a: () => {
    state.selection = items().map((item) => item.id);
    renderAll();
  },
};

function onKey(e) {
  if (e.target.closest("input, textarea, select")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && CTRL_KEYS[key]) {
    e.preventDefault();
    CTRL_KEYS[key](e);
    return;
  }
  if (e.key === "Escape") {
    if (state.tool !== "select") setTool("select");
    state.selection = [];
    renderAll();
  } else if ((e.key === "Delete" || e.key === "Backspace") && state.selection.length) {
    e.preventDefault();
    remove();
  } else if (ARROWS[e.key] && state.selection.length) {
    e.preventDefault();
    const step = e.shiftKey ? NUDGE_BIG : NUDGE;
    nudge(ARROWS[e.key][0] * step, ARROWS[e.key][1] * step);
  }
}

/* ---------- what panel.js may do ---------- */

const api = {
  get doc() {
    return state.doc;
  },
  get figureIndex() {
    return state.figure;
  },
  get canPaste() {
    return Boolean(state.clipboard);
  },
  settings,
  selectedItems,
  change(fn) {
    fn();
    commit();
  },
  edit(fn) {
    editSelected(fn);
    commit();
  },
  // While typing: draw at once, but record one undo step only when the box is left (record).
  live(fn) {
    fn();
    persist();
    render();
    renderTabs();
  },
  editLive(fn) {
    editSelected(fn);
    persist();
    render();
  },
  record() {
    history.record();
    syncToolbar();
  },
  rotateBy,
  straighten,
  duplicate,
  remove,
  copy,
  paste,
  toFront: () => restack(true),
  toBack: () => restack(false),
  arrange,
  setArrange,
  duplicateFigure,
  deleteFigure,
};

/* ---------- events ---------- */

buildPalette();
document.querySelector(".palette").addEventListener("pointerdown", onTileDown);
board.addEventListener("pointerdown", onBoardDown);
board.addEventListener("pointermove", onBoardMove);
board.addEventListener("pointerup", onBoardUp);
board.addEventListener("pointercancel", onBoardUp);
document.addEventListener("keydown", onKey);
wrap.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  zoomStep(-Math.sign(e.deltaY));
}, { passive: false });
new ResizeObserver(() => render()).observe(wrap);

$("undo-btn").addEventListener("click", () => history.undo());
$("redo-btn").addEventListener("click", () => history.redo());
$("snap-btn").addEventListener("click", () => {
  settings.snap = !settings.snap;
  saveJson(SETTINGS_KEY, settings);
  render();
  syncToolbar();
});
$("bw-btn").addEventListener("click", () => {
  state.doc.bw = !state.doc.bw;
  commit();
  showStatus(state.doc.bw ? "白黒印刷向けにしました。保存する図も白黒になります" : "色ありにもどしました");
});
$("more-btn").addEventListener("click", () => menus.toggle($("more-menu")));
$("save-btn").addEventListener("click", () => menus.toggle($("save-menu")));
$("save-png-btn").addEventListener("click", savePng);
$("copy-btn").addEventListener("click", copyFigure);
$("save-pdf-btn").addEventListener("click", () => savePdf(false));
$("save-all-btn").addEventListener("click", () => savePdf(true));
$("save-data-btn").addEventListener("click", saveData);
$("clear-figure-btn").addEventListener("click", clearFigure);
$("new-doc-btn").addEventListener("click", startOver);
$("open-input").addEventListener("change", (e) => {
  menus.close();
  openData(e.target.files[0]);
  e.target.value = "";
});
$("add-figure-btn").addEventListener("click", addFigure);
$("zoom-in").addEventListener("click", () => zoomStep(1));
$("zoom-out").addEventListener("click", () => zoomStep(-1));
$("zoom-fit").addEventListener("click", () => zoomTo(1));
onFileDrop((files) => openData(files[0]));
renderAll();

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "parts.js",
  "drawing.js",
  "panel.js",
  "save.js",
  "icon.svg",
  "manifest.webmanifest",
  ...OFFLINE.pdfLib,
]);

// Hook for automated tests.
window.__fieldLayout = { state, settings, history, place, arrange, setTool, figurePng: () => figurePng(state.doc, state.figure) };
