import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { randomInt } from "../shared/js/random.js";
import { copyText } from "../shared/js/clipboard.js";
import { toggleFullscreen } from "../shared/js/fullscreen.js";
import { dateText } from "../shared/js/dates.js";
import { arrangeSeats, splitGroups, seatProblems, parseNames, parsePairs, unknownNames } from "./seats.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their class lists. Add a new key instead.
// { lists: [list], current, noRepeat, seatView }, where a list is
// { title, names (the text as typed), picked: [names already chosen],
//   front, apart (席替え・班分けの条件, the text as typed),
//   seats: { cols, rows, frontRows, unused: [seat], plan: [name or ""] } }   (see seats.js)
// front, apart, seats and seatView came later; lists saved before them get the defaults.
const STORE_KEY = "class-picker-v1";
const MAX_SEATS = 12; // seats across, and rows, at most

const $ = (id) => document.getElementById(id);
const els = {
  tabs: document.querySelectorAll(".tab"),
  pick: $("pick"),
  groups: $("groups"),
  listSelect: $("list-select"),
  listAdd: $("list-add"),
  listRename: $("list-rename"),
  listDelete: $("list-delete"),
  names: $("names"),
  count: $("count"),
  display: $("pick-display"),
  spinBtn: $("spin-btn"),
  noRepeat: $("no-repeat"),
  left: $("left"),
  pickReset: $("pick-reset"),
  picked: $("picked"),
  groupMode: $("group-mode"),
  groupN: $("group-n"),
  groupBtn: $("group-btn"),
  groupCopy: $("group-copy"),
  groupList: $("group-list"),
  groupNote: $("group-note"),
  frontNames: $("front-names"),
  apartPairs: $("apart-pairs"),
  conditionWarn: $("condition-warn"),
  seats: $("seats"),
  seatCols: $("seat-cols"),
  seatRows: $("seat-rows"),
  seatFront: $("seat-front"),
  seatView: $("seat-view"),
  seatBtn: $("seat-btn"),
  seatUnused: $("seat-unused"),
  seatPrint: $("seat-print"),
  seatNote: $("seat-note"),
  seatTitle: $("seat-title"),
  seatGrid: $("seat-grid"),
  fullscreenBtn: $("fullscreen-btn"),
};

const clamp = (n, min, max, fallback) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback);

function loadSeats(seats = {}) {
  const cols = clamp(seats.cols, 1, MAX_SEATS, 6);
  const rows = clamp(seats.rows, 1, MAX_SEATS, 6);
  const size = cols * rows;
  const unused = Array.isArray(seats.unused) ? seats.unused.filter((i) => Number.isInteger(i) && i >= 0 && i < size) : [];
  const plan = Array.isArray(seats.plan) && seats.plan.length === size ? seats.plan.map((n) => String(n ?? "")) : [];
  return { cols, rows, frontRows: clamp(seats.frontRows, 1, MAX_SEATS, 2), unused, plan };
}

const newList = (title) => ({ title, names: "", picked: [], front: "", apart: "", seats: loadSeats() });

function loadStore() {
  const s = loadJson(STORE_KEY, null);
  if (!s || !Array.isArray(s.lists) || !s.lists.length) {
    return { lists: [newList("クラス1")], current: 0, noRepeat: true, seatView: "students" };
  }
  s.lists = s.lists.map((l) => ({
    title: String(l.title ?? "クラス"),
    names: String(l.names ?? ""),
    picked: Array.isArray(l.picked) ? l.picked : [],
    front: String(l.front ?? ""),
    apart: String(l.apart ?? ""),
    seats: loadSeats(l.seats),
  }));
  s.current = Math.min(Math.max(0, s.current | 0), s.lists.length - 1);
  s.noRepeat = s.noRepeat !== false;
  s.seatView = s.seatView === "teacher" ? "teacher" : "students";
  return s;
}

const store = loadStore();
const state = { spinning: false, groups: [], unusedMode: false, seatPick: null };
const list = () => store.lists[store.current];
const save = () => saveJson(STORE_KEY, store);

// One name per line; spaces around are dropped, empty lines ignored.
const names = () => list().names.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/* ---------- class lists ---------- */

function renderLists() {
  els.listSelect.replaceChildren(...store.lists.map((l, i) => new Option(l.title, i, false, i === store.current)));
  els.listDelete.disabled = store.lists.length < 2;
  els.names.value = list().names;
  els.noRepeat.checked = store.noRepeat;
  els.frontNames.value = list().front;
  els.apartPairs.value = list().apart;
  state.seatPick = null;
  renderCount();
  renderPicked();
  renderConditions();
  renderSeats();
}

function renderCount() {
  const n = names().length;
  els.count.textContent = n ? `${n}人` : "";
  els.spinBtn.disabled = !n || state.spinning;
  els.groupBtn.disabled = !n;
  els.seatBtn.disabled = !n;
}

// Names still to be chosen when "一度当たった人は外す" is on. Duplicate names count separately.
function remaining() {
  const left = names();
  if (!store.noRepeat) return left;
  for (const p of list().picked) {
    const i = left.indexOf(p);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}

function renderPicked() {
  els.picked.replaceChildren(...list().picked.map((n) => Object.assign(document.createElement("li"), { textContent: n })));
  const all = names().length;
  els.left.textContent = store.noRepeat && all ? `残り ${remaining().length} / ${all}人` : "";
  els.pickReset.disabled = !list().picked.length;
}

els.listSelect.addEventListener("change", () => {
  store.current = Number(els.listSelect.value);
  save();
  renderLists();
  clearGroups();
  showDisplay("名簿を入れて「回す」");
});

els.listAdd.addEventListener("click", () => {
  const title = prompt("新しい名簿の名前（例: 2年1組）", `クラス${store.lists.length + 1}`)?.trim();
  if (!title) return;
  store.lists.push(newList(title));
  store.current = store.lists.length - 1;
  save();
  renderLists();
  clearGroups();
  els.names.focus();
});

els.listRename.addEventListener("click", () => {
  const title = prompt("名簿の名前", list().title)?.trim();
  if (!title) return;
  list().title = title;
  save();
  renderLists();
});

els.listDelete.addEventListener("click", () => {
  if (store.lists.length < 2 || !confirm(`「${list().title}」の名簿を消しますか？`)) return;
  store.lists.splice(store.current, 1);
  store.current = Math.max(0, store.current - 1);
  save();
  renderLists();
  clearGroups();
});

els.names.addEventListener("input", () => {
  list().names = els.names.value;
  // Chosen names that were taken off the list are forgotten.
  const now = names();
  list().picked = list().picked.filter((p) => now.includes(p));
  // So are their seats.
  const { plan } = list().seats;
  plan.forEach((name, i) => name && !now.includes(name) && (plan[i] = ""));
  save();
  renderCount();
  renderPicked();
  renderConditions();
  renderSeats();
});

/* ---------- conditions (席替え・班分け) ---------- */

const conditions = () => ({ front: parseNames(list().front), apart: parsePairs(list().apart) });

// Names in the conditions that are not on the roster: probably typos.
function renderConditions() {
  const { front, apart } = conditions();
  const unknown = unknownNames([...front, ...apart.flat()], names());
  els.conditionWarn.hidden = !unknown.length;
  els.conditionWarn.textContent = `名簿にない名前: ${unknown.join("、")}`;
  if (front.length || apart.length) els.conditionWarn.closest("details").open = true;
}

for (const [input, field] of [[els.frontNames, "front"], [els.apartPairs, "apart"]]) {
  input.addEventListener("input", () => {
    list()[field] = input.value;
    save();
    renderConditions();
    renderSeats();
  });
}

/* ---------- roulette ---------- */

function showDisplay(text, cls = "") {
  els.display.textContent = text;
  els.display.className = `pick-display ${cls}`.trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Flicks through names, slowing down, and stops on one chosen fairly in advance.
async function spin() {
  if (state.spinning) return;
  let pool = remaining();
  if (!pool.length) {
    if (!names().length) return;
    showStatus("全員当たったので、最初からにしました");
    list().picked = [];
    pool = remaining();
  }
  const winner = pool[randomInt(pool.length)];
  state.spinning = true;
  renderCount();
  if (!reducedMotion() && pool.length > 1) {
    const all = names();
    let delay = 40;
    let last = "";
    while (delay < 320) {
      let n;
      do {
        n = all[randomInt(all.length)];
      } while (n === last && all.length > 1);
      last = n;
      showDisplay(n, "name spinning");
      await sleep(delay);
      delay *= 1.12;
    }
  }
  showDisplay(winner, "name done");
  list().picked.push(winner);
  save();
  state.spinning = false;
  renderCount();
  renderPicked();
}

els.spinBtn.addEventListener("click", spin);
els.noRepeat.addEventListener("change", () => {
  store.noRepeat = els.noRepeat.checked;
  save();
  renderPicked();
});
els.pickReset.addEventListener("click", () => {
  list().picked = [];
  save();
  renderPicked();
  showDisplay("名簿を入れて「回す」");
});

/* ---------- groups ---------- */

function clearGroups() {
  state.groups = [];
  els.groupList.replaceChildren();
  els.groupCopy.disabled = true;
}

function renderGroups() {
  els.groupList.replaceChildren(...state.groups.map((g, i) => {
    const li = document.createElement("li");
    li.className = "group-card";
    const h = document.createElement("h3");
    h.textContent = `${i + 1}班`;
    const count = document.createElement("span");
    count.textContent = `${g.length}人`;
    h.append(count);
    const ul = document.createElement("ul");
    ul.append(...g.map((n) => Object.assign(document.createElement("li"), { textContent: n })));
    li.append(h, ul);
    return li;
  }));
  els.groupCopy.disabled = !state.groups.length;
}

els.groupBtn.addEventListener("click", () => {
  const n = Math.floor(Number(els.groupN.value));
  if (!(n >= 1)) {
    showStatus("1以上の数を入れてください", { error: true });
    return;
  }
  const { groups, broken } = splitGroups(names(), els.groupMode.value, n, conditions().apart);
  state.groups = groups;
  renderGroups();
  if (broken.length) showStatus(`同じ班になった組み合わせがあります: ${pairText(broken)}（班の数を増やすと分けやすくなります）`, { error: true, ms: 8000 });
});

els.groupCopy.addEventListener("click", async () => {
  const text = state.groups.map((g, i) => `${i + 1}班: ${g.join("、")}`).join("\n");
  if (await copyText(text)) showStatus("コピーしました。ドキュメントやClassroomに Ctrl+V で貼り付けられます");
  else showStatus("コピーできませんでした", { error: true });
});

const pairText = (pairs) => pairs.map((p) => p.join("と")).join("、");

/* ---------- seats (席替え) ---------- */

const seatOptions = () => ({ ...list().seats, ...conditions() });

// Seat numbers in the order they are shown: from the students' side the teacher's desk is at
// the top and the front row under it; from the desk everything is turned around.
function seatOrder({ cols, rows }) {
  const order = Array.from({ length: cols * rows }, (_, i) => i);
  return store.seatView === "teacher" ? order.reverse() : order;
}

function renderSeats() {
  const seats = list().seats;
  const { cols, rows, unused, plan } = seats;
  els.seatCols.value = cols;
  els.seatRows.value = rows;
  els.seatFront.value = seats.frontRows;
  els.seatView.value = store.seatView;
  els.seats.classList.toggle("teacher-view", store.seatView === "teacher");
  els.seatUnused.setAttribute("aria-pressed", String(state.unusedMode));
  els.seatPrint.disabled = !plan.length;
  const problems = plan.length ? seatProblems(plan, seatOptions()) : { apart: [], front: [] };
  const flagged = new Set([...problems.apart.flat(), ...problems.front]);
  els.seatGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  els.seatGrid.replaceChildren(...seatOrder(seats).map((i) => {
    const seat = document.createElement("button");
    seat.type = "button";
    seat.className = "seat";
    seat.dataset.seat = i;
    const off = unused.includes(i);
    const name = plan[i] ?? "";
    seat.classList.toggle("unused", off);
    seat.classList.toggle("front-row", Math.floor(i / cols) < seats.frontRows);
    seat.classList.toggle("picked", state.seatPick === i);
    seat.classList.toggle("problem", flagged.has(name));
    seat.textContent = off ? "" : name;
    seat.setAttribute("aria-label", off ? "使わない席" : name || "空いている席");
    return seat;
  }));
  els.seatTitle.textContent = `${list().title}　座席表（${store.seatView === "teacher" ? "教卓から見た向き" : "生徒から見た向き"}）　${dateText(new Date(), "/")}`;
  els.seatNote.textContent = seatNote(problems);
  els.seatNote.classList.toggle("warn", problems.apart.length + problems.front.length > 0);
}

function seatNote(problems) {
  const { plan } = list().seats;
  if (state.unusedMode) return "使わない席をクリックしてください（もう一度クリックで戻ります）。終わったら「使わない席を選ぶ」をもう一度押します。";
  const notes = [];
  if (problems.apart.length) notes.push(`隣どうしの組み合わせ: ${pairText(problems.apart)}`);
  if (problems.front.length) notes.push(`前の席でない人: ${problems.front.join("、")}`);
  const seated = new Set(plan.filter(Boolean));
  const without = plan.length ? names().filter((n) => !seated.has(n)) : [];
  if (without.length) notes.push(`席のない人: ${without.join("、")}（「席を決める」で入ります）`);
  return notes.length ? `${notes.join("。")}。` : "席を2つ続けてクリックすると入れかえられます。";
}

function decideSeats() {
  const people = names();
  const seats = list().seats;
  const result = arrangeSeats(people, seatOptions());
  if (!result) {
    const free = seats.cols * seats.rows - seats.unused.length;
    showStatus(`席が足りません（${people.length}人に対して${free}席）。席の数を増やしてください`, { error: true });
    return;
  }
  seats.plan = result.plan;
  state.seatPick = null;
  save();
  renderSeats();
  if (result.ok) showStatus("席を決めました");
  else showStatus("条件をすべて満たす並びが見つからなかったので、いちばん近い並びにしました（下の赤い名前）", { error: true, ms: 8000 });
}

// Keeps every seat's row and column when the room gets more or fewer seats.
function resizeSeats(cols, rows) {
  const seats = list().seats;
  const move = (i) => {
    const r = Math.floor(i / seats.cols);
    const c = i % seats.cols;
    return r < rows && c < cols ? r * cols + c : -1;
  };
  seats.unused = seats.unused.map(move).filter((i) => i >= 0);
  if (seats.plan.length) {
    const plan = Array(cols * rows).fill("");
    seats.plan.forEach((name, i) => move(i) >= 0 && (plan[move(i)] = name));
    seats.plan = plan;
  }
  Object.assign(seats, { cols, rows });
}

function onSeatClick(i) {
  const seats = list().seats;
  if (state.unusedMode) {
    toggleUnused(seats, i);
  } else if (seats.unused.includes(i) || !seats.plan.length) {
    return;
  } else if (state.seatPick === null || state.seatPick === i) {
    state.seatPick = state.seatPick === i ? null : i;
  } else {
    const j = state.seatPick;
    [seats.plan[i], seats.plan[j]] = [seats.plan[j], seats.plan[i]];
    state.seatPick = null;
  }
  save();
  renderSeats();
  els.seatGrid.querySelector(`[data-seat="${i}"]`)?.focus();
}

// A seat someone sits in can be taken out of use only if there is an empty seat to move them to.
function toggleUnused(seats, i) {
  const k = seats.unused.indexOf(i);
  if (k >= 0) {
    seats.unused.splice(k, 1);
    if (seats.plan.length) seats.plan[i] = "";
    return;
  }
  if (seats.plan[i]) {
    const empty = seats.plan.findIndex((name, j) => !name && j !== i && !seats.unused.includes(j));
    if (empty < 0) {
      showStatus("空いている席がないので、使わない席にできません", { error: true });
      return;
    }
    seats.plan[empty] = seats.plan[i];
    seats.plan[i] = "";
  }
  seats.unused.push(i);
}

els.seatGrid.addEventListener("click", (e) => {
  const seat = e.target.closest(".seat");
  if (seat) onSeatClick(Number(seat.dataset.seat));
});
els.seatBtn.addEventListener("click", decideSeats);
els.seatUnused.addEventListener("click", () => {
  state.unusedMode = !state.unusedMode;
  state.seatPick = null;
  renderSeats();
});
for (const input of [els.seatCols, els.seatRows]) {
  input.addEventListener("change", () => {
    const seats = list().seats;
    resizeSeats(clamp(Number(els.seatCols.value), 1, MAX_SEATS, seats.cols), clamp(Number(els.seatRows.value), 1, MAX_SEATS, seats.rows));
    save();
    renderSeats();
  });
}
els.seatFront.addEventListener("change", () => {
  const seats = list().seats;
  seats.frontRows = clamp(Number(els.seatFront.value), 1, MAX_SEATS, seats.frontRows);
  save();
  renderSeats();
});
els.seatView.addEventListener("change", () => {
  store.seatView = els.seatView.value;
  save();
  renderSeats();
});
els.seatPrint.addEventListener("click", () => window.print());

/* ---------- tabs, keys, full screen ---------- */

function setMode(mode) {
  for (const t of els.tabs) t.setAttribute("aria-selected", String(t.dataset.mode === mode));
  els.pick.hidden = mode !== "pick";
  els.groups.hidden = mode !== "groups";
  els.seats.hidden = mode !== "seats";
}
for (const t of els.tabs) t.addEventListener("click", () => setMode(t.dataset.mode));

els.fullscreenBtn.addEventListener("click", toggleFullscreen);

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === " " && !els.pick.hidden && !e.target.matches("button")) {
    e.preventDefault();
    spin();
  } else if (e.key === "f" || e.key === "F") {
    toggleFullscreen();
  }
});

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "seats.js", "icon.svg", "manifest.webmanifest"]);

renderLists();

// Hook for automated tests.
window.__classPicker = { store, state, spin, names, remaining, arrangeSeats, splitGroups, seatProblems };
