import { showStatus } from "../shared/js/status.js";
import { download } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { dateText } from "../shared/js/dates.js";

const STORAGE_KEY = "todo-tool-v1";
const DAYS = ["月", "火", "水", "木", "金", "土"];

const $ = (id) => document.getElementById(id);

let state = load();
let filter = "open";
let editing = null; // id of the task being changed, if any

// ---- 保存 ----

function defaultState() {
  return { periods: 6, saturday: false, timetable: {}, tasks: [] };
}

function normalize(data) {
  const s = defaultState();
  if (!data || typeof data !== "object") return s;
  const p = Number(data.periods);
  if (p >= 4 && p <= 8) s.periods = p;
  s.saturday = !!data.saturday;
  if (data.timetable && typeof data.timetable === "object") {
    for (const [k, v] of Object.entries(data.timetable)) {
      if (/^\d-\d$/.test(k) && typeof v === "string") s.timetable[k] = v;
    }
  }
  if (Array.isArray(data.tasks)) {
    s.tasks = data.tasks
      .filter((t) => t && typeof t.title === "string")
      .map((t) => ({
        id: String(t.id || newId()),
        title: t.title,
        subject: typeof t.subject === "string" ? t.subject : "",
        due: /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : "",
        done: !!t.done,
        created: Number(t.created) || Date.now(),
      }));
  }
  return s;
}

function load() {
  return normalize(loadJson(STORAGE_KEY));
}

function save() {
  if (!saveJson(STORAGE_KEY, state)) showStatus("保存できませんでした。「バックアップ」でファイルに保存してください。", { error: true, ms: 5000 });
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- 日付 ----

function daysUntil(due) {
  const [y, m, d] = due.split("-").map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}

function dueLabel(due) {
  const n = daysUntil(due);
  const [y, m, d] = due.split("-").map(Number);
  const wd = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  const date = `${m}/${d}(${wd})`;
  if (n < 0) return `${date} ・ ${-n}日過ぎています`;
  if (n === 0) return `${date} ・ 今日まで`;
  if (n === 1) return `${date} ・ 明日まで`;
  return `${date} ・ あと${n}日`;
}

// ---- 時間割 ----

function todayColumn() {
  const wd = new Date().getDay(); // 0=日
  if (wd === 0) return -1;
  if (wd === 6 && !state.saturday) return -1;
  return wd - 1;
}

function renderTimetable() {
  const table = $("timetable");
  const days = state.saturday ? 6 : 5;
  const today = todayColumn();
  table.textContent = "";

  const head = table.createTHead().insertRow();
  const corner = document.createElement("th");
  corner.className = "period";
  head.appendChild(corner);
  for (let d = 0; d < days; d++) {
    const th = document.createElement("th");
    th.textContent = DAYS[d];
    if (d === today) th.className = "today";
    head.appendChild(th);
  }

  const body = table.createTBody();
  for (let p = 1; p <= state.periods; p++) {
    const row = body.insertRow();
    const th = document.createElement("th");
    th.className = "period";
    th.textContent = p;
    row.appendChild(th);
    for (let d = 0; d < days; d++) {
      const td = row.insertCell();
      if (d === today) td.className = "today";
      const input = document.createElement("input");
      input.value = state.timetable[`${d}-${p}`] || "";
      input.setAttribute("aria-label", `${DAYS[d]}曜${p}時間目`);
      input.dataset.key = `${d}-${p}`;
      td.appendChild(input);
    }
  }

  $("period-count").value = String(state.periods);
  $("show-sat").checked = state.saturday;
  renderSubjects();
}

$("timetable").addEventListener("input", (e) => {
  const key = e.target.dataset.key;
  if (!key) return;
  const v = e.target.value.trim();
  if (v) state.timetable[key] = v;
  else delete state.timetable[key];
  save();
  renderSubjects();
});

// Enter / 矢印の上下で縦に移動できるようにする
$("timetable").addEventListener("keydown", (e) => {
  const key = e.target.dataset.key;
  if (!key || e.isComposing) return;
  const [d, p] = key.split("-").map(Number);
  let next = null;
  if (e.key === "Enter" || e.key === "ArrowDown") next = `${d}-${p + 1}`;
  else if (e.key === "ArrowUp") next = `${d}-${p - 1}`;
  if (!next) return;
  e.preventDefault();
  const el = $("timetable").querySelector(`[data-key="${next}"]`);
  if (el) el.focus();
  else if (e.key === "Enter") e.target.blur();
});

$("period-count").addEventListener("change", (e) => {
  state.periods = Number(e.target.value);
  save();
  renderTimetable();
});

$("show-sat").addEventListener("change", (e) => {
  state.saturday = e.target.checked;
  save();
  renderTimetable();
});

function renderSubjects() {
  const list = $("subject-list");
  const subjects = new Set();
  for (const v of Object.values(state.timetable)) subjects.add(v);
  for (const t of state.tasks) if (t.subject) subjects.add(t.subject);
  list.textContent = "";
  for (const s of [...subjects].sort((a, b) => a.localeCompare(b, "ja"))) {
    const opt = document.createElement("option");
    opt.value = s;
    list.appendChild(opt);
  }
}

// ---- 課題 ----

function sortTasks(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  // 締め切りが近い順。締め切りなしは最後
  if (a.due !== b.due) {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return a.created - b.created;
}

// Which tasks each filter tab shows.
const FILTERS = {
  all: () => true,
  open: (t) => !t.done,
  done: (t) => t.done,
};

function renderTasks() {
  const shown = state.tasks.filter(FILTERS[filter]).sort(sortTasks);
  $("task-list").replaceChildren(...shown.map(taskItem));
  const open = state.tasks.filter((t) => !t.done).length;
  const done = state.tasks.length - open;
  const empty = $("task-empty");
  empty.hidden = shown.length > 0;
  empty.textContent = filter === "open" && state.tasks.length
    ? "未完了の課題はありません"
    : "課題はまだありません。上の欄から追加してください。";
  $("task-count").textContent = state.tasks.length ? `未完了 ${open}件 ・ 完了 ${done}件` : "";
  $("clear-done").hidden = done === 0;
}

// "overdue" past the deadline, "soon" with a day or less left, or "" for an unfinished task.
function urgencyOf(t) {
  if (t.done || !t.due) return "";
  const n = daysUntil(t.due);
  if (n < 0) return "overdue";
  if (n <= 1) return "soon";
  return "";
}

function taskItem(t) {
  // A form already open keeps what has been typed into it when the list is drawn again.
  if (t.id === editing) return $("task-list").querySelector(".task.editing") ?? taskEditor(t);
  const urgency = urgencyOf(t);
  const li = document.createElement("li");
  li.className = "task";
  li.dataset.id = t.id;
  if (urgency) li.classList.add(urgency);
  if (t.done) li.classList.add("done");

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = t.done;
  cb.setAttribute("aria-label", "完了");

  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = t.title;
  const body = document.createElement("div");
  body.className = "task-body";
  body.append(title, taskMeta(t, urgency));

  const edit = iconButton("task-edit", "i-edit", "直す");
  const del = iconButton("task-del", "i-close", "削除");
  li.append(cb, body, edit, del);
  return li;
}

function iconButton(className, icon, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.innerHTML = `<svg class="i" aria-hidden="true"><use href="#${icon}"/></svg>`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  return btn;
}

// The task as a small form for changing its title, subject and deadline.
// Enter keeps the change and Esc throws it away.
function taskEditor(t) {
  const form = document.createElement("form");
  form.className = "task-edit-form";
  form.autocomplete = "off";
  const field = (className, value, label, extra = {}) => {
    const input = document.createElement("input");
    input.className = `input ${className}`;
    input.value = value;
    input.setAttribute("aria-label", label);
    Object.assign(input, extra);
    return input;
  };
  const title = field("grow edit-title", t.title, "課題の内容", { required: true });
  const subject = field("subject edit-subject", t.subject, "科目");
  subject.setAttribute("list", "subject-list");
  const due = field("edit-due", t.due, "締め切り", { type: "date" });
  const ok = document.createElement("button");
  ok.className = "btn primary small";
  ok.type = "submit";
  ok.textContent = "決定";
  const cancel = document.createElement("button");
  cancel.className = "btn small";
  cancel.type = "button";
  cancel.textContent = "やめる";
  form.append(title, subject, due, ok, cancel);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const changed = { title: title.value.trim(), subject: subject.value.trim(), due: due.value };
    if (!changed.title) return;
    Object.assign(t, changed);
    save();
    stopEditing(t.id);
    renderSubjects();
  });
  cancel.addEventListener("click", () => stopEditing(t.id));
  form.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    stopEditing(t.id);
  });

  const li = document.createElement("li");
  li.className = "task editing";
  li.dataset.id = t.id;
  li.append(form);
  return li;
}

function startEditing(id) {
  editing = id;
  renderTasks();
  $("task-list").querySelector(".edit-title")?.focus();
}

// Closes the form and puts the focus back on the task's "直す" button.
function stopEditing(id) {
  editing = null;
  renderTasks();
  $("task-list").querySelector(`.task[data-id="${id}"] .task-edit`)?.focus();
}

// The subject and the deadline under the task's title.
function taskMeta(t, urgency) {
  const meta = document.createElement("div");
  meta.className = "task-meta";
  if (t.subject) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = t.subject;
    meta.appendChild(tag);
  }
  if (t.due) {
    const due = document.createElement("span");
    due.className = "due " + urgency;
    due.textContent = t.done ? dueLabel(t.due).split(" ・ ")[0] : dueLabel(t.due);
    meta.appendChild(due);
  }
  return meta;
}

$("task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = $("task-title").value.trim();
  if (!title) return;
  state.tasks.push({
    id: newId(),
    title,
    subject: $("task-subject").value.trim(),
    due: $("task-due").value,
    done: false,
    created: Date.now(),
  });
  save();
  $("task-title").value = "";
  $("task-subject").value = "";
  $("task-due").value = "";
  $("task-title").focus();
  if (filter === "done") setFilter("open");
  renderTasks();
  renderSubjects();
});

// Double-clicking a task's title or details also opens it for changing.
$("task-list").addEventListener("dblclick", (e) => {
  const task = e.target.closest(".task:not(.editing)");
  if (task && e.target.closest(".task-body")) startEditing(task.dataset.id);
});

$("task-list").addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  const t = state.tasks.find((x) => x.id === e.target.closest(".task").dataset.id);
  if (!t) return;
  t.done = e.target.checked;
  save();
  renderTasks();
});

$("task-list").addEventListener("click", (e) => {
  if (e.target.closest(".task-edit")) startEditing(e.target.closest(".task").dataset.id);
  if (!e.target.closest(".task-del")) return;
  const id = e.target.closest(".task").dataset.id;
  const t = state.tasks.find((x) => x.id === id);
  if (!t || !confirm(`「${t.title}」を削除しますか？`)) return;
  state.tasks = state.tasks.filter((x) => x.id !== id);
  save();
  renderTasks();
});

$("clear-done").addEventListener("click", () => {
  const n = state.tasks.filter((t) => t.done).length;
  if (!confirm(`完了した課題 ${n}件を消しますか？`)) return;
  state.tasks = state.tasks.filter((t) => !t.done);
  save();
  renderTasks();
});

function setFilter(f) {
  filter = f;
  for (const chip of document.querySelectorAll(".chip")) {
    const on = chip.dataset.filter === f;
    chip.classList.toggle("selected", on);
    chip.setAttribute("aria-checked", on);
  }
}

for (const chip of document.querySelectorAll(".chip")) {
  chip.setAttribute("role", "radio");
  chip.addEventListener("click", () => {
    setFilter(chip.dataset.filter);
    renderTasks();
  });
}

// ---- バックアップ ----

$("export-btn").addEventListener("click", () => {
  download(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }), `時間割と課題_${dateText()}.json`);
  showStatus("バックアップを保存しました");
});

$("import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || (!data.timetable && !Array.isArray(data.tasks))) throw new Error();
    if (!confirm("今のデータを、このファイルの内容で置きかえますか？")) return;
    state = normalize(data);
    save();
    renderAll();
    showStatus("読み込みました");
  } catch {
    showStatus("このファイルは読み込めませんでした", { error: true, ms: 5000 });
  }
});

// ---- 共通 ----

function renderAll() {
  renderTimetable();
  renderTasks();
}

// 別のタブで変更されたら反映する
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY) return;
  state = load();
  renderAll();
});

// 日付が変わったとき（開きっぱなしのとき）に「今日」や残り日数を更新する
let lastDay = dateText();
setInterval(() => {
  const now = dateText();
  if (now === lastDay) return;
  lastDay = now;
  if (!document.activeElement || !document.activeElement.closest("#timetable")) renderTimetable();
  renderTasks();
}, 60000);

renderAll();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);
