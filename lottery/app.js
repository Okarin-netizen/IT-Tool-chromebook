// くじ引き: one list of things (names, jobs, numbers…) drawn four ways — a spinning wheel,
// あみだくじ, face-down cards, and a random order.
import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { randomInt, shuffle } from "../shared/js/random.js";
import { copyText } from "../shared/js/clipboard.js";
import { toggleFullscreen } from "../shared/js/fullscreen.js";
import { pixelRatio } from "../shared/js/canvas.js";
import { AMIDA_ROWS, makeLadder, canAddRung, tracePath, bottomLabels } from "./amida.js";
import "../shared/js/guide.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their lists. Add a new key instead.
// { items, goals (the text as typed), mode, removePicked, sound, picked: [things already drawn] }
const STORE_KEY = "lottery-v1";
const MODES = ["wheel", "amida", "cards", "order"];
const SPIN_MS = 4500; // one spin of the wheel
const SPIN_MS_REDUCED = 600; // the same, when the device asks for less motion
const SPIN_TURNS = 5; // whole turns before slowing down
const TRACE_MS = 1600; // following one line down the あみだくじ
const TRACE_MS_ALL = 800; // the same, during 全部たどる
const MAX_AMIDA = 30; // lines in one あみだくじ
const VERTICAL_LABELS_FROM = 9; // more lines than this: write the names top to bottom
const LADDER_UNIT = 100; // あみだくじ drawing units between two lines, and between two rows
const MAX_FILL = 100; // かんたんに入れる: at most this many lines
const ORDER_STAGGER_MS = 60; // 順番決め: the next line appears this much later
// Pale colors for the wheel (dark text on top) and strong ones for lines in the あみだくじ.
const WHEEL_COLORS = ["#ffd8a8", "#b2f2bb", "#a5d8ff", "#ffc9c9", "#d0bfff", "#ffec99", "#99e9f2", "#fcc2d7"];
const TRACE_COLORS = ["#e8590c", "#1971c2", "#2f9e44", "#c2255c", "#7048e8", "#0c8599", "#f08c00", "#5c940d", "#d6336c", "#3b5bdb"];
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);

function loadStore() {
  const saved = loadJson(STORE_KEY, null) ?? {};
  return {
    items: String(saved.items ?? ""),
    goals: String(saved.goals ?? ""),
    mode: MODES.includes(saved.mode) ? saved.mode : "wheel",
    removePicked: saved.removePicked === true,
    sound: saved.sound === true,
    picked: Array.isArray(saved.picked) ? saved.picked.map(String) : [],
  };
}

const store = loadStore();
const state = {
  spinning: false,
  angle: 0, // the wheel's turn, in radians
  result: "", // the last thing the wheel landed on
  amida: { rungs: [], lines: 0, traced: new Map(), tracing: false, showBottom: false },
  cards: { deck: [], opened: new Set() },
  order: [],
};
const save = () => saveJson(STORE_KEY, store);

// One thing per line; spaces around are dropped, empty lines ignored.
const lines = (text) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const items = () => lines(store.items);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- the list ---------- */

function renderCount() {
  const n = items().length;
  $("count").textContent = n ? `${n}こ` : "";
  $("spin-btn").disabled = state.spinning || !wheelItems().length;
  $("order-btn").disabled = n < 2;
}

function setItems(text) {
  store.items = text;
  // Things taken off the list are no longer counted as drawn.
  const now = items();
  store.picked = store.picked.filter((p) => now.includes(p));
  save();
  renderCount();
  renderHistory();
  drawWheel();
  newLadder();
  newDeck();
  state.order = [];
  renderOrder();
}

function fillList(list) {
  $("items").value = list.join("\n");
  setItems($("items").value);
  showStatus(`${list.length}こ入れました`);
}

function fillNumbers() {
  const max = Math.floor(Number($("number-max").value));
  if (!(max >= 2 && max <= MAX_FILL)) {
    showStatus(`2から${MAX_FILL}までの数を入れてください`, { error: true });
    return;
  }
  fillList(Array.from({ length: max }, (_, i) => `${i + 1}`));
}

function fillWins() {
  const wins = Math.floor(Number($("win-count").value));
  const losses = Math.floor(Number($("lose-count").value));
  const ok = wins >= 1 && losses >= 0 && wins + losses >= 2 && wins + losses <= MAX_FILL;
  if (!ok) {
    showStatus(`当たりは1こ以上、全部で2〜${MAX_FILL}こにしてください`, { error: true });
    return;
  }
  fillList([...new Array(wins).fill("当たり"), ...new Array(losses).fill("はずれ")]);
}

/* ---------- ルーレット ---------- */

// What is still on the wheel. With 当たったものは外す, each drawn thing is taken off once
// (two lines with the same words count separately).
function wheelItems() {
  const left = items();
  if (!store.removePicked) return left;
  for (const picked of store.picked) {
    const i = left.indexOf(picked);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}

function wheelColor(i, count) {
  const color = WHEEL_COLORS[i % WHEEL_COLORS.length];
  // The last slice touches the first one: never give them the same color.
  const touchesFirst = i === count - 1 && i > 0 && color === WHEEL_COLORS[0];
  return touchesFirst ? WHEEL_COLORS[1] : color;
}

function sizeWheelCanvas() {
  const canvas = $("wheel-canvas");
  const box = canvas.parentElement.getBoundingClientRect();
  const size = Math.max(160, Math.floor(Math.min(box.width, box.height)));
  const ratio = pixelRatio();
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.width = canvas.height = Math.round(size * ratio);
  return { canvas, size, ratio };
}

function drawWheel() {
  const { canvas, size, ratio } = sizeWheelCanvas();
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const list = wheelItems();
  const center = size / 2;
  const radius = center - 4;
  if (!list.length) {
    drawEmptyWheel(ctx, center, radius);
    return;
  }
  const slice = (Math.PI * 2) / list.length;
  ctx.save();
  ctx.translate(center, center);
  ctx.rotate(state.angle);
  list.forEach((text, i) => drawSlice(ctx, { text, i, count: list.length, slice, radius }));
  ctx.restore();
  drawHub(ctx, center, radius);
}

function drawSlice(ctx, { text, i, count, slice, radius }) {
  const start = -Math.PI / 2 + i * slice;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, start, start + slice);
  ctx.closePath();
  ctx.fillStyle = count === 1 ? WHEEL_COLORS[0] : wheelColor(i, count);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
  const degrees = (slice * 180) / Math.PI;
  if (degrees < 3) return; // too thin to hold any words
  const middle = start + slice / 2;
  // Words on the left half would read upside down: turn them round to read from the edge in.
  const onLeft = Math.cos(middle + state.angle) < 0;
  ctx.save();
  ctx.rotate(onLeft ? middle + Math.PI : middle);
  const fontSize = Math.max(11, Math.min(radius * 0.11, radius * slice * 0.45));
  ctx.font = `bold ${fontSize}px system-ui, "Noto Sans JP", sans-serif`;
  ctx.fillStyle = "#1d2228";
  ctx.textAlign = onLeft ? "left" : "right";
  ctx.textBaseline = "middle";
  const edge = radius - 14;
  ctx.fillText(fitText(ctx, text, radius * 0.62), onLeft ? -edge : edge, 0);
  ctx.restore();
}

// Shortens words that do not fit in `width`, ending them with "…".
function fitText(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function drawHub(ctx, center, radius) {
  ctx.beginPath();
  ctx.arc(center, center, radius * 0.1, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#1d2228";
  ctx.stroke();
}

function drawEmptyWheel(ctx, center, radius) {
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(127, 127, 127, .12)";
  ctx.fill();
}

// Which slice is under the pointer (at the top) when the wheel is turned by `angle`.
function sliceAtPointer(angle, count) {
  const full = Math.PI * 2;
  const turned = (((-angle) % full) + full) % full;
  return Math.floor(turned / (full / count)) % count;
}

// The winner is chosen first (fairly), then the wheel is turned so that it stops on it,
// somewhere inside its slice but not on an edge.
function spinTarget(winner, count) {
  const full = Math.PI * 2;
  const slice = full / count;
  const within = 0.15 + (randomInt(700) / 1000);
  const goal = -(winner + within) * slice;
  const delta = (((goal - state.angle) % full) + full) % full;
  return state.angle + SPIN_TURNS * full + delta;
}

async function spin() {
  const list = wheelItems();
  if (state.spinning || !list.length) return;
  state.spinning = true;
  renderCount();
  showResult("…", "spinning");
  const winner = randomInt(list.length);
  await turnWheel(spinTarget(winner, list.length), list.length);
  state.spinning = false;
  state.result = list[winner];
  store.picked.push(list[winner]);
  save();
  showResult(list[winner], "done");
  playChime();
  renderHistory();
  drawWheel();
  renderCount();
  if (store.removePicked && !wheelItems().length) showStatus("全部当たりました。「最初から」で元に戻せます", { ms: 6000 });
}

function turnWheel(target, count) {
  const from = state.angle;
  const duration = reducedMotion() ? SPIN_MS_REDUCED : SPIN_MS;
  const begin = performance.now();
  let lastSlice = sliceAtPointer(from, count);
  return new Promise((resolve) => {
    function frame(now) {
      const t = Math.min(1, (now - begin) / duration);
      const eased = 1 - Math.pow(1 - t, 4); // fast first, slowing to a stop
      state.angle = from + (target - from) * eased;
      drawWheel();
      const slice = sliceAtPointer(state.angle, count);
      if (slice !== lastSlice) playTick();
      lastSlice = slice;
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function showResult(text, look) {
  const box = $("wheel-result");
  box.textContent = text;
  box.className = `result ${look}`;
}

function renderHistory() {
  $("history").replaceChildren(...store.picked.map((p) => Object.assign(document.createElement("li"), { textContent: p })));
  $("wheel-reset").disabled = !store.picked.length;
}

function resetWheel() {
  store.picked = [];
  save();
  renderHistory();
  drawWheel();
  renderCount();
  showResult("「回す」を押してください", "");
}

/* ---------- sound (only with 音を出す) ---------- */

let audio = null;

function beep(frequency, length, volume) {
  if (!store.sound) return;
  audio ??= new AudioContext();
  const now = audio.currentTime;
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  tone.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
  tone.connect(gain).connect(audio.destination);
  tone.start(now);
  tone.stop(now + length);
}

const playTick = () => beep(1400, 0.03, 0.05);

function playChime() {
  beep(880, 0.25, 0.12);
  setTimeout(() => beep(1320, 0.4, 0.12), 150);
}

/* ---------- あみだくじ ---------- */

function newLadder() {
  const count = items().length;
  const amida = state.amida;
  amida.lines = count;
  amida.rungs = count >= 2 && count <= MAX_AMIDA ? makeLadder(count) : [];
  amida.traced = new Map();
  renderAmida();
}

const goalLabels = () => bottomLabels(lines(store.goals), state.amida.lines);
const traceColor = (start) => TRACE_COLORS[start % TRACE_COLORS.length];

function renderAmida() {
  const { lines: count } = state.amida;
  const usable = count >= 2 && count <= MAX_AMIDA;
  $("amida-board").hidden = !usable;
  $("amida-all").disabled = !usable || state.amida.tracing || state.amida.traced.size === count;
  $("amida-new").disabled = !usable || state.amida.tracing;
  $("amida-note").textContent = amidaNote(count);
  if (!usable) return;
  $("amida-board").classList.toggle("vertical", count > VERTICAL_LABELS_FROM);
  $("amida-board").style.setProperty("--lines", count);
  renderAmidaTop();
  renderAmidaBottom();
  drawLadder();
}

function amidaNote(count) {
  if (count < 2) return "左の欄に、くじを引く人（2人以上）を入れてください。";
  if (count > MAX_AMIDA) return `あみだくじは${MAX_AMIDA}人までです（今は${count}こ）。`;
  return "上の名前を押すと、線をたどって行き先が分かります。始める前なら、たての線の間をクリックして横線を足せます。";
}

function renderAmidaTop() {
  const { traced, tracing } = state.amida;
  $("amida-top").replaceChildren(...items().map((name, start) => {
    const button = document.createElement("button");
    button.className = "amida-name";
    button.textContent = name;
    button.disabled = tracing || traced.has(start);
    button.style.setProperty("--trace", traceColor(start));
    button.classList.toggle("done", traced.has(start));
    button.addEventListener("click", () => traceOne(start, TRACE_MS));
    return button;
  }));
}

function renderAmidaBottom() {
  const names = items();
  const arrived = new Map([...state.amida.traced].map(([start, end]) => [end, start]));
  $("amida-bottom").replaceChildren(...goalLabels().map((label, end) => {
    const cell = document.createElement("div");
    cell.className = "amida-goal";
    const start = arrived.get(end);
    const open = start !== undefined || state.amida.showBottom;
    cell.classList.toggle("hidden-goal", !open);
    const word = Object.assign(document.createElement("span"), { className: "goal-word", textContent: open ? label : "？" });
    cell.append(word);
    if (start !== undefined) {
      cell.style.setProperty("--trace", traceColor(start));
      cell.classList.add("done");
      cell.append(Object.assign(document.createElement("span"), { className: "goal-who", textContent: names[start] }));
    }
    return cell;
  }));
}

const svgElement = (name, attributes) => {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
};
const lineX = (line) => (line + 0.5) * LADDER_UNIT;
const pointsText = (points) => points.map((p) => `${lineX(p.x)},${p.y * LADDER_UNIT}`).join(" ");

function drawLadder() {
  const { rungs, lines: count, traced } = state.amida;
  const height = (AMIDA_ROWS + 1) * LADDER_UNIT;
  const svg = $("amida-svg");
  svg.setAttribute("viewBox", `0 0 ${count * LADDER_UNIT} ${height}`);
  const parts = [];
  for (let line = 0; line < count; line++) {
    parts.push(svgElement("line", { class: "rail", x1: lineX(line), y1: 0, x2: lineX(line), y2: height }));
  }
  rungs.forEach((row, index) => row.forEach((on, gap) => {
    if (!on) return;
    const y = (index + 1) * LADDER_UNIT;
    parts.push(svgElement("line", { class: "rung", x1: lineX(gap), y1: y, x2: lineX(gap + 1), y2: y }));
  }));
  for (const start of traced.keys()) {
    parts.push(svgElement("polyline", { class: "trace", stroke: traceColor(start), points: pointsText(tracePath(rungs, start).points) }));
  }
  svg.replaceChildren(...parts);
}

// Clicking between two lines before anyone has traced adds a rung there.
function addRungAt(e) {
  const { rungs, lines: count, traced, tracing } = state.amida;
  if (tracing) return;
  if (traced.size) {
    showStatus("たどり始めたあとは横線を足せません。「線を引きなおす」で最初からにできます");
    return;
  }
  const box = $("amida-svg").getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * count;
  const y = ((e.clientY - box.top) / box.height) * (AMIDA_ROWS + 1);
  const gap = Math.floor(x - 0.5);
  const row = Math.round(y) - 1;
  if (!canAddRung(rungs, row, gap)) return;
  rungs[row][gap] = true;
  drawLadder();
}

// Draws the way down from `start`, a little at a time, at an even speed on the screen.
function animateTrace(start, duration) {
  const { points } = tracePath(state.amida.rungs, start);
  const box = $("amida-svg").getBoundingClientRect();
  const scaleX = box.width / state.amida.lines;
  const scaleY = box.height / (AMIDA_ROWS + 1);
  const lengths = points.slice(1).map((p, i) => Math.hypot((p.x - points[i].x) * scaleX, (p.y - points[i].y) * scaleY));
  const total = lengths.reduce((a, b) => a + b, 0);
  const line = svgElement("polyline", { class: "trace moving", stroke: traceColor(start), points: "" });
  $("amida-svg").append(line);
  const begin = performance.now();
  return new Promise((resolve) => {
    function frame(now) {
      const t = reducedMotion() ? 1 : Math.min(1, (now - begin) / duration);
      line.setAttribute("points", pointsText(partOfPath(points, lengths, total * t)));
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

// The first `distance` of the path, as corner points.
function partOfPath(points, lengths, distance) {
  const part = [points[0]];
  let left = distance;
  for (let i = 0; i < lengths.length; i++) {
    const [from, to] = [points[i], points[i + 1]];
    if (left >= lengths[i]) {
      part.push(to);
      left -= lengths[i];
      continue;
    }
    const share = lengths[i] ? left / lengths[i] : 0;
    part.push({ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share });
    break;
  }
  return part;
}

async function traceOne(start, duration) {
  const amida = state.amida;
  if (amida.tracing || amida.traced.has(start)) return;
  amida.tracing = true;
  renderAmida();
  await animateTrace(start, duration);
  const { end } = tracePath(amida.rungs, start);
  amida.traced.set(start, end);
  amida.tracing = false;
  renderAmida();
}

async function traceAll() {
  for (let start = 0; start < state.amida.lines; start++) {
    if (!state.amida.traced.has(start)) await traceOne(start, TRACE_MS_ALL);
  }
}

function traceNext() {
  const count = state.amida.lines;
  const next = Array.from({ length: count }, (_, i) => i).find((i) => !state.amida.traced.has(i));
  if (next !== undefined) traceOne(next, TRACE_MS);
}

function toggleBottom() {
  const amida = state.amida;
  amida.showBottom = !amida.showBottom;
  const button = $("amida-show");
  button.setAttribute("aria-pressed", String(amida.showBottom));
  button.querySelector("use").setAttribute("href", amida.showBottom ? "#i-hide" : "#i-eye");
  button.lastChild.textContent = amida.showBottom ? "下をかくす" : "下を見せる";
  renderAmidaBottom();
}

/* ---------- めくるくじ ---------- */

function newDeck() {
  state.cards.deck = shuffle(items());
  state.cards.opened = new Set();
  renderCards();
}

function renderCards() {
  const { deck, opened } = state.cards;
  $("card-grid").replaceChildren(...deck.map((text, i) => {
    const li = document.createElement("li");
    const card = document.createElement("button");
    card.className = "card";
    card.classList.toggle("open", opened.has(i));
    card.setAttribute("aria-label", opened.has(i) ? `${i + 1}番: ${text}` : `${i + 1}番のカードをめくる`);
    const back = Object.assign(document.createElement("span"), { className: "card-face card-back", textContent: `${i + 1}` });
    const front = Object.assign(document.createElement("span"), { className: "card-face card-front", textContent: text });
    card.append(back, front);
    card.addEventListener("click", () => openCard(i));
    li.append(card);
    return li;
  }));
  renderCardsLeft();
}

function renderCardsLeft() {
  const { deck, opened } = state.cards;
  $("cards-left").textContent = deck.length ? `のこり ${deck.length - opened.size} / ${deck.length}枚` : "左の欄に中身を入れてください";
  $("cards-open-all").disabled = !deck.length || opened.size === deck.length;
  $("cards-shuffle").disabled = !deck.length;
}

function openCard(i) {
  const { opened } = state.cards;
  if (opened.has(i)) return;
  opened.add(i);
  const card = $("card-grid").children[i]?.querySelector(".card");
  card?.classList.add("open");
  card?.setAttribute("aria-label", `${i + 1}番: ${state.cards.deck[i]}`);
  renderCardsLeft();
}

function openAllCards() {
  state.cards.deck.forEach((_, i) => openCard(i));
}

/* ---------- 順番決め ---------- */

function decideOrder() {
  if (items().length < 2) return;
  state.order = shuffle(items());
  renderOrder();
}

function renderOrder() {
  const stagger = reducedMotion() ? 0 : ORDER_STAGGER_MS;
  $("order-list").replaceChildren(...state.order.map((text, i) => {
    const li = Object.assign(document.createElement("li"), { textContent: text });
    li.style.animationDelay = `${i * stagger}ms`;
    return li;
  }));
  $("order-copy").disabled = !state.order.length;
}

async function copyOrder() {
  const text = state.order.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const copied = await copyText(text);
  showStatus(copied ? "順番をコピーしました" : "コピーできませんでした", { error: !copied });
}

/* ---------- modes ---------- */

function showMode(mode) {
  store.mode = mode;
  save();
  for (const tab of document.querySelectorAll(".tab")) tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  for (const name of MODES) $(name).hidden = name !== mode;
  $("items-label").textContent = mode === "amida" ? "くじを引く人（1行に1人）" : "くじの中身（1行に1つ）";
  if (mode === "wheel") drawWheel();
  if (mode === "amida") drawLadder();
}

// Space runs the main button of the screen that is showing.
const SPACE_ACTIONS = { wheel: spin, amida: traceNext, order: decideOrder };

function onKey(e) {
  const typing = e.target.closest("input, textarea, select, button, summary, a");
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "f" || e.key === "F") toggleFullscreen();
  if (e.key !== " ") return;
  const action = SPACE_ACTIONS[store.mode];
  if (!action) return;
  e.preventDefault();
  action();
}

/* ---------- start ---------- */

for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showMode(tab.dataset.mode));
$("items").addEventListener("input", () => setItems($("items").value));
$("fill-numbers").addEventListener("click", fillNumbers);
$("fill-wins").addEventListener("click", fillWins);
$("spin-btn").addEventListener("click", spin);
$("wheel-reset").addEventListener("click", resetWheel);
$("remove-picked").addEventListener("change", (e) => {
  store.removePicked = e.target.checked;
  save();
  drawWheel();
  renderCount();
});
$("sound").addEventListener("change", (e) => {
  store.sound = e.target.checked;
  save();
});
$("amida-svg").addEventListener("click", addRungAt);
$("amida-all").addEventListener("click", traceAll);
$("amida-new").addEventListener("click", newLadder);
$("amida-show").addEventListener("click", toggleBottom);
$("goals").addEventListener("input", (e) => {
  store.goals = e.target.value;
  save();
  renderAmidaBottom();
});
$("cards-shuffle").addEventListener("click", newDeck);
$("cards-open-all").addEventListener("click", openAllCards);
$("order-btn").addEventListener("click", decideOrder);
$("order-copy").addEventListener("click", copyOrder);
$("fullscreen-btn").addEventListener("click", toggleFullscreen);
document.addEventListener("keydown", onKey);
new ResizeObserver(() => drawWheel()).observe($("wheel-canvas").parentElement);

$("items").value = store.items;
$("goals").value = store.goals;
$("remove-picked").checked = store.removePicked;
$("sound").checked = store.sound;
setItems(store.items);
showMode(store.mode);
if (store.picked.length) showResult(store.picked.at(-1), "done");

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "amida.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__lottery = { store, state, items, wheelItems, spin, traceOne, traceAll, newLadder, newDeck, openCard, decideOrder };
