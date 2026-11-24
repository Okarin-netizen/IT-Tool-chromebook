// Draws one figure (the school yard and what is on it) as SVG markup. The editor shows the same
// markup that is saved as an image or PDF, so what you see is what you print.
// Everything is in meters: the SVG's viewBox is the yard, 0 0 width height.
import { PARTS, LINE_WIDTHS, LABEL_SIZE } from "./parts.js";

// Where the figure is: the school yard (校庭) or the gym (体育館). Each starts with its own lines,
// size and ground; parts are offered by place (parts.js).
export const PLACES = {
  yard: { name: "校庭", field: "track200", width: 110, height: 70, ground: "soil" },
  gym: { name: "体育館", field: "gymBasket", width: 30, height: 40, ground: "wood" },
};
export const placeName = (doc) => `${PLACES[doc.place].name}の配置図`;

// Lines and words are drawn this many times as large as on the yard. A gym is about a third of a
// yard across, so the same letters would cover it.
export const inkScale = (doc) => (doc.place === "gym" ? 0.5 : 1);

export const FIELDS = {
  track200: { name: "トラック（200m）", place: "yard", radius: 15, straight: 51.9 },
  track150: { name: "トラック（150m）", place: "yard", radius: 12, straight: 36.4 },
  rect: { name: "長方形の白線", place: "yard" },
  blank: { name: "白線なし", place: "yard" },
  gymAll: { name: "コートの線を全部", place: "gym", courts: ["basket", "volley", "badminton"] },
  gymBasket: { name: "バスケットボール", place: "gym", courts: ["basket"] },
  gymVolley: { name: "バレーボール", place: "gym", courts: ["volley"] },
  gymBadminton: { name: "バドミントン", place: "gym", courts: ["badminton"] },
  gymBlank: { name: "線なし", place: "gym", courts: [] },
};

export const GROUNDS = {
  soil: { name: "土", place: "yard", color: "#efe1c1" },
  grass: { name: "芝", place: "yard", color: "#cfe3b0" },
  wood: { name: "木", place: "gym", color: "#efdbb2" },
  white: { name: "白", color: "#ffffff" },
};

export const STAGES = { top: "上", bottom: "下", left: "左", right: "右", none: "なし" };

export const NORTH_ANGLES = { 0: "上", 45: "右上", 90: "右", 135: "右下", 180: "下", 225: "左下", 270: "左", 315: "左上" };

const LANES = 4;
const LANE_WIDTH = 1.1; // m
const RECT_INSET = 6; // m from the edge of the yard to the white rectangle
const TRACK_LINE = 0.14; // m
const BW_LINE = "#8a9099"; // white lines become this gray in black-and-white mode
const TEXT_INK = "#333333";
const TITLE_SIZE = 3; // m
// Japanese fonts first, and lang="ja" on the SVG: otherwise a computer with Chinese fonts may draw
// the kanji in their Chinese shapes, above all in the saved image.
const FONT = "'Noto Sans JP', 'Noto Sans CJK JP', 'Hiragino Sans', 'Yu Gothic UI', 'Yu Gothic', Meiryo, system-ui, sans-serif";
const HIT_WIDTH = 1.6; // m, how close to a line a press still picks it

export const BASE_INDEX = 0; // figures[0] is 全体の配置, shown under every other figure

export function newDoc() {
  return {
    version: 1,
    place: "yard",
    field: "track200",
    stage: "top",
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

// Moves the document to another place. What is on the figures stays.
export function setPlace(doc, place) {
  const { field, width, height, ground } = PLACES[place];
  Object.assign(doc, { place, field, width, height, ground });
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
function itemLabel(item, k) {
  if (!item.label) return "";
  const part = PARTS[item.type];
  const size = LABEL_SIZE * k;
  const fits = Math.max(...item.label.split("\n").map((line) => textWidth(line, size))) <= item.w * 0.95;
  if (part?.labelAt === "center" && fits) return words(item.label, item.x, item.y, size);
  const { hh } = turnedHalfSize(item);
  return words(item.label, item.x, item.y + hh + size * 0.85, size);
}

/* ---------- items ---------- */

function idAttr(item, mode) {
  if (mode === "own") return ` data-id="${item.id}"`;
  if (mode === "base") return ` data-base="${item.id}"`;
  return "";
}

// In black and white, white parts without an outline would vanish on the white ground.
const BW_WHITE = "#adb5bd";

function drawPart(item, mode, bw, k) {
  const part = PARTS[item.type];
  const look = bw && item.color === "#ffffff" && !part.outlined ? { ...item, color: BW_WHITE } : item;
  const hit = mode ? `<rect x="${fmt(-item.w / 2)}" y="${fmt(-item.h / 2)}" width="${fmt(item.w)}" height="${fmt(item.h)}" fill="transparent"/>` : "";
  const place = `translate(${fmt(item.x)} ${fmt(item.y)}) rotate(${fmt(item.rot ?? 0)})`;
  return `<g${idAttr(item, mode)} transform="${place}">${hit}${part.draw({ ...look, k })}</g>${itemLabel(item, k)}`;
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
function arrowHead(x, y, dir, width, color, k) {
  const length = Math.max(1.8 * k, width * 4.5);
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

function drawMeasure(item, color, width, k) {
  const dir = unit(item.x2 - item.x1, item.y2 - item.y1);
  const across = { x: -dir.y * 0.8 * k, y: dir.x * 0.8 * k };
  const tick = (x, y) => `M${fmt(x - across.x)} ${fmt(y - across.y)}L${fmt(x + across.x)} ${fmt(y + across.y)}`;
  const path = `M${fmt(item.x1)} ${fmt(item.y1)}L${fmt(item.x2)} ${fmt(item.y2)}${tick(item.x1, item.y1)}${tick(item.x2, item.y2)}`;
  const up = across.y > 0 ? -1 : 1; // put the words on the upper side of the line
  const words0 = item.label || lengthText(Math.hypot(item.x2 - item.x1, item.y2 - item.y1));
  const midX = (item.x1 + item.x2) / 2 + across.x * up * 1.6;
  const midY = (item.y1 + item.y2) / 2 + across.y * up * 1.6;
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${fmt(width)}"/>${words(words0, midX, midY, LABEL_SIZE * 0.9 * k)}`;
}

function drawCurve(item, color, width, k) {
  let { x1, y1, x2, y2 } = item;
  let heads = "";
  const fromEnd = unit(x2 - item.cx, y2 - item.cy);
  const fromStart = unit(x1 - item.cx, y1 - item.cy);
  if (item.head === "end" || item.head === "both") {
    const end = arrowHead(x2, y2, fromEnd, width, color, k);
    [heads, x2, y2] = [heads + end.head, end.stopX, end.stopY];
  }
  if (item.head === "both") {
    const start = arrowHead(x1, y1, fromStart, width, color, k);
    [heads, x1, y1] = [heads + start.head, start.stopX, start.stopY];
  }
  const dash = item.dash ? ` stroke-dasharray="${fmt(width * 3)} ${fmt(width * 2)}"` : "";
  const path = `<path d="M${fmt(x1)} ${fmt(y1)}Q${fmt(item.cx)} ${fmt(item.cy)} ${fmt(x2)} ${fmt(y2)}" fill="none" stroke="${color}" stroke-width="${fmt(width)}"${dash}/>`;
  if (!item.label) return path + heads;
  const middle = pointOnLine(item, 0.5);
  return path + heads + words(item.label, middle.x, middle.y - LABEL_SIZE * 1.1 * k, LABEL_SIZE * k);
}

function drawLine(item, mode, bw, k) {
  const color = lineColor(item, bw);
  const width = LINE_WIDTHS[item.width] * k;
  const body = item.kind === "measure" ? drawMeasure(item, color, width, k) : drawCurve(item, color, width, k);
  const d = `M${fmt(item.x1)} ${fmt(item.y1)}Q${fmt(item.cx)} ${fmt(item.cy)} ${fmt(item.x2)} ${fmt(item.y2)}`;
  const hit = mode ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="${fmt(Math.max(HIT_WIDTH * k, width * 3))}"/>` : "";
  return `<g${idAttr(item, mode)}>${hit}${body}</g>`;
}

// k: how large lines and words are drawn (inkScale).
export function drawItem(item, mode, bw, k = 1) {
  if (item.type === "line") return drawLine(item, mode, bw, k);
  if (item.type === "text") return drawText(item, mode);
  if (item.type === "number") return drawNumber(item, mode);
  return drawPart(item, mode, bw, k);
}

/* ---------- the school yard ---------- */

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

/* ---------- the gym ---------- */

const STAGE_DEPTH = 6; // m
const STAGE_COLOR = "#d6b47c";
const COURT_LINE = 0.1; // m
const COURTS = {
  basket: { name: "バスケットボール", color: "#e03131", gray: "#5c636a", draw: basketCourt },
  volley: { name: "バレーボール", color: "#1c7ed6", gray: "#8a9099", draw: volleyCourt },
  badminton: { name: "バドミントン", color: "#2f9e44", gray: "#b0b6bd", draw: badmintonCourt },
};

// The floor of the gym: all of it but the side the stage is on.
function floorRect(doc) {
  const depth = doc.stage === "none" ? 0 : STAGE_DEPTH;
  const x = doc.stage === "left" ? depth : 0;
  const y = doc.stage === "top" ? depth : 0;
  const across = doc.stage === "left" || doc.stage === "right";
  return { x, y, w: doc.width - (across ? depth : 0), h: doc.height - (across ? 0 : depth) };
}

function drawStage(doc, bw) {
  if (doc.stage === "none") return "";
  const across = doc.stage === "left" || doc.stage === "right";
  const side = across ? doc.height : doc.width;
  const length = Math.min(side * 0.5, 16);
  const start = (side - length) / 2;
  const far = doc.stage === "right" || doc.stage === "bottom";
  const depthAt = far ? (across ? doc.width : doc.height) - STAGE_DEPTH : 0;
  const [x, y, w, h] = across ? [depthAt, start, STAGE_DEPTH, length] : [start, depthAt, length, STAGE_DEPTH];
  const fill = bw ? "#e9ecef" : STAGE_COLOR;
  // The word goes near the back wall, leaving the front of the stage for a 演台 and its name.
  const back = { top: [0, -0.28], bottom: [0, 0.28], left: [-0.28, 0], right: [0.28, 0] }[doc.stage];
  const labelX = x + w / 2 + back[0] * w;
  const labelY = y + h / 2 + back[1] * h;
  // On a side wall the word runs along the wall, or it would not fit in the stage's depth.
  const turn = across ? ` transform="rotate(${doc.stage === "left" ? -90 : 90} ${fmt(labelX)} ${fmt(labelY)})"` : "";
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="${fill}" stroke="#495057" stroke-width="0.12"/>` +
    `<g font-family="${FONT}"${turn}>${words("ステージ", labelX, labelY, 1.2, { color: "#495057" })}</g>`;
}

// Each court is drawn lying along x, centered on (0, 0); drawCourts turns it into place.
function basketCourt() {
  const L = 14; // half the length (28 m × 15 m)
  const W = 7.5;
  let d = `M${-L} ${-W}H${L}V${W}H${-L}ZM0 ${-W}V${W}`;
  for (const s of [1, -1]) {
    const lane = L - 5.8;
    d += `M${s * L} -2.45H${s * lane}V2.45H${s * L}`;
    d += `M${s * L} -6.6H${fmt(s * 11.009)}A6.75 6.75 0 0 ${s > 0 ? 0 : 1} ${fmt(s * 11.009)} 6.6H${s * L}`;
    d += `M${fmt(s * lane)} -1.8A1.8 1.8 0 0 ${s > 0 ? 0 : 1} ${fmt(s * lane)} 1.8`;
  }
  return `<path d="${d}"/><circle r="1.8"/>`;
}

function volleyCourt() {
  return `<path d="M-9 -4.5H9V4.5H-9ZM0 -4.5V4.5M-3 -4.5V4.5M3 -4.5V4.5"/>`;
}

function badmintonCourt() {
  const L = 6.7;
  const W = 3.05;
  return `<path d="M${-L} ${-W}H${L}V${W}H${-L}ZM${-L} -2.59H${L}M${-L} 2.59H${L}M0 ${-W}V${W}` +
    `M-1.98 ${-W}V${W}M1.98 ${-W}V${W}M-5.94 ${-W}V${W}M5.94 ${-W}V${W}M-1.98 0H${-L}M1.98 0H${L}"/>`;
}

// Where the courts go: lengthwise in the floor, or across it when two fit side by side.
// Returns [along, across, turned] for each court, measured from the middle of the floor.
function courtSpots(kind, long, short) {
  if (kind === "basket") return [[0, 0, false]];
  if (kind === "volley") {
    if (short >= 20 && long >= 24) return [[-7.5, 0, true], [7.5, 0, true]];
    return [[0, 0, false]];
  }
  const turned = short >= 15.4;
  const size = turned ? 6.1 : 13.4;
  const each = Math.max(1, Math.min(3, Math.floor((long - 2 + 2.5) / (size + 2.5))));
  const rows = turned && short >= 2 * 13.4 + 5 ? [-8.2, 8.2] : [0];
  const spots = [];
  for (const across of rows) {
    for (let i = 0; i < each; i++) spots.push([(i - (each - 1) / 2) * (size + 2.5), across, turned]);
  }
  return spots;
}

function drawCourts(doc, field, bw) {
  const floor = floorRect(doc);
  const cx = floor.x + floor.w / 2;
  const cy = floor.y + floor.h / 2;
  const lengthwise = floor.w >= floor.h; // the long way of the floor runs along x
  const long = Math.max(floor.w, floor.h);
  const short = Math.min(floor.w, floor.h);
  let markup = "";
  for (const kind of field.courts) {
    const court = COURTS[kind];
    const color = bw ? court.gray : court.color;
    for (const [along, across, turned] of courtSpots(kind, long, short)) {
      const x = cx + (lengthwise ? along : across);
      const y = cy + (lengthwise ? across : along);
      const angle = (lengthwise ? 0 : 90) + (turned ? 90 : 0);
      markup += `<g transform="translate(${fmt(x)} ${fmt(y)}) rotate(${angle})" fill="none" stroke="${color}" stroke-width="${COURT_LINE}">${court.draw()}</g>`;
    }
  }
  if (field.courts.length > 1) markup += courtLegend(doc, field, bw);
  return markup;
}

// Which color is which sport, in the lower left of the floor.
function courtLegend(doc, field, bw) {
  const floor = floorRect(doc);
  const size = 0.8;
  const x = floor.x + 0.8;
  let y = floor.y + floor.h - 0.9 - (field.courts.length - 1) * size * 1.4;
  let markup = "";
  for (const kind of field.courts) {
    const court = COURTS[kind];
    markup += `<path d="M${fmt(x)} ${fmt(y)}h1.2" stroke="${bw ? court.gray : court.color}" stroke-width="0.2"/>`;
    markup += words(court.name, x + 1.6, y, size, { anchor: "start" });
    y += size * 1.4;
  }
  return `<g font-family="${FONT}">${markup}</g>`;
}

/* ---------- the ground ---------- */

function drawField(doc, bw) {
  const ground = bw ? GROUNDS.white.color : GROUNDS[doc.ground].color;
  const ink = bw ? BW_LINE : "#ffffff";
  const field = FIELDS[doc.field];
  let markup = `<rect width="${fmt(doc.width)}" height="${fmt(doc.height)}" fill="${ground}" stroke="#8a8f98" stroke-width="0.25"/>`;
  if (doc.place === "gym") {
    markup = `<rect width="${fmt(doc.width)}" height="${fmt(doc.height)}" fill="${ground}" stroke="#495057" stroke-width="0.3"/>`;
    return markup + drawCourts(doc, field, bw) + drawStage(doc, bw);
  }
  if (field.radius) markup += drawTrack(doc, field, ink);
  if (doc.field === "rect") {
    markup += `<rect x="${RECT_INSET}" y="${RECT_INSET}" width="${fmt(doc.width - RECT_INSET * 2)}" height="${fmt(doc.height - RECT_INSET * 2)}" fill="none" stroke="${ink}" stroke-width="${TRACK_LINE * 1.6}"/>`;
  }
  return markup;
}

// Faint lines while "ます目にそろえる" is on, every 5 m on the yard and every 1 m in the gym.
// Only in the editor, never printed.
export function drawGrid(doc) {
  const step = doc.place === "gym" ? 1 : 5;
  const strong = step * 5;
  const lines = [];
  const opacity = (at) => (Math.round(at / step) % (strong / step) ? 0.07 : 0.16);
  for (let x = step; x < doc.width; x += step) lines.push(`<path d="M${x} 0V${fmt(doc.height)}" stroke-opacity="${opacity(x)}"/>`);
  for (let y = step; y < doc.height; y += step) lines.push(`<path d="M0 ${y}H${fmt(doc.width)}" stroke-opacity="${opacity(y)}"/>`);
  return `<g stroke="#000" stroke-width="${0.08 * inkScale(doc)}" pointer-events="none">${lines.join("")}</g>`;
}

function drawNorth(doc) {
  const k = inkScale(doc);
  const cx = doc.width - 5 * k;
  const cy = 8 * k;
  const angle = (doc.north.angle * Math.PI) / 180;
  const arrow = `<polygon points="0,-3 2,2.2 0,1 -2,2.2" fill="${TEXT_INK}" transform="translate(${fmt(cx)} ${fmt(cy)}) rotate(${doc.north.angle}) scale(${k})"/>`;
  const labelX = cx + Math.sin(angle) * 4.6 * k;
  const labelY = cy - Math.cos(angle) * 4.6 * k;
  return arrow + words("北", labelX, labelY, 1.9 * k);
}

function drawScaleBar(doc) {
  const k = inkScale(doc);
  const length = doc.width > 160 ? 20 : doc.width >= 60 ? 10 : 5;
  const x = doc.width - 3 * k - length;
  const y = doc.height - 2.5 * k;
  const t = 0.8 * k;
  const path = `M${fmt(x)} ${fmt(y)}H${fmt(x + length)}M${fmt(x)} ${fmt(y - t)}V${fmt(y + t)}M${fmt(x + length)} ${fmt(y - t)}V${fmt(y + t)}M${fmt(x + length / 2)} ${fmt(y - t * 0.6)}V${fmt(y + t * 0.6)}`;
  return `<path d="${path}" fill="none" stroke="${TEXT_INK}" stroke-width="${0.3 * k}"/>${words(`${length}m`, x + length / 2, y - 1.6 * k, 1.6 * k)}`;
}

/* ---------- a whole figure ---------- */

// `editor` marks items so they can be picked, and `grid` adds the faint lines; without them the
// figure is drawn for printing.
export function figureMarkup(doc, index, { editor = false, grid = false } = {}) {
  const figure = doc.figures[index];
  const k = inkScale(doc);
  const underneath = index !== BASE_INDEX && figure.showBase ? doc.figures[BASE_INDEX].items : [];
  const baseMode = editor ? "base" : null;
  const ownMode = editor ? "own" : null;
  const items = underneath.map((item) => drawItem(item, baseMode, doc.bw, k)).join("") +
    figure.items.map((item) => drawItem(item, ownMode, doc.bw, k)).join("");
  const filter = doc.bw ? ' filter="url(#bw)"' : "";
  let markup = drawField(doc, doc.bw);
  if (grid) markup += drawGrid(doc);
  markup += `<g font-family="${FONT}"${filter}>${items}</g>`;
  markup += `<g font-family="${FONT}" pointer-events="none">`;
  if (doc.north.show) markup += drawNorth(doc);
  if (doc.scaleBar) markup += drawScaleBar(doc);
  const title = TITLE_SIZE * k;
  if (doc.showTitle) markup += words(figure.name, 1.6 * k, 1.6 * k + title * 0.6, title, { anchor: "start", weight: 700 });
  return `${markup}</g>`;
}

export const DEFS = '<defs><filter id="bw"><feColorMatrix type="saturate" values="0"/></filter></defs>';

// The figure as a standalone SVG file, `pixels` wide.
export function figureSvg(doc, index, pixels) {
  const height = Math.round((pixels * doc.height) / doc.width);
  const open = `<svg xmlns="http://www.w3.org/2000/svg" xml:lang="ja" lang="ja" width="${pixels}" height="${height}" viewBox="0 0 ${fmt(doc.width)} ${fmt(doc.height)}">`;
  return `${open}${DEFS}${figureMarkup(doc, index)}</svg>`;
}

