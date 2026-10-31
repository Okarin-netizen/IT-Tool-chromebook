import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { toggleFullscreen } from "../shared/js/fullscreen.js";

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
  // until: "14:30" when the timer ends at a clock time; startedAt / lastEnd: for the exam board
  timer: { total: 10 * 60000, remaining: null, endAt: null, until: null, startedAt: null, lastEnd: null },
  stopwatch: { elapsed: 0, startedAt: null, laps: [] },
  today: { date: "", count: 0, minutes: 0 },
  exam: false, // 試験モード: the start and end times, and the time now, shown large
};
// When the countdown turns orange and red: 5 minutes and 1 minute before the end, or a share
// of a short timer.
const WARN_MS = 5 * 60000;
const URGENT_MS = 60000;

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

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (t) => {
  const d = new Date(t);
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
};

// Today's moment for "14:30".
function untilTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
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
  if (c.remaining == null && kind === "timer" && c.until) return Math.max(0, untilTime(c.until) - Date.now());
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
    const now = Date.now();
    if (kind === "timer" && c.until) {
      // "14:30 まで" ends at 14:30 however long it was paused.
      const end = untilTime(c.until);
      if (end <= now) {
        showStatus(`${c.until} はもう過ぎています。時刻を入れ直してください`, { error: true, ms: 4000 });
        return;
      }
      if (c.remaining == null || !c.startedAt) c.total = end - now;
      c.endAt = end;
    } else {
      let left = remaining(kind);
      if (left <= 0) left = totalOf(kind);
      c.endAt = now + left;
    }
    if (kind === "timer" && (!c.startedAt || c.remaining == null || c.remaining === 0)) c.startedAt = now;
    if (kind === "timer") c.lastEnd = c.endAt;
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
    Object.assign(state.timer, { remaining: null, endAt: null, startedAt: null, lastEnd: null });
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
  state.timer = { total: ms, remaining: null, endAt: null, until: null, startedAt: null, lastEnd: null };
  document.body.classList.remove("done");
  afterChange();
  buildPresets();
}

// A timer that ends at a clock time, such as the end of a test.
function setUntil(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) {
    showStatus("終わりの時刻を入れてください", { ms: 3000 });
    return;
  }
  hhmm = hhmm.replace(/^0(\d)/, "$1"); // "09:50" is shown as 9:50, like the other times
  const left = untilTime(hhmm) - Date.now();
  if (left <= 0) {
    showStatus(`${hhmm} はもう過ぎています`, { error: true, ms: 3000 });
    return;
  }
  state.timer = { total: left, remaining: null, endAt: null, until: hhmm, startedAt: null, lastEnd: null };
  document.body.classList.remove("done");
  afterChange();
  buildPresets();
  showStatus(`${hhmm} までのタイマーにしました。スタートを押してください`, { ms: 3000 });
}

const examShown = () => state.exam && state.mode === "timer";

// 試験モード: when the test started, when it ends, and the time now.
function renderExam() {
  $("exam-board").hidden = !examShown();
  document.body.classList.toggle("exam", examShown());
  if (!examShown()) return;
  const c = state.timer;
  const now = Date.now();
  let end = null;
  if (c.endAt) end = c.endAt;
  else if (c.until) end = untilTime(c.until);
  else if (c.remaining === 0) end = c.lastEnd;
  else if (c.startedAt && c.remaining > 0) end = now + c.remaining; // paused: if it went on now
  const set = (id, text) => {
    const el = $(id);
    if (el.textContent !== text) el.textContent = text;
  };
  set("exam-start", c.startedAt ? clock(c.startedAt) : "--:--");
  set("exam-end", end ? clock(end) : "--:--");
  set("exam-now", clock(now));
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
  document.querySelectorAll("#timer-setup button, #timer-setup input:not(#exam-on)").forEach((el) => { el.disabled = running; });
  document.body.classList.toggle("running", running);

  $("start-btn").textContent = startLabel(mode, running);
  $("exam-on").checked = state.exam;
  $("sound-btn").innerHTML = `<svg class="i" aria-hidden="true"><use href="#i-${state.sound ? "bell" : "bell-off"}"/></svg>`;

  if (mode === "pomodoro") {
    renderPomodoro();
  } else if (mode === "timer") {
    $("phase").textContent = state.timer.until ? `${state.timer.until} までのタイマー` : `${fmt(state.timer.total)} のタイマー`;
  } else {
    $("phase").textContent = "ストップウォッチ";
    renderLaps();
  }

  tick();
}

// "一時停止" while running, "再開" when stopped part way, "スタート" otherwise.
function startLabel(mode, running) {
  if (running) return "一時停止";
  const started = mode === "stopwatch"
    ? state.stopwatch.elapsed > 0
    : countdown().remaining > 0 && countdown().remaining < totalOf(mode);
  return started ? "再開" : "スタート";
}

// The phase, a dot for each round of the set, and today's count.
function renderPomodoro() {
  const p = state.pomodoro;
  $("phase").textContent = `${PHASE_LABEL[p.phase]}（${state.settings[p.phase]}分）`;
  $("dots").replaceChildren(...Array.from({ length: state.settings.rounds }, (_, i) => {
    const dot = document.createElement("span");
    dot.className = "dot" + (i < p.done ? " filled" : "");
    return dot;
  }));
  const t = today();
  $("today-count").textContent = t.count;
  $("today-min").textContent = t.minutes;
}

function renderLaps() {
  const list = $("laps");
  list.replaceChildren();
  const laps = state.stopwatch.laps;
  for (let i = laps.length - 1; i >= 0; i--) {
    const li = document.createElement("li");
    const split = laps[i] - (laps[i - 1] ?? 0);
    const exact = { tenths: true, ceil: false };
    li.innerHTML = `<span>ラップ ${i + 1}</span><span class="split">+${fmt(split, exact)}</span><span>${fmt(laps[i], exact)}</span>`;
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
    // The timer turns orange, then red, as the end comes near.
    const timing = state.mode === "timer" && isRunning();
    document.body.classList.toggle("warn", timing && left <= Math.min(WARN_MS, total * 0.3) && left > Math.min(URGENT_MS, total * 0.1));
    document.body.classList.toggle("urgent", timing && left <= Math.min(URGENT_MS, total * 0.1));
  }
  if (state.mode === "stopwatch") document.body.classList.remove("warn", "urgent");
  renderExam();
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

$("until-set").addEventListener("click", () => setUntil($("until-time").value));
$("exam-on").addEventListener("change", () => {
  state.exam = $("exam-on").checked;
  afterChange();
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
setInterval(() => { if (isRunning() || examShown()) tick(); }, 100);

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

// Hook for automated tests.
window.__timer = { state, setUntil, start, pause, tick };
