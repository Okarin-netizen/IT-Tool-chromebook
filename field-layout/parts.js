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
function drawCrowd({ w, h, color }) {
  const columns = Math.max(1, Math.round(w / CROWD_STEP));
  const rows = Math.max(1, Math.round(h / CROWD_STEP));
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

// labelAt: where the item's name goes. "center" for things big enough to write on.
// stretch: the width and height can be changed separately (else the shape keeps its proportions).
// outlined: drawn with a dark outline, so it still shows when white on white paper.
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
  tent: { name: "テント", group: "設備", w: 5.4, h: 3.6, color: "#ffffff", labelAt: "center", stretch: true, outlined: true, draw: drawTent },
  gate: { name: "門", group: "設備", w: 5, h: 0.9, color: "#333333", labelAt: "below", stretch: true, draw: drawGate },
  stand: { name: "朝礼台", group: "設備", w: 3.6, h: 1.8, color: "#adb5bd", labelAt: "center", stretch: true, outlined: true, draw: drawBox },
  desk: { name: "机", group: "設備", w: 2.4, h: 1, color: "#ffffff", labelAt: "below", stretch: true, outlined: true, draw: drawBox },
  board: { name: "得点板", group: "設備", w: 3.2, h: 2.2, color: "#ffffff", labelAt: "below", outlined: true, draw: drawBoard },
  speaker: { name: "放送", group: "設備", w: 2.6, h: 2.6, color: "#333333", labelAt: "below", draw: drawSpeaker },
};

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
