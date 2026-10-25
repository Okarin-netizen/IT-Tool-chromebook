import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";

const $ = (id) => document.getElementById(id);

const STORE_KEY = "timer-tool-v1";
const PRESETS = [1, 3, 5, 10, 15, 20, 30, 45, 50, 60];
const RING_LEN = 2 * Math.PI * 90;
const PHASE_LABEL = { work: "集中", short: "休憩", long: "長い休憩" };

const defaults = {
  mode: "pomodoro",
  sound: true,
  settings: { work: 25, short: 5, long: 15, rounds: 4, auto: true },
  pomodoro: { phase: "work", done: 0, remaining: null, endAt: null },
  timer: { total: 10 * 60000, remaining: null, endAt: null },
  stopwatch: { elapsed: 0, startedAt: null, laps: [] },
  today: { date: "", count: 0, minutes: 0 },
};

const state = load();
let finishTimer = null;
let wakeLock = null;
let audio = null;

// ---------- storage ----------

function load() {
  const saved = loadJson(STORE_KEY) || {};
  const s = structuredClone(defaults);
  for (const key of Object.keys(s)) {
    if (saved[key] === undefined) continue;
    s[key] = typeof s[key] === "object" ? { ...s[key], ...saved[key] } : saved[key];
  }
  return s;
}

function save() {
  saveJson(STORE_KEY, state);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function today() {
  if (state.today.date !== todayStr()) state.today = { date: todayStr(), count: 0, minutes: 0 };
  return state.today;
}

// ---------- time helpers ----------

function fmt(ms, { tenths = false, ceil = true } = {}) {
  ms = Math.max(0, ms);
  const totalSec = ceil ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  let out = h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (tenths) out += `.${Math.floor((ms % 1000) / 100)}`;
  return out;
}

function phaseMs(phase) {
  return state.settings[phase] * 60000;
}

// The countdown currently on screen (pomodoro or timer).
function countdown() {
  return state.mode === "pomodoro" ? state.pomodoro : state.timer;
}

function totalOf(kind) {
  return kind === "pomodoro" ? phaseMs(state.pomodoro.phase) : state.timer.total;
}

function remaining(kind = state.mode) {
  const c = state[kind];
  if (c.endAt) return c.endAt - Date.now();
  return c.remaining ?? totalOf(kind);
}

function isRunning() {
  if (state.mode === "stopwatch") return state.stopwatch.startedAt != null;
  return countdown().endAt != null;
}

function swElapsed() {
  const sw = state.stopwatch;
  return sw.elapsed + (sw.startedAt ? Date.now() - sw.startedAt : 0);
}

// ---------- sound / notification / wake lock ----------

function beep(times = 3) {
  if (!state.sound) return;
  try {
    audio ||= new AudioContext();
    if (audio.state === "suspended") audio.resume();
    const t0 = audio.currentTime + 0.05;
    for (let r = 0; r < times; r++) {
      for (let i = 0; i < 3; i++) {
        const t = t0 + r * 1.2 + i * 0.22;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(gain).connect(audio.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      }
    }
  } catch { /* no audio available */ }
}

function unlockAudio() {
  // Browsers only allow sound after a click, so create the audio context on the first click.
  try {
    audio ||= new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch { /* ignore */ }
}

function notify(text) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  try { new Notification("タイマー", { body: text, icon: "icon.svg", tag: "timer" }); } catch { /* ignore */ }
}

function askNotification() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed; fine */ }
}

// ---------- actions ----------

function scheduleFinish() {
  clearTimeout(finishTimer);
  finishTimer = null;
  const ends = ["pomodoro", "timer"].map((k) => state[k].endAt).filter(Boolean);
  if (!ends.length) return;
  // A one-shot timeout fires on time even in a background tab; the render loop alone may be throttled.
  finishTimer = setTimeout(checkFinish, Math.max(0, Math.min(...ends) - Date.now()) + 30);
}

function start(kind = state.mode) {
  unlockAudio();
  if (kind === state.mode) document.body.classList.remove("done");
  if (kind === "stopwatch") {
    state.stopwatch.startedAt = Date.now();
  } else {
    askNotification();
    const c = state[kind];
    let left = remaining(kind);
    if (left <= 0) left = totalOf(kind);
    c.endAt = Date.now() + left;
    c.remaining = null;
  }
  keepAwake(true);
  afterChange();
}

function pause() {
  if (state.mode === "stopwatch") {
    const sw = state.stopwatch;
    sw.elapsed = swElapsed();
    sw.startedAt = null;
  } else {
    const c = countdown();
    c.remaining = Math.max(0, remaining());
    c.endAt = null;
  }
  keepAwake(false);
  afterChange();
}

function reset() {
  document.body.classList.remove("done");
  if (state.mode === "stopwatch") {
    state.stopwatch = { elapsed: 0, startedAt: null, laps: [] };
  } else if (state.mode === "timer") {
    Object.assign(state.timer, { remaining: null, endAt: null });
  } else {
    // First press resets the current phase; pressing again when nothing is in progress clears the set.
    const p = state.pomodoro;
    if (p.endAt == null && p.remaining == null) Object.assign(p, { phase: "work", done: 0 });
    Object.assign(p, { remaining: null, endAt: null });
  }
  keepAwake(false);
  afterChange();
}

function nextPhase({ counted }) {
  const p = state.pomodoro;
  if (p.phase === "work") {
    if (counted) {
      const t = today();
      t.count += 1;
      t.minutes += state.settings.work;
    }
    p.done += 1;
    p.phase = p.done >= state.settings.rounds ? "long" : "short";
  } else {
    if (p.phase === "long") p.done = 0;
    p.phase = "work";
  }
  p.remaining = null;
  p.endAt = null;
}

function skip() {
  if (state.mode !== "pomodoro") return;
  const wasRunning = isRunning();
  document.body.classList.remove("done");
  nextPhase({ counted: false });
  if (wasRunning) start(); else { keepAwake(false); afterChange(); }
}

function lap() {
  if (state.mode !== "stopwatch" || !isRunning()) return;
  state.stopwatch.laps.push(swElapsed());
  afterChange();
}

function checkFinish() {
  for (const kind of ["pomodoro", "timer"]) {
    if (state[kind].endAt && remaining(kind) <= 0) finish(kind);
  }
}

// Countdowns keep going while another mode is on screen, so this may finish the one not shown.
function finish(kind) {
  beep();
  const shown = kind === state.mode;
  if (kind === "timer") {
    Object.assign(state.timer, { remaining: 0, endAt: null });
    if (shown) document.body.classList.add("done");
    notify("時間になりました！");
    showStatus("時間になりました", { ms: 3000 });
    keepAwake(false);
    afterChange();
    return;
  }
  const finished = state.pomodoro.phase;
  nextPhase({ counted: true });
  const msg = finished === "work"
    ? `お疲れさまでした！${PHASE_LABEL[state.pomodoro.phase]}しましょう`
    : "休憩おわり。集中をはじめましょう";
  notify(msg);
  showStatus(msg, { ms: 3000 });
  if (state.settings.auto) {
    start("pomodoro");
  } else {
    if (shown) document.body.classList.add("done");
    keepAwake(false);
    afterChange();
  }
}

function setMode(mode) {
  if (mode === state.mode) return;
  // Switching modes leaves the other modes' clocks running in the background.
  state.mode = mode;
  document.body.classList.remove("done");
  afterChange();
  buildPresets();
  keepAwake(isRunning());
}

function setTimerTotal(ms) {
  if (ms <= 0) return;
  state.timer = { total: ms, remaining: null, endAt: null };
  document.body.classList.remove("done");
  afterChange();
  buildPresets();
}

function afterChange() {
  save();
  scheduleFinish();
  render();
}

// ---------- rendering ----------

function buildPresets() {
  const box = $("presets");
  box.replaceChildren();
  for (const min of PRESETS) {
    const b = document.createElement("button");
    b.className = "btn chip";
    b.textContent = `${min}分`;
    b.classList.toggle("selected", state.timer.total === min * 60000);
    b.addEventListener("click", () => setTimerTotal(min * 60000));
    box.append(b);
  }
}

function render() {
  const mode = state.mode;
  const running = isRunning();

  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.mode === mode)));
  document.body.classList.toggle("stopwatch", mode === "stopwatch");
  document.body.classList.toggle("rest", mode === "pomodoro" && state.pomodoro.phase !== "work");

  $("timer-setup").hidden = mode !== "timer";
  $("pomodoro-info").hidden = mode !== "pomodoro";
  $("skip-btn").hidden = mode !== "pomodoro";
  $("lap-btn").hidden = mode !== "stopwatch";
  $("lap-btn").disabled = !running;
  $("laps").hidden = mode !== "stopwatch" || state.stopwatch.laps.length === 0;
  document.querySelectorAll("#timer-setup button, #timer-setup input").forEach((el) => { el.disabled = running; });

  const startBtn = $("start-btn");
  const paused = mode === "stopwatch" ? state.stopwatch.elapsed > 0 : countdown().remaining > 0 && countdown().remaining < totalOf(mode);
  startBtn.textContent = running ? "一時停止" : paused ? "再開" : "スタート";

  $("sound-btn").innerHTML = `<svg class="i" aria-hidden="true"><use href="#i-${state.sound ? "bell" : "bell-off"}"/></svg>`;

  if (mode === "pomodoro") {
    const p = state.pomodoro;
    $("phase").textContent = `${PHASE_LABEL[p.phase]}（${state.settings[p.phase]}分）`;
    const dots = $("dots");
    dots.replaceChildren();
    for (let i = 0; i < state.settings.rounds; i++) {
      const d = document.createElement("span");
      d.className = "dot" + (i < p.done ? " filled" : "");
      dots.append(d);
    }
    const t = today();
    $("today-count").textContent = t.count;
    $("today-min").textContent = t.minutes;
  } else if (mode === "timer") {
    $("phase").textContent = `${fmt(state.timer.total)} のタイマー`;
  } else {
    $("phase").textContent = "ストップウォッチ";
    renderLaps();
  }

  tick();
}

function renderLaps() {
  const list = $("laps");
  list.replaceChildren();
  const laps = state.stopwatch.laps;
  for (let i = laps.length - 1; i >= 0; i--) {
    const li = document.createElement("li");
    const split = laps[i] - (laps[i - 1] ?? 0);
    li.innerHTML = `<span>ラップ ${i + 1}</span><span class="split">+${fmt(split, { tenths: true, ceil: false })}</span><span>${fmt(laps[i], { tenths: true, ceil: false })}</span>`;
    list.append(li);
  }
}

function tick() {
  checkFinish();
  const display = $("display");
  const ring = $("ring");
  let text;
  let progress;
  if (state.mode === "stopwatch") {
    const ms = swElapsed();
    text = fmt(ms, { tenths: true, ceil: false });
    progress = (ms % 60000) / 60000;
    document.title = isRunning() ? `${fmt(ms, { ceil: false })} ストップウォッチ` : "タイマー・ポモドーロ";
  } else {
    const left = Math.max(0, remaining());
    const total = totalOf(state.mode);
    text = fmt(left);
    progress = total ? left / total : 0;
    const label = state.mode === "pomodoro" ? PHASE_LABEL[state.pomodoro.phase] : "タイマー";
    document.title = isRunning() ? `${text} ${label}` : "タイマー・ポモドーロ";
  }
  if (display.textContent !== text) display.textContent = text;
  display.classList.toggle("small", text.length > 7);
  ring.style.strokeDasharray = RING_LEN;
  ring.style.strokeDashoffset = RING_LEN * (1 - progress);
}

// ---------- events ----------

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));

$("start-btn").addEventListener("click", () => (isRunning() ? pause() : start()));
$("reset-btn").addEventListener("click", reset);
$("skip-btn").addEventListener("click", skip);
$("lap-btn").addEventListener("click", lap);

$("sound-btn").addEventListener("click", () => {
  state.sound = !state.sound;
  save();
  render();
  if (state.sound) { unlockAudio(); beep(1); }
  showStatus(state.sound ? "音をオンにしました" : "音をオフにしました", { ms: 3000 });
});

$("custom-set").addEventListener("click", () => {
  const m = Math.max(0, Math.min(999, parseInt($("custom-min").value, 10) || 0));
  const s = Math.max(0, Math.min(59, parseInt($("custom-sec").value, 10) || 0));
  if (m === 0 && s === 0) { showStatus("1秒以上の時間を入れてください", { ms: 3000 }); return; }
  setTimerTotal((m * 60 + s) * 1000);
});

const settingInputs = { work: "set-work", short: "set-short", long: "set-long", rounds: "set-rounds" };
for (const [key, id] of Object.entries(settingInputs)) {
  const input = $(id);
  input.value = state.settings[key];
  input.addEventListener("change", () => {
    const v = parseInt(input.value, 10);
    const min = Number(input.min);
    const max = Number(input.max);
    if (!Number.isFinite(v)) { input.value = state.settings[key]; return; }
    state.settings[key] = Math.max(min, Math.min(max, v));
    input.value = state.settings[key];
    // A paused or idle phase picks up the new length right away; a running one keeps its end time.
    const p = state.pomodoro;
    if (!p.endAt && p.phase === key) p.remaining = null;
    if (key === "rounds" && p.done > state.settings.rounds) p.done = state.settings.rounds;
    afterChange();
  });
}
$("set-auto").checked = state.settings.auto;
$("set-auto").addEventListener("change", () => {
  state.settings.auto = $("set-auto").checked;
  save();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$("fullscreen-btn").addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("fullscreen", !!document.fullscreenElement);
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest("input, select, textarea")) return;
  if (e.key === " ") {
    // Space always means start/pause, even while a tab or other button has focus.
    e.preventDefault();
    if (e.repeat) return;
    $("start-btn").click();
  } else if (e.key === "r" || e.key === "R") {
    reset();
  } else if (e.key === "f" || e.key === "F") {
    toggleFullscreen();
  } else if ((e.key === "l" || e.key === "L") && state.mode === "stopwatch") {
    lap();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    keepAwake(isRunning());
    tick();
  }
});

// Another tab of this tool changed the saved state: follow it.
window.addEventListener("storage", (e) => {
  if (e.key !== STORE_KEY) return;
  Object.assign(state, load());
  scheduleFinish();
  buildPresets();
  render();
});

// The clock is redrawn 10 times a second only while the one on screen runs; when it is stopped,
// render() draws it once after each change. A countdown in another mode ends via scheduleFinish().
setInterval(() => { if (isRunning()) tick(); }, 100);

// Picks up where it left off after a reload; a countdown that ran out while closed just ends quietly.
for (const c of [state.pomodoro, state.timer]) {
  if (c.endAt && c.endAt <= Date.now()) { c.endAt = null; c.remaining = 0; }
}
buildPresets();
render();
scheduleFinish();
if (isRunning()) keepAwake(true);

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);
