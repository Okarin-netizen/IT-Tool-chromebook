// 単位の換算: the screen. The calculations are in convert.js (tested without a browser).
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { CATEGORIES, UnitError, convert, formatNumber } from "./convert.js";
import "../shared/js/guide.js";

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "convert.js", "icon.svg", "manifest.webmanifest"]);

// Never change the key (or the shape of what is saved) once the tool is in use.
// { cat: "length", units: { length: { from: "km", to: "m" }, ... }, dataBase: "1024" }
const SETTINGS_KEY = "unit-convert-settings-v1";

// The units shown first for each kind.
const DEFAULT_UNITS = {
  length: { from: "km", to: "m" },
  mass: { from: "kg", to: "g" },
  area: { from: "m2", to: "a" },
  volume: { from: "l", to: "ml" },
  time: { from: "h", to: "min" },
  speed: { from: "kmph", to: "mps" },
  temperature: { from: "c", to: "f" },
  data: { from: "GB", to: "MB" },
};

const $ = (id) => document.getElementById(id);

const saved = loadJson(SETTINGS_KEY, {}) || {};
const state = {
  cat: CATEGORIES.some((c) => c.id === saved.cat) ? saved.cat : CATEGORIES[0].id,
  units: { ...DEFAULT_UNITS, ...(saved.units || {}) },
  dataBase: saved.dataBase === "1000" ? "1000" : "1024",
};

function category() {
  return CATEGORIES.find((c) => c.id === state.cat);
}

function unitName(id) {
  return category().units.find((u) => u.id === id)?.name ?? id;
}

function save() {
  saveJson(SETTINGS_KEY, { cat: state.cat, units: state.units, dataBase: state.dataBase });
}

// "１２．５" or "1,500" typed by students → a number, or null when it is not a number.
function parseValue(text) {
  const plain = text
    .replace(/[０-９．－]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[ー−]/g, "-")
    .replace(/[,，\s]/g, "");
  if (plain === "") return null;
  const value = Number(plain);
  return Number.isFinite(value) ? value : null;
}

/* ---------- screen ---------- */

function fillSelect(select, units, value) {
  select.replaceChildren(...units.map((u) => new Option(u.name, u.id)));
  select.value = units.some((u) => u.id === value) ? value : units[0].id;
}

function showCategory() {
  const cat = category();
  for (const tab of document.querySelectorAll(".tab[data-cat]")) tab.setAttribute("aria-selected", String(tab.dataset.cat === cat.id));
  const units = state.units[cat.id] || DEFAULT_UNITS[cat.id];
  fillSelect($("from"), cat.units, units.from);
  fillSelect($("to"), cat.units, units.to);
  $("data-base-row").hidden = cat.id !== "data";
  $("data-base").value = state.dataBase;
  render();
}

function render() {
  const cat = category();
  const from = $("from").value;
  const to = $("to").value;
  const options = { dataBase: state.dataBase };
  const value = parseValue($("value").value);
  const rows = [];
  $("result-unit").textContent = "";
  $("formula").textContent = "";
  $("result").classList.remove("error");
  try {
    if (value === null) throw new UnitError("数を入れてください");
    const answer = formatNumber(convert(value, from, to, options));
    $("result").textContent = answer;
    $("result-unit").textContent = unitName(to);
    $("formula").textContent = `${formatNumber(value)} ${unitName(from)} = ${answer} ${unitName(to)}`;
    for (const unit of cat.units) {
      const li = document.createElement("li");
      li.dataset.unit = unit.id;
      if (unit.id === from) li.classList.add("from");
      const number = document.createElement("span");
      number.className = "all-number";
      number.textContent = formatNumber(convert(value, from, unit.id, options));
      const name = document.createElement("span");
      name.className = "all-unit";
      name.textContent = unit.name;
      li.append(number, name);
      rows.push(li);
    }
  } catch (error) {
    if (!(error instanceof UnitError)) throw error;
    $("result").textContent = error.message;
    $("result").classList.add("error");
  }
  $("all").replaceChildren(...rows);
}

function rememberUnits() {
  state.units[state.cat] = { from: $("from").value, to: $("to").value };
  save();
}

/* ---------- events ---------- */

$("tabs").replaceChildren(...CATEGORIES.map((cat) => {
  const tab = document.createElement("button");
  tab.className = "tab";
  tab.type = "button";
  tab.setAttribute("role", "tab");
  tab.dataset.cat = cat.id;
  tab.textContent = cat.name;
  tab.addEventListener("click", () => {
    state.cat = cat.id;
    save();
    showCategory();
  });
  return tab;
}));

$("value").addEventListener("input", render);
for (const id of ["from", "to"]) {
  $(id).addEventListener("change", () => {
    rememberUnits();
    render();
  });
}
$("swap").addEventListener("click", () => {
  const from = $("from").value;
  $("from").value = $("to").value;
  $("to").value = from;
  rememberUnits();
  render();
});
$("data-base").addEventListener("change", () => {
  state.dataBase = $("data-base").value;
  save();
  render();
});

showCategory();

// Hook for automated tests.
window.__unitConvert = { convert, formatNumber };
