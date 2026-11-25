// Gives many files (photos, PDFs, anything) names that follow one pattern, like "遠足_001.jpg",
// and saves the renamed copies as a ZIP or straight into a folder. A web page cannot rename the
// user's files in place, so the originals stay as they are.
import { showStatus, hideStatus } from "../shared/js/status.js";
import { download, onFileDrop, safeFileName, formatSize } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { makeZip } from "../shared/js/zip.js";
import { readInfo } from "../shared/js/exif.js";
import { isImage } from "../shared/js/heic.js";
import { dateText } from "../shared/js/dates.js";
import { createSortable } from "../shared/js/sortable.js";
import { iconButton } from "../shared/js/buttons.js";
import "../shared/js/guide.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their settings. Add a new key instead. The 名簿 is not saved: it holds students' names.
const SETTINGS_KEY = "file-rename-settings-v1";
const EXIF_READ_BYTES = 256 * 1024; // the Exif block sits near the start of a photo file
const MAX_NUMBER = 99999;
const DEFAULTS = {
  prefix: "写真",
  numbered: true,
  place: "after", // where the number goes: "front", "after" (the prefix) or "end"
  start: 1,
  digits: 0, // 0 = as many as the last number needs
  middle: "none", // "none", "original", "list" or "date"
  suffix: "",
  separator: "underscore",
  ext: "keep", // "keep" or "lower"
  order: "name", // "name", "taken", "modified" or "manual"
};
const SEPARATORS = { underscore: "_", hyphen: "-", space: " ", none: "" };
// The parts of a name, in order, for each place the number can go.
const PART_ORDER = {
  front: ["number", "prefix", "middle", "suffix"],
  after: ["prefix", "number", "middle", "suffix"],
  end: ["prefix", "middle", "suffix", "number"],
};
// Pictures the browser can show as a thumbnail without help (not HEIC).
const THUMB_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/svg+xml"]);
const byName = new Intl.Collator("ja", { numeric: true, sensitivity: "base" }).compare;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  folderInput: $("folder-input"),
  clearBtn: $("clear-btn"),
  summary: $("summary"),
  folderBtn: $("folder-btn"),
  saveBtn: $("save-btn"),
  welcome: $("welcome"),
  work: $("work"),
  example: $("example"),
  prefix: $("prefix"),
  numbered: $("numbered"),
  place: $("place"),
  start: $("start"),
  digits: $("digits"),
  middle: $("middle"),
  listBox: $("list-box"),
  listText: $("list-text"),
  listNote: $("list-note"),
  suffix: $("suffix"),
  separator: $("separator"),
  ext: $("ext"),
  reverseBtn: $("reverse-btn"),
  dupNote: $("dup-note"),
  list: $("list"),
  overwriteDialog: $("overwrite-dialog"),
  overwriteHint: $("overwrite-hint"),
};

const settings = { ...DEFAULTS, ...loadJson(SETTINGS_KEY, {}) };
const state = {
  items: [], // { file, taken: Date | null, thumb: object URL | "", el } in numbering order
  names: [], // { name, duplicate } for each item, from the settings
  roster: [], // the 名簿, one name per line
  busy: false,
};

/* ---------- adding files ---------- */

// A folder dropped on the page arrives as an empty "file" that cannot be read.
const looksLikeFolder = (file) => file.size === 0 && !file.type && !/\.[^.]+$/.test(file.name);
const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

async function addFiles(files) {
  const fresh = [...files].filter((file) => !looksLikeFolder(file) && !state.items.some((item) => sameFile(item.file, file)));
  if (!fresh.length) {
    if (files.length) showStatus("追加できるファイルがありません。フォルダは「フォルダごと追加」から選んでください", { error: true });
    return;
  }
  // New files are numbered after the ones already in a hand-made order.
  const added = fresh.map(makeItem);
  state.items.push(...added);
  sortItems();
  render();
  showStatus(`${added.length}個のファイルを追加しました`);
  await Promise.all(added.map(readTakenDate));
  sortItems();
  render();
}

function makeItem(file) {
  const thumb = THUMB_TYPES.has(file.type) ? URL.createObjectURL(file) : "";
  const item = { file, taken: null, thumb, el: null };
  item.el = makeRow(item);
  sortable.attach(item.el, item);
  return item;
}

// When the photo was taken, from its Exif block ("2026:11:14 10:20:30").
async function readTakenDate(item) {
  if (!isImage(item.file)) return;
  try {
    const bytes = new Uint8Array(await item.file.slice(0, EXIF_READ_BYTES).arrayBuffer());
    const exif = readInfo(bytes).exif;
    const text = exif?.dateTimeOriginal || exif?.dateTime;
    const parts = String(text || "").match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (!parts) return;
    const [, year, month, day, hour, minute, second] = parts.map(Number);
    item.taken = new Date(year, month - 1, day, hour, minute, second);
  } catch {
    // No readable date: the file's own date is used instead.
  }
}

/* ---------- order and names ---------- */

// The date a file is put in order by: when the photo was taken, or else when it was saved.
const fileDate = (item) => item.taken ?? new Date(item.file.lastModified);

const COMPARE = {
  name: (a, b) => byName(a.file.name, b.file.name),
  taken: (a, b) => fileDate(a) - fileDate(b) || byName(a.file.name, b.file.name),
  modified: (a, b) => a.file.lastModified - b.file.lastModified || byName(a.file.name, b.file.name),
};

function sortItems() {
  const compare = COMPARE[settings.order];
  if (compare) state.items.sort(compare);
}

function reverseOrder() {
  state.items.reverse();
  settings.order = "manual";
  saveJson(SETTINGS_KEY, settings);
  render();
}

const extensionOf = (name) => name.match(/\.[^.]+$/)?.[0] ?? "";
const withoutExtension = (name) => name.slice(0, name.length - extensionOf(name).length) || name;

function numberText(index) {
  const number = settings.start + index;
  const last = settings.start + state.items.length - 1;
  const digits = settings.digits || String(last).length;
  return String(number).padStart(digits, "0");
}

function middleText(item, index) {
  if (settings.middle === "original") return withoutExtension(item.file.name);
  if (settings.middle === "list") return state.roster[index] ?? "";
  if (settings.middle === "date") return dateText(fileDate(item), "-");
  return "";
}

// The new name of the item at `index` (before telling apart names that come out the same).
function newName(item, index) {
  const parts = {
    prefix: settings.prefix.trim(),
    number: settings.numbered ? numberText(index) : "",
    middle: middleText(item, index).trim(),
    suffix: settings.suffix.trim(),
  };
  const stem = PART_ORDER[settings.place].map((part) => parts[part]).filter(Boolean).join(SEPARATORS[settings.separator]);
  let extension = extensionOf(item.file.name);
  if (settings.ext === "lower") extension = extension.toLowerCase();
  return safeFileName(stem || withoutExtension(item.file.name)) + extension;
}

// Names that come out the same get " (2)", " (3)" … like a computer does when copying.
// Chromebooks and Windows see "A.jpg" and "a.JPG" as the same name, so case is ignored.
function computeNames() {
  const taken = new Set();
  state.names = state.items.map((item, index) => {
    const wanted = newName(item, index);
    let name = wanted;
    for (let copy = 2; taken.has(name.toLowerCase()); copy++) {
      name = `${withoutExtension(wanted)} (${copy})${extensionOf(wanted)}`;
    }
    taken.add(name.toLowerCase());
    return { name, duplicate: name !== wanted };
  });
}

/* ---------- showing ---------- */

function makeRow(item) {
  const row = document.createElement("li");
  row.className = "item";
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (item.thumb) {
    thumb.innerHTML = `<img alt="" loading="lazy" decoding="async" draggable="false">`;
    thumb.firstChild.src = item.thumb;
  } else {
    const kind = extensionOf(item.file.name).slice(1).toUpperCase().slice(0, 4) || "?";
    thumb.innerHTML = `<svg class="i" aria-hidden="true"><use href="#i-file"/></svg><span class="kind"></span>`;
    thumb.querySelector(".kind").textContent = kind;
  }
  const names = document.createElement("div");
  names.className = "names";
  names.innerHTML = `<span class="new-name"></span><span class="old-name"><svg class="i" aria-hidden="true"><use href="#i-arrow-right"/></svg><span></span></span>`;
  const remove = iconButton("i-close", "このファイルを外す", () => removeItem(item));
  row.append(thumb, names, remove);
  return row;
}

function removeItem(item) {
  if (state.busy) return;
  URL.revokeObjectURL(item.thumb);
  state.items.splice(state.items.indexOf(item), 1);
  render();
}

function clearAll() {
  if (state.busy) return;
  for (const item of state.items) URL.revokeObjectURL(item.thumb);
  state.items = [];
  render();
}

function showSettings() {
  els.prefix.value = settings.prefix;
  els.numbered.checked = settings.numbered;
  els.place.value = settings.place;
  els.start.value = settings.start;
  els.digits.value = settings.digits;
  els.middle.value = settings.middle;
  els.suffix.value = settings.suffix;
  els.separator.value = settings.separator;
  els.ext.value = settings.ext;
}

// Brings the screen in line with `state` and `settings`.
function render() {
  computeNames();
  const count = state.items.length;
  els.welcome.hidden = count > 0;
  els.work.hidden = count === 0;
  els.clearBtn.disabled = count === 0 || state.busy;
  els.saveBtn.disabled = count === 0 || state.busy;
  els.folderBtn.disabled = count === 0 || state.busy;
  els.summary.textContent = count ? `${count}個（${formatSize(totalSize())}）` : "";
  els.place.disabled = !settings.numbered;
  els.start.disabled = !settings.numbered;
  els.digits.disabled = !settings.numbered;
  els.listBox.hidden = settings.middle !== "list";
  for (const tab of document.querySelectorAll("[data-order]")) tab.setAttribute("aria-checked", String(tab.dataset.order === settings.order));
  renderList();
  renderNotes();
}

const totalSize = () => state.items.reduce((sum, item) => sum + item.file.size, 0);

function renderList() {
  els.list.replaceChildren(...state.items.map((item) => item.el));
  state.items.forEach((item, index) => {
    const { name, duplicate } = state.names[index];
    item.el.querySelector(".new-name").textContent = name;
    item.el.querySelector(".old-name span").textContent = `元: ${item.file.name}`;
    item.el.classList.toggle("duplicate", duplicate);
    item.el.title = duplicate ? "同じ名前になるので、後ろに番号を付けました" : "";
  });
  els.example.textContent = state.names[0]?.name ?? "";
}

function renderNotes() {
  const duplicates = state.names.filter((entry) => entry.duplicate).length;
  els.dupNote.hidden = duplicates === 0;
  els.dupNote.textContent = `${duplicates}個のファイルが同じ名前になるので、後ろに (2) などを付けました。番号を付けると重なりません。`;
  const people = state.roster.length;
  const files = state.items.length;
  let note = `名簿 ${people}人・ファイル ${files}個`;
  if (people < files) note += "。名簿が足りない分は名前なしになります";
  if (people > files) note += "。ファイルが足りない分の名簿は使いません";
  els.listNote.textContent = note;
}

/* ---------- settings ---------- */

function readSettings() {
  settings.prefix = els.prefix.value;
  settings.numbered = els.numbered.checked;
  settings.place = els.place.value;
  const start = Math.round(Number(els.start.value));
  settings.start = Number.isFinite(start) ? Math.min(MAX_NUMBER, Math.max(0, start)) : 1;
  settings.digits = Number(els.digits.value);
  settings.middle = els.middle.value;
  settings.suffix = els.suffix.value;
  settings.separator = els.separator.value;
  settings.ext = els.ext.value;
  state.roster = els.listText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  saveJson(SETTINGS_KEY, settings);
  render();
}

function chooseOrder(order) {
  settings.order = order;
  saveJson(SETTINGS_KEY, settings);
  sortItems();
  render();
}

/* ---------- saving ---------- */

async function saveZip() {
  if (!state.items.length || state.busy) return;
  await work("ZIPを作っています…", async () => {
    const files = [];
    for (const [index, item] of state.items.entries()) {
      files.push({ name: state.names[index].name, bytes: new Uint8Array(await item.file.arrayBuffer()) });
    }
    const zipName = safeFileName(settings.prefix.trim() || "名前を変えたファイル");
    download(makeZip(files), `${zipName}.zip`);
  });
}

// Chrome (and so Chromebooks) can write into a folder the user picks.
const canSaveToFolder = () => typeof window.showDirectoryPicker === "function";

async function saveToFolder() {
  if (!state.items.length || state.busy) return;
  let folder;
  try {
    folder = await window.showDirectoryPicker({ id: "file-rename", mode: "readwrite" });
  } catch {
    return; // closed without choosing
  }
  const existing = await existingNames(folder);
  if (existing.length && !(await askOverwrite(existing))) return;
  await work("フォルダに書き出しています…", async () => {
    for (const [index, item] of state.items.entries()) {
      const handle = await folder.getFileHandle(state.names[index].name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(item.file);
      await writable.close();
    }
    return `「${folder.name}」に${state.items.length}個のファイルを保存しました`;
  });
}

async function existingNames(folder) {
  const found = [];
  for (const { name } of state.names) {
    try {
      await folder.getFileHandle(name);
      found.push(name);
    } catch {
      // Not there yet: fine.
    }
  }
  return found;
}

function askOverwrite(names) {
  const shown = names.slice(0, 3).join("、");
  const more = names.length > 3 ? ` ほか${names.length - 3}個` : "";
  els.overwriteHint.textContent = `選んだフォルダに「${shown}」${more}がすでにあります。上書きすると、もとの中身は消えます。`;
  els.overwriteDialog.returnValue = "";
  els.overwriteDialog.showModal();
  return new Promise((resolve) => {
    els.overwriteDialog.addEventListener("close", () => resolve(els.overwriteDialog.returnValue === "overwrite"), { once: true });
  });
}

// Runs a save with the buttons off and a message up. `task` may return a message for the end.
async function work(message, task) {
  state.busy = true;
  render();
  showStatus(message, { sticky: true });
  try {
    const done = await task();
    if (done) showStatus(done, { ms: 6000 });
    else hideStatus();
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。ファイルの数を減らすか、別のフォルダでためしてください", { error: true });
  } finally {
    state.busy = false;
    render();
  }
}

/* ---------- events ---------- */

const sortable = createSortable({
  scroller: els.list,
  vertical: true,
  items: () => state.items,
  canStart: (e) => !e.target.closest("button") && !state.busy,
  ghost: (item) => [item.el.querySelector(".new-name").cloneNode(true)],
  onDrop: ([item], target, after) => {
    if (item === target) return;
    state.items.splice(state.items.indexOf(item), 1);
    state.items.splice(state.items.indexOf(target) + (after ? 1 : 0), 0, item);
    settings.order = "manual";
    saveJson(SETTINGS_KEY, settings);
    render();
  },
});

for (const input of [els.fileInput, els.folderInput]) {
  input.addEventListener("change", (e) => {
    addFiles(e.target.files);
    e.target.value = "";
  });
}
els.clearBtn.addEventListener("click", clearAll);
els.saveBtn.addEventListener("click", saveZip);
els.folderBtn.addEventListener("click", saveToFolder);
els.folderBtn.hidden = !canSaveToFolder();
els.reverseBtn.addEventListener("click", reverseOrder);
for (const tab of document.querySelectorAll("[data-order]")) {
  tab.addEventListener("click", () => chooseOrder(tab.dataset.order));
}
for (const input of document.querySelectorAll(".form input, .form select, .form textarea")) {
  input.addEventListener("input", readSettings);
}
onFileDrop(addFiles);
showSettings();
render();

// Keeps this tool working without a network once it has been opened.
registerOffline(["./", "index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]);

// Hook for automated tests.
window.__fileRename = { state, settings, addFiles, saveZip };
