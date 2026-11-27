// ペンの確認: shows what the browser reports for pen, finger and mouse, and lets the two ways
// of scrolling with a finger be compared on a real device (see shared/js/pen.js).
//   方法1  the drawing surface keeps touch-action: none and the page is moved by our code
//   方法2  touch-action: pan-x pan-y lets the browser scroll; the pen's touchmove is cancelled
import { canDraw, scrollWithFinger, drawSurface, penButtonGroup, isPenOnly, onPenOnlyChange } from "../shared/js/pen.js";
import { pixelRatio } from "../shared/js/canvas.js";

const RATE_WINDOW_MS = 1000; // points counted over this long for "1秒あたりの点の数"
const LOG_LINES = 12;
const TYPE_NAMES = { pen: "ペン", touch: "指", mouse: "マウス" };
const PEN_COLOR = "#1d2228";
const FINGER_COLOR = "#d11a1a"; // a finger line on 方法2 shows that fingers also draw there

const $ = (id) => document.getElementById(id);
const readout = {
  type: $("r-type"), rate: $("r-rate"), coalesced: $("r-coalesced"), pressure: $("r-pressure"),
  tilt: $("r-tilt"), stylus: $("r-stylus"), mode: $("r-mode"),
};
const pads = [
  { canvas: $("pad1"), box: $("box1"), ownScroll: true },
  { canvas: $("pad2"), box: $("box2"), ownScroll: false },
];
let pointTimes = [];
let sawCoalesced = false;

/* ---------- what the browser reports ---------- */

function log(text) {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("ja-JP");
  item.textContent = `${time} ${text}`;
  $("log").prepend(item);
  while ($("log").children.length > LOG_LINES) $("log").lastChild.remove();
}

function showPointer(e, coalescedCount) {
  readout.type.textContent = TYPE_NAMES[e.pointerType] ?? e.pointerType;
  const now = performance.now();
  pointTimes.push(...Array(coalescedCount).fill(now));
  pointTimes = pointTimes.filter((t) => now - t < RATE_WINDOW_MS);
  readout.rate.textContent = `${pointTimes.length} 点`;
  if (coalescedCount > 1) sawCoalesced = true;
  const supported = typeof PointerEvent.prototype.getCoalescedEvents === "function";
  readout.coalesced.textContent = supported ? `使える（${sawCoalesced ? "拾えている" : "まだ1点ずつ"}）` : "使えない";
  readout.pressure.textContent = e.pressure.toFixed(2);
  readout.tilt.textContent = `${e.tiltX}°, ${e.tiltY}°`;
}

function showMode(on) {
  readout.mode.textContent = on ? "オン（指はスクロール）" : "オフ（指でも書く）";
}

/* ---------- drawing ---------- */

function sizePad({ canvas }) {
  const dpr = pixelRatio();
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 方法1 asks pen.js; 方法2 lets the browser take fingers (it cancels them when it scrolls).
function onDown(e, pad) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  log(`${TYPE_NAMES[e.pointerType] ?? e.pointerType}が ${pad.ownScroll ? "方法1" : "方法2"} にふれた`);
  if (pad.ownScroll && !canDraw(e)) {
    scrollWithFinger(e, pad.box);
    return;
  }
  if (!pad.ownScroll && e.pointerType === "touch" && isPenOnly()) return;
  e.preventDefault();
  drawFrom(e, pad);
}

function drawFrom(e, pad) {
  const { canvas } = pad;
  const ctx = canvas.getContext("2d");
  const rect = () => canvas.getBoundingClientRect();
  const at = (ev) => [ev.clientX - rect().left, ev.clientY - rect().top];
  let last = at(e);
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = e.pointerType === "touch" ? FINGER_COLOR : PEN_COLOR;
  canvas.setPointerCapture(e.pointerId);
  showPointer(e, 1);
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const events = ev.getCoalescedEvents?.() ?? [];
    const points = events.length ? events : [ev];
    showPointer(ev, points.length);
    ctx.beginPath();
    ctx.moveTo(...last);
    for (const p of points) {
      last = at(p);
      ctx.lineTo(...last);
    }
    ctx.stroke();
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    if (ev.type === "pointercancel") log("ブラウザが線を止めた（スクロールになった）");
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
}

/* ---------- events ---------- */

drawSurface(pads[0].canvas);
// 方法2: only the pen's movement is cancelled, so fingers still scroll the box natively.
pads[1].canvas.addEventListener("touchmove", (e) => {
  if ([...e.changedTouches].some((t) => t.touchType === "stylus")) e.preventDefault();
}, { passive: false });

for (const pad of pads) {
  sizePad(pad);
  pad.canvas.addEventListener("pointerdown", (e) => onDown(e, pad));
}
// Safari tells pen from finger on touch events too: shows whether it does on this device.
document.addEventListener("touchstart", (e) => {
  const kinds = [...e.changedTouches].map((t) => t.touchType ?? "なし");
  readout.stylus.textContent = kinds.includes("stylus") ? "stylus（ペンと分かる）" : `${kinds.join(", ")}`;
}, { passive: true });

$("clear-btn").addEventListener("click", () => pads.forEach(sizePad));
$("pen-slot").replaceWith(penButtonGroup());
onPenOnlyChange((on) => {
  showMode(on);
  log(on ? "「ペンだけで書く」がオンになった" : "「ペンだけで書く」がオフになった");
});
showMode(isPenOnly());
$("r-agent").textContent = navigator.userAgent;
