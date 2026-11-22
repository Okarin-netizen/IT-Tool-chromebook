import { showStatus } from "../shared/js/status.js";
import { download, onFileDrop, onFilePaste, safeFileName } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { isImage } from "../shared/js/heic.js";
import { loadPhoto, stripExtension, makeCanvas } from "../shared/js/photo.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { createSortable } from "../shared/js/sortable.js";
import { iconButton } from "../shared/js/buttons.js";
import { registerOffline } from "../shared/js/offline.js";
import "../shared/js/guide.js";
import { OFFLINE } from "../shared/js/vendor.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "screenshot-stitch-settings-v1";
const MAX_SHOTS = 40;

// Finding the overlap. Each line of a screenshot (a row when joining top to bottom, a column
// when joining side by side) is boiled down to the gray of SAMPLES points across it, and lines
// are compared by the mean difference of those points (like wayscrollshot's column sampling).
const SAMPLES = 128;
const SAMPLE_FROM = 0.03; // of the width: skip the edges, where a scrollbar moves between shots
const SAMPLE_TO = 0.94;
const FLAT_RANGE = 10; // gray levels: a line whose points differ less than this is blank
const SAME_LINE = 2.5; // mean gray difference: lines this alike are the same (a fixed bar)
const MATCH_LIMIT = 6; // mean gray difference: an overlap that matches worse is not one
const TIE_MARGIN = 0.3; // matches this close to the best count as equal; the longer overlap wins
const MIN_OVERLAP = 16; // px
const MIN_TEXT_LINES = 6; // an overlap must hold at least this many lines that are not blank
const MAX_COMPARE_LINES = 200; // lines compared per try (spread over the overlap), for speed
const STILL_SHARE = 0.97; // a point that is the same on this share of lines in every shot stays still
const MIN_MOVING_POINTS = 8; // fewer moving points than this: compare all of them
const FIXED_BAND_SHARE = 0.45; // of a screenshot's length: the most a fixed bar can take
const TRIM_SHARE = 0.4; // of the shortest screenshot: the most "上を切る" can cut

const PREVIEW_BREADTH = 900; // px
const PREVIEW_MAX_LENGTH = 16000; // px, a canvas cannot be much longer
const ZOOM_HALF = 140; // px shown on each side of a seam in the seam editor
const SEAM_HIT = 14; // css px: a click this close to a seam line in the preview opens it
// The biggest picture a canvas can safely hold.
const MAX_SIDE = 32000; // px
const MAX_AREA = 120_000_000; // px
const JPEG_QUALITY = 0.92;

const A4 = { short: 595.28, long: 841.89 }; // pt
const PDF_MARGIN = 24; // pt
const PDF_MAX_SIDE = 14400; // pt, the largest page PDF readers open
const PDF_CHUNK = 8000; // px: a long page is drawn from pictures of at most this length
const BREAK_SEARCH = 0.2; // of a page: how far up to look for a blank line to end the page on

const FILE_ORDER = new Intl.Collator("ja", { numeric: true });

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  clearBtn: $("clear-btn"),
  format: $("format"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  auto: $("auto"),
  trimStart: $("trim-start"),
  trimEnd: $("trim-end"),
  trimStartLabel: $("trim-start-label"),
  trimEndLabel: $("trim-end-label"),
  fit: $("fit"),
  gap: $("gap"),
  background: $("background"),
  seamLines: $("seam-lines"),
  sortBtn: $("sort-btn"),
  count: $("count"),
  shots: $("shots"),
  seamEditor: $("seam-editor"),
  seamTitle: $("seam-title"),
  seamCanvas: $("seam-canvas"),
  seamOverlap: $("seam-overlap"),
  seamAuto: $("seam-auto"),
  seamClose: $("seam-close"),
  previewScroll: $("preview-scroll"),
  preview: $("preview"),
  info: $("info"),
};

const settings = Object.assign(
  { direction: "vertical", auto: true, trimStart: 0, trimEnd: 0, fit: "small", gap: 0, background: "#ffffff", seamLines: true, format: "png" },
  loadJson(SETTINGS_KEY, {}),
);
const state = {
  shots: [], // { id, name, bitmap, prepared, preparedFor, lines, blank, el }
  seams: new Map(), // "id>id" of two shots in a row → { auto, context, manual }
  fixed: { start: 0, end: 0 }, // px of bars that every screenshot has at its start and end
  editing: -1, // the seam open in the seam editor: between shot i and i + 1
  busy: false,
};
let nextId = 1;
let frameRequest = 0;
let updating = null;
let updateAgain = false;
let trimTimer = 0;

const vertical = () => settings.direction === "vertical";
const lengthOf = (image) => (vertical() ? image.height : image.width);
const breadthOf = (image) => (vertical() ? image.width : image.height);
const seamKey = (index) => `${state.shots[index].id}>${state.shots[index + 1].id}`;

/* ---------- adding screenshots ---------- */

async function addFiles(fileList) {
  const files = [...fileList].filter(isImage).sort((a, b) => FILE_ORDER.compare(a.name, b.name));
  if (!files.length) return showStatus("画像のファイルを選んでください", { error: true });
  const room = MAX_SHOTS - state.shots.length;
  if (files.length > room) showStatus(`つなげられるのは${MAX_SHOTS}枚までです`, { error: true });
  for (const file of files.slice(0, Math.max(0, room))) {
    try {
      const bitmap = await loadPhoto(file);
      state.shots.push({ id: nextId++, name: file.name, bitmap });
    } catch (err) {
      console.error(err);
      showStatus(`${file.name} を開けませんでした`, { error: true });
    }
  }
  await update();
}

function removeShot(index) {
  const [shot] = state.shots.splice(index, 1);
  closeShot(shot);
  state.editing = -1;
  update();
}

function closeShot(shot) {
  shot.bitmap.close();
  if (shot.prepared !== shot.bitmap) shot.prepared?.close();
}

function clearAll() {
  for (const shot of state.shots) closeShot(shot);
  state.shots = [];
  state.seams.clear();
  state.editing = -1;
  update();
}

function moveShot(index, step) {
  const [shot] = state.shots.splice(index, 1);
  state.shots.splice(index + step, 0, shot);
  state.editing = -1;
  update();
}

function sortByName() {
  state.shots.sort((a, b) => FILE_ORDER.compare(a.name, b.name));
  state.editing = -1;
  update();
}

/* ---------- getting the screenshots ready ---------- */

// Prepares the screenshots and finds the overlaps again. Calls that come while it works are
// folded into one more round, so dragging a slider does not pile up work.
function update() {
  if (updating) {
    updateAgain = true;
    return updating;
  }
  updating = (async () => {
    try {
      do {
        updateAgain = false;
        await prepareAll();
        await findSeams();
      } while (updateAgain);
    } catch (err) {
      console.error(err);
      showStatus("スクショをつなげられませんでした", { error: true });
    }
    updating = null;
    renderList();
    render();
  })();
  return updating;
}

// The breadth every screenshot is scaled to ("大きさがちがうとき"), or null to keep each as it is.
function targetBreadth() {
  const breadths = state.shots.map((shot) => breadthOf(shot.bitmap));
  if (settings.fit === "small") return Math.min(...breadths);
  if (settings.fit === "large") return Math.max(...breadths);
  return null;
}

async function prepareAll() {
  const target = targetBreadth();
  for (const shot of state.shots) {
    const breadth = target ?? breadthOf(shot.bitmap);
    const key = `${settings.direction}:${breadth}`;
    if (shot.preparedFor === key) continue;
    if (shot.prepared && shot.prepared !== shot.bitmap) shot.prepared.close();
    shot.prepared = await scaledTo(shot.bitmap, breadth);
    Object.assign(shot, lineSignatures(shot.prepared));
    shot.preparedFor = key;
  }
}

async function scaledTo(bitmap, breadth) {
  const k = breadth / breadthOf(bitmap);
  if (k === 1) return bitmap;
  const resizeWidth = Math.max(1, Math.round(bitmap.width * k));
  const resizeHeight = Math.max(1, Math.round(bitmap.height * k));
  return createImageBitmap(bitmap, { resizeWidth, resizeHeight, resizeQuality: "high" });
}

// For each line along the joining direction: the gray of SAMPLES points across it, and whether
// the line is blank (one color). Used to find overlaps and good places to end a PDF page.
function lineSignatures(image) {
  const canvas = makeCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  canvas.width = canvas.height = 0;
  const count = lengthOf(image);
  const across = breadthOf(image);
  const points = Array.from({ length: SAMPLES }, (_, k) => Math.floor(across * (SAMPLE_FROM + ((SAMPLE_TO - SAMPLE_FROM) * k) / (SAMPLES - 1))));
  const lines = new Uint8Array(count * SAMPLES);
  const blank = new Uint8Array(count);
  const rows = vertical();
  for (let line = 0; line < count; line++) {
    let low = 255;
    let high = 0;
    for (let k = 0; k < SAMPLES; k++) {
      const x = rows ? points[k] : line;
      const y = rows ? line : points[k];
      const i = (y * image.width + x) * 4;
      const gray = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      lines[line * SAMPLES + k] = gray;
      low = Math.min(low, gray);
      high = Math.max(high, gray);
    }
    blank[line] = high - low < FLAT_RANGE ? 1 : 0;
  }
  return { lines, blank };
}

const ALL_POINTS = Array.from({ length: SAMPLES }, (_, k) => k);

// The mean gray difference between line `a` of one screenshot and line `b` of another, at the
// sample points `points`.
function lineDifference(shotA, a, shotB, b, points = ALL_POINTS) {
  let sum = 0;
  const offsetA = a * SAMPLES;
  const offsetB = b * SAMPLES;
  for (const k of points) sum += Math.abs(shotA.lines[offsetA + k] - shotB.lines[offsetB + k]);
  return sum / points.length;
}

// The sample points that move when the page scrolls. Points on a part of the screen that stays
// still in every shot (a menu at the side that does not scroll) would spoil the comparison.
function movingPoints() {
  const shots = state.shots;
  const shortest = Math.min(...shots.map((shot) => lengthOf(shot.prepared)));
  const still = (k) => shots.slice(1).every((shot) => {
    let same = 0;
    for (let line = 0; line < shortest; line++) {
      if (Math.abs(shots[0].lines[line * SAMPLES + k] - shot.lines[line * SAMPLES + k]) <= 2) same++;
    }
    return same >= shortest * STILL_SHARE;
  });
  const moving = ALL_POINTS.filter((k) => !still(k));
  return moving.length >= MIN_MOVING_POINTS ? moving : ALL_POINTS;
}

/* ---------- finding the overlaps ---------- */

async function findSeams() {
  state.fixed = settings.auto ? fixedBands() : { start: 0, end: 0 };
  const points = settings.auto && state.shots.length > 1 ? movingPoints() : ALL_POINTS;
  for (let i = 0; i + 1 < state.shots.length; i++) {
    const key = seamKey(i);
    const seam = state.seams.get(key) ?? {};
    const context = seamContext(i);
    if (seam.context !== context) {
      seam.auto = settings.auto ? findOverlap(state.shots[i], state.shots[i + 1], range(i), range(i + 1), points) : 0;
      seam.context = context;
      state.seams.set(key, seam);
      await new Promise((resolve) => setTimeout(resolve)); // let the page breathe between seams
    }
  }
}

// Everything the overlap of seam `index` depends on: when it changes, the overlap is found again.
function seamContext(index) {
  const { direction, fit, auto, trimStart, trimEnd } = settings;
  const ends = [index === 0, index + 2 === state.shots.length];
  const shots = state.shots.map((shot) => shot.id);
  return JSON.stringify([direction, fit, auto, trimStart, trimEnd, state.fixed, ends, shots]);
}

// Bars that are the same in every screenshot at the same place (the browser's tabs, a page's
// fixed heading, the shelf at the bottom of the screen): kept on the first (or last) one only.
function fixedBands() {
  const shots = state.shots;
  if (shots.length < 2) return { start: 0, end: 0 };
  const shortest = Math.min(...shots.map((shot) => lengthOf(shot.prepared)));
  const limit = Math.floor(shortest * FIXED_BAND_SHARE);
  const sameAt = (lineOf) => shots.every((shot) => lineDifference(shots[0], lineOf(shots[0]), shot, lineOf(shot)) < SAME_LINE);
  const band = (lineOf) => {
    let size = 0;
    while (size < limit && sameAt((shot) => lineOf(shot, size))) size++;
    return size;
  };
  return {
    start: band((shot, i) => i),
    end: band((shot, i) => lengthOf(shot.prepared) - 1 - i),
  };
}

// The lines of screenshot `index` that take part: without the cut edges and without the fixed
// bars that an earlier (or later) screenshot already shows.
function range(index) {
  const shot = state.shots[index];
  const length = lengthOf(shot.prepared);
  const first = index === 0;
  const last = index === state.shots.length - 1;
  let start = first ? settings.trimStart : Math.max(settings.trimStart, state.fixed.start);
  let end = length - (last ? settings.trimEnd : Math.max(settings.trimEnd, state.fixed.end));
  start = Math.min(start, length - 1);
  end = Math.max(end, start + 1);
  return { start, end };
}

// How many lines at the start of B repeat the end of A, or null when no good match is found.
// Tries every place in A where B could begin and scores how alike the lines that would lie on
// each other are (only lines with something on them count, since blank lines match anything).
function findOverlap(shotA, shotB, rangeA, rangeB, points) {
  const longest = Math.min(rangeA.end - rangeA.start, rangeB.end - rangeB.start);
  const scores = [];
  let bestScore = Infinity;
  for (let overlap = MIN_OVERLAP; overlap <= longest; overlap++) {
    const score = overlapScore(shotA, shotB, rangeA.end - overlap, rangeB.start, overlap, points);
    if (score === null) continue;
    scores.push({ overlap, score });
    bestScore = Math.min(bestScore, score);
  }
  if (bestScore > MATCH_LIMIT) return null;
  // Of the matches as good as the best, the longest: a list of alike rows can match at several
  // places, and screenshots are usually scrolled by less than a screen.
  const good = scores.filter((s) => s.score <= bestScore + TIE_MARGIN);
  return good.at(-1).overlap;
}

function overlapScore(shotA, shotB, startA, startB, overlap, points) {
  const step = Math.max(1, Math.floor(overlap / MAX_COMPARE_LINES));
  let sum = 0;
  let counted = 0;
  for (let t = 0; t < overlap; t += step) {
    if (shotB.blank[startB + t] && shotA.blank[startA + t]) continue;
    sum += lineDifference(shotA, startA + t, shotB, startB + t, points);
    counted++;
  }
  if (counted < Math.min(MIN_TEXT_LINES, Math.ceil(overlap / step))) return null;
  return sum / counted;
}

// The overlap used at seam `index`: the one set by hand, or the one found.
function overlapAt(index) {
  const seam = state.seams.get(seamKey(index));
  const room = range(index + 1).end - range(index + 1).start - 1;
  const chosen = seam?.manual ?? seam?.auto ?? 0;
  return Math.max(0, Math.min(room, chosen));
}

/* ---------- the joined picture ---------- */

// Where each screenshot's part goes along the joined picture, in px of the prepared screenshots.
function layout() {
  const pieces = [];
  let at = 0;
  state.shots.forEach((shot, index) => {
    const { start, end } = range(index);
    const from = index > 0 ? start + overlapAt(index - 1) : start;
    if (index > 0) at += settings.gap;
    pieces.push({ shot, from, to: end, at });
    at += end - from;
  });
  const breadth = Math.max(0, ...state.shots.map((shot) => breadthOf(shot.prepared)));
  return { pieces, length: at, breadth };
}

// Draws the part [from, to) of the joined picture onto a new canvas, `scale` times its size.
function drawPart(plan, from, to, scale) {
  const along = Math.max(1, (to - from) * scale);
  const across = Math.max(1, plan.breadth * scale);
  const canvas = vertical() ? makeCanvas(across, along) : makeCanvas(along, across);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = settings.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  for (const piece of plan.pieces) drawPiece(ctx, plan, piece, from, to, scale);
  return canvas;
}

function drawPiece(ctx, plan, piece, from, to, scale) {
  const start = Math.max(piece.at, from);
  const end = Math.min(piece.at + piece.to - piece.from, to);
  if (end <= start) return;
  const image = piece.shot.prepared;
  const breadth = breadthOf(image);
  const source = piece.from + (start - piece.at);
  const length = end - start;
  const side = ((plan.breadth - breadth) / 2) * scale;
  const place = (start - from) * scale;
  if (vertical()) ctx.drawImage(image, 0, source, breadth, length, side, place, breadth * scale, length * scale);
  else ctx.drawImage(image, source, 0, length, breadth, place, side, length * scale, breadth * scale);
}

// Where the seams lie along the joined picture.
const seamPlaces = (plan) => plan.pieces.slice(1).map((piece) => piece.at - settings.gap / 2);

/* ---------- the list ---------- */

function renderList() {
  els.count.textContent = state.shots.length;
  syncTrims();
  const rows = [];
  state.shots.forEach((shot, index) => {
    shot.el = shotRow(shot, index);
    sortable.attach(shot.el, shot);
    rows.push(shot.el);
    if (index + 1 < state.shots.length) rows.push(seamRow(index));
  });
  els.shots.replaceChildren(...rows);
}

function shotRow(shot, index) {
  const li = document.createElement("li");
  li.className = "shot";
  const thumb = makeCanvas(96, 96);
  const ctx = thumb.getContext("2d");
  const k = Math.max(96 / shot.bitmap.width, 96 / shot.bitmap.height);
  ctx.drawImage(shot.bitmap, 0, 0, shot.bitmap.width * k, shot.bitmap.height * k);
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = `${index + 1}. ${shot.name}`;
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  buttons.append(
    iconButton("i-up", "前へ", () => moveShot(index, -1), { disabled: index === 0 }),
    iconButton("i-down", "後ろへ", () => moveShot(index, 1), { disabled: index === state.shots.length - 1 }),
    iconButton("i-close", "このスクショを外す", () => removeShot(index)),
  );
  li.append(thumb, name, buttons);
  return li;
}

function seamRow(index) {
  const li = document.createElement("li");
  li.className = "seam";
  li.classList.toggle("editing", state.editing === index);
  const seam = state.seams.get(seamKey(index));
  const missing = settings.auto && seam?.auto === null && seam?.manual === undefined;
  li.classList.toggle("missing", missing);
  const text = document.createElement("span");
  text.className = "seam-text";
  text.textContent = seamText(index, seam, missing);
  const fix = document.createElement("button");
  fix.className = "btn small";
  fix.textContent = "直す";
  fix.title = "つなぎ目を大きくして、手で合わせる";
  fix.addEventListener("click", () => openEditor(index));
  li.append(svgIcon("i-seam"), text, fix);
  return li;
}

function seamText(index, seam, missing) {
  const overlap = overlapAt(index);
  if (missing) return "重なりが見つかりません";
  if (seam?.manual !== undefined) return `重なり ${overlap}（手で合わせた）`;
  if (overlap === 0) return "重なりなし";
  return `重なり ${overlap} を消しました`;
}

function svgIcon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

const sortable = createSortable({
  scroller: els.shots.closest(".form"),
  vertical: true,
  items: () => state.shots,
  canStart: (e) => !e.target.closest("button") && !state.busy,
  ghost: (shot) => [shot.el.querySelector(".name").cloneNode(true)],
  onDrop: ([shot], target, after) => {
    if (shot === target) return;
    state.shots.splice(state.shots.indexOf(shot), 1);
    state.shots.splice(state.shots.indexOf(target) + (after ? 1 : 0), 0, shot);
    state.editing = -1;
    update();
  },
});

/* ---------- the preview ---------- */

function render() {
  cancelAnimationFrame(frameRequest);
  frameRequest = requestAnimationFrame(draw);
}

function draw() {
  const has = state.shots.length > 0 && !!state.shots[0].prepared;
  els.welcome.hidden = state.shots.length > 0;
  els.work.hidden = !els.welcome.hidden;
  els.saveBtn.disabled = !has || state.busy;
  els.clearBtn.disabled = !state.shots.length;
  if (!has) return;
  // The editor is shown or hidden first: it takes room from the preview.
  els.seamEditor.hidden = state.editing < 0 || state.editing + 1 >= state.shots.length;
  els.previewScroll.classList.toggle("across", !vertical());
  const plan = layout();
  const scale = previewScale(plan);
  const canvas = drawPart(plan, 0, plan.length, scale);
  if (settings.seamLines) drawSeamLines(canvas, plan, scale);
  els.preview.width = canvas.width;
  els.preview.height = canvas.height;
  els.preview.getContext("2d").drawImage(canvas, 0, 0);
  els.preview.dataset.scale = scale;
  els.info.textContent = infoText(plan);
  drawEditor(plan);
}

// Joined top to bottom, the preview is at most PREVIEW_BREADTH wide; side by side, it fits the
// height of the box it scrolls in.
function previewScale(plan) {
  const room = vertical() ? PREVIEW_BREADTH : Math.max(200, els.previewScroll.clientHeight - 20);
  return Math.min(1, room / plan.breadth, PREVIEW_MAX_LENGTH / Math.max(1, plan.length));
}

function infoText(plan) {
  const width = vertical() ? plan.breadth : plan.length;
  const height = vertical() ? plan.length : plan.breadth;
  const missing = state.shots.slice(1).filter((_, i) => settings.auto && state.seams.get(seamKey(i))?.auto === null && state.seams.get(seamKey(i))?.manual === undefined).length;
  const parts = [`できあがり ${Math.round(width)}×${Math.round(height)}`];
  if (state.fixed.start || state.fixed.end) parts.push(`どのスクショにもある${vertical() ? "上下" : "左右"}のバーは1回だけにしました`);
  if (missing) parts.push(`重なりが見つからないつなぎ目が${missing}か所あります（「直す」で合わせられます）`);
  return parts.join("　");
}

// Dashed lines with numbers on the preview (not on the saved picture), so seams are easy to find.
function drawSeamLines(canvas, plan, scale) {
  const ctx = canvas.getContext("2d");
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0b7285";
  ctx.lineWidth = 2;
  ctx.font = 'bold 13px system-ui, "Noto Sans JP", sans-serif';
  seamPlaces(plan).forEach((place, index) => {
    const at = Math.round(place * scale) + 0.5;
    ctx.strokeStyle = state.editing === index ? "#e03131" : accent;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    if (vertical()) {
      ctx.moveTo(0, at);
      ctx.lineTo(canvas.width, at);
    } else {
      ctx.moveTo(at, 0);
      ctx.lineTo(at, canvas.height);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    drawSeamBadge(ctx, index + 1, vertical() ? 4 : at - 11, vertical() ? at - 11 : 4, ctx.strokeStyle);
  });
}

function drawSeamBadge(ctx, number, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 22, 22);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(number), x + 11, y + 12);
}

// A click near a seam line in the preview opens that seam.
function previewClicked(e) {
  if (!settings.seamLines || state.shots.length < 2) return;
  const box = els.preview.getBoundingClientRect();
  const cssScale = (vertical() ? box.height / els.preview.height : box.width / els.preview.width) * Number(els.preview.dataset.scale);
  const along = vertical() ? e.clientY - box.top : e.clientX - box.left;
  const places = seamPlaces(layout());
  let nearest = -1;
  places.forEach((place, index) => {
    const distance = Math.abs(place * cssScale - along);
    if (distance <= SEAM_HIT && (nearest < 0 || distance < Math.abs(places[nearest] * cssScale - along))) nearest = index;
  });
  if (nearest >= 0) openEditor(nearest);
}

/* ---------- the seam editor ---------- */

function openEditor(index) {
  state.editing = index;
  renderList();
  render();
  els.seamEditor.scrollIntoView({ block: "nearest" });
}

function closeEditor() {
  state.editing = -1;
  renderList();
  render();
}

// The seam at full size: the end of one screenshot over the start of the next, with a red line.
function drawEditor(plan) {
  const index = state.editing;
  if (els.seamEditor.hidden) return;
  els.seamTitle.textContent = `${index + 1}枚目と${index + 2}枚目のつなぎ目`;
  els.seamOverlap.value = overlapAt(index);
  els.seamAuto.disabled = state.seams.get(seamKey(index))?.manual === undefined;
  const place = seamPlaces(plan)[index];
  const from = Math.max(0, Math.floor(place - ZOOM_HALF));
  const to = Math.min(plan.length, Math.ceil(place + ZOOM_HALF));
  const canvas = drawPart(plan, from, to, 1);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(224, 49, 49, .85)";
  const at = Math.round(place - from);
  if (vertical()) ctx.fillRect(0, at - 1, canvas.width, 2);
  else ctx.fillRect(at - 1, 0, 2, canvas.height);
  els.seamCanvas.width = canvas.width;
  els.seamCanvas.height = canvas.height;
  els.seamCanvas.getContext("2d").drawImage(canvas, 0, 0);
}

function setOverlap(value) {
  const index = state.editing;
  if (index < 0) return;
  const seam = state.seams.get(seamKey(index));
  const room = range(index + 1).end - range(index + 1).start - 1;
  seam.manual = Math.max(0, Math.min(room, Math.round(value)));
  renderList();
  render();
}

function resetOverlap() {
  const seam = state.seams.get(seamKey(state.editing));
  delete seam.manual;
  renderList();
  render();
}

/* ---------- settings ---------- */

function syncControls() {
  for (const button of document.querySelectorAll("[data-direction]")) button.setAttribute("aria-checked", String(button.dataset.direction === settings.direction));
  els.auto.checked = settings.auto;
  els.fit.value = settings.fit;
  els.gap.value = settings.gap;
  els.gap.nextElementSibling.textContent = settings.gap;
  els.background.value = settings.background;
  els.seamLines.checked = settings.seamLines;
  els.format.value = settings.format;
  els.trimStartLabel.textContent = vertical() ? "上を切る" : "左を切る";
  els.trimEndLabel.textContent = vertical() ? "下を切る" : "右を切る";
  syncTrims();
  syncNudgeButtons();
}

// The trim sliders go up to a share of the shortest screenshot.
function syncTrims() {
  const lengths = state.shots.map((shot) => lengthOf(shot.bitmap));
  const shortest = lengths.length ? Math.min(...lengths) : 1000;
  const most = Math.floor(shortest * TRIM_SHARE);
  for (const [input, key] of [[els.trimStart, "trimStart"], [els.trimEnd, "trimEnd"]]) {
    input.max = most;
    input.value = Math.min(settings[key], most);
    input.nextElementSibling.textContent = input.value;
  }
}

const NUDGE_WORDS = { vertical: ["上へ", "下へ", "i-up", "i-down"], horizontal: ["左へ", "右へ", "i-left", "i-right"] };

function syncNudgeButtons() {
  const [back, forward, backIcon, forwardIcon] = NUDGE_WORDS[settings.direction];
  for (const button of document.querySelectorAll("[data-nudge]")) {
    const step = Number(button.dataset.nudge);
    button.querySelector("span").textContent = `${step < 0 ? back : forward} ${Math.abs(step)}`;
    button.querySelector("use").setAttribute("href", `#${step < 0 ? backIcon : forwardIcon}`);
  }
  els.seamEditor.querySelector("#seam-help").textContent = vertical()
    ? "あとの画像を上下に動かして、つなぎ目（赤い線）の文字や線がずれないようにします。"
    : "あとの画像を左右に動かして、つなぎ目（赤い線）の文字や線がずれないようにします。";
}

function saveSettings() {
  saveJson(SETTINGS_KEY, settings);
  syncControls();
}

// Settings that change which lines are compared: the screenshots are prepared and matched again.
function changedJoin() {
  settings.auto = els.auto.checked;
  settings.fit = els.fit.value;
  saveSettings();
  update();
}

function changedTrim() {
  settings.trimStart = Number(els.trimStart.value);
  settings.trimEnd = Number(els.trimEnd.value);
  saveSettings();
  clearTimeout(trimTimer);
  trimTimer = setTimeout(update, 150);
}

// Settings that only change how the picture is drawn.
function changedLook() {
  settings.gap = Number(els.gap.value);
  settings.background = els.background.value;
  settings.seamLines = els.seamLines.checked;
  settings.format = els.format.value;
  saveSettings();
  render();
}

/* ---------- saving ---------- */

const PDF_FORMATS = { "pdf-a4": savePdfPages, "pdf-long": savePdfLong };

async function save() {
  if (!state.shots.length || state.busy) return;
  await updating;
  state.busy = true;
  render();
  showStatus("保存しています…", { sticky: true });
  try {
    const plan = layout();
    const pdf = PDF_FORMATS[settings.format];
    if (pdf) await pdf(plan);
    else await saveImage(plan);
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした", { error: true });
  }
  state.busy = false;
  render();
}

const baseName = () => safeFileName(`${stripExtension(state.shots[0].name)}_つなげた`);

async function saveImage(plan) {
  const jpeg = settings.format === "jpg";
  const area = plan.length * plan.breadth;
  const scale = Math.min(1, MAX_SIDE / plan.length, MAX_SIDE / plan.breadth, Math.sqrt(MAX_AREA / area));
  const canvas = drawPart(plan, 0, plan.length, scale);
  const blob = await canvasToBlob(canvas, jpeg ? "image/jpeg" : "image/png", JPEG_QUALITY);
  canvas.width = canvas.height = 0;
  download(blob, `${baseName()}.${jpeg ? "jpg" : "png"}`);
  if (scale < 1) showStatus(`とても長いので、${Math.round(scale * 100)}%の大きさで保存しました。PDFなら元の大きさのままです`);
  else showStatus("保存しました");
}

// A4 pages, each ending on a blank line where one is near, so lines of text are not cut.
async function savePdfPages(plan) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const [pageWidth, pageHeight] = vertical() ? [A4.short, A4.long] : [A4.long, A4.short];
  const acrossRoom = (vertical() ? pageWidth : pageHeight) - PDF_MARGIN * 2;
  const alongRoom = (vertical() ? pageHeight : pageWidth) - PDF_MARGIN * 2;
  const k = acrossRoom / plan.breadth; // pt per px
  for (const [from, to] of pageBreaks(plan, alongRoom / k)) {
    const page = doc.addPage([pageWidth, pageHeight]);
    const image = await embedPart(doc, plan, from, to);
    const width = vertical() ? plan.breadth * k : (to - from) * k;
    const height = vertical() ? (to - from) * k : plan.breadth * k;
    page.drawImage(image, { x: PDF_MARGIN, y: pageHeight - PDF_MARGIN - height, width, height });
  }
  await savePdf(doc, `${baseName()}.pdf`);
}

// One long page, A4 wide (or A4 high when joined side by side), drawn from pictures of at most
// PDF_CHUNK px. Very long pictures are made smaller so the page stays within what readers open.
async function savePdfLong(plan) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  const across = vertical() ? A4.short : A4.long;
  const k = Math.min((across - PDF_MARGIN * 2) / plan.breadth, (PDF_MAX_SIDE - PDF_MARGIN * 2) / plan.length);
  const alongSize = plan.length * k + PDF_MARGIN * 2;
  const acrossSize = plan.breadth * k + PDF_MARGIN * 2;
  const [pageWidth, pageHeight] = vertical() ? [acrossSize, alongSize] : [alongSize, acrossSize];
  const page = doc.addPage([pageWidth, pageHeight]);
  for (let from = 0; from < plan.length; from += PDF_CHUNK) {
    const to = Math.min(plan.length, from + PDF_CHUNK);
    const image = await embedPart(doc, plan, from, to);
    const size = (to - from) * k;
    if (vertical()) page.drawImage(image, { x: PDF_MARGIN, y: pageHeight - PDF_MARGIN - from * k - size, width: plan.breadth * k, height: size });
    else page.drawImage(image, { x: PDF_MARGIN + from * k, y: PDF_MARGIN, width: size, height: plan.breadth * k });
  }
  await savePdf(doc, `${baseName()}.pdf`);
}

async function embedPart(doc, plan, from, to) {
  const canvas = drawPart(plan, from, to, 1);
  const blob = await canvasToBlob(canvas, "image/png");
  canvas.width = canvas.height = 0;
  return doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
}

async function savePdf(doc, name) {
  const bytes = await doc.save();
  download(new Blob([bytes], { type: "application/pdf" }), name);
  showStatus("保存しました");
}

// Where the pages of `pageLength` px start and end: each page ends on the last blank line in
// the last part of the page, if there is one.
function pageBreaks(plan, pageLength) {
  const pages = [];
  let from = 0;
  while (from < plan.length) {
    let to = Math.floor(from + pageLength);
    if (to >= plan.length) to = plan.length;
    else to = blankLineBefore(plan, to, Math.floor(to - pageLength * BREAK_SEARCH)) ?? to;
    pages.push([from, to]);
    from = to;
  }
  return pages;
}

function blankLineBefore(plan, from, until) {
  for (let line = from; line > until; line--) {
    if (isBlankLine(plan, line)) return line;
  }
  return null;
}

// Lines in a gap between screenshots are blank too.
function isBlankLine(plan, line) {
  const piece = plan.pieces.find((p) => line >= p.at && line < p.at + p.to - p.from);
  if (!piece) return true;
  return piece.shot.blank[piece.from + (line - piece.at)] === 1;
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
for (const button of document.querySelectorAll("[data-direction]")) {
  button.addEventListener("click", () => {
    settings.direction = button.dataset.direction;
    state.editing = -1;
    saveSettings();
    update();
  });
}
for (const button of document.querySelectorAll("[data-nudge]")) {
  // "上へ" moves the later screenshot up: more of it lies under the earlier one.
  button.addEventListener("click", () => setOverlap(overlapAt(state.editing) - Number(button.dataset.nudge)));
}
els.seamOverlap.addEventListener("change", () => setOverlap(Number(els.seamOverlap.value) || 0));
els.seamAuto.addEventListener("click", resetOverlap);
els.seamClose.addEventListener("click", closeEditor);
els.preview.addEventListener("click", previewClicked);
els.auto.addEventListener("change", changedJoin);
els.fit.addEventListener("change", changedJoin);
els.trimStart.addEventListener("input", changedTrim);
els.trimEnd.addEventListener("input", changedTrim);
els.gap.addEventListener("input", changedLook);
for (const el of [els.background, els.seamLines, els.format]) el.addEventListener("change", changedLook);
els.sortBtn.addEventListener("click", sortByName);
els.clearBtn.addEventListener("click", clearAll);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: () => (PDF_FORMATS[settings.format] ? "pdf" : "image") });
onFilePaste(addFiles);
onFileDrop(addFiles);
syncControls();
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest", ...OFFLINE.pdfLib]);

// Hook for automated tests.
window.__screenshotStitch = { state, settings, addFiles, save, layout, update };
