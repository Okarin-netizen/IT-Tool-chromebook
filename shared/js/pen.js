// Telling a pen (Apple Pencil, a Chromebook stylus) from a finger on the drawing tools.
//
// 「ペンだけで書く」 (pen-only) is one setting for the whole site, kept on this device:
//   off (the default)  pen, finger and mouse all draw, as before
//   on                 pen and mouse draw; one or two fingers scroll the page instead, and a
//                      hand resting on the screen draws nothing
// The first time a pen touches a drawing surface it turns itself on (like Excalidraw and
// tldraw), so nobody has to find the switch. Once someone presses the button themselves, it is
// never switched for them again. People without a pen never see any change.
//
// A tool asks canDraw(e) on pointerdown. When the answer is no for a finger, it hands the
// pointer to scrollWithFinger(e, scroller), which moves the page with the finger and lets it
// glide a little after release. Drawing surfaces keep `touch-action: none` (class
// .draw-surface in base.css) so this works the same in Safari and Chrome.
import { loadText, saveText } from "./storage.js";
import { showStatus } from "./status.js";

const STORE_KEY = "portal-pen-only"; // "on" / "off"; missing = never decided (auto may switch it on)
const PALM_MS = 600; // fingers that land this soon after the pen lifts are taken for the hand
const GLIDE_FRICTION = 0.94; // speed kept per frame (16 ms) after the finger lifts
const GLIDE_MIN_SPEED = 0.03; // px per ms; slower than this the glide stops
const GLIDE_MAX_SPEED = 4; // px per ms; a quick flick glides no faster than this
const VELOCITY_WINDOW_MS = 100; // finger movement this recent decides the glide speed

let penOnly = loadText(STORE_KEY) === "on";
let decided = loadText(STORE_KEY) !== null;
const listeners = new Set();
const penDownListeners = new Set();
const pensDown = new Set(); // pointer ids of pens touching the screen now
let penLiftedAt = -Infinity;

export const isPenOnly = () => penOnly;

// `byPerson`: the button was pressed, so the choice is theirs from now on.
export function setPenOnly(on, { byPerson = true } = {}) {
  if (byPerson) decided = true;
  if (on === penOnly) {
    if (byPerson) saveText(STORE_KEY, on ? "on" : "off");
    return;
  }
  penOnly = on;
  saveText(STORE_KEY, on ? "on" : "off");
  if (!byPerson) decided = false; // switched for them: they have not chosen yet
  for (const listener of listeners) listener(on);
}

// `listener(on)` runs whenever the setting changes. Returns a function that stops it.
export function onPenOnlyChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// `listener()` runs when a pen touches the screen. Lets a finger's stroke that was already
// going (the hand landed just before the pen) be thrown away. Returns a function that stops it.
export function onPenDown(listener) {
  penDownListeners.add(listener);
  return () => penDownListeners.delete(listener);
}

// Whether this pointer may draw. Pens and mice always may. A finger may not while pen-only is
// on, nor while a pen is down or has just lifted (that is the hand holding it).
export function canDraw(e) {
  if (e.pointerType !== "touch") return true;
  if (penOnly) return false;
  return !handIsWriting();
}

// A finger touching while a pen is down or has just lifted: the hand holding the pen. For
// places a finger may still write in pen-only mode (the signature pad).
export const isHandResting = (e) => e.pointerType === "touch" && handIsWriting();

const handIsWriting = () => pensDown.size > 0 || performance.now() - penLiftedAt < PALM_MS;

// The pen is watched on the whole page (capture phase, before any tool sees the event), so
// the first touch anywhere on a drawing surface already counts.
function watchPens() {
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "pen") return;
    pensDown.add(e.pointerId);
    stopAllFingerScrolls(); // the hand landed first and started scrolling: stop it
    for (const listener of [...penDownListeners]) listener();
    if (!penOnly && !decided && e.target.closest?.(".draw-surface")) switchOnForPen();
  }, true);
  const lift = (e) => {
    if (e.pointerType !== "pen" || !pensDown.delete(e.pointerId)) return;
    penLiftedAt = performance.now();
  };
  document.addEventListener("pointerup", lift, true);
  document.addEventListener("pointercancel", lift, true);
}

function switchOnForPen() {
  setPenOnly(true, { byPerson: false });
  showStatus("ペンを見つけたので「ペンだけで書く」にしました。指でさわるとスクロールします。もどすときは上の「ペンだけ」ボタンを押します", { ms: 7000 });
}

/* ---------- moving the page with fingers ---------- */

const scrolls = new Map(); // scroller → its finger scroll

// Moves `scroller` with this finger (and any other finger already on it) until they lift.
// The pointer is captured on the element that got the event, as trackPointer does.
export function scrollWithFinger(e, scroller) {
  e.preventDefault();
  if (handIsWriting()) return; // a hand resting next to the pen: do nothing at all
  let scroll = scrolls.get(scroller);
  if (!scroll) {
    scroll = createFingerScroll(scroller);
    scrolls.set(scroller, scroll);
  }
  scroll.add(e);
}

function stopAllFingerScrolls() {
  for (const scroll of scrolls.values()) scroll.stop();
}

function createFingerScroll(scroller) {
  const fingers = new Map(); // pointer id → { x, y, target }
  let samples = []; // { t, dx, dy } of recent movement, for the glide
  let glideFrame = 0;

  function add(e) {
    cancelAnimationFrame(glideFrame);
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, target });
    if (fingers.size === 1) samples = [];
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  // With two fingers the page follows their middle, so each counts for half.
  function move(e) {
    const finger = fingers.get(e.pointerId);
    if (!finger) return;
    const share = 1 / fingers.size;
    const dx = (finger.x - e.clientX) * share;
    const dy = (finger.y - e.clientY) * share;
    finger.x = e.clientX;
    finger.y = e.clientY;
    scroller.scrollBy(dx, dy);
    const now = performance.now();
    samples.push({ t: now, dx, dy });
    samples = samples.filter((s) => now - s.t < VELOCITY_WINDOW_MS);
  }

  function up(e) {
    const finger = fingers.get(e.pointerId);
    if (!finger) return;
    release(e.pointerId, finger);
    if (!fingers.size && e.type === "pointerup") glide();
  }

  function release(id, finger) {
    fingers.delete(id);
    finger.target.removeEventListener("pointermove", move);
    finger.target.removeEventListener("pointerup", up);
    finger.target.removeEventListener("pointercancel", up);
  }

  // Keeps going a little after the finger lifts, slowing down, like a normal page.
  function glide() {
    const now = performance.now();
    const recent = samples.filter((s) => now - s.t < VELOCITY_WINDOW_MS);
    if (recent.length < 2) return;
    const span = Math.max(16, now - recent[0].t);
    let vx = recent.reduce((sum, s) => sum + s.dx, 0) / span;
    let vy = recent.reduce((sum, s) => sum + s.dy, 0) / span;
    const limit = Math.min(1, GLIDE_MAX_SPEED / Math.hypot(vx, vy));
    vx *= limit;
    vy *= limit;
    let last = now;
    const step = (t) => {
      const frames = (t - last) / 16;
      last = t;
      scroller.scrollBy(vx * 16 * frames, vy * 16 * frames);
      const keep = GLIDE_FRICTION ** frames;
      vx *= keep;
      vy *= keep;
      if (Math.hypot(vx, vy) > GLIDE_MIN_SPEED) glideFrame = requestAnimationFrame(step);
    };
    glideFrame = requestAnimationFrame(step);
  }

  function stop() {
    cancelAnimationFrame(glideFrame);
    for (const [id, finger] of [...fingers]) release(id, finger);
  }

  return { add, stop };
}

/* ---------- the drawing surface ---------- */

// Marks `el` as a place to draw on. Safari's Scribble (handwriting into text boxes) can eat
// pen movement unless the pen's touchmove is cancelled; fingers are left alone so that tools
// which let the browser scroll (the 選択 tool) still can.
export function drawSurface(el) {
  el.classList.add("draw-surface");
  el.addEventListener("touchmove", (e) => {
    if ([...e.changedTouches].some((t) => t.touchType === "stylus")) e.preventDefault();
  }, { passive: false });
  return el;
}

/* ---------- the button ---------- */

// Touch screens only: on a computer with just a mouse the setting does nothing.
const hasTouch = () => navigator.maxTouchPoints > 0 || matchMedia("(any-pointer: coarse)").matches;

const PEN_ICON = '<svg class="i" aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20l1-4L14 7l3 3-9 9z"/><path d="M15 6l2-2 3 3-2 2"/><path d="M14 20h6"/></svg>';

// The 「ペンだけ」 toggle in a toolbar group of its own (<div class="group">). It stays hidden on
// screens without touch unless the setting is already on, and follows changes made anywhere
// (the automatic switch).
export function penButtonGroup() {
  const group = document.createElement("div");
  group.className = "group pen-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "ペンと指");
  const button = penButton();
  group.append(button);
  const show = () => (group.hidden = button.hidden);
  onPenOnlyChange(show);
  show();
  return group;
}

export function penButton({ className = "btn pen-only-btn" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = "ペンだけで書く: オンのときは、指でさわるとスクロールになり、手を画面に置いて書けます";
  button.innerHTML = `${PEN_ICON}ペンだけ`;
  const show = (on) => {
    button.setAttribute("aria-pressed", String(on));
    button.classList.toggle("selected", on);
    button.hidden = !on && !hasTouch();
  };
  button.addEventListener("click", () => {
    setPenOnly(!penOnly);
    showStatus(penOnly ? "ペンだけで書く: オン（指でさわるとスクロール）" : "ペンだけで書く: オフ（指でも書けます）");
  });
  onPenOnlyChange(show);
  show(penOnly);
  return button;
}

watchPens();

