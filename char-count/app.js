// 文字数カウンター: counts the characters of an essay and lays it out on 400-character
// manuscript paper (原稿用紙), to look at or print.
import { showStatus } from "../shared/js/status.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { copyText } from "../shared/js/clipboard.js";
import { registerOffline } from "../shared/js/offline.js";

// Never change a key (or the shape of what is saved) once the tool is in use.
const SETTINGS_KEY = "char-count-v1";

const PAPER_COLUMNS = 20; // cells in one line of 原稿用紙
const PAPER_ROWS = 20; // lines on one sheet
const READ_CHARS_PER_MINUTE = 300; // a calm reading-aloud speed for Japanese
const READ_WORDS_PER_MINUTE = 130; // the same for English
const SAVE_DELAY_MS = 300;

// Characters that may not start a line on 原稿用紙: they go into the last cell of the line before.
const NOT_AT_LINE_START = new Set([..."、。，．,.」』）)】〕〉》"]);
// A paragraph that starts like this is not indented (a conversation starts at the top).
const NO_INDENT_START = /^[\s「『（(]/u;
// How characters change in vertical writing on 原稿用紙.
const VERTICAL_FORMS = { "「": "﹁", "」": "﹂", "『": "﹃", "』": "﹄", "（": "︵", "）": "︶", "(": "︵", ")": "︶" };
const TURNED = new Set([..."ー―─～〜…‥-=＝→←"]);
const COMMAS = new Set([..."、。，．,."]);
const SMALL_KANA = new Set([..."ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ"]);
const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;
const SPACE = /^\s$/u;
const ENGLISH_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;
const LATIN = /[A-Za-z0-9]/;

const $ = (id) => document.getElementById(id);

const settings = loadJson(SETTINGS_KEY, { text: "", min: "", max: "", vertical: true, indent: true });
const state = {
  pane: "count",
};
let saveTimer = 0;

const segmenter = "Segmenter" in Intl ? new Intl.Segmenter("ja", { granularity: "grapheme" }) : null;

// One entry per character as people see it (an emoji or a letter with a mark is one).
function characters(text) {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/* ---------- counting ---------- */

function countText(text) {
  const chars = characters(text.replace(/\r/g, "")).filter((c) => c !== "\n");
  const visible = chars.filter((c) => !SPACE.test(c));
  const letters = visible.filter((c) => !PUNCTUATION_OR_SYMBOL.test(c));
  const lines = text.split("\n");
  const words = (text.match(ENGLISH_WORD) ?? []).length;
  const japanese = letters.filter((c) => !LATIN.test(c)).length;
  const readSeconds = Math.round((japanese / READ_CHARS_PER_MINUTE + words / READ_WORDS_PER_MINUTE) * 60);
  return {
    main: visible.length,
    withSpaces: chars.length,
    letters: letters.length,
    lines: text === "" ? 0 : lines.length,
    paragraphs: lines.filter((line) => line.trim()).length,
    words,
    readSeconds,
  };
}

/* ---------- 原稿用紙 ---------- */

// Lines of cells (each cell a string, usually one character) as the text sits on 原稿用紙.
function layoutPaper(text, { indent }) {
  const lines = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let chars = characters(paragraph);
    const wantsIndent = indent && chars.length > 0 && !NO_INDENT_START.test(paragraph);
    if (wantsIndent) chars = ["　", ...chars];
    let line = [];
    for (const ch of chars) {
      if (line.length === PAPER_COLUMNS) {
        if (NOT_AT_LINE_START.has(ch)) {
          line[PAPER_COLUMNS - 1] += ch;
          continue;
        }
        lines.push(line);
        line = [];
      }
      line.push(ch);
    }
    lines.push(line);
  }
  while (lines.length > 1 && lines.at(-1).length === 0) lines.pop();
  return lines;
}

// "2枚目の5行目まで" for a number of used lines.
function paperText(lineCount, isEmpty) {
  if (isEmpty) return "0枚";
  const sheets = Math.ceil(lineCount / PAPER_ROWS);
  const lastRow = lineCount - (sheets - 1) * PAPER_ROWS;
  return `${sheets}枚目の${lastRow}行目まで`;
}

// One character in a cell. For vertical writing some characters are swapped for their upright
// forms or turned, and small ones sit in the upper right of the cell.
function buildChar(ch, vertical, hanging) {
  const span = document.createElement("span");
  span.className = "ch";
  span.textContent = vertical ? (VERTICAL_FORMS[ch] ?? ch) : ch;
  if (vertical && TURNED.has(ch)) span.classList.add("turn");
  if (COMMAS.has(ch)) span.classList.add("comma");
  else if (SMALL_KANA.has(ch)) span.classList.add("small");
  if (hanging) span.classList.add("hang");
  return span;
}

function buildSheet(lines, vertical) {
  const sheet = document.createElement("div");
  sheet.className = vertical ? "sheet vertical" : "sheet horizontal";
  for (let row = 0; row < PAPER_ROWS; row++) {
    const lineEl = document.createElement("div");
    lineEl.className = "line";
    if (row === PAPER_ROWS / 2 - 1) lineEl.classList.add("middle");
    const cells = lines[row] ?? [];
    for (let col = 0; col < PAPER_COLUMNS; col++) {
      const cell = document.createElement("span");
      cell.className = "cell";
      characters(cells[col] ?? "").forEach((ch, i) => cell.append(buildChar(ch, vertical, i > 0)));
      lineEl.append(cell);
    }
    sheet.append(lineEl);
  }
  return sheet;
}

function renderPaper() {
  const lines = layoutPaper(settings.text, settings);
  const sheets = [];
  for (let start = 0; start < lines.length; start += PAPER_ROWS) {
    sheets.push(buildSheet(lines.slice(start, start + PAPER_ROWS), settings.vertical));
  }
  $("sheets").replaceChildren(...sheets);
  $("paper-info").textContent = paperText(lines.length, settings.text.trim() === "");
  for (const tab of document.querySelectorAll("[data-vertical]")) {
    tab.setAttribute("aria-checked", String(tab.dataset.vertical === String(settings.vertical)));
  }
  $("indent").checked = settings.indent;
  const orientation = settings.vertical ? "landscape" : "portrait";
  $("page-style").textContent = `@page { size: A4 ${orientation}; margin: 10mm; }`;
}

/* ---------- screen ---------- */

function timeText(seconds) {
  if (seconds < 60) return `約${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `約${minutes}分${rest}秒` : `約${minutes}分`;
}

function renderTarget(count) {
  const min = Number(settings.min) || 0;
  const max = Number(settings.max) || 0;
  const hasTarget = min > 0 || max > 0;
  $("target-bar").hidden = !hasTarget;
  $("target-text").hidden = !hasTarget;
  if (!hasTarget) return;
  const goal = max || min;
  $("target-fill").style.width = `${Math.min(100, (count / goal) * 100)}%`;
  let message = "目標の字数に入っています";
  let kind = "ok";
  if (count < min) {
    message = `あと${min - count}字で${min}字です`;
    kind = "short";
  } else if (max && count > max) {
    message = `${count - max}字多すぎます（${max}字まで）`;
    kind = "over";
  }
  $("target-text").textContent = message;
  $("target-text").dataset.kind = kind;
  $("target-bar").dataset.kind = kind;
}

function renderCount() {
  const count = countText(settings.text);
  const lines = layoutPaper(settings.text, settings);
  $("count-main").textContent = count.main.toLocaleString();
  $("count-spaces").textContent = `${count.withSpaces.toLocaleString()}字`;
  $("count-letters").textContent = `${count.letters.toLocaleString()}字`;
  $("count-paper").textContent = paperText(lines.length, settings.text.trim() === "");
  $("count-lines").textContent = `${count.lines}行・${count.paragraphs}段落`;
  $("count-words").textContent = `${count.words}語`;
  $("count-read").textContent = timeText(count.readSeconds);
  renderTarget(count.main);
}

function render() {
  if (state.pane === "count") renderCount();
  else renderPaper();
}

function showPane(name) {
  state.pane = name;
  for (const tab of document.querySelectorAll("[data-pane]")) tab.setAttribute("aria-selected", String(tab.dataset.pane === name));
  $("count-pane").hidden = name !== "count";
  $("paper-pane").hidden = name !== "paper";
  $("print-btn").hidden = name !== "paper";
  render();
}

/* ---------- saving ---------- */

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJson(SETTINGS_KEY, settings), SAVE_DELAY_MS);
}

async function copyAll() {
  if (!settings.text) return showStatus("コピーする文章がありません");
  const copied = await copyText(settings.text);
  showStatus(copied ? "文章をコピーしました" : "コピーできませんでした", { error: !copied });
}

function clearAll() {
  if (!settings.text) return;
  if (!confirm("書いた文章を全部消しますか？")) return;
  settings.text = "";
  $("text").value = "";
  saveJson(SETTINGS_KEY, settings);
  render();
}

function printPaper() {
  if (!settings.text.trim()) return showStatus("印刷する文章がありません");
  window.print();
}

/* ---------- events ---------- */

$("text").value = settings.text;
$("target-min").value = settings.min;
$("target-max").value = settings.max;

$("text").addEventListener("input", (e) => {
  settings.text = e.target.value;
  saveSoon();
  render();
});
for (const id of ["target-min", "target-max"]) {
  $(id).addEventListener("input", (e) => {
    settings[id === "target-min" ? "min" : "max"] = e.target.value;
    saveSoon();
    render();
  });
}
for (const tab of document.querySelectorAll("[data-pane]")) tab.addEventListener("click", () => showPane(tab.dataset.pane));
for (const tab of document.querySelectorAll("[data-vertical]")) {
  tab.addEventListener("click", () => {
    settings.vertical = tab.dataset.vertical === "true";
    saveSoon();
    render();
  });
}
$("indent").addEventListener("change", (e) => {
  settings.indent = e.target.checked;
  saveSoon();
  render();
});
$("copy-btn").addEventListener("click", copyAll);
$("clear-btn").addEventListener("click", clearAll);
$("print-btn").addEventListener("click", printPaper);
window.addEventListener("pagehide", () => saveJson(SETTINGS_KEY, settings));
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__charCount = { settings, countText, layoutPaper };
