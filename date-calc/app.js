// 日付の計算: the date some days before or after, the days between two dates, countdowns to
// school events, and a month calendar with the national holidays.
import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { dateText } from "../shared/js/dates.js";
import { registerOffline } from "../shared/js/offline.js";
import { holidayName } from "./holidays.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const EVENTS_KEY = "date-calc-events-v1";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STEPS = 20000; // school days counted one by one: about 50 years
const WEEKDAYS = "日月火水木金土";
const SATURDAY = 6;
const SUNDAY = 0;

const $ = (id) => document.getElementById(id);

const warekiFormat = new Intl.DateTimeFormat("ja-JP-u-ca-japanese", { era: "long", year: "numeric", month: "long", day: "numeric" });

const state = {
  pane: "after",
  direction: 1, // 1: 後, -1: 前
  month: null, // first day of the month the calendar shows
  events: loadJson(EVENTS_KEY, []), // [{ id, name, date: "YYYY-MM-DD" }]
};

/* ---------- dates ---------- */

// Today at midnight, local time.
function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// "2026-11-04" from a date input → a Date, or null when empty or wrong.
function parseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function daysBetween(start, end) {
  return Math.round((end - start) / DAY_MS);
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// One month after 1月31日 is the end of February, not 3月3日.
function addMonths(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

function isDayOff(date) {
  const weekday = date.getDay();
  return weekday === SATURDAY || weekday === SUNDAY || holidayName(date) !== "";
}

// Moves by `count` weekdays that are not holidays (土日・祝日をとばす).
function addSchoolDays(date, count, direction) {
  let current = date;
  let left = count;
  for (let step = 0; left > 0 && step < MAX_STEPS; step++) {
    current = addDays(current, direction);
    if (!isDayOff(current)) left--;
  }
  return current;
}

function moveDate(start, amount, unit, direction) {
  const signed = amount * direction;
  const moves = {
    day: () => addDays(start, signed),
    school: () => addSchoolDays(start, amount, direction),
    week: () => addDays(start, signed * 7),
    month: () => addMonths(start, signed),
    year: () => addMonths(start, signed * 12),
  };
  return moves[unit]();
}

/* ---------- words ---------- */

// "2026年11月4日（水）"
function dateWords(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${WEEKDAYS[date.getDay()]}）`;
}

// "令和8年11月4日" and the holiday's name when there is one.
function warekiWords(date) {
  const holiday = holidayName(date);
  const wareki = warekiFormat.format(date);
  return holiday ? `${wareki}・${holiday}` : wareki;
}

// "令和8年" (the era and year only).
function warekiYear(date) {
  const parts = warekiFormat.formatToParts(date).filter((part) => part.type === "era" || part.type === "year");
  return `${parts.map((part) => part.value).join("")}年`;
}

// "今日から30日後", "今日", "3日前"
function fromTodayWords(date) {
  const days = daysBetween(today(), date);
  if (days === 0) return "今日です";
  if (days > 0) return `今日から${days}日後`;
  return `今日から${-days}日前`;
}

// "4週と2日" or "2か月と3日"
function weeksWords(days) {
  const weeks = Math.floor(days / 7);
  const rest = days % 7;
  if (weeks === 0) return `${rest}日`;
  return rest ? `${weeks}週と${rest}日` : `${weeks}週`;
}

function monthsWords(start, end) {
  let months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
  if (addMonths(start, months) > end) months--;
  const rest = daysBetween(addMonths(start, months), end);
  const years = Math.floor(months / 12);
  const parts = [];
  if (years) parts.push(`${years}年`);
  if (months % 12) parts.push(`${months % 12}か月`);
  if (rest || parts.length === 0) parts.push(`${rest}日`);
  return parts.join("と");
}

/* ---------- 何日後・何日前 ---------- */

function renderAfter() {
  const start = parseDate($("after-start").value);
  const amount = Math.max(0, Math.floor(Number($("after-amount").value) || 0));
  for (const button of document.querySelectorAll("[data-direction]")) {
    button.setAttribute("aria-checked", String(Number(button.dataset.direction) === state.direction));
  }
  if (!start) {
    $("after-result").textContent = "はじめの日を入れてください";
    $("after-wareki").textContent = "";
    $("after-note").textContent = "";
    return;
  }
  const result = moveDate(start, amount, $("after-unit").value, state.direction);
  $("after-result").textContent = dateWords(result);
  $("after-wareki").textContent = warekiWords(result);
  $("after-note").textContent = fromTodayWords(result);
}

/* ---------- 2つの日付のあいだ ---------- */

function countDaysOff(start, end) {
  const counts = { weekdays: 0, weekends: 0, holidays: 0 };
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const weekday = date.getDay();
    if (weekday === SATURDAY || weekday === SUNDAY) counts.weekends++;
    else if (holidayName(date)) counts.holidays++;
    else counts.weekdays++;
  }
  return counts;
}

function renderBetween() {
  let start = parseDate($("between-start").value);
  let end = parseDate($("between-end").value);
  const stats = $("between-stats");
  if (!start || !end) {
    $("between-result").textContent = "2つの日にちを入れてください";
    $("between-sub").textContent = "";
    stats.replaceChildren();
    return;
  }
  const reversed = end < start;
  if (reversed) [start, end] = [end, start];
  const days = daysBetween(start, end);
  $("between-result").textContent = `${days}日`;
  $("between-sub").textContent = `${dateWords(start)} から ${dateWords(end)} まで${reversed ? "（日にちを入れかえて計算）" : ""}`;
  const counts = countDaysOff(start, end);
  const rows = [
    ["両方の日をふくめると", `${days + 1}日`],
    ["週にすると", weeksWords(days)],
    ["月にすると", monthsWords(start, end)],
    ["平日（両方の日をふくむ）", `${counts.weekdays}日`],
    ["土日", `${counts.weekends}日`],
    ["土日以外の祝日", `${counts.holidays}日`],
  ];
  stats.replaceChildren(...rows.flatMap(([term, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    return [dt, dd];
  }));
}

/* ---------- あと何日 ---------- */

function sortedEvents() {
  return [...state.events].sort((a, b) => a.date.localeCompare(b.date));
}

function eventCountdown(date) {
  const days = daysBetween(today(), date);
  if (days === 0) return { number: "今日", unit: "", kind: "today" };
  if (days > 0) return { number: String(days), unit: "日", kind: "future", prefix: "あと" };
  return { number: String(-days), unit: "日前", kind: "past", prefix: "" };
}

function buildEvent(item) {
  const date = parseDate(item.date);
  const countdown = eventCountdown(date);
  const li = document.createElement("li");
  li.className = `event ${countdown.kind}`;
  li.innerHTML = `
    <div class="event-main"><span class="event-name"></span><span class="event-date"></span></div>
    <div class="event-count"><span class="prefix"></span><strong></strong><span class="unit"></span></div>
    <button class="btn icon event-del" title="消す" aria-label="消す"><svg class="i" aria-hidden="true"><use href="#i-trash"/></svg></button>`;
  li.querySelector(".event-name").textContent = item.name;
  li.querySelector(".event-date").textContent = dateWords(date);
  li.querySelector(".prefix").textContent = countdown.prefix ?? "";
  li.querySelector("strong").textContent = countdown.number;
  li.querySelector(".unit").textContent = countdown.unit;
  li.querySelector(".event-del").addEventListener("click", () => removeEvent(item.id));
  return li;
}

function renderCountdown() {
  const events = sortedEvents();
  $("event-empty").hidden = events.length > 0;
  $("event-list").replaceChildren(...events.map(buildEvent));
}

function addEvent(name, date) {
  state.events.push({ id: Date.now().toString(36), name, date });
  if (!saveJson(EVENTS_KEY, state.events)) showStatus("このブラウザでは保存できません。閉じると消えます", { error: true });
  render();
}

function removeEvent(id) {
  state.events = state.events.filter((item) => item.id !== id);
  saveJson(EVENTS_KEY, state.events);
  render();
}

/* ---------- カレンダー ---------- */

function buildDayCell(date, eventsByDate) {
  const td = document.createElement("td");
  const isToday = daysBetween(today(), date) === 0;
  const holiday = holidayName(date);
  const classes = [];
  if (date.getDay() === SUNDAY || holiday) classes.push("sun");
  if (date.getDay() === SATURDAY) classes.push("sat");
  if (isToday) classes.push("today");
  td.className = classes.join(" ");
  const names = [holiday, ...(eventsByDate.get(dateText(date)) ?? [])].filter(Boolean);
  td.innerHTML = `<span class="day"></span><span class="names"></span>`;
  td.querySelector(".day").textContent = date.getDate();
  td.querySelector(".names").textContent = names.join("・");
  return td;
}

function renderCalendar() {
  const first = state.month;
  $("month-title").textContent = `${first.getFullYear()}年${first.getMonth() + 1}月（${warekiYear(first)}）`;
  const eventsByDate = new Map();
  for (const item of state.events) eventsByDate.set(item.date, [...(eventsByDate.get(item.date) ?? []), item.name]);
  const rows = [];
  let date = addDays(first, -first.getDay());
  while (rows.length === 0 || date.getMonth() === first.getMonth()) {
    const tr = document.createElement("tr");
    for (let i = 0; i < 7; i++) {
      const td = buildDayCell(date, eventsByDate);
      if (date.getMonth() !== first.getMonth()) td.classList.add("other");
      tr.append(td);
      date = addDays(date, 1);
    }
    rows.push(tr);
  }
  $("calendar-body").replaceChildren(...rows);
}

function moveMonth(months) {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + months, 1);
  render();
}

/* ---------- screen ---------- */

const RENDERERS = { after: renderAfter, between: renderBetween, countdown: renderCountdown, calendar: renderCalendar };

function render() {
  RENDERERS[state.pane]();
}

function showPane(name) {
  state.pane = name;
  for (const tab of document.querySelectorAll("[data-pane]")) tab.setAttribute("aria-selected", String(tab.dataset.pane === name));
  for (const pane of Object.keys(RENDERERS)) $(`${pane}-pane`).hidden = pane !== name;
  render();
}

/* ---------- events ---------- */

const todayText = dateText(today());
$("after-start").value = todayText;
$("between-start").value = todayText;
$("between-end").value = dateText(addDays(today(), 30));
$("event-date").value = todayText;
state.month = new Date(today().getFullYear(), today().getMonth(), 1);

for (const tab of document.querySelectorAll("[data-pane]")) tab.addEventListener("click", () => showPane(tab.dataset.pane));
for (const id of ["after-start", "after-amount", "after-unit", "between-start", "between-end"]) {
  $(id).addEventListener("input", render);
}
for (const button of document.querySelectorAll("[data-direction]")) {
  button.addEventListener("click", () => {
    state.direction = Number(button.dataset.direction);
    render();
  });
}
for (const button of document.querySelectorAll("[data-quick]")) {
  button.addEventListener("click", () => {
    const [amount, unit] = button.dataset.quick.split(" ");
    $("after-amount").value = amount;
    $("after-unit").value = unit;
    render();
  });
}
$("event-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("event-name").value.trim();
  if (!name || !parseDate($("event-date").value)) return;
  addEvent(name, $("event-date").value);
  $("event-name").value = "";
  $("event-name").focus();
});
$("month-prev").addEventListener("click", () => moveMonth(-1));
$("month-next").addEventListener("click", () => moveMonth(1));
$("month-today").addEventListener("click", () => {
  state.month = new Date(today().getFullYear(), today().getMonth(), 1);
  render();
});
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "holidays.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__dateCalc = { state, moveDate, holidayName, parseDate };
