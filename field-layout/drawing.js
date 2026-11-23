// Draws one figure (the school yard and what is on it) as SVG markup. The editor shows the same
// markup that is saved as an image or PDF, so what you see is what you print.
// Everything is in meters: the SVG's viewBox is the yard, 0 0 width height.
import { PARTS, LINE_WIDTHS, LABEL_SIZE } from "./parts.js";

export const FIELDS = {
  track200: { name: "トラック（200m）", radius: 15, straight: 51.9 },
  track150: { name: "トラック（150m）", radius: 12, straight: 36.4 },
  rect: { name: "長方形の白線" },
  blank: { name: "白線なし" },
};

export const GROUNDS = {
  soil: { name: "土", color: "#efe1c1" },
  grass: { name: "芝", color: "#cfe3b0" },
  white: { name: "白", color: "#ffffff" },
};

export const NORTH_ANGLES = { 0: "上", 45: "右上", 90: "右", 135: "右下", 180: "下", 225: "左下", 270: "左", 315: "左上" };

const LANES = 4;
const LANE_WIDTH = 1.1; // m
const RECT_INSET = 6; // m from the edge of the yard to the white rectangle
const TRACK_LINE = 0.14; // m
const BW_LINE = "#8a9099"; // white lines become this gray in black-and-white mode
const TEXT_INK = "#333333";
const TITLE_SIZE = 3; // m
const FONT = "system-ui, 'Noto Sans JP', 'Noto Sans CJK JP', sans-serif";
const HIT_WIDTH = 1.6; // m, how close to a line a press still picks it

export const BASE_INDEX = 0; // figures[0] is 全体の配置, shown under every other figure

export function newDoc() {
  return {
    version: 1,
    field: "track200",
    width: 110,
    height: 70,
    ground: "soil",
    bw: false,
    showTitle: true,
    north: { show: true, angle: 0 },
    scaleBar: true,
    figures: [{ id: "base", name: "全体の配置", items: [], showBase: true }],
  };
}

const fmt = (n) => String(Math.round(n * 1000) / 1000);
const escapeText = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------- sizes ---------- */

// A rough width of a line of text: Japanese letters are square, others about half as wide.
function textWidth(line, size) {
  let ems = 0;
  for (const char of line) ems += char.codePointAt(0) < 0x2000 ? 0.6 : 1;
  return ems * size;
}

// Half the width and height of an item before it is turned.
export function halfSize(item) {
  if (item.type === "text") {
    const lines = item.text.split("\n");
    const widest = Math.max(...lines.map((line) => textWidth(line, item.size)), item.size);
    return { hw: widest / 2, hh: (lines.length * item.size * 1.25) / 2 };
  }
  return { hw: item.w / 2, hh: item.h / 2 };
}

// Half the width and height of the box around an item after it is turned.
export function turnedHalfSize(item) {
  const { hw, hh } = halfSize(item);
  const angle = ((item.rot ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  return { hw: hw * cos + hh * sin, hh: hw * sin + hh * cos };
}

export const isStraight = (line) => Math.hypot(line.cx - (line.x1 + line.x2) / 2, line.cy - (line.y1 + line.y2) / 2) < 0.05;

// The length of a line along its curve, in meters.
export function lineLength(line) {
  const STEPS = 24;
  let length = 0;
  let previous = { x: line.x1, y: line.y1 };
  for (let i = 1; i <= STEPS; i++) {
    const point = pointOnLine(line, i / STEPS);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return length;
}

export function pointOnLine(line, t) {
  const a = (1 - t) * (1 - t);
  const b = 2 * (1 - t) * t;
  const c = t * t;
  return { x: a * line.x1 + b * line.cx + c * line.x2, y: a * line.y1 + b * line.cy + c * line.y2 };
}

export function lengthText(meters) {
  if (meters < 10) return `${Math.round(meters * 10) / 10}m`;
  return `${Math.round(meters * 2) / 2}m`;
}

/* ---------- words ---------- */

function words(text, x, y, size, { color = TEXT_INK, anchor = "middle", weight = 600 } = {}) {
  const lines = String(text).split("\n");
  const lineHeight = size * 1.25;
  const firstY = y - ((lines.length - 1) * lineHeight) / 2;
  const spans = lines.map((line, i) => `<tspan x="${fmt(x)}" y="${fmt(firstY + i * lineHeight)}">${escapeText(line)}</tspan>`).join("");
  const halo = `stroke="#fff" stroke-width="${fmt(size * 0.26)}" stroke-linejoin="round" paint-order="stroke"`;
  return `<text font-size="${fmt(size)}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" dominant-baseline="central" ${halo}>${spans}</text>`;
}

// Names go on the item when they fit on it, else under it.
function itemLabel(item) {
  if (!item.label) return "";
  const part = PARTS[item.type];
  const fits = Math.max(...item.label.split("\n").map((line) => textWidth(line, LABEL_SIZE))) <= item.w * 0.95;
  if (part?.labelAt === "center" && fits) return words(item.label, item.x, item.y, LABEL_SIZE);
  const { hh } = turnedHalfSize(item);
  return words(item.label, item.x, item.y + hh + LABEL_SIZE * 0.85, LABEL_SIZE);
}

/* ---------- items ---------- */

function idAttr(item, mode) {
  if (mode === "own") return ` data-id="${item.id}"`;
  if (mode === "base") return ` data-base="${item.id}"`;
  return "";
}

// In black and white, white parts without an outline would vanish on the white ground.
const BW_WHITE = "#adb5bd";

function drawPart(item, mode, bw) {
  const part = PARTS[item.type];
  const look = bw && item.color === "#ffffff" && !part.outlined ? { ...item, color: BW_WHITE } : item;
  const hit = mode ? `<rect x="${fmt(-item.w / 2)}" y="${fmt(-item.h / 2)}" width="${fmt(item.w)}" height="${fmt(item.h)}" fill="transparent"/>` : "";
  const place = `translate(${fmt(item.x)} ${fmt(item.y)}) rotate(${fmt(item.rot ?? 0)})`;
  return `<g${idAttr(item, mode)} transform="${place}">${hit}${part.draw(look)}</g>${itemLabel(item)}`;
}

function drawText(item, mode) {
  const place = `translate(${fmt(item.x)} ${fmt(item.y)}) rotate(${fmt(item.rot ?? 0)})`;
  const { hw, hh } = halfSize(item);
  const hit = mode ? `<rect x="${fmt(-hw)}" y="${fmt(-hh)}" width="${fmt(hw * 2)}" height="${fmt(hh * 2)}" fill="transparent"/>` : "";
  return `<g${idAttr(item, mode)} transform="${place}">${hit}${words(item.text, 0, 0, item.size, { color: item.color, weight: 700 })}</g>`;
}

const DARK_ON = new Set(["#ffffff", "#f5b800"]); // light colors get dark digits
function drawNumber(item, mode) {
  const r = item.w / 2;
  const digits = DARK_ON.has(item.color) ? TEXT_INK : "#ffffff";
  const circle = `<circle r="${fmt(r)}" fill="${item.color}" stroke="rgba(0,0,0,.35)" stroke-width="${fmt(r * 0.06)}"/>`;
  const text = `<text font-size="${fmt(r * 1.25)}" font-weight="700" fill="${digits}" text-anchor="middle" dominant-baseline="central">${escapeText(item.n)}</text>`;
  return `<g${idAttr(item, mode)} transform="translate(${fmt(item.x)} ${fmt(item.y)})">${circle}${text}</g>`;
}

/* ---------- lines ---------- */

function unit(x, y) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

// An arrowhead with its tip on (x, y), pointing along `dir`. Returns the head and where the
// line should stop so its square end does not poke out of the head.
function arrowHead(x, y, dir, width, color) {
  const length = Math.max(1.8, width * 4.5);
  const half = length * 0.45;
  const baseX = x - dir.x * length;
  const baseY = y - dir.y * length;
  const points = [[x, y], [baseX - dir.y * half, baseY + dir.x * half], [baseX + dir.y * half, baseY - dir.x * half]];
  const head = `<polygon points="${points.map(([px, py]) => `${fmt(px)},${fmt(py)}`).join(" ")}" fill="${color}"/>`;
  return { head, stopX: x - dir.x * length * 0.7, stopY: y - dir.y * length * 0.7 };
}

function lineColor(item, bw) {
  if (bw && item.color === "#ffffff") return BW_LINE;
  return item.color;
}

function drawMeasure(item, color, width) {
  const dir = unit(item.x2 - item.x1, item.y2 - item.y1);
  const across = { x: -dir.y * 0.8, y: dir.x * 0.8 };
  const tick = (x, y) => `M${fmt(x - across.x)} ${fmt(y - across.y)}L${fmt(x + across.x)} ${fmt(y + across.y)}`;
  const path = `M${fmt(item.x1)} ${fmt(item.y1)}L${fmt(item.x2)} ${fmt(item.y2)}${tick(item.x1, item.y1)}${tick(item.x2, item.y2)}`;
  const up = across.y > 0 ? -1 : 1; // put the words on the upper side of the line
  const words0 = item.label || lengthText(Math.hypot(item.x2 - item.x1, item.y2 - item.y1));
  const midX = (item.x1 + item.x2) / 2 + across.x * up * 1.6;
  const midY = (item.y1 + item.y2) / 2 + across.y * up * 1.6;
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${fmt(width)}"/>${words(words0, midX, midY, LABEL_SIZE * 0.9)}`;
}

function drawCurve(item, color, width) {
  let { x1, y1, x2, y2 } = item;
  let heads = "";
  const fromEnd = unit(x2 - item.cx, y2 - item.cy);
  const fromStart = unit(x1 - item.cx, y1 - item.cy);
  if (item.head === "end" || item.head === "both") {
    const end = arrowHead(x2, y2, fromEnd, width, color);
    [heads, x2, y2] = [heads + end.head, end.stopX, end.stopY];
  }
  if (item.head === "both") {
    const start = arrowHead(x1, y1, fromStart, width, color);
    [heads, x1, y1] = [heads + start.head, start.stopX, start.stopY];
  }
  const dash = item.dash ? ` stroke-dasharray="${fmt(width * 3)} ${fmt(width * 2)}"` : "";
  const path = `<path d="M${fmt(x1)} ${fmt(y1)}Q${fmt(item.cx)} ${fmt(item.cy)} ${fmt(x2)} ${fmt(y2)}" fill="none" stroke="${color}" stroke-width="${fmt(width)}"${dash}/>`;
  if (!item.label) return path + heads;
  const middle = pointOnLine(item, 0.5);
  return path + heads + words(item.label, middle.x, middle.y - LABEL_SIZE * 1.1, LABEL_SIZE);
}

function drawLine(item, mode, bw) {
  const color = lineColor(item, bw);
  const width = LINE_WIDTHS[item.width];
  const body = item.kind === "measure" ? drawMeasure(item, color, width) : drawCurve(item, color, width);
  const d = `M${fmt(item.x1)} ${fmt(item.y1)}Q${fmt(item.cx)} ${fmt(item.cy)} ${fmt(item.x2)} ${fmt(item.y2)}`;
  const hit = mode ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="${fmt(Math.max(HIT_WIDTH, width * 3))}"/>` : "";
  return `<g${idAttr(item, mode)}>${hit}${body}</g>`;
}

export function drawItem(item, mode, bw) {
  if (item.type === "line") return drawLine(item, mode, bw);
  if (item.type === "text") return drawText(item, mode);
  if (item.type === "number") return drawNumber(item, mode);
  return drawPart(item, mode, bw);
}

/* ---------- the yard ---------- */

function drawTrack(doc, field, ink) {
  const cx = doc.width / 2;
  const cy = doc.height / 2;
  const lanes = [];
  for (let lane = 0; lane <= LANES; lane++) {
    const r = field.radius + lane * LANE_WIDTH;
    const edge = lane === 0 || lane === LANES;
    const width = edge ? TRACK_LINE * 1.6 : TRACK_LINE;
    lanes.push(`<rect x="${fmt(cx - field.straight / 2 - r)}" y="${fmt(cy - r)}" width="${fmt(field.straight + r * 2)}" height="${fmt(r * 2)}" rx="${fmt(r)}" fill="none" stroke="${ink}" stroke-width="${fmt(width)}"/>`);
  }
  return lanes.join("");
}

function drawField(doc, bw) {
  const ground = bw ? GROUNDS.white.color : GROUNDS[doc.ground].color;
  const ink = bw ? BW_LINE : "#ffffff";
  const field = FIELDS[doc.field];
  let markup = `<rect width="${fmt(doc.width)}" height="${fmt(doc.height)}" fill="${ground}" stroke="#8a8f98" stroke-width="0.25"/>`;
  if (field.radius) markup += drawTrack(doc, field, ink);
  if (doc.field === "rect") {
    markup += `<rect x="${RECT_INSET}" y="${RECT_INSET}" width="${fmt(doc.width - RECT_INSET * 2)}" height="${fmt(doc.height - RECT_INSET * 2)}" fill="none" stroke="${ink}" stroke-width="${TRACK_LINE * 1.6}"/>`;
  }
  return markup;
}

// Faint lines every 5 m while "ます目にそろえる" is on. Only in the editor, never printed.
export function drawGrid(doc) {
  const STEP = 5;
  const lines = [];
  for (let x = STEP; x < doc.width; x += STEP) lines.push(`<path d="M${x} 0V${fmt(doc.height)}" stroke-opacity="${x % 10 ? 0.07 : 0.14}"/>`);
  for (let y = STEP; y < doc.height; y += STEP) lines.push(`<path d="M0 ${y}H${fmt(doc.width)}" stroke-opacity="${y % 10 ? 0.07 : 0.14}"/>`);
  return `<g stroke="#000" stroke-width="0.08" pointer-events="none">${lines.join("")}</g>`;
}

function drawNorth(doc) {
  const cx = doc.width - 5;
  const cy = 8;
  const angle = (doc.north.angle * Math.PI) / 180;
  const arrow = `<polygon points="0,-3 2,2.2 0,1 -2,2.2" fill="${TEXT_INK}" transform="translate(${fmt(cx)} ${fmt(cy)}) rotate(${doc.north.angle})"/>`;
  const labelX = cx + Math.sin(angle) * 4.6;
  const labelY = cy - Math.cos(angle) * 4.6;
  return arrow + words("北", labelX, labelY, 1.9);
}

function drawScaleBar(doc) {
  const length = doc.width > 160 ? 20 : 10;
  const x = doc.width - 3 - length;
  const y = doc.height - 2.5;
  const path = `M${fmt(x)} ${fmt(y)}H${fmt(x + length)}M${fmt(x)} ${fmt(y - 0.8)}V${fmt(y + 0.8)}M${fmt(x + length)} ${fmt(y - 0.8)}V${fmt(y + 0.8)}M${fmt(x + length / 2)} ${fmt(y - 0.5)}V${fmt(y + 0.5)}`;
  return `<path d="${path}" fill="none" stroke="${TEXT_INK}" stroke-width="0.3"/>${words(`${length}m`, x + length / 2, y - 1.6, 1.6)}`;
}

/* ---------- a whole figure ---------- */

// `editor` marks items so they can be picked, and `grid` adds the 5 m lines; without them the
// figure is drawn for printing.
export function figureMarkup(doc, index, { editor = false, grid = false } = {}) {
  const figure = doc.figures[index];
  const underneath = index !== BASE_INDEX && figure.showBase ? doc.figures[BASE_INDEX].items : [];
  const baseMode = editor ? "base" : null;
  const ownMode = editor ? "own" : null;
  const items = underneath.map((item) => drawItem(item, baseMode, doc.bw)).join("") +
    figure.items.map((item) => drawItem(item, ownMode, doc.bw)).join("");
  const filter = doc.bw ? ' filter="url(#bw)"' : "";
  let markup = drawField(doc, doc.bw);
  if (grid) markup += drawGrid(doc);
  markup += `<g font-family="${FONT}"${filter}>${items}</g>`;
  markup += `<g font-family="${FONT}" pointer-events="none">`;
  if (doc.north.show) markup += drawNorth(doc);
  if (doc.scaleBar) markup += drawScaleBar(doc);
  if (doc.showTitle) markup += words(figure.name, 1.6, 1.6 + TITLE_SIZE * 0.6, TITLE_SIZE, { anchor: "start", weight: 700 });
  return `${markup}</g>`;
}

export const DEFS = '<defs><filter id="bw"><feColorMatrix type="saturate" values="0"/></filter></defs>';

// The figure as a standalone SVG file, `pixels` wide.
export function figureSvg(doc, index, pixels) {
  const height = Math.round((pixels * doc.height) / doc.width);
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${height}" viewBox="0 0 ${fmt(doc.width)} ${fmt(doc.height)}">`;
  return `${open}${DEFS}${figureMarkup(doc, index)}</svg>`;
}

