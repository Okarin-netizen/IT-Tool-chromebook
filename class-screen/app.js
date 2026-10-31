// Things to show on the classroom screen during a lesson: how loud the room is, a traffic
// light for when to talk, dice, and a scoreboard for team games.
import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { randomInt } from "../shared/js/random.js";
import { toggleFullscreen } from "../shared/js/fullscreen.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their settings. Add a new key instead.
const SETTINGS_KEY = "class-screen-v1";

const QUIET_DB = -40; // a level this loud (dBFS) reads 0 at sensitivity 1 …
const SENSITIVITY_DB = 4; // … and every step of sensitivity lowers it by this much
const RANGE_DB = 50; // from 0 to 100 on the meter
const FALL_PER_FRAME = 1.2; // how fast the bar sinks when the room gets quieter (meter units)
const LOUD_HOLD_MS = 600; // the room must stay over the line this long to count once
const ROLL_MS = 700; // how long the dice tumble
const ROLL_FRAME_MS = 70; // … showing a new face this often
const MAX_TEAMS = 8;
const DEFAULT_LIGHTS = ["話さない", "小さな声で", "話してよい"];

// Where each pip of a die face sits, on a 3 × 3 grid numbered 0–8 from the top left.
const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

const $ = (id) => document.getElementById(id);

function loadSettings() {
  const s = loadJson(SETTINGS_KEY, {});
  const teams = Array.isArray(s.teams) && s.teams.length ? s.teams : [{ name: "Aチーム", points: 0 }, { name: "Bチーム", points: 0 }];
  return {
    mode: ["meter", "signal", "dice", "score"].includes(s.mode) ? s.mode : "meter",
    limit: Number(s.limit) || 70,
    sensitivity: Number(s.sensitivity) || 5,
    lights: DEFAULT_LIGHTS.map((word, i) => String(s.lights?.[i] ?? word)),
    light: Number.isInteger(s.light) ? s.light : -1, // -1: all lights off
    diceCount: Number(s.diceCount) || 2,
    teams: teams.map((t) => ({ name: String(t.name ?? ""), points: Number(t.points) || 0 })),
    step: Number(s.step) || 1,
  };
}

const settings = loadSettings();
const save = () => saveJson(SETTINGS_KEY, settings);

const state = {
  mic: null, // { stream, context, analyser, samples, frame } while listening
  level: 0, // 0–100, what the bar shows
  loudSince: 0, // when the room went over the line (0 while it is under)
  overCount: 0,
  dice: [],
  rolling: false,
};

/* ---------- 声の大きさ (noise meter) ---------- */

async function startMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      // The raw loudness of the room: no clean-up that would flatten it.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    state.mic = { stream, context, analyser, samples: new Float32Array(analyser.fftSize), frame: 0 };
    listen();
  } catch (err) {
    console.error(err);
    showStatus("マイクを使えませんでした。アドレスバーのマイクのマークから、使うのを許可してください", { error: true, ms: 8000 });
  }
  renderMeter();
}

function stopMic() {
  if (!state.mic) return;
  cancelAnimationFrame(state.mic.frame);
  state.mic.stream.getTracks().forEach((track) => track.stop());
  state.mic.context.close();
  state.mic = null;
  state.level = 0;
  state.loudSince = 0;
  renderMeter();
}

// Reads the microphone once per frame.
function listen() {
  const { analyser, samples } = state.mic;
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const v of samples) sum += v * v;
  const rms = Math.sqrt(sum / samples.length);
  meterFrame(20 * Math.log10(Math.max(rms, 1e-6)));
  state.mic.frame = requestAnimationFrame(listen);
}

// Moves the bar to the loudness `db` (dBFS): up at once, down slowly, so a single shout is seen.
function meterFrame(db, now = performance.now()) {
  const floor = QUIET_DB - settings.sensitivity * SENSITIVITY_DB;
  const target = Math.min(100, Math.max(0, ((db - floor) / RANGE_DB) * 100));
  state.level = Math.max(target, state.level - FALL_PER_FRAME);
  if (state.level < settings.limit) {
    state.loudSince = 0;
  } else if (!state.loudSince) {
    state.loudSince = now;
  } else if (state.loudSince > 0 && now - state.loudSince >= LOUD_HOLD_MS) {
    state.overCount++;
    state.loudSince = -1; // counted; wait until the room is under the line again
  }
  renderMeter();
}

const meterWords = [
  [0.6, "静か", "quiet"],
  [1, "ちょうどいい", "fine"],
  [Infinity, "大きすぎ！", "loud"],
];

function renderMeter() {
  const listening = Boolean(state.mic);
  const ratio = state.level / settings.limit;
  const [, word, mood] = meterWords.find(([upTo]) => ratio < upTo);
  $("meter").dataset.mood = listening ? mood : "";
  $("meter-word").textContent = listening ? word : "「マイクを使う」を押してください";
  $("meter-bar").style.width = `${state.level}%`;
  $("meter-limit-line").style.left = `${settings.limit}%`;
  $("mic-label").textContent = listening ? "止める" : "マイクを使う";
  $("mic-btn").querySelector("use").setAttribute("href", listening ? "#i-stop" : "#i-mic");
  $("meter-count").textContent = state.overCount ? `線をこえた回数: ${state.overCount}回` : "";
  $("meter-reset").disabled = !state.overCount;
}

/* ---------- 信号 (traffic light) ---------- */

function setLight(i) {
  settings.light = settings.light === i ? -1 : i;
  save();
  renderSignal();
}

function renderSignal() {
  for (const light of document.querySelectorAll(".light")) {
    const i = Number(light.dataset.light);
    light.setAttribute("aria-checked", String(settings.light === i));
    light.querySelector(".light-label").textContent = settings.lights[i];
  }
  for (const input of document.querySelectorAll(".signal-input")) {
    if (document.activeElement !== input) input.value = settings.lights[Number(input.dataset.light)];
  }
}

/* ---------- サイコロ (dice) ---------- */

const rollOnce = () => Array.from({ length: settings.diceCount }, () => randomInt(6) + 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Tumbles through random faces, then stops on the real throw.
async function roll() {
  if (state.rolling) return;
  state.rolling = true;
  if (!reducedMotion()) {
    for (let t = 0; t < ROLL_MS; t += ROLL_FRAME_MS) {
      renderDice(rollOnce(), true);
      await sleep(ROLL_FRAME_MS);
    }
  }
  state.dice = rollOnce();
  state.rolling = false;
  renderDice(state.dice, false);
}

function dieFace(value) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 90 90");
  svg.setAttribute("class", "die");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", String(value));
  const face = document.createElementNS(svgNS, "rect");
  Object.entries({ x: 3, y: 3, width: 84, height: 84, rx: 16, class: "die-face" }).forEach(([k, v]) => face.setAttribute(k, v));
  svg.append(face);
  for (const spot of PIPS[value]) {
    const pip = document.createElementNS(svgNS, "circle");
    pip.setAttribute("cx", 21 + (spot % 3) * 24);
    pip.setAttribute("cy", 21 + Math.floor(spot / 3) * 24);
    pip.setAttribute("r", value === 1 ? 11 : 8);
    pip.setAttribute("class", value === 1 ? "pip one" : "pip");
    svg.append(pip);
  }
  return svg;
}

function renderDice(values, tumbling) {
  const faces = $("dice-faces");
  faces.classList.toggle("tumbling", tumbling);
  faces.replaceChildren(...values.map(dieFace));
  const total = values.reduce((a, b) => a + b, 0);
  const thrown = !tumbling && state.dice.length > 1;
  $("dice-total").textContent = thrown ? `合計 ${total}` : "";
  $("dice-count").value = settings.diceCount;
}

/* ---------- 得点板 (scoreboard) ---------- */

function renderTeams() {
  $("teams").replaceChildren(...settings.teams.map(teamCard));
  $("team-add").disabled = settings.teams.length >= MAX_TEAMS;
  $("score-step").value = settings.step;
}

function teamCard(team, i) {
  const name = document.createElement("input");
  name.className = "team-name";
  name.value = team.name;
  name.maxLength = 16;
  name.setAttribute("aria-label", `${i + 1}番目のチームの名前`);
  name.addEventListener("input", () => {
    team.name = name.value;
    save();
  });
  const points = document.createElement("output");
  points.className = "team-points";
  points.textContent = team.points;
  const buttons = document.createElement("div");
  buttons.className = "team-buttons";
  buttons.append(
    iconButton("i-minus", `${settings.step}点減らす`, () => addPoints(i, -settings.step)),
    iconButton("i-plus", `${settings.step}点増やす`, () => addPoints(i, settings.step), "primary"),
  );
  const remove = iconButton("i-close", "このチームを消す", () => removeTeam(i), "team-remove");
  remove.disabled = settings.teams.length <= 1;
  const card = document.createElement("li");
  card.className = "team";
  card.style.setProperty("--team", `var(--team-${i % MAX_TEAMS})`);
  card.append(remove, name, points, buttons);
  return card;
}

function iconButton(icon, label, onClick, extraClass = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn icon ${extraClass}`.trim();
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `<svg class="i" aria-hidden="true"><use href="#${icon}"/></svg>`;
  btn.addEventListener("click", onClick);
  return btn;
}

function addPoints(i, delta) {
  settings.teams[i].points += delta;
  save();
  renderTeams();
}

function addTeam() {
  if (settings.teams.length >= MAX_TEAMS) return;
  const letter = String.fromCharCode(65 + settings.teams.length); // A, B, C, …
  settings.teams.push({ name: `${letter}チーム`, points: 0 });
  save();
  renderTeams();
}

function removeTeam(i) {
  const team = settings.teams[i];
  if (team.points && !confirm(`「${team.name}」（${team.points}点）を消しますか？`)) return;
  settings.teams.splice(i, 1);
  save();
  renderTeams();
}

function resetScores() {
  if (!confirm("全部のチームを0点にしますか？")) return;
  settings.teams.forEach((team) => (team.points = 0));
  save();
  renderTeams();
}

/* ---------- tabs ---------- */

function setMode(mode) {
  settings.mode = mode;
  save();
  for (const tab of document.querySelectorAll(".tab")) tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== mode;
}

/* ---------- events ---------- */

for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => setMode(tab.dataset.mode));
$("fullscreen-btn").addEventListener("click", toggleFullscreen);

$("mic-btn").addEventListener("click", () => (state.mic ? stopMic() : startMic()));
$("meter-reset").addEventListener("click", () => {
  state.overCount = 0;
  renderMeter();
});
for (const [id, field] of [["meter-limit", "limit"], ["meter-sensitivity", "sensitivity"]]) {
  $(id).value = settings[field];
  $(id).addEventListener("input", () => {
    settings[field] = Number($(id).value);
    save();
    renderMeter();
  });
}

for (const light of document.querySelectorAll(".light")) light.addEventListener("click", () => setLight(Number(light.dataset.light)));
for (const input of document.querySelectorAll(".signal-input")) {
  input.addEventListener("input", () => {
    settings.lights[Number(input.dataset.light)] = input.value;
    save();
    renderSignal();
  });
}

$("roll-btn").addEventListener("click", roll);
$("dice-count").addEventListener("change", () => {
  settings.diceCount = Number($("dice-count").value);
  save();
  state.dice = [];
  renderDice(Array(settings.diceCount).fill(1), false);
});

$("team-add").addEventListener("click", addTeam);
$("score-step").addEventListener("change", () => {
  settings.step = Number($("score-step").value);
  save();
  renderTeams();
});
$("score-reset").addEventListener("click", resetScores);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "f" || e.key === "F") {
    toggleFullscreen();
  } else if (settings.mode === "dice" && e.key === " " && !e.target.matches("button")) {
    e.preventDefault();
    roll();
  } else if (settings.mode === "signal" && ["1", "2", "3"].includes(e.key)) {
    setLight(Number(e.key) - 1);
  }
});

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

setMode(settings.mode);
renderMeter();
renderSignal();
renderDice(Array(settings.diceCount).fill(1), false);
renderTeams();

// Hook for automated tests.
window.__classScreen = { settings, state, meterFrame, roll, setLight, addPoints };
