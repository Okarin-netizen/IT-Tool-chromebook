import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { randomInt, shuffle } from "../shared/js/random.js";
import { copyText } from "../shared/js/clipboard.js";
import { toggleFullscreen } from "../shared/js/fullscreen.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their class lists. Add a new key instead.
// { lists: [{ title, names (the text as typed), picked: [names already chosen] }], current, noRepeat }
const STORE_KEY = "class-picker-v1";

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
  fullscreenBtn: $("fullscreen-btn"),
};

function loadStore() {
  const s = loadJson(STORE_KEY, null);
  if (!s || !Array.isArray(s.lists) || !s.lists.length) {
    return { lists: [{ title: "クラス1", names: "", picked: [] }], current: 0, noRepeat: true };
  }
  s.lists = s.lists.map((l) => ({ title: String(l.title ?? "クラス"), names: String(l.names ?? ""), picked: Array.isArray(l.picked) ? l.picked : [] }));
  s.current = Math.min(Math.max(0, s.current | 0), s.lists.length - 1);
  s.noRepeat = s.noRepeat !== false;
  return s;
}

const store = loadStore();
const state = { spinning: false, groups: [] };
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
  renderCount();
  renderPicked();
}

function renderCount() {
  const n = names().length;
  els.count.textContent = n ? `${n}人` : "";
  els.spinBtn.disabled = !n || state.spinning;
  els.groupBtn.disabled = !n;
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
  store.lists.push({ title, names: "", picked: [] });
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
  save();
  renderCount();
  renderPicked();
});

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

// Splits the shuffled names into groups whose sizes differ by at most one.
function makeGroups(people, mode, n) {
  const count = Math.max(1, Math.min(people.length, mode === "size" ? Math.ceil(people.length / n) : n));
  const groups = Array.from({ length: count }, () => []);
  shuffle(people).forEach((p, i) => groups[i % count].push(p));
  return groups;
}

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
  state.groups = makeGroups(names(), els.groupMode.value, n);
  renderGroups();
});

els.groupCopy.addEventListener("click", async () => {
  const text = state.groups.map((g, i) => `${i + 1}班: ${g.join("、")}`).join("\n");
  if (await copyText(text)) showStatus("コピーしました。ドキュメントやClassroomに Ctrl+V で貼り付けられます");
  else showStatus("コピーできませんでした", { error: true });
});

/* ---------- tabs, keys, full screen ---------- */

function setMode(mode) {
  for (const t of els.tabs) t.setAttribute("aria-selected", String(t.dataset.mode === mode));
  els.pick.hidden = mode !== "pick";
  els.groups.hidden = mode !== "groups";
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
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

renderLists();

// Hook for automated tests.
window.__classPicker = { store, state, spin, makeGroups, names, remaining };
