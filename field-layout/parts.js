// The parts that can be put on the school yard, and how each one is drawn.
// Everything is measured in meters: an item sits at (x, y), is w × h meters and turned by rot
// degrees. draw() returns SVG markup centered on (0, 0), which drawing.js moves into place.

export const COLORS = [
  { color: "#e03131", name: "赤" },
  { color: "#1c7ed6", name: "青" },
  { color: "#2f9e44", name: "緑" },
  { color: "#f5b800", name: "黄" },
  { color: "#f08c00", name: "オレンジ" },
  { color: "#ffffff", name: "白" },
  { color: "#868e96", name: "灰色" },
  { color: "#333333", name: "黒" },
];

const INK = "#333333"; // outlines of equipment
const OUTLINE = 0.12; // m

const fmt = (n) => String(Math.round(n * 1000) / 1000);

function rect(x, y, w, h, attrs) {
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ${attrs}/>`;
}

function polygon(points, attrs) {
  return `<polygon points="${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}" ${attrs}/>`;
}

// A traffic cone from the side: easy to recognize even when small.
function drawCone({ w, h, color }) {
  const baseH = h * 0.16;
  const top = -h / 2;
  const foot = h / 2 - baseH;
  const halfAt = (y) => (w * 0.34 * (y - top)) / (foot - top);
  const bandTop = top + h * 0.38;
  const bandBottom = top + h * 0.56;
  const stroke = `stroke="rgba(0,0,0,.35)" stroke-width="${fmt(OUTLINE * 0.6)}"`;
  const band = [[-halfAt(bandTop), bandTop], [halfAt(bandTop), bandTop], [halfAt(bandBottom), bandBottom], [-halfAt(bandBottom), bandBottom]];
  return [
    polygon([[0, top], [w * 0.34, foot], [-w * 0.34, foot]], `fill="${color}" ${stroke}`),
    rect(-w / 2, foot, w, baseH, `fill="${color}" ${stroke}`),
    polygon(band, 'fill="#fff"'),
  ].join("");
}

function drawMarker({ w, h, color }) {
  return `<ellipse rx="${fmt(w / 2)}" ry="${fmt(h / 2)}" fill="${color}" stroke="rgba(0,0,0,.35)" stroke-width="${fmt(OUTLINE * 0.6)}"/>` +
    `<ellipse rx="${fmt(w / 5)}" ry="${fmt(h / 5)}" fill="#fff"/>`;
}

function drawFlag({ w, h, color }) {
  const poleX = -w * 0.38;
  return rect(poleX, -h / 2, w * 0.1, h, `fill="${INK}"`) +
    polygon([[poleX + w * 0.1, -h / 2], [w / 2, -h / 2 + h * 0.22], [poleX + w * 0.1, -h / 2 + h * 0.44]], `fill="${color}"`);
}

// A hurdle from the side: two legs and the bar.
function drawHurdle({ w, h, color }) {
  const t = Math.min(w, h) * 0.14;
  return rect(-w / 2, -h / 2, w, t * 1.4, `fill="${color}"`) +
    rect(-w / 2 + t * 0.4, -h / 2, t, h, `fill="${color}"`) +
    rect(w / 2 - t * 1.4, -h / 2, t, h, `fill="${color}"`);
}

function drawBox({ w, h, color }) {
  return rect(-w / 2, -h / 2, w, h, `fill="${color}" stroke="${INK}" stroke-width="${fmt(OUTLINE)}"`);
}

function drawBall({ w, color }) {
  const r = w / 2;
  const line = `stroke="${INK}" stroke-width="${fmt(OUTLINE * 0.8)}"`;
  return `<circle r="${fmt(r)}" fill="${color}" ${line}/>` +
    `<path d="M${fmt(-r)} 0H${fmt(r)}M0 ${fmt(-r)}V${fmt(r)}" ${line}/>`;
}

function drawPerson({ w, color }) {
  return `<circle r="${fmt(w / 2)}" fill="${color}" stroke="rgba(0,0,0,.35)" stroke-width="${fmt(OUTLINE * 0.6)}"/>`;
}

// A group of people (a class lined up, a team): dots spread over the whole area.
const CROWD_STEP = 1.5; // m between people
function drawCrowd({ w, h, color, k = 1 }) {
  const columns = Math.max(1, Math.round(w / (CROWD_STEP * k)));
  const rows = Math.max(1, Math.round(h / (CROWD_STEP * k)));
  const stepX = w / columns;
  const stepY = h / rows;
  const r = Math.min(stepX, stepY) * 0.33;
  const dots = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = -w / 2 + stepX * (column + 0.5);
      const y = -h / 2 + stepY * (row + 0.5);
      dots.push(`<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(r)}"/>`);
    }
  }
  return `<g fill="${color}" stroke="rgba(0,0,0,.3)" stroke-width="${fmt(r * 0.15)}">${dots.join("")}</g>`;
}

// Seats or an area: a light wash of the color inside a dashed border.
function drawArea({ w, h, color }) {
  const line = 0.22;
  return rect(-w / 2, -h / 2, w, h, `fill="${color}" fill-opacity=".18" stroke="${color}" stroke-width="${line}" stroke-dasharray="${line * 4} ${line * 2.5}"`);
}

// A tent seen from above, drawn the way site plans usually show one: a box with a cross.
function drawTent({ w, h, color }) {
  const line = `stroke="${INK}" stroke-width="${fmt(OUTLINE * 0.7)}"`;
  return rect(-w / 2, -h / 2, w, h, `fill="${color}" stroke="${INK}" stroke-width="${fmt(OUTLINE * 1.2)}"`) +
    `<path d="M${fmt(-w / 2)} ${fmt(-h / 2)}L${fmt(w / 2)} ${fmt(h / 2)}M${fmt(w / 2)} ${fmt(-h / 2)}L${fmt(-w / 2)} ${fmt(h / 2)}" ${line}/>`;
}

// An entrance gate from above: two posts and the bar between them.
function drawGate({ w, h, color }) {
  const post = h;
  return rect(-w / 2, -h * 0.25, w, h * 0.5, `fill="${color}"`) +
    rect(-w / 2, -post / 2, post, post, `fill="${color}"`) +
    rect(w / 2 - post, -post / 2, post, post, `fill="${color}"`);
}

function drawBoard({ w, h, color }) {
  const line = `stroke="${INK}" stroke-width="${fmt(OUTLINE)}"`;
  return drawBox({ w, h, color }) +
    `<path d="M${fmt(-w * 0.3)} ${fmt(-h * 0.12)}H${fmt(w * 0.3)}M${fmt(-w * 0.3)} ${fmt(h * 0.18)}H${fmt(w * 0.3)}" ${line}/>`;
}

function drawSpeaker({ w, h, color }) {
  const s = Math.min(w, h) / 2;
  const wave = `fill="none" stroke="${color}" stroke-width="${fmt(s * 0.16)}" stroke-linecap="round"`;
  return polygon([[-s, -s * 0.35], [-s * 0.5, -s * 0.35], [s * 0.1, -s * 0.85], [s * 0.1, s * 0.85], [-s * 0.5, s * 0.35], [-s, s * 0.35]], `fill="${color}"`) +
    `<path d="M${fmt(s * 0.42)} ${fmt(-s * 0.42)}a${fmt(s * 0.6)} ${fmt(s * 0.6)} 0 0 1 0 ${fmt(s * 0.84)}" ${wave}/>` +
    `<path d="M${fmt(s * 0.68)} ${fmt(-s * 0.72)}a${fmt(s)} ${fmt(s)} 0 0 1 0 ${fmt(s * 1.44)}" ${wave}/>`;
}

/* ---------- 体育館の部品: drawn at their real size ---------- */

// A folding chair from above, facing up (toward a stage at the top): the seat, and the back below it.
function chairShape(x, y, w, h, color) {
  const line = `stroke="${INK}" stroke-width="${fmt(Math.min(w, h) * 0.08)}"`;
  return rect(x - w / 2, y - h / 2, w, h * 0.78, `fill="${color}" ${line}`) +
    rect(x - w / 2, y + h / 2 - h * 0.18, w, h * 0.18, `fill="${INK}"`);
}

function drawChair({ w, h, color }) {
  return chairShape(0, 0, w, h, color);
}

// Rows of chairs (入学式・卒業式・集会): how many fit is worked out from the size, so the count
// changes when the area is stretched. CHAIR_STEP is one chair with the gap beside and behind it.
export const CHAIR_STEP = { x: 0.6, y: 0.9 }; // m
export function chairCount(item) {
  return { columns: Math.max(1, Math.round(item.w / CHAIR_STEP.x)), rows: Math.max(1, Math.round(item.h / CHAIR_STEP.y)) };
}

function drawChairRows(item) {
  const { columns, rows } = chairCount(item);
  const stepX = item.w / columns;
  const stepY = item.h / rows;
  const w = stepX * 0.75;
  const h = Math.min(stepY * 0.62, w * 1.15);
  const chairs = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      chairs.push(chairShape(-item.w / 2 + stepX * (column + 0.5), -item.h / 2 + stepY * (row + 0.5), w, h, item.color));
    }
  }
  return chairs.join("");
}

function drawFlowers({ w, color }) {
  const r = w / 2;
  const petals = [0, 72, 144, 216, 288].map((angle) => {
    const a = (angle * Math.PI) / 180;
    return `<circle cx="${fmt(Math.cos(a) * r * 0.5)}" cy="${fmt(Math.sin(a) * r * 0.5)}" r="${fmt(r * 0.42)}"/>`;
  }).join("");
  return `<circle r="${fmt(r)}" fill="#8ce99a" stroke="${INK}" stroke-width="${fmt(r * 0.06)}"/>` +
    `<g fill="${color}" stroke="rgba(0,0,0,.3)" stroke-width="${fmt(r * 0.04)}">${petals}</g><circle r="${fmt(r * 0.2)}" fill="#ffd43b"/>`;
}

// A grand piano from above: the curved body and the keyboard along the bottom.
function drawPiano({ w, h, color }) {
  const x0 = -w / 2;
  const y0 = -h / 2;
  const keys = h * 0.14;
  const body = `M${fmt(x0)} ${fmt(y0 + h - keys)}V${fmt(y0 + h * 0.12)}Q${fmt(x0)} ${fmt(y0)} ${fmt(x0 + w * 0.3)} ${fmt(y0)}` +
    `Q${fmt(x0 + w * 0.55)} ${fmt(y0)} ${fmt(x0 + w * 0.6)} ${fmt(y0 + h * 0.3)}Q${fmt(x0 + w * 0.68)} ${fmt(y0 + h * 0.55)} ${fmt(x0 + w)} ${fmt(y0 + h * 0.62)}V${fmt(y0 + h - keys)}Z`;
  return `<path d="${body}" fill="${color}" stroke="${INK}" stroke-width="${fmt(OUTLINE * 0.5)}"/>` +
    rect(x0, y0 + h - keys, w, keys, `fill="#fff" stroke="${INK}" stroke-width="${fmt(OUTLINE * 0.4)}"`);
}

// A door in a wall: the opening and the way the door swings.
function drawDoor({ w, h, color }) {
  const wall = h * 0.22;
  const line = `stroke="${color}" stroke-width="${fmt(wall * 0.35)}" fill="none"`;
  return rect(-w / 2 - wall * 1.5, -h / 2, wall * 1.5, wall, `fill="${color}"`) +
    rect(w / 2, -h / 2, wall * 1.5, wall, `fill="${color}"`) +
    `<path d="M${fmt(-w / 2)} ${fmt(-h / 2 + wall)}V${fmt(h / 2)}A${fmt(h - wall)} ${fmt(h - wall)} 0 0 0 ${fmt(-w / 2 + h - wall)} ${fmt(-h / 2 + wall)}" ${line} stroke-dasharray="${fmt(wall * 0.6)} ${fmt(wall * 0.4)}"/>`;
}

// A vaulting box from above: rounded, with the leather top and the wooden steps.
function drawVault({ w, h, color }) {
  const line = `stroke="${INK}" stroke-width="${fmt(OUTLINE * 0.5)}"`;
  return `<rect x="${fmt(-w / 2)}" y="${fmt(-h / 2)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(h * 0.3)}" fill="${color}" ${line}/>` +
    `<rect x="${fmt(-w / 2 + w * 0.08)}" y="${fmt(-h / 2 + h * 0.15)}" width="${fmt(w * 0.84)}" height="${fmt(h * 0.7)}" rx="${fmt(h * 0.25)}" fill="#fff" ${line}/>`;
}

// A basketball goal from above: the board, the ring in front of it and the stand behind.
function drawGoal({ w, h, color }) {
  const line = `stroke="${INK}" stroke-width="${fmt(OUTLINE * 0.6)}"`;
  const ring = h * 0.2;
  return rect(-w * 0.12, h * 0.05, w * 0.24, h * 0.45, `fill="#adb5bd" ${line}`) +
    rect(-w / 2, -h * 0.02, w, h * 0.1, `fill="#fff" ${line}`) +
    `<circle cy="${fmt(-h * 0.02 - ring)}" r="${fmt(ring)}" fill="none" stroke="${color}" stroke-width="${fmt(ring * 0.25)}"/>`;
}

// A net between two posts (バレー・バドミントン): stretch it to the width of the court.
function drawNet({ w, h, color }) {
  const r = h / 2;
  return `<path d="M${fmt(-w / 2 + r)} 0H${fmt(w / 2 - r)}" stroke="${color}" stroke-width="${fmt(r * 0.5)}" stroke-dasharray="${fmt(r * 0.6)} ${fmt(r * 0.3)}"/>` +
    `<circle cx="${fmt(-w / 2 + r)}" r="${fmt(r)}" fill="${INK}"/><circle cx="${fmt(w / 2 - r)}" r="${fmt(r)}" fill="${INK}"/>`;
}

// A table tennis table: white edges, the middle line and the net across.
function drawTable({ w, h, color }) {
  const line = `stroke="#fff" stroke-width="${fmt(h * 0.03)}" fill="none"`;
  return rect(-w / 2, -h / 2, w, h, `fill="${color}" stroke="${INK}" stroke-width="${fmt(h * 0.03)}"`) +
    rect(-w / 2 + h * 0.03, -h / 2 + h * 0.03, w - h * 0.06, h * 0.94, line) +
    `<path d="M${fmt(-w / 2)} 0H${fmt(w / 2)}" ${line}/>` +
    `<path d="M0 ${fmt(-h / 2 - h * 0.08)}V${fmt(h / 2 + h * 0.08)}" stroke="${INK}" stroke-width="${fmt(h * 0.06)}"/>`;
}

// Stairs from above: the steps as lines, the lowest step at the bottom (toward the floor).
export const STAIR_COLOR = "#e6cc9a";
export function drawStairs({ w, h, color }) {
  const steps = Math.max(2, Math.round(h / 0.3));
  let lines = "";
  for (let i = 1; i < steps; i++) lines += `M${fmt(-w / 2)} ${fmt(-h / 2 + (h * i) / steps)}H${fmt(w / 2)}`;
  return rect(-w / 2, -h / 2, w, h, `fill="${color}" stroke="${INK}" stroke-width="0.06"`) +
    `<path d="${lines}" stroke="${INK}" stroke-width="0.04"/>`;
}

// A (red) carpet for the way in (入場の通路): the carpet with a gold edge along both long sides.
function drawCarpet({ w, h, color }) {
  const edge = Math.min(w, h) * 0.07;
  const long = w >= h;
  const lines = long
    ? `M${fmt(-w / 2)} ${fmt(-h / 2 + edge * 1.5)}H${fmt(w / 2)}M${fmt(-w / 2)} ${fmt(h / 2 - edge * 1.5)}H${fmt(w / 2)}`
    : `M${fmt(-w / 2 + edge * 1.5)} ${fmt(-h / 2)}V${fmt(h / 2)}M${fmt(w / 2 - edge * 1.5)} ${fmt(-h / 2)}V${fmt(h / 2)}`;
  return rect(-w / 2, -h / 2, w, h, `fill="${color}" stroke="rgba(0,0,0,.35)" stroke-width="${fmt(edge * 0.5)}"`) +
    `<path d="${lines}" stroke="#f5c84c" stroke-width="${fmt(edge)}"/>`;
}

// labelAt: where the item's name goes. "center" for things big enough to write on.
// stretch: the width and height can be changed separately (else the shape keeps its proportions).
// outlined: drawn with a dark outline, so it still shows when white on white paper.
// place: "yard" or "gym" when the part is only offered there (else on both).
// tile: the size drawn on its button, when the real size would be too long or too busy there.
// real: drawn at its real size. Other parts are drawn larger than life so they show on a whole
// school yard, and in a gym (much smaller) they start at half that size (see inkScale).
export const PARTS = {
  cone: { name: "コーン", group: "目印", w: 2.4, h: 2.4, color: "#f08c00", labelAt: "below", draw: drawCone },
  marker: { name: "マーカー", group: "目印", w: 2.2, h: 1.2, color: "#f08c00", labelAt: "below", draw: drawMarker },
  flag: { name: "旗", group: "目印", w: 2.4, h: 3.2, color: "#e03131", labelAt: "below", draw: drawFlag },
  hurdle: { name: "ハードル", group: "目印", w: 3.2, h: 2, color: "#333333", labelAt: "below", draw: drawHurdle },
  mat: { name: "マット", group: "目印", w: 4, h: 2.4, color: "#74c0fc", labelAt: "center", stretch: true, outlined: true, draw: drawBox },
  ball: { name: "ボール", group: "目印", w: 2, h: 2, color: "#ffffff", labelAt: "below", outlined: true, draw: drawBall },
  person: { name: "人", group: "人", w: 2, h: 2, color: "#e03131", labelAt: "below", draw: drawPerson },
  crowd: { name: "列・集団", group: "人", w: 6, h: 4.5, color: "#1c7ed6", labelAt: "below", stretch: true, draw: drawCrowd },
  area: { name: "席・範囲", group: "人", w: 16, h: 6, color: "#e03131", labelAt: "center", stretch: true, draw: drawArea },
  tent: { name: "テント", group: "設備", place: "yard", w: 5.4, h: 3.6, color: "#ffffff", labelAt: "center", stretch: true, outlined: true, draw: drawTent },
  gate: { name: "門", group: "設備", place: "yard", w: 5, h: 0.9, color: "#333333", labelAt: "below", stretch: true, draw: drawGate },
  stand: { name: "朝礼台", group: "設備", place: "yard", w: 3.6, h: 1.8, color: "#adb5bd", labelAt: "center", stretch: true, outlined: true, draw: drawBox },
  desk: { name: "机", group: "設備", w: 2.4, h: 1, color: "#ffffff", labelAt: "below", stretch: true, outlined: true, draw: drawBox },
  board: { name: "得点板", group: "設備", w: 3.2, h: 2.2, color: "#ffffff", labelAt: "below", outlined: true, draw: drawBoard },
  speaker: { name: "放送", group: "設備", w: 2.6, h: 2.6, color: "#333333", labelAt: "below", draw: drawSpeaker },
  chairs: { name: "いすの列", group: "式・集会", place: "gym", real: true, w: 6, h: 4.5, tile: { w: 1.8, h: 1.8 }, color: "#868e96", labelAt: "below", stretch: true, draw: drawChairRows },
  chair: { name: "いす", group: "式・集会", place: "gym", real: true, w: 0.45, h: 0.5, color: "#868e96", labelAt: "below", draw: drawChair },
  podium: { name: "演台", group: "式・集会", place: "gym", real: true, w: 1.5, h: 0.7, color: "#b5835a", labelAt: "below", stretch: true, outlined: true, draw: drawBox },
  flowers: { name: "花", group: "式・集会", place: "gym", real: true, w: 1, h: 1, color: "#f06595", labelAt: "below", draw: drawFlowers },
  piano: { name: "ピアノ", group: "式・集会", place: "gym", real: true, w: 1.6, h: 2, color: "#333333", labelAt: "below", draw: drawPiano },
  carpet: { name: "じゅうたん", group: "式・集会", place: "gym", real: true, w: 1.8, h: 15, tile: { w: 0.8, h: 2.4 }, color: "#c92a2a", labelAt: "below", stretch: true, draw: drawCarpet },
  stairs: { name: "階段", group: "式・集会", place: "gym", real: true, w: 1.8, h: 1.2, color: STAIR_COLOR, labelAt: "below", stretch: true, draw: drawStairs },
  door: { name: "出入口", group: "式・集会", place: "gym", real: true, w: 1.8, h: 1.2, color: "#333333", labelAt: "below", stretch: true, draw: drawDoor },
  vault: { name: "跳び箱", group: "体育", place: "gym", real: true, w: 1.6, h: 0.9, color: "#b5835a", labelAt: "below", draw: drawVault },
  beam: { name: "平均台", group: "体育", place: "gym", real: true, w: 5, h: 0.3, tile: { w: 2, h: 0.3 }, color: "#b5835a", labelAt: "below", stretch: true, outlined: true, draw: drawBox },
  goal: { name: "ゴール", group: "体育", place: "gym", real: true, w: 1.8, h: 2, color: "#e03131", labelAt: "below", draw: drawGoal },
  net: { name: "ネット", group: "体育", place: "gym", real: true, w: 10, h: 0.4, tile: { w: 2.4, h: 0.4 }, color: "#333333", labelAt: "below", stretch: true, draw: drawNet },
  pingpong: { name: "卓球台", group: "体育", place: "gym", real: true, w: 2.74, h: 1.525, color: "#1c7ed6", labelAt: "below", draw: drawTable },
};

export const GROUP_ORDER = ["式・集会", "体育", "目印", "人", "設備", "線・文字"];
export const fitsPlace = (part, place) => !part.place || part.place === place;

// The lines and words. They are not boxes, so drawing.js draws them itself.
export const MARKS = {
  arrow: { name: "矢印", group: "線・文字", line: "arrow" },
  curve: { name: "カーブ矢印", group: "線・文字", line: "arrow", curved: true },
  white: { name: "白線", group: "線・文字", line: "white" },
  text: { name: "文字", group: "線・文字" },
  number: { name: "番号", group: "線・文字" },
  measure: { name: "長さ", group: "線・文字", line: "measure" },
};

export const LINE_DEFAULTS = {
  arrow: { color: "#e03131", width: "normal", dash: false, head: "end" },
  white: { color: "#ffffff", width: "normal", dash: false, head: "none" },
  measure: { color: "#333333", width: "thin", dash: false, head: "none" },
};

export const LINE_WIDTHS = { thin: 0.25, normal: 0.45, thick: 0.8 }; // m

export const TEXT_SIZES = { small: 2.2, normal: 3.2, large: 4.8 }; // m, the height of a letter
export const NUMBER_SIZE = 3; // m across
export const LABEL_SIZE = 2.2; // m, the names written by items
