import { openPdf, rasterizePdf } from "../shared/js/pdf.js";
import { createPageViewer, clampScale } from "../shared/js/page-viewer.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { History } from "../shared/js/history.js";
import {
  MARKER_FACTOR, SEAL_COLOR, TEXT_FONT, textWidth, drawStroke, drawStamp, hits, previewCanvas, renderInkImage, createInkEditor,
} from "../shared/js/ink.js";
import { makeZip } from "../shared/js/zip.js";
import { readZip } from "../shared/js/unzip.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";

const SCORE_H = 34; // height of a new score, in page points
const OUT_SUFFIX = "_採点済";
const STORE = { max: "pdf-grade-score-max" };
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  folderInput: $("folder-input"),
  filesBtn: $("files-btn"),
  filesClose: $("files-close"),
  tools: document.querySelectorAll(".btn.tool"),
  stampBtn: $("stamp-btn"),
  stampMenu: $("stamp-menu"),
  sealList: $("seal-list"),
  markList: $("mark-list"),
  scoreBtn: $("score-btn"),
  scoreMenu: $("score-menu"),
  scoreMax: $("score-max"),
  scoreUse: $("score-use"),
  swatches: document.querySelectorAll(".toolbar .swatch"),
  width: $("width"),
  textSize: $("text-size"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  deleteBtn: $("delete-btn"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomLabel: $("zoom-label"),
  prevBtn: $("prev-btn"),
  nextBtn: $("next-btn"),
  folderSaveBtn: $("folder-save-btn"),
  saveBtn: $("save-btn"),
  filesCount: $("files-count"),
  fileList: $("file-list"),
  filesEmpty: $("files-empty"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  docs: $("docs"),
};

const state = {
  // file: { id, name, size, bytes, pdf, views: [], section, row }
  files: [],
  // page view: { id, file, num, viewport (scale 1), el, canvas, ink, selbox, rendered, task }
  pages: new Map(),
  // Strokes and stamps as described in shared/js/ink.js (`page` is a page view id, unique
  // across all files), plus
  // text:   { type, page, text, color, x, y, w, h }
  // score:  { type, page, value, max, color, x, y, w, h }  (one per file)
  items: [],
  selected: null,
  drawing: null, // stroke being drawn
  editing: null, // { item, input, isNew } while a text or score is being typed
  current: null, // file shown at the top of the viewer
  tool: "pen",
  color: "#d11a1a",
  width: 2,
  textSize: 20,
  stamp: "ring",
  scoreMax: "",
  scale: 1,
  dirty: false,
};
let nextId = 1;

/* ---------- stamps, text and scores ---------- */

// Seals are always vermilion; marks use the current color.
const STAMPS = [
  { id: "ring", label: "まる", shape: "ring", w: 34, h: 34 },
  { id: "cross", label: "ばつ", shape: "cross", w: 28, h: 28 },
  { id: "check", label: "チェック", shape: "check", w: 30, h: 30 },
  { id: "triangle", label: "さんかく", shape: "triangle", w: 32, h: 30 },
  { id: "hanamaru", label: "花丸", shape: "hanamaru", w: 60, h: 60 },
  { id: "sumi", label: "済", seal: true, shape: "circle", w: 36, h: 36, text: "済" },
  { id: "kakunin", label: "確認", seal: true, shape: "circle", w: 40, h: 40, text: "確認" },
  { id: "yoku", label: "よくできました", seal: true, shape: "rect", fit: 0.86, w: 104, h: 26, text: "よくできました" },
  { id: "saiteishutsu", label: "再提出", seal: true, shape: "rect", fit: 0.86, w: 66, h: 26, text: "再提出" },
];
const stampDef = (id) => STAMPS.find((s) => s.id === id);

const textFont = (h) => `${h * 0.85}px ${TEXT_FONT}`;
const scoreFonts = (h) => [`bold ${h * 0.82}px ${TEXT_FONT}`, `bold ${h * 0.46}px ${TEXT_FONT}`];
const scoreSuffix = (max) => (max ? ` / ${max}` : "点");

// Text and scores grow sideways with what is typed; their height sets the font size.
function fitWidth(item) {
  if (item.type === "text") {
    item.w = textWidth(item.text, textFont(item.h)) + 2;
  } else if (item.type === "score") {
    const [big, small] = scoreFonts(item.h);
    item.w = textWidth(item.value, big) + textWidth(scoreSuffix(item.max), small) + item.h * 0.3;
  }
}

function drawText(ctx, item) {
  ctx.save();
  ctx.fillStyle = item.color;
  ctx.textBaseline = "middle";
  ctx.font = textFont(item.h);
  ctx.fillText(item.text, item.x + 1, item.y + item.h / 2);
  ctx.restore();
}

function drawScore(ctx, item) {
  const { x, y, w, h } = item;
  const [big, small] = scoreFonts(h);
  ctx.save();
  ctx.fillStyle = ctx.strokeStyle = item.color;
  ctx.textBaseline = "alphabetic";
  const base = y + h * 0.74;
  ctx.font = big;
  ctx.fillText(item.value, x + h * 0.1, base);
  const vw = ctx.measureText(item.value).width;
  ctx.font = small;
  ctx.fillText(scoreSuffix(item.max), x + h * 0.14 + vw, base);
  // Double underline, like a total written by hand.
  ctx.lineWidth = h * 0.045;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const ly of [y + h * 0.84, y + h * 0.95]) {
    ctx.moveTo(x + h * 0.04, ly);
    ctx.lineTo(x + w - h * 0.04, ly);
  }
  ctx.stroke();
  ctx.restore();
}

function newStamp(id, page, cx, cy) {
  const def = stampDef(id);
  const { w, h } = def;
  return {
    type: "stamp", page, kind: id, text: def.text ?? "",
    color: def.seal ? SEAL_COLOR : state.color,
    x: cx - w / 2, y: cy - h / 2, w, h,
  };
}

/* ---------- drawing items ---------- */

function drawItem(ctx, item) {
  if (item.type === "stroke") drawStroke(ctx, item);
  else if (item.type === "stamp") drawStamp(ctx, item, stampDef(item.kind));
  else if (item.type === "text") drawText(ctx, item);
  else if (item.type === "score") drawScore(ctx, item);
}

const history = new History(state);
const editor = createInkEditor({
  state,
  history,
  viewOf: (id) => state.pages.get(id),
  allViews: () => state.pages,
  drawItem,
  updateUi,
  onChange: () => refreshAllRows(),
  beforeRestore: () => commitEditor(true),
});
const { renderInk, renderPageInk, select, commit, undo, redo } = editor;

const fileItems = (file) => state.items.filter((i) => state.pages.get(i.page)?.file === file);
const scoreOf = (file) => fileItems(file).find((i) => i.type === "score");

/* ---------- opening PDFs ---------- */

const isZip = (f) => /zip/.test(f.type) || /\.zip$/i.test(f.name);
// Skips the hidden "._name.pdf" files macOS leaves in zips and folders.
const isJunk = (name) => /(^|\/)(__MACOSX\/|\._)/.test(name);

// Expands zips, drops everything that is not a PDF. Returns [{ name, size, bytes }].
async function collectPdfs(fileList) {
  const out = [];
  let skipped = 0;
  for (const f of fileList) {
    const path = f.webkitRelativePath || f.name;
    if (isJunk(path)) continue;
    if (isPdf(f)) {
      out.push({ name: f.name, size: f.size, bytes: new Uint8Array(await f.arrayBuffer()) });
    } else if (isZip(f)) {
      try {
        const entries = await readZip(await f.arrayBuffer(), (n) => /\.pdf$/i.test(n) && !isJunk(n));
        for (const e of entries) {
          out.push({ name: e.name.split("/").pop(), size: e.bytes.length, bytes: e.bytes });
        }
        if (!entries.length) skipped++;
      } catch (err) {
        console.error(err);
        skipped++;
      }
    } else {
      skipped++;
    }
  }
  return { pdfs: out, skipped };
}

async function addFiles(fileList) {
  commitEditor();
  const list = [...fileList];
  if (!list.length) return;
  showStatus("ファイルを読み込み中…", { sticky: true });
  const { pdfs, skipped } = await collectPdfs(list);
  const failed = [];
  let dupes = 0;
  let added = 0;
  const firstAdded = [];
  for (const [i, src] of pdfs.entries()) {
    if (state.files.some((f) => f.name === src.name && f.size === src.size)) {
      dupes++;
      continue;
    }
    showStatus(`PDFを読み込み中… (${i + 1}/${pdfs.length})`, { sticky: true });
    try {
      const pdf = await openPdf(src.bytes.slice()).promise;
      const file = { id: nextId++, name: src.name, size: src.size, bytes: src.bytes, pdf, views: [] };
      buildFileView(file);
      for (let num = 1; num <= pdf.numPages; num++) {
        const page = await pdf.getPage(num);
        createPageView(file, num, page.getViewport({ scale: 1 }));
        page.cleanup();
      }
      state.files.push(file);
      firstAdded.push(file);
      added++;
    } catch (err) {
      console.error(err);
      failed.push(err?.name === "PasswordException" ? `${src.name}（パスワード付き）` : src.name);
    }
  }

  state.files.sort((a, b) => collator.compare(a.name, b.name));
  for (const file of state.files) {
    els.docs.append(file.section);
    els.fileList.append(file.row);
  }
  els.welcome.hidden = state.files.length > 0;
  const wasEmpty = state.files.length === added;
  if (added) setScale(wasEmpty ? viewer.fitWidthScale() : state.scale);
  if (wasEmpty && added) els.viewer.scrollTop = 0;
  refreshAllRows();
  updateCurrent();
  updateUi();

  const notes = [];
  if (added) notes.push(`${added}人分のPDFを追加しました（全${state.files.length}人）`);
  if (dupes) notes.push(`同じファイル${dupes}件は飛ばしました`);
  if (skipped) notes.push(`PDFでないファイル${skipped}件は飛ばしました`);
  if (failed.length) notes.push(`開けなかったPDF: ${failed.join("、")}`);
  if (!notes.length) notes.push("PDFが見つかりませんでした");
  showStatus(notes.join("。"), { error: !added });
}

function buildFileView(file) {
  const section = document.createElement("section");
  section.className = "doc";
  const head = document.createElement("div");
  head.className = "doc-head";
  const title = document.createElement("span");
  title.className = "doc-title";
  title.textContent = file.name;
  const score = document.createElement("span");
  score.className = "doc-score";
  head.append(title, score);
  const pages = document.createElement("div");
  pages.className = "doc-pages";
  section.append(head, pages);
  file.section = section;
  file.head = head;
  file.headScore = score;
  file.pagesEl = pages;

  const row = document.createElement("li");
  row.className = "file-row";
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "file-jump";
  jump.title = "この人のPDFへ移動";
  const name = document.createElement("span");
  name.className = "file-name";
  name.textContent = baseName(file.name);
  const meta = document.createElement("span");
  meta.className = "file-meta";
  jump.append(name, meta);
  jump.addEventListener("click", () => {
    scrollToFile(file);
    if (window.matchMedia("(max-width: 760px)").matches) toggleFiles(false);
  });
  const dl = document.createElement("button");
  dl.type = "button";
  dl.className = "btn row-btn";
  dl.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-save"/></svg>';
  dl.title = "この人のPDFだけ保存";
  dl.setAttribute("aria-label", dl.title);
  dl.addEventListener("click", () => saveOne(file));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn row-btn row-del";
  del.textContent = "✕";
  del.title = "一覧から外す";
  del.addEventListener("click", () => removeFile(file));
  row.append(jump, dl, del);
  file.row = row;
  file.rowMeta = meta;
}

function createPageView(file, num, viewport) {
  const el = document.createElement("div");
  el.className = "page";
  const canvas = document.createElement("canvas");
  const ink = document.createElement("canvas");
  ink.className = "ink";
  const selbox = document.createElement("div");
  selbox.className = "selbox";
  selbox.hidden = true;
  const resize = document.createElement("div");
  resize.className = "resize";
  resize.title = "ドラッグで大きさを変える";
  selbox.append(resize);
  const label = document.createElement("div");
  label.className = "page-num";
  label.textContent = `${baseName(file.name)}　${num} / ${file.pdf.numPages}`;
  el.append(canvas, ink, selbox, label);
  file.pagesEl.append(el);

  const view = { id: nextId++, file, num, viewport, el, canvas, ink, selbox, rendered: false, task: null };
  ink.addEventListener("pointerdown", (e) => onPointerDown(e, view));
  ink.addEventListener("dblclick", (e) => onDoubleClick(e, view));
  resize.addEventListener("pointerdown", (e) => editor.onResizeDown(e, view));
  file.views.push(view);
  state.pages.set(view.id, view);
  viewer.add(view);
  return view;
}

function removeFile(file) {
  commitEditor();
  const count = fileItems(file).length;
  if (count && !confirm(`「${file.name}」の書き込み（${count}個）は保存されていません。一覧から外しますか？`)) return;
  for (const view of file.views) {
    viewer.remove(view);
    state.pages.delete(view.id);
  }
  file.pdf.destroy();
  file.section.remove();
  file.row.remove();
  state.files = state.files.filter((f) => f !== file);
  state.items = state.items.filter((i) => state.pages.has(i.page));
  // Undo steps could bring back ink for pages that are gone, so start the history over.
  history.reset();
  if (state.selected && !state.pages.has(state.selected.page)) state.selected = null;
  els.welcome.hidden = state.files.length > 0;
  updateCurrent();
  updateUi();
}

/* ---------- file list ---------- */

function scoreLabel(item) {
  return item.max ? `${item.value}/${item.max}` : `${item.value}点`;
}

function refreshRow(file, items) {
  const score = items.find((i) => i.type === "score");
  const parts = [`${file.views.length}ページ`];
  if (items.length) parts.push(`書き込み${items.length}`);
  file.rowMeta.textContent = parts.join("・");
  file.row.classList.toggle("marked", items.length > 0);
  file.row.dataset.score = score ? scoreLabel(score) : "";
  file.headScore.textContent = score ? scoreLabel(score) : "";
}

// Sorts the items into students once, instead of searching all items for every student.
function refreshAllRows() {
  const byFile = new Map(state.files.map((file) => [file, []]));
  for (const item of state.items) byFile.get(state.pages.get(item.page)?.file)?.push(item);
  let done = 0;
  for (const [file, items] of byFile) {
    refreshRow(file, items);
    if (items.length) done++;
  }
  els.filesCount.textContent = state.files.length
    ? `提出物 ${state.files.length}人（書き込み済み ${done}人）`
    : "提出物";
  els.filesEmpty.hidden = state.files.length > 0;
}

function toggleFiles(show = !document.body.classList.contains("show-files")) {
  document.body.classList.toggle("show-files", show);
  els.filesBtn.setAttribute("aria-pressed", String(show));
}

function updateCurrent() {
  const top = els.viewer.scrollTop + els.viewer.clientHeight * 0.3;
  let current = state.files[0] ?? null;
  for (const file of state.files) {
    if (file.section.offsetTop <= top) current = file;
    else break;
  }
  if (current !== state.current) {
    state.current = current;
    for (const file of state.files) file.row.classList.toggle("current", file === current);
    current?.row.scrollIntoView({ block: "nearest" });
  }
  const i = state.files.indexOf(current);
  els.prevBtn.disabled = i <= 0;
  els.nextBtn.disabled = i < 0 || i >= state.files.length - 1;
}

function scrollToFile(file) {
  if (!file) return;
  els.viewer.scrollTop = file.section.offsetTop - 8;
  updateCurrent();
}
function stepFile(delta) {
  commitEditor();
  const i = state.files.indexOf(state.current);
  scrollToFile(state.files[i + delta]);
}

/* ---------- rendering ---------- */

// With dozens of students the page images would fill up memory, so pages far off screen are freed.
const viewer = createPageViewer({
  state,
  viewer: els.viewer,
  zoomLabel: els.zoomLabel,
  views: () => state.pages.values(),
  pdfOf: (view) => view.file.pdf,
  onRender: (view) => {
    const dpr = window.devicePixelRatio || 1;
    view.ink.width = Math.floor(view.viewport.width * state.scale * dpr);
    view.ink.height = Math.floor(view.viewport.height * state.scale * dpr);
    renderInk(view);
  },
  onRelease: (view) => (view.ink.width = view.ink.height = 0),
  onScale: (view) => editor.updateSelbox(view),
});

function setScale(scale) {
  commitEditor();
  viewer.setScale(scale);
}

/* ---------- editing ---------- */

function onPointerDown(e, view) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  closeMenus();
  commitEditor();
  const point = editor.pagePoint(e, view);
  const [x, y] = point;
  const tolerance = 4 / state.scale;

  if (state.tool === "pen" || state.tool === "marker") {
    editor.drawStrokeFrom(e, view, point);
  } else if (state.tool === "eraser") {
    editor.eraseFrom(e, view, point);
  } else if (state.tool === "select") {
    editor.selectFrom(e, view, point);
  } else if (state.tool === "stamp") {
    editor.placeFrom(e, view, newStamp(state.stamp, view.id, x, y), point);
  } else if (state.tool === "text") {
    e.preventDefault();
    const hit = editor.itemAt(view.id, x, y, tolerance, ["text"]);
    if (hit) {
      openEditor(hit);
    } else {
      const h = state.textSize;
      openEditor({ type: "text", page: view.id, text: "", color: state.color, x, y: y - h / 2, w: 0, h }, true);
    }
  } else if (state.tool === "score") {
    e.preventDefault();
    const existing = scoreOf(view.file);
    if (existing && existing.page === view.id && hits(existing, x, y, tolerance)) {
      openEditor(existing);
    } else if (existing) {
      // One score per student: clicking somewhere else moves it there.
      const score = history.edit(existing);
      score.page = view.id;
      score.x = x;
      score.y = y - score.h / 2;
      commit();
      renderPageInk(existing.page);
      openEditor(score);
    } else {
      openEditor({
        type: "score", page: view.id, value: "", max: state.scoreMax, color: state.color,
        x, y: y - SCORE_H / 2, w: 0, h: SCORE_H,
      }, true);
    }
  }
}

function onDoubleClick(e, view) {
  if (state.tool !== "select") return;
  const [x, y] = editor.pagePoint(e, view);
  const item = editor.itemAt(view.id, x, y, 4 / state.scale, ["text", "score"]);
  if (item) openEditor(item);
}

/* ---------- typing text and scores ---------- */

function openEditor(item, isNew = false) {
  commitEditor();
  select(null);
  const view = state.pages.get(item.page);
  if (!view) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = `inline-edit ${item.type}`;
  input.autocomplete = "off";
  if (item.type === "score") {
    input.inputMode = "numeric";
    input.maxLength = 6;
    input.placeholder = "点数";
    input.value = item.value;
  } else {
    input.placeholder = "文字を入力";
    input.value = item.text;
  }
  const s = state.scale;
  const fontPx = (item.type === "score" ? item.h * 0.82 : item.h * 0.85) * s;
  Object.assign(input.style, {
    left: `${item.x * s}px`,
    top: `${item.y * s}px`,
    height: `${item.h * s}px`,
    fontSize: `${fontPx}px`,
    color: item.color,
    minWidth: `${item.type === "score" ? 3 * fontPx : 8 * fontPx}px`,
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitEditor();
    } else if (e.key === "Escape") {
      e.preventDefault();
      commitEditor(true);
    }
  });
  input.addEventListener("blur", () => commitEditor());
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  state.editing = { item, input, isNew };
  view.el.append(input);
  renderInk(view);
  input.focus();
  input.select();
}

function commitEditor(cancel = false) {
  const editing = state.editing;
  if (!editing) return;
  state.editing = null;
  let { item } = editing;
  const { input, isNew } = editing;
  input.remove();
  const value = input.value.trim();
  const field = item.type === "score" ? "value" : "text";
  if (!cancel) {
    if (!value) {
      if (!isNew) {
        state.items = state.items.filter((i) => i !== item);
        commit();
      }
    } else if (isNew || value !== item[field]) {
      if (!isNew) item = history.edit(item);
      item[field] = value;
      if (item.type === "score" && isNew) item.max = state.scoreMax;
      fitWidth(item);
      if (isNew) state.items.push(item);
      commit();
    }
  }
  renderPageInk(item.page);
  if (!cancel && value && state.items.includes(item)) select(item);
}

/* ---------- toolbar state ---------- */

function hintForTool() {
  switch (state.tool) {
    case "pen": return "ページの上をなぞって書いてください";
    case "marker": return "線を引きたいところをなぞってください";
    case "eraser": return "消したい線や記号をなぞってください";
    case "stamp": return `押したい場所をクリックしてください（${stampDef(state.stamp).label}）`;
    case "text": return "文字を書きたい場所をクリックして入力し、Enter";
    case "score": return "点数を入れたい場所をクリックして数字を入力し、Enter（1人に1つ）";
    default: return "書いたものをドラッグして動かせます。文字・点数はダブルクリックで書き直し";
  }
}

function setTool(tool, { hint = true } = {}) {
  commitEditor();
  state.tool = tool;
  document.body.dataset.tool = tool;
  if (tool !== "select") select(null);
  if (tool === "marker" && state.color !== "#facc15") setColor("#facc15");
  else if (tool !== "marker" && tool !== "select" && tool !== "eraser" && state.color === "#facc15") setColor("#d11a1a");
  updateUi();
  if (hint && state.files.length) showStatus(hintForTool());
}

function setColor(color) {
  state.color = color;
  const recolors = (item) => !(item.type === "stamp" && stampDef(item.kind).seal);
  editor.changeSelected(recolors, (item) => (item.color = color));
  renderStampChoices();
  updateUi();
}

function updateUi() {
  const open = state.files.length > 0;
  for (const btn of els.tools) btn.classList.toggle("selected", btn.dataset.tool === state.tool);
  for (const sw of els.swatches) sw.classList.toggle("selected", sw.dataset.color === state.color);
  els.undoBtn.disabled = !open || !history.canUndo;
  els.redoBtn.disabled = !open || !history.canRedo;
  els.deleteBtn.disabled = !state.selected;
  els.saveBtn.disabled = !open || saving;
  els.folderSaveBtn.disabled = !open || saving;
}

/* ---------- menus ---------- */

function closeMenus() {
  els.stampMenu.hidden = true;
  els.scoreMenu.hidden = true;
}

function toggleMenu(menu) {
  const show = menu.hidden;
  closeMenus();
  menu.hidden = !show;
}

function renderStampChoices() {
  for (const [list, seal] of [[els.markList, false], [els.sealList, true]]) {
    list.replaceChildren(...STAMPS.filter((s) => !!s.seal === seal).map((def) => {
      const item = newStamp(def.id, 0, 0, 0);
      item.x = item.y = 0;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stamp-choice";
      btn.title = def.label;
      btn.setAttribute("aria-label", def.label);
      btn.classList.toggle("selected", state.stamp === def.id);
      if (def.shape === "rect") btn.style.gridColumn = "span 2";
      btn.append(previewCanvas((ctx) => drawStamp(ctx, item, def), item.w, item.h, def.shape === "rect" ? 110 : 46));
      btn.addEventListener("click", () => {
        state.stamp = def.id;
        closeMenus();
        renderStampChoices();
        setTool("stamp");
      });
      return btn;
    }));
  }
}

/* ---------- saving ---------- */

// Returns { bytes, rebuilt } for one student's marked-up PDF.
async function buildPdf(file, progress) {
  const items = fileItems(file);
  if (!items.length) return { bytes: file.bytes, rebuilt: false }; // nothing written: hand back the original
  const { PDFDocument, degrees, BlendMode } = await loadPdfLib();
  const original = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const rebuilt = original.isEncrypted;
  const doc = rebuilt ? await rasterizePdf(file.pdf, { onPage: progress }) : original;
  for (const view of file.views) {
    const pageItems = items.filter((i) => i.page === view.id);
    if (!pageItems.length) continue;
    const ink = await renderInkImage(pageItems, view.viewport, drawItem);
    if (!ink) continue;
    const { box } = ink;
    const page = doc.getPage(view.num - 1);
    const image = await doc.embedPng(ink.png);
    // The image's bottom-left corner on screen is its origin in the PDF.
    // Rebuilt pages are already upright, so only the y axis flips.
    const [x, y] = rebuilt
      ? [box.x, view.viewport.height - (box.y + box.h)]
      : view.viewport.convertToPdfPoint(box.x, box.y + box.h);
    page.drawImage(image, {
      x, y, width: box.w, height: box.h,
      rotate: degrees(rebuilt ? 0 : view.viewport.rotation),
      blendMode: BlendMode.Multiply,
    });
  }
  return { bytes: await doc.save(), rebuilt };
}

const outputName = (file) => `${baseName(file.name)}${OUT_SUFFIX}.pdf`;

// Two students can upload files with the same name; keep both in the zip.
function uniqueNames(files) {
  const used = new Set();
  return files.map((file) => {
    let name = outputName(file);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${baseName(file.name)}${OUT_SUFFIX}(${n}).pdf`;
    used.add(name.toLowerCase());
    return name;
  });
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function scoreCsv(names) {
  const rows = [["ファイル名", "点数", "満点", "書き込み数"]];
  state.files.forEach((file, i) => {
    const score = scoreOf(file);
    rows.push([names[i], score?.value ?? "", score?.max ?? "", fileItems(file).length]);
  });
  // BOM so Excel opens the Japanese text correctly.
  return new TextEncoder().encode(`﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`);
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// Builds every student's PDF in turn and hands each to `write(name, bytes)`.
async function buildAll(write) {
  await document.fonts.ready;
  const names = uniqueNames(state.files);
  let rebuiltCount = 0;
  for (const [i, file] of state.files.entries()) {
    const label = `保存用のPDFを作成中… (${i + 1}/${state.files.length}人)`;
    showStatus(label, { sticky: true });
    const { bytes, rebuilt } = await buildPdf(file, (num) => showStatus(`${label} 保護されたPDFを画像にしています ${num}/${file.views.length}`, { sticky: true }));
    if (rebuilt) rebuiltCount++;
    await write(names[i], bytes);
  }
  const hasScores = state.files.some(scoreOf);
  if (hasScores) await write(`点数一覧_${dateStamp()}.csv`, scoreCsv(names));
  return { rebuiltCount, hasScores };
}

let saving = false;
async function guarded(run) {
  if (!state.files.length || saving) return;
  commitEditor();
  select(null);
  saving = true;
  updateUi();
  try {
    await run();
  } catch (err) {
    if (err?.name === "AbortError") {
      hideStatus();
    } else {
      console.error(err);
      showStatus("保存できませんでした。壊れたPDFや、対応していない形式のPDFが含まれている可能性があります", { error: true });
    }
  } finally {
    saving = false;
    updateUi();
  }
}

function doneMessage({ rebuiltCount, hasScores }, where, after = "") {
  let msg = `${state.files.length}人分のPDF${hasScores ? "と点数一覧" : ""}を${where}しました。`;
  if (rebuiltCount) msg += `保護されたPDF${rebuiltCount}件は、元のページを画像にして保存しています。`;
  return msg + after;
}

const saveZip = () => guarded(async () => {
  const entries = [];
  const result = await buildAll((name, bytes) => entries.push({ name, bytes }));
  showStatus("ZIPにまとめています…", { sticky: true });
  download(makeZip(entries), `採点済_${dateStamp()}.zip`);
  state.dirty = false;
  showStatus(doneMessage(result, "ZIPで保存", "ダウンロードフォルダを確認してください"));
});

const saveToFolder = () => guarded(async () => {
  const dir = await window.showDirectoryPicker({ mode: "readwrite", id: "pdf-grade-out" });
  const result = await buildAll(async (name, bytes) => {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  });
  state.dirty = false;
  showStatus(doneMessage(result, `フォルダ「${dir.name}」に保存`));
});

const saveOne = (file) => guarded(async () => {
  await document.fonts.ready;
  showStatus("PDFを作成中…", { sticky: true });
  const { bytes } = await buildPdf(file);
  download(new Blob([bytes], { type: "application/pdf" }), outputName(file));
  showStatus(`「${outputName(file)}」を保存しました`);
});

/* ---------- toolbar & global events ---------- */

for (const input of [els.fileInput, els.folderInput]) {
  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    await addFiles(files);
  });
}
els.filesBtn.addEventListener("click", () => toggleFiles());
els.filesClose.addEventListener("click", () => toggleFiles(false));

for (const btn of els.tools) {
  const tool = btn.dataset.tool;
  if (tool === "stamp" || tool === "score") continue;
  btn.addEventListener("click", () => {
    closeMenus();
    setTool(tool);
  });
}
els.stampBtn.addEventListener("click", () => toggleMenu(els.stampMenu));
els.scoreBtn.addEventListener("click", () => toggleMenu(els.scoreMenu));
els.scoreUse.addEventListener("click", () => {
  closeMenus();
  setTool("score");
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".menu-wrap")) closeMenus();
});

els.scoreMax.addEventListener("input", () => {
  state.scoreMax = els.scoreMax.value.trim();
  saveJson(STORE.max, state.scoreMax);
});
els.scoreMax.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    closeMenus();
    setTool("score");
  }
});

for (const sw of els.swatches) sw.addEventListener("click", () => setColor(sw.dataset.color));

els.width.addEventListener("change", () => {
  state.width = Number(els.width.value);
  editor.changeSelected((item) => item.type === "stroke", (item) => {
    item.width = item.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
  });
});

els.textSize.addEventListener("change", () => {
  state.textSize = Number(els.textSize.value);
  editor.changeSelected((item) => item.type === "text", (item) => {
    item.h = state.textSize;
    fitWidth(item);
  });
});

els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.deleteBtn.addEventListener("click", editor.deleteSelected);
els.zoomIn.addEventListener("click", () => state.files.length && setScale(clampScale(state.scale * 1.2)));
els.zoomOut.addEventListener("click", () => state.files.length && setScale(clampScale(state.scale / 1.2)));
els.prevBtn.addEventListener("click", () => stepFile(-1));
els.nextBtn.addEventListener("click", () => stepFile(1));
els.saveBtn.addEventListener("click", saveZip);
els.folderSaveBtn.addEventListener("click", saveToFolder);
els.folderSaveBtn.hidden = typeof window.showDirectoryPicker !== "function";

let scrollQueued = false;
els.viewer.addEventListener("scroll", () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    updateCurrent();
  });
});

const SHORTCUTS = { v: "select", p: "pen", m: "marker", e: "eraser", h: "stamp", t: "text", s: "score" };
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea, select");
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (key === "s") {
      e.preventDefault();
      saveZip();
    } else if (typing) {
      return;
    } else if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      redo();
    }
    return;
  }
  if (typing || e.altKey) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selected) {
      e.preventDefault();
      editor.deleteSelected();
    }
  } else if (e.key === "Escape") {
    closeMenus();
    select(null);
  } else if (key === "n") {
    stepFile(e.shiftKey ? -1 : 1);
  } else if (SHORTCUTS[key]) {
    setTool(SHORTCUTS[key]);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty && state.items.length) e.preventDefault();
});

// Drag & drop PDFs (or a zip of them) anywhere on the page.
onFileDrop(addFiles);

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js",
  "../shared/vendor/pdfjs-4.10.38/pdf.min.mjs",
  "../shared/vendor/pdfjs-4.10.38/pdf.worker.min.mjs",
]);

if (window.matchMedia("(max-width: 760px)").matches) toggleFiles(false);
state.scoreMax = loadJson(STORE.max, "");
els.scoreMax.value = state.scoreMax;
renderStampChoices();
refreshAllRows();
setTool("pen", { hint: false });
// Seal previews use the system's Japanese font, which may finish loading after first paint.
document.fonts.ready.then(renderStampChoices);

// Hook for automated tests.
window.__pdfGrade = { state, addFiles, buildPdf, saveZip, setScale, setTool, undo, redo, commit, renderInk, stepFile };
