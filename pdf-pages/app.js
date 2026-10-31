import { openPdf, openPdfError, renderPage, addPageImage } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { loadText, saveText } from "../shared/js/storage.js";
import { createLazyRenderer, freeCanvas } from "../shared/js/lazy.js";
import { createSortable } from "../shared/js/sortable.js";
import { History } from "../shared/js/history.js";
import { embedPages, placePage } from "../shared/js/imposition.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";
import { pixelRatio } from "../shared/js/canvas.js";

const THUMB_SIZES = { small: 110, medium: 150, large: 220 }; // longest side of a thumbnail, in CSS pixels
const HISTORY_LIMIT = 50;
const SPLIT_CONFIRM = 10; // ask before downloading more files than this at once
const RASTER_SCALE = 2; // 144 dpi page images for protected PDFs

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  selectAll: $("select-all"),
  selectNone: $("select-none"),
  count: $("count"),
  rotateLeft: $("rotate-left"),
  rotateRight: $("rotate-right"),
  deleteBtn: $("delete-btn"),
  clearBtn: $("clear-btn"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  thumbSize: $("thumb-size"),
  splitBtn: $("split-btn"),
  extractBtn: $("extract-btn"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  grid: $("grid"),
  preview: $("preview"),
  previewLabel: $("preview-label"),
  previewStage: $("preview-stage"),
  previewPrev: $("preview-prev"),
  previewNext: $("preview-next"),
  previewRotate: $("preview-rotate"),
  previewDelete: $("preview-delete"),
  previewClose: $("preview-close"),
  moreBtn: $("more-btn"),
  moreMenu: $("more-menu"),
  blankBtn: $("blank-btn"),
  duplicateBtn: $("duplicate-btn"),
  reverseBtn: $("reverse-btn"),
  interleaveBtn: $("interleave-btn"),
  rangeForm: $("range-form"),
  rangeInput: $("range-input"),
  interleaveDialog: $("interleave-dialog"),
  frontFile: $("front-file"),
  backFile: $("back-file"),
  backReverse: $("back-reverse"),
  nup: $("nup"),
};

const state = {
  files: [], // { name, bytes, pdf (pdf.js), doc (pdf-lib, null when protected), blank }; kept until "最初から" so undo can bring pages back
  pages: [], // { id, file, index (0-based), baseRotation, rotation (added by the user), selected, el, canvas, rendered }
  lastClicked: null, // for shift-click range selection
  thumbPx: THUMB_SIZES.medium,
  dirty: false,
  busy: false,
  loading: false,
};
let nextId = 1;

/* ---------- adding PDFs ---------- */

async function addFiles(fileList) {
  const files = [...fileList].filter(isPdf);
  if (!files.length) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  const failed = [];
  const protectedNames = [];
  let added = 0;
  state.loading = true;
  for (const [i, file] of files.entries()) {
    showStatus(`PDFを読み込み中…（${i + 1}/${files.length}）`, { sticky: true });
    try {
      const entry = await addFile(file);
      added += entry.pdf.numPages;
      if (!entry.doc) protectedNames.push(entry.name);
    } catch (err) {
      console.error(err);
      failed.push({ name: file.name, reason: openPdfError(err) });
    }
  }
  state.loading = false;
  if (added) history.record();
  updateUi();
  if (failed.length) {
    showStatus(failed.map((f) => `${f.name}: ${f.reason}`).join(" / "), { error: true });
  } else if (protectedNames.length) {
    showStatus(`${protectedNames.join("、")} は保護されたPDFのため、保存するときにページを画像にします（文字の選択はできなくなります）`, { ms: 8000 });
  } else {
    hideStatus();
    showStatus(`${added}ページを追加しました`);
  }
}

async function addFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await openPdf(bytes.slice(), { name: file.name }).promise;
  // pdf-lib can't decrypt, so pages of a protected PDF are saved as images rendered by pdf.js.
  const { PDFDocument } = await loadPdfLib();
  const loaded = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const doc = loaded.isEncrypted ? null : loaded;
  const entry = { name: file.name || "document.pdf", bytes, pdf, doc };
  state.files.push(entry);

  for (let index = 0; index < pdf.numPages; index++) {
    const page = await pdf.getPage(index + 1);
    const view = newView(entry, index, page.rotate);
    state.pages.push(view);
    els.grid.append(view.el);
  }
  state.dirty = true;
  return entry;
}

function newView(file, index, baseRotation, rotation = 0) {
  const view = { id: nextId++, file, index, baseRotation, rotation, selected: false, el: null, canvas: null, rendered: false };
  createCard(view);
  return view;
}

/* ---------- page cards ---------- */

// Thumbnails far off screen are freed, so a long PDF does not fill up memory.
const thumbs = createLazyRenderer({
  root: els.viewer,
  renderMargin: "400px",
  releaseMargin: "2500px",
  render: renderThumb,
  release: (view) => {
    view.renderToken = null; // drop a thumbnail still being drawn
    if (view.canvas) freeCanvas(view.canvas);
  },
});

function createCard(view) {
  const li = document.createElement("li");
  li.className = "card";
  li.tabIndex = 0;
  li.innerHTML = `
    <span class="check" aria-hidden="true">✓</span>
    <button class="zoom" data-act="zoom" title="大きく表示" aria-label="大きく表示"><svg class="i" aria-hidden="true"><use href="#i-zoom"/></svg></button>
    <div class="thumb"><div class="placeholder"></div></div>
    <div class="label"></div>
    <div class="card-actions">
      <button class="mini" data-act="left" title="前へ移動" aria-label="前へ移動"><svg class="i" aria-hidden="true"><use href="#i-left"/></svg></button>
      <button class="mini" data-act="rotate" title="右に90°回転" aria-label="右に90°回転"><svg class="i" aria-hidden="true"><use href="#i-rotate"/></svg></button>
      <button class="mini" data-act="right" title="後ろへ移動" aria-label="後ろへ移動"><svg class="i" aria-hidden="true"><use href="#i-right"/></svg></button>
      <button class="mini danger" data-act="delete" title="このページを外す" aria-label="このページを外す"><svg class="i" aria-hidden="true"><use href="#i-close"/></svg></button>
    </div>`;
  view.el = li;

  li.addEventListener("click", (e) => {
    if (sortable.dragged) return; // the end of a drag, not a click
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "zoom") openPreview(view);
    else if (act === "left") movePage(view, -1);
    else if (act === "right") movePage(view, 1);
    else if (act === "rotate") rotatePages([view], 90);
    else if (act === "delete") removePages([view]);
    else toggleSelect(view, e.shiftKey);
  });
  li.addEventListener("keydown", (e) => {
    if (e.target !== li) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggleSelect(view, e.shiftKey);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removePages([view]);
    } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      movePage(view, e.key === "ArrowLeft" ? -1 : 1);
    }
  });
  li.addEventListener("dblclick", (e) => {
    if (!e.target.closest("[data-act]")) openPreview(view);
  });
  sortable.attach(li, view);

  thumbs.add(view);
}

/* ---------- dragging pages (mouse, touch and pen) ---------- */

const sortable = createSortable({
  scroller: els.viewer,
  items: () => state.pages,
  canStart: (e) => !e.target.closest("[data-act]") && !state.busy,
  // Dragging a selected page carries all the selected pages along.
  carry: (view) => (view.selected ? state.pages.filter((p) => p.selected) : [view]),
  ghost: (view, views) => {
    const parts = [];
    if (view.canvas) {
      const copy = document.createElement("canvas");
      const k = 90 / Math.max(view.canvas.width, view.canvas.height);
      copy.width = Math.round(view.canvas.width * k);
      copy.height = Math.round(view.canvas.height * k);
      copy.getContext("2d").drawImage(view.canvas, 0, 0, copy.width, copy.height);
      parts.push(copy);
    }
    if (views.length > 1) {
      parts.push(Object.assign(document.createElement("span"), { className: "badge", textContent: `${views.length}ページ` }));
    }
    return parts;
  },
  onDrop: placePages,
});

// Moves the pages, keeping their order, to just before or after the target page.
function placePages(views, target, after) {
  const moving = state.pages.filter((p) => views.includes(p));
  let at = state.pages.indexOf(target) + (after ? 1 : 0);
  at -= state.pages.slice(0, at).filter((p) => views.includes(p)).length;
  const rest = state.pages.filter((p) => !views.includes(p));
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (next.every((p, i) => p === state.pages[i])) return;
  state.pages = next;
  state.dirty = true;
  history.record();
  syncOrder();
}

async function renderThumb(view) {
  view.rendered = true;
  const token = (view.renderToken = {});
  try {
    const page = await view.file.pdf.getPage(view.index + 1);
    const rotation = (view.baseRotation + view.rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = pixelRatio();
    const scale = (state.thumbPx / Math.max(base.width, base.height)) * dpr;
    const canvas = await renderPage(page, scale, { rotation });
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    if (token !== view.renderToken) return; // rotated again while rendering
    view.el.querySelector(".thumb").replaceChildren(canvas);
    view.canvas = canvas;
  } catch (err) {
    console.error(err);
    view.rendered = false;
  }
}

/* ---------- editing ---------- */

function toggleSelect(view, range) {
  if (range && state.lastClicked && state.pages.includes(state.lastClicked)) {
    const a = state.pages.indexOf(state.lastClicked);
    const b = state.pages.indexOf(view);
    const [from, to] = a < b ? [a, b] : [b, a];
    const value = !view.selected || state.lastClicked.selected;
    for (let i = from; i <= to; i++) state.pages[i].selected = value;
  } else {
    view.selected = !view.selected;
  }
  state.lastClicked = view;
  updateUi();
}

function setAllSelected(value) {
  for (const view of state.pages) view.selected = value;
  updateUi();
}

function movePage(view, delta) {
  const i = state.pages.indexOf(view);
  const j = i + delta;
  if (j < 0 || j >= state.pages.length) return;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  state.dirty = true;
  history.record();
  syncOrder();
  view.el.focus();
}

function rotatePages(views, delta) {
  if (!views.length) return;
  for (const view of views) {
    view.rotation = (view.rotation + delta + 360) % 360;
    renderThumb(view);
  }
  state.dirty = true;
  history.record();
  updateUi();
}

function removePages(views) {
  if (!views.length) return;
  for (const view of views) {
    thumbs.remove(view);
    view.el.remove();
  }
  state.pages = state.pages.filter((p) => !views.includes(p));
  state.dirty = state.pages.length > 0;
  history.record();
  updateUi();
  if (views.length > 1 || !state.pages.length) showStatus(`${views.length}ページを外しました（「元に戻す」で戻せます）`);
}

function clearAll() {
  removePages(state.pages.slice());
  for (const file of state.files) file.pdf.destroy();
  state.files = [];
  blankFiles.clear();
  history.reset();
  hideStatus();
  updateUi();
}

// A blank page the size of the page it follows (as shown, after turning), so it prints alike.
const blankFiles = new Map(); // "595x842" → file entry, reused for every blank page of that size

async function blankFile(width, height) {
  const key = `${Math.round(width)}x${Math.round(height)}`;
  if (!blankFiles.has(key)) {
    const { PDFDocument } = await loadPdfLib();
    const doc = await PDFDocument.create();
    doc.addPage([width, height]);
    const bytes = await doc.save();
    const pdf = await openPdf(bytes.slice()).promise;
    const entry = { name: "白紙", bytes, pdf, doc, blank: true };
    state.files.push(entry);
    blankFiles.set(key, entry);
  }
  return blankFiles.get(key);
}

async function insertBlank() {
  const selected = state.pages.filter((p) => p.selected);
  const after = selected.at(-1) ?? state.pages.at(-1);
  let [width, height] = [595.28, 841.89]; // A4
  if (after) {
    const page = await after.file.pdf.getPage(after.index + 1);
    const size = page.getViewport({ scale: 1, rotation: (after.baseRotation + after.rotation) % 360 });
    [width, height] = [size.width, size.height];
  }
  const view = newView(await blankFile(width, height), 0, 0);
  state.pages.splice(after ? state.pages.indexOf(after) + 1 : state.pages.length, 0, view);
  state.dirty = true;
  history.record();
  syncOrder();
  view.el.scrollIntoView({ block: "nearest" });
  showStatus("白紙のページを入れました");
}

function duplicatePages() {
  const selected = state.pages.filter((p) => p.selected);
  if (!selected.length) return;
  state.pages = state.pages.flatMap((view) => view.selected
    ? [view, newView(view.file, view.index, view.baseRotation, view.rotation)]
    : [view]);
  state.dirty = true;
  history.record();
  syncOrder();
  showStatus(`${selected.length}ページを複製しました`);
}

// Reverses the selected pages among themselves (they stay where they are), or every page.
function reversePages() {
  const targets = targetPages();
  if (targets.length < 2) return;
  const reversed = targets.slice().reverse();
  let k = 0;
  state.pages = state.pages.map((view) => (targets.includes(view) ? reversed[k++] : view));
  state.dirty = true;
  history.record();
  syncOrder();
  showStatus("順番を逆にしました");
}

// Front and back pages of double-sided prints scanned one side at a time: front 1, back 1,
// front 2, back 2… When the stack was turned over to scan the backs, they come last-first.
function interleave(front, back, reverseBack) {
  const fronts = state.pages.filter((p) => p.file === front);
  const backs = state.pages.filter((p) => p.file === back);
  if (reverseBack) backs.reverse();
  const merged = [];
  for (let i = 0; i < Math.max(fronts.length, backs.length); i++) {
    if (fronts[i]) merged.push(fronts[i]);
    if (backs[i]) merged.push(backs[i]);
  }
  const at = state.pages.findIndex((p) => p.file === front || p.file === back);
  const rest = state.pages.filter((p) => p.file !== front && p.file !== back);
  state.pages = [...rest.slice(0, at), ...merged, ...rest.slice(at)];
  state.dirty = true;
  history.record();
  syncOrder();
  showStatus(`${merged.length}ページを表と裏の交互に並べました`);
}

function openInterleave() {
  const files = [...new Set(state.pages.filter((p) => !p.file.blank).map((p) => p.file))];
  if (files.length < 2) return;
  for (const [select, pick] of [[els.frontFile, 0], [els.backFile, 1]]) {
    select.replaceChildren(...files.map((file, i) => {
      const count = state.pages.filter((p) => p.file === file).length;
      return new Option(`${file.name}（${count}ページ）`, i, false, i === pick);
    }));
  }
  els.interleaveDialog.returnValue = "";
  els.interleaveDialog.onclose = () => {
    if (els.interleaveDialog.returnValue !== "ok") return;
    const front = files[els.frontFile.value];
    const back = files[els.backFile.value];
    if (front === back) return showStatus("表面と裏面に別々のPDFを選んでください", { error: true });
    interleave(front, back, els.backReverse.checked);
  };
  els.interleaveDialog.showModal();
}

// "1-3, 5" → page positions 0, 1, 2, 4. Full-width digits and 、 also work; "8-" runs to the
// last page. Returns null when the text is not a list of numbers and ranges.
function parseRange(text, total) {
  const normal = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ー〜～−]/g, "-")
    .replace(/[、，,\s]+/g, ",");
  const picked = new Set();
  for (const part of normal.split(",").filter(Boolean)) {
    const m = part.match(/^(\d*)-(\d*)$|^(\d+)$/);
    if (!m) return null;
    let from;
    let to;
    if (m[3]) from = to = Number(m[3]);
    else {
      from = m[1] ? Number(m[1]) : 1;
      to = m[2] ? Number(m[2]) : total;
    }
    if (from > to) [from, to] = [to, from];
    for (let n = Math.max(1, from); n <= Math.min(total, to); n++) picked.add(n - 1);
  }
  return [...picked].sort((a, b) => a - b);
}

function selectByRange() {
  const picked = parseRange(els.rangeInput.value, state.pages.length);
  if (!picked) return showStatus("「1-3, 5」のように、ページの番号とハイフン・カンマで入れてください", { error: true });
  if (!picked.length) return showStatus(`ページは 1〜${state.pages.length} です`, { error: true });
  state.pages.forEach((view, i) => (view.selected = picked.includes(i)));
  updateUi();
  closeMenu();
  showStatus(`${picked.length}ページを選びました`);
}

function closeMenu() {
  els.moreMenu.hidden = true;
  els.moreBtn.setAttribute("aria-expanded", "false");
}

/* ---------- undo / redo ---------- */

// A step is the pages in order with the turn each had then (the page objects are reused).
const history = new History(state, {
  take: () => state.pages.map((view) => ({ view, rotation: view.rotation })),
  apply: restore,
  limit: HISTORY_LIMIT,
});

function restore(snap) {
  const keep = new Set(snap.map((s) => s.view));
  for (const view of state.pages) {
    if (keep.has(view)) continue;
    thumbs.remove(view);
    view.el.remove();
  }
  for (const { view, rotation } of snap) {
    if (view.rotation !== rotation) {
      view.rotation = rotation;
      renderThumb(view);
    } else if (!state.pages.includes(view)) {
      thumbs.add(view);
    }
  }
  state.pages = snap.map((s) => s.view);
  state.dirty = state.pages.length > 0;
  syncOrder();
  if (previewView && !state.pages.includes(previewView)) closePreview();
  else if (previewView) renderPreview();
}

const canChange = () => !state.busy && !state.loading && !sortable.dragging;

function undo() {
  if (canChange() && history.undo()) showStatus("元に戻しました");
}

function redo() {
  if (canChange() && history.redo()) showStatus("やり直しました");
}

/* ---------- thumbnail size ---------- */

function setThumbSize(name) {
  if (!THUMB_SIZES[name]) name = "medium";
  els.thumbSize.value = name;
  state.thumbPx = THUMB_SIZES[name];
  els.grid.style.setProperty("--thumb", `${state.thumbPx}px`);
  saveText("pdf-pages-thumb", name);
  thumbs.redrawAll(state.pages);
}

/* ---------- large preview ---------- */

let previewView = null;
let previewToken = null;

function openPreview(view) {
  previewView = view;
  els.preview.hidden = false;
  els.previewClose.focus();
  renderPreview();
}

function closePreview() {
  if (els.preview.hidden) return;
  els.preview.hidden = true;
  els.previewStage.replaceChildren();
  const view = previewView;
  previewView = null;
  previewToken = null;
  if (view && state.pages.includes(view)) view.el.focus();
}

function stepPreview(delta) {
  const i = state.pages.indexOf(previewView) + delta;
  if (i < 0 || i >= state.pages.length) return;
  previewView = state.pages[i];
  renderPreview();
}

async function renderPreview() {
  const view = previewView;
  const i = state.pages.indexOf(view);
  const turned = view.rotation ? ` ・${view.rotation}°回転` : "";
  const source = view.file.blank ? "白紙" : `${view.file.name} p.${view.index + 1}`;
  els.previewLabel.textContent = `${i + 1} / ${state.pages.length}ページ（${source}${turned}）`;
  els.previewPrev.disabled = i === 0;
  els.previewNext.disabled = i === state.pages.length - 1;
  const token = (previewToken = {});
  try {
    const page = await view.file.pdf.getPage(view.index + 1);
    const rotation = (view.baseRotation + view.rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const box = els.previewStage.getBoundingClientRect();
    const fit = Math.min(box.width / base.width, box.height / base.height);
    const dpr = pixelRatio();
    const canvas = await renderPage(page, fit * dpr, { rotation });
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    if (token !== previewToken) return; // moved on to another page meanwhile
    els.previewStage.replaceChildren(canvas);
  } catch (err) {
    console.error(err);
  }
}

function deletePreviewed() {
  const i = state.pages.indexOf(previewView);
  removePages([previewView]);
  if (!state.pages.length) return closePreview();
  previewView = state.pages[Math.min(i, state.pages.length - 1)];
  renderPreview();
}

// Rotate/delete act on the selected pages, or on every page when none are selected.
function targetPages() {
  const selected = state.pages.filter((p) => p.selected);
  return selected.length ? selected : state.pages;
}

// Files that still have pages in the list.
function fileCount() {
  return new Set(state.pages.filter((p) => !p.file.blank).map((p) => p.file)).size;
}

function syncOrder() {
  els.grid.append(...state.pages.map((p) => p.el));
  updateUi();
}

// "3 / 10ページ選択中", or "全10ページ" when none is chosen.
function countText(chosen, total) {
  return chosen ? `${chosen} / ${total}ページ選択中` : `全${total}ページ`;
}

function updateUi() {
  const total = state.pages.length;
  const selected = state.pages.filter((p) => p.selected).length;
  const multiFile = fileCount() > 1;
  state.pages.forEach((view, i) => {
    view.el.classList.toggle("selected", view.selected);
    view.el.setAttribute("aria-selected", String(view.selected));
    const label = view.el.querySelector(".label");
    const source = multiFile ? `${view.file.name} ` : "";
    const turned = view.rotation ? ` ・${view.rotation}°` : "";
    label.innerHTML = "";
    label.append(Object.assign(document.createElement("b"), { textContent: `${i + 1}` }),
      view.file.blank ? ` （白紙${turned}）` : ` （${source}p.${view.index + 1}${turned}）`);
    label.title = view.file.blank ? "白紙のページ" : `${view.file.name} の ${view.index + 1}ページ目`;
    view.el.querySelector('[data-act="left"]').disabled = i === 0;
    view.el.querySelector('[data-act="right"]').disabled = i === total - 1;
  });

  els.welcome.hidden = total > 0;
  els.count.textContent = total ? countText(selected, total) : "";
  const none = total === 0 || state.busy;
  for (const btn of [els.selectAll, els.selectNone, els.rotateLeft, els.rotateRight, els.clearBtn, els.splitBtn, els.saveBtn]) {
    btn.disabled = none;
  }
  els.selectNone.disabled = none || selected === 0;
  els.moreBtn.disabled = none;
  els.duplicateBtn.disabled = selected === 0;
  els.interleaveBtn.disabled = fileCount() < 2;
  els.deleteBtn.disabled = none || selected === 0;
  els.extractBtn.disabled = none || selected === 0;
  els.undoBtn.disabled = state.busy || state.loading || !history.canUndo;
  els.redoBtn.disabled = state.busy || state.loading || !history.canRedo;
  const scope = selected ? "選んだページ" : "全ページ";
  els.rotateLeft.title = `${scope}を左に90°回転`;
  els.rotateRight.title = `${scope}を右に90°回転`;
}

/* ---------- saving ---------- */

async function buildPdf(views, { nup = 1 } = {}) {
  const { PDFDocument, degrees } = await loadPdfLib();
  const out = await PDFDocument.create();
  // Copy runs of pages from the same file together so shared resources are copied once.
  let i = 0;
  while (i < views.length) {
    const file = views[i].file;
    let j = i;
    while (j < views.length && views[j].file === file) j++;
    const run = views.slice(i, j);
    if (!file.doc) {
      // A protected PDF: each page becomes a picture of itself, already turned upright.
      for (const view of run) {
        const page = await view.file.pdf.getPage(view.index + 1);
        await addPageImage(out, page, { scale: RASTER_SCALE, rotation: (view.baseRotation + view.rotation) % 360 });
      }
      i = j;
      continue;
    }
    const copied = await out.copyPages(file.doc, run.map((v) => v.index));
    copied.forEach((page, k) => {
      const angle = (((page.getRotation().angle + run[k].rotation) % 360) + 360) % 360;
      page.setRotation(degrees(angle));
      out.addPage(page);
    });
    i = j;
  }
  return nup > 1 ? (await placeOnSheets(out, nup)).save() : out.save();
}

// N-up for printing: puts `n` (2 or 4) pages side by side on each sheet, in reading order
// (left to right, then top to bottom). The sheet is the first page's size, turned sideways
// for 2 pages, so 2 A4 pages land on one landscape A4. Each page keeps its look, scaled down.
async function placeOnSheets(src, n) {
  const { PDFDocument } = await loadPdfLib();
  const out = await PDFDocument.create();
  const pages = await embedPages(out, src);
  const [cols, rows] = n === 2 ? [2, 1] : [2, 2];
  const first = pages[0];
  let sheetW = Math.min(first.width, first.height);
  let sheetH = Math.max(first.width, first.height);
  if (n === 2) [sheetW, sheetH] = [sheetH, sheetW];
  const margin = 18; // pt, about 6 mm
  const gap = 12;
  const cellW = (sheetW - margin * 2 - gap * (cols - 1)) / cols;
  const cellH = (sheetH - margin * 2 - gap * (rows - 1)) / rows;
  let sheet = null;
  pages.forEach((page, i) => {
    const slot = i % n;
    if (slot === 0) sheet = out.addPage([sheetW, sheetH]);
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const cell = { x: margin + col * (cellW + gap), y: sheetH - margin - (row + 1) * cellH - row * gap, w: cellW, h: cellH };
    placePage(sheet, page, cell);
  });
  return out;
}

function outputName(suffix) {
  const first = baseName((state.pages.find((p) => !p.file.blank) ?? state.pages[0]).file.name);
  const n = Number(els.nup.value);
  if (n > 1) suffix += `_${n}in1`;
  return fileCount() > 1 ? `${first}など_${suffix}.pdf` : `${first}_${suffix}.pdf`;
}

async function withBusy(message, fn) {
  if (state.busy) return;
  state.busy = true;
  updateUi();
  showStatus(message, { sticky: true });
  try {
    await fn();
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。PDFが壊れている可能性があります", { error: true });
  } finally {
    state.busy = false;
    updateUi();
  }
}

function saveAll() {
  return withBusy("PDFを作成中…", async () => {
    const bytes = await buildPdf(state.pages, { nup: Number(els.nup.value) });
    download(new Blob([bytes], { type: "application/pdf" }), outputName(fileCount() > 1 ? "結合" : "編集済み"));
    state.dirty = false;
    showStatus("保存しました");
  });
}

function saveSelected() {
  const views = state.pages.filter((p) => p.selected);
  if (!views.length) return;
  return withBusy("PDFを作成中…", async () => {
    const bytes = await buildPdf(views, { nup: Number(els.nup.value) });
    download(new Blob([bytes], { type: "application/pdf" }), outputName("抜き出し"));
    showStatus(`${views.length}ページを保存しました`);
  });
}

function saveEachPage() {
  const views = state.pages.slice();
  if (views.length > SPLIT_CONFIRM && !confirm(`${views.length}個のPDFファイルをダウンロードします。よろしいですか？`)) return;
  return withBusy("PDFを分割中…", async () => {
    const digits = String(views.length).length;
    for (const [i, view] of views.entries()) {
      showStatus(`PDFを分割中…（${i + 1}/${views.length}）`, { sticky: true });
      const bytes = await buildPdf([view]);
      const n = String(i + 1).padStart(digits, "0");
      download(new Blob([bytes], { type: "application/pdf" }), `${baseName(view.file.name)}_${n}.pdf`);
      // Chrome drops downloads fired too close together.
      await new Promise((r) => setTimeout(r, 250));
    }
    state.dirty = false;
    showStatus(`${views.length}個のPDFに分けて保存しました`);
  });
}

/* ---------- wiring ---------- */

els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.selectAll.addEventListener("click", () => setAllSelected(true));
els.selectNone.addEventListener("click", () => setAllSelected(false));
els.rotateLeft.addEventListener("click", () => rotatePages(targetPages(), -90));
els.rotateRight.addEventListener("click", () => rotatePages(targetPages(), 90));
els.deleteBtn.addEventListener("click", () => removePages(state.pages.filter((p) => p.selected)));
els.clearBtn.addEventListener("click", () => {
  if (state.dirty && !confirm("並べたページをすべて外して最初からやり直しますか？（元に戻せません）")) return;
  clearAll();
});
els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.thumbSize.addEventListener("change", () => setThumbSize(els.thumbSize.value));
els.previewClose.addEventListener("click", closePreview);
els.previewPrev.addEventListener("click", () => stepPreview(-1));
els.previewNext.addEventListener("click", () => stepPreview(1));
els.previewRotate.addEventListener("click", () => {
  rotatePages([previewView], 90);
  renderPreview();
});
els.previewDelete.addEventListener("click", deletePreviewed);
els.preview.addEventListener("click", (e) => {
  if (e.target === els.preview || e.target.classList.contains("preview-body")) closePreview();
});
els.saveBtn.addEventListener("click", saveAll);
addNextTool({ saveBtn: els.saveBtn, save: saveAll, kind: "pdf" });
els.extractBtn.addEventListener("click", saveSelected);
els.splitBtn.addEventListener("click", saveEachPage);
els.moreBtn.addEventListener("click", () => {
  const show = els.moreMenu.hidden;
  els.moreMenu.hidden = !show;
  els.moreBtn.setAttribute("aria-expanded", String(show));
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".menu-wrap")) closeMenu();
});
const menuActions = [
  [els.blankBtn, insertBlank],
  [els.duplicateBtn, duplicatePages],
  [els.reverseBtn, reversePages],
  [els.interleaveBtn, openInterleave],
];
for (const [btn, fn] of menuActions) {
  btn.addEventListener("click", () => {
    closeMenu();
    if (!state.busy) fn();
  });
}
els.rangeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  selectByRange();
});

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.target.closest("input, textarea, select")) {
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      return undo();
    }
    if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      return redo();
    }
  }
  if (!els.preview.hidden) {
    if (e.key === "Escape") closePreview();
    else if (e.key === "ArrowLeft") stepPreview(-1);
    else if (e.key === "ArrowRight") stepPreview(1);
    else if (e.key === "Delete" || e.key === "Backspace") deletePreviewed();
    else return;
    e.preventDefault();
    return;
  }
  if (mod && e.key === "a" && state.pages.length && !e.target.closest("input, textarea")) {
    e.preventDefault();
    setAllSelected(true);
  } else if (e.key === "Escape" && !els.moreMenu.hidden) {
    closeMenu();
  } else if (e.key === "Escape") {
    setAllSelected(false);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty && state.pages.length) e.preventDefault();
});

// Drag & drop PDFs anywhere on the page (page cards handle their own reordering drags).
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

setThumbSize(loadText("pdf-pages-thumb") || "medium");
updateUi();

// Hook for automated tests.
window.__pdfPages = {
  state, addFiles, buildPdf, rotatePages, removePages, movePage, toggleSelect, placePages, undo, redo, openPreview,
  insertBlank, duplicatePages, reversePages, interleave, parseRange,
};
