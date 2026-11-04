// What is drawn on each kind of sheet, as simple shapes in millimetres from the top left of the
// paper. app.js draws the same shapes on the preview canvas and into the PDF.
//   { type: "line", x1, y1, x2, y2, width, dash?, ink? }  dash: [on, off] in mm; ink: dark, not the line color
//   { type: "dot", x, y, r }
//   { type: "text", x, y, size, text, latin?, align }    y is the middle of the text; align left|center|right

export const PAPERS = { A4: [210, 297], B5: [182, 257], B4: [257, 364], A3: [297, 420] };

const MARGIN = 12; // mm around the drawing
const TITLE_HEIGHT = 12; // mm taken by the title
const NAME_HEIGHT = 14; // mm taken by the 年・組・番・名前 line
const THIN = 0.12; // line widths in mm
const NORMAL = 0.2;
const BOLD = 0.4;
const DASH = [1.2, 1.2];

// Each kind of sheet, with its sizes (the select's options: value → words).
export const KINDS = {
  grid: { name: "方眼", sizes: { 5: "5mm", 7: "7mm", 10: "1cm", 1: "1mm（グラフ用紙）" }, size: "5" },
  dots: { name: "ドット方眼", sizes: { 5: "5mm", 7: "7mm", 10: "1cm" }, size: "5" },
  lines: { name: "横罫線", sizes: { 6: "6mm（せまい）", 7: "7mm（ふつう）", 8: "8mm", 10: "10mm（広い）" }, size: "7" },
  english: { name: "英語の4線", sizes: { 9: "小さめ", 12: "ふつう", 15: "大きめ" }, size: "12" },
  kanji: { name: "漢字練習のマス", sizes: { 15: "1.5cm", 20: "2cm", 25: "2.5cm" }, size: "20" },
  coord: {
    name: "座標（グラフ）",
    sizes: { "-5,5,1": "−5〜5 を1つ", "-5,5,2": "−5〜5 を2つ", "-5,5,4": "−5〜5 を4つ", "-10,10,1": "−10〜10 を1つ", "-10,10,2": "−10〜10 を2つ", "0,10,4": "0〜10 を4つ" },
    size: "-5,5,1",
  },
  music: { name: "五線譜", sizes: { 8: "8段", 10: "10段", 12: "12段" }, size: "10" },
};

const line = (x1, y1, x2, y2, width, extra = {}) => ({ type: "line", x1, y1, x2, y2, width, ...extra });
const text = (x, y, size, words, align, extra = {}) => ({ type: "text", x, y, size, text: words, align, ...extra });

/* ---------- top of the sheet ---------- */

// 「　年　組　番　名前＿＿＿」 along the right of the top edge.
function nameLine(right, top) {
  const size = 4.2;
  const parts = [[14, "年"], [14, "組"], [14, "番"], [4, "名前"]];
  const nameWidth = 70;
  const width = parts.reduce((sum, [gap, words]) => sum + gap + words.length * size, 0) + nameWidth;
  const shapes = [];
  let x = right - width;
  const y = top + NAME_HEIGHT / 2;
  shapes.push(line(x, y + 3.5, right, y + 3.5, NORMAL, { ink: true }));
  for (const [gap, words] of parts) {
    x += gap;
    shapes.push(text(x, y, size, words, "left"));
    x += words.length * size;
  }
  return shapes;
}

// The drawing area below the title and the name line.
function frame(paper, options) {
  const [width, height] = paper;
  let top = MARGIN;
  const shapes = [];
  if (options.title) {
    shapes.push(text(width / 2, top + TITLE_HEIGHT / 2 - 1, 6, options.title, "center"));
    top += TITLE_HEIGHT;
  }
  if (options.nameLine) {
    shapes.push(...nameLine(width - MARGIN, top));
    top += NAME_HEIGHT;
  }
  return { left: MARGIN, top, right: width - MARGIN, bottom: height - MARGIN, shapes };
}

// Whole cells of `size` that fit, centred in the box.
function cells(box, size) {
  const columns = Math.floor((box.right - box.left) / size + 1e-6);
  const rows = Math.floor((box.bottom - box.top) / size + 1e-6);
  const x0 = box.left + (box.right - box.left - columns * size) / 2;
  const y0 = box.top + (box.bottom - box.top - rows * size) / 2;
  return { columns, rows, x0, y0 };
}

/* ---------- the kinds ---------- */

// A 1mm grid gets a mid line every 5mm and a bold one every 1cm, like graph paper.
function gridWidth(size, i) {
  if (size !== 1) return NORMAL;
  if (i % 10 === 0) return BOLD;
  if (i % 5 === 0) return NORMAL;
  return THIN * 0.7;
}

function drawGrid(box, size) {
  const { columns, rows, x0, y0 } = cells(box, size);
  const shapes = [];
  for (let i = 0; i <= columns; i++) shapes.push(line(x0 + i * size, y0, x0 + i * size, y0 + rows * size, gridWidth(size, i)));
  for (let i = 0; i <= rows; i++) shapes.push(line(x0, y0 + i * size, x0 + columns * size, y0 + i * size, gridWidth(size, i)));
  return shapes;
}

function drawDots(box, size) {
  const { columns, rows, x0, y0 } = cells(box, size);
  const shapes = [];
  for (let i = 0; i <= columns; i++) {
    for (let j = 0; j <= rows; j++) shapes.push({ type: "dot", x: x0 + i * size, y: y0 + j * size, r: 0.35 });
  }
  return shapes;
}

function drawLines(box, size) {
  const shapes = [];
  for (let y = box.top + size; y <= box.bottom + 1e-6; y += size) shapes.push(line(box.left, y, box.right, y, NORMAL));
  return shapes;
}

// Four lines per row: the third is the base line the letters sit on, so it is bolder.
function drawEnglish(box, height) {
  const gap = height / 3;
  const between = height * 0.55;
  const shapes = [];
  for (let y = box.top + 2; y + height <= box.bottom + 1e-6; y += height + between) {
    shapes.push(line(box.left, y, box.right, y, NORMAL));
    shapes.push(line(box.left, y + gap, box.right, y + gap, THIN, { dash: DASH }));
    shapes.push(line(box.left, y + gap * 2, box.right, y + gap * 2, BOLD));
    shapes.push(line(box.left, y + height, box.right, y + height, NORMAL));
  }
  return shapes;
}

// Squares with a dotted cross in each, for practising kanji.
function drawKanji(box, size) {
  const { columns, rows, x0, y0 } = cells(box, size);
  const shapes = [];
  for (let i = 0; i <= columns; i++) shapes.push(line(x0 + i * size, y0, x0 + i * size, y0 + rows * size, BOLD));
  for (let i = 0; i <= rows; i++) shapes.push(line(x0, y0 + i * size, x0 + columns * size, y0 + i * size, BOLD));
  for (let i = 0; i < columns; i++) {
    const x = x0 + (i + 0.5) * size;
    shapes.push(line(x, y0, x, y0 + rows * size, THIN, { dash: DASH }));
  }
  for (let i = 0; i < rows; i++) {
    const y = y0 + (i + 0.5) * size;
    shapes.push(line(x0, y, x0 + columns * size, y, THIN, { dash: DASH }));
  }
  return shapes;
}

function drawStaves(box, count) {
  const space = 2; // mm between the five lines
  const staffHeight = space * 4;
  const step = (box.bottom - box.top - staffHeight) / Math.max(1, count - 1);
  const shapes = [];
  for (let i = 0; i < count; i++) {
    const top = box.top + i * step;
    for (let k = 0; k < 5; k++) shapes.push(line(box.left, top + k * space, box.right, top + k * space, NORMAL));
    shapes.push(line(box.left, top, box.left, top + staffHeight, NORMAL));
    shapes.push(line(box.right, top, box.right, top + staffHeight, NORMAL));
  }
  return shapes;
}

/* ---------- 座標 ---------- */

// Every number when there is room, otherwise every other one.
function labelStep(unit) {
  return unit >= 5 ? 1 : 2;
}

function axisArrow(x, y, dx, dy) {
  const size = 2.2;
  const back = [x - dx * size, y - dy * size];
  return [
    line(x, y, back[0] - dy * size * 0.5, back[1] + dx * size * 0.5, NORMAL, { ink: true }),
    line(x, y, back[0] + dy * size * 0.5, back[1] - dx * size * 0.5, NORMAL, { ink: true }),
  ];
}

function coordLabels(min, max, unit, ox, oy) {
  const step = labelStep(unit);
  const size = Math.min(3.2, unit * 0.62);
  const shapes = [text(ox - 1.2, oy + size * 0.8, size, "O", "right", { latin: true })];
  for (let n = min; n <= max; n++) {
    if (n === 0 || n % step !== 0) continue;
    const words = String(n); // ASCII minus: the PDF writes numbers in a Latin font
    shapes.push(text(ox + n * unit, oy + size * 0.95, size, words, "center", { latin: true }));
    shapes.push(text(ox - 1.2, oy - n * unit, size, words, "right", { latin: true }));
  }
  return shapes;
}

// One coordinate plane in the square cell (x, y, side): grid, axes with arrows, numbers.
function coordPlane(x, y, side, min, max) {
  const room = 7; // mm left for the numbers and the axis names
  const unit = (side - room * 2) / (max - min);
  const left = x + room;
  const top = y + room;
  const ox = left - min * unit;
  const oy = top + max * unit;
  const shapes = [];
  for (let n = 0; n <= max - min; n++) {
    shapes.push(line(left + n * unit, top, left + n * unit, top + (max - min) * unit, THIN));
    shapes.push(line(left, top + n * unit, left + (max - min) * unit, top + n * unit, THIN));
  }
  const end = room - 1.5;
  shapes.push(line(left - (min < 0 ? end : 0), oy, left + (max - min) * unit + end, oy, NORMAL, { ink: true }));
  shapes.push(line(ox, top + (max - min) * unit + (min < 0 ? end : 0), ox, top - end, NORMAL, { ink: true }));
  shapes.push(...axisArrow(left + (max - min) * unit + end, oy, 1, 0), ...axisArrow(ox, top - end, 0, -1));
  shapes.push(text(left + (max - min) * unit + end, oy + 3.5, 3.6, "x", "center", { latin: true }));
  shapes.push(text(ox + 3, top - end, 3.6, "y", "left", { latin: true }));
  shapes.push(...coordLabels(min, max, unit, ox, oy));
  return shapes;
}

function drawCoord(box, size) {
  const [min, max, count] = size.split(",").map(Number);
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const wide = width > height;
  const layouts = { 1: [1, 1], 2: wide ? [2, 1] : [1, 2], 4: [2, 2] };
  const [columns, rows] = layouts[count];
  const side = Math.min(width / columns, height / rows);
  const shapes = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = box.left + (width - side * columns) / 2 + column * side;
      const y = box.top + (height - side * rows) / 2 + row * side;
      shapes.push(...coordPlane(x, y, side, min, max));
    }
  }
  return shapes;
}

const DRAW = { grid: drawGrid, dots: drawDots, lines: drawLines, english: drawEnglish, kanji: drawKanji, coord: drawCoord, music: drawStaves };

// The whole sheet: { width, height, shapes }.
export function buildSheet(options) {
  const [shortSide, longSide] = PAPERS[options.paper];
  const paper = options.landscape ? [longSide, shortSide] : [shortSide, longSide];
  const box = frame(paper, options);
  const size = options.kind === "coord" ? options.size : Number(options.size);
  return { width: paper[0], height: paper[1], shapes: [...box.shapes, ...DRAW[options.kind](box, size)] };
}
