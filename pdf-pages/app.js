import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";

const { PDFDocument, degrees } = window.PDFLib;

const asset = (path) => new URL(path, location.href).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = asset("lib/pdfjs/pdf.worker.min.mjs");

const THUMB_PX = 150; // longest side of a thumbnail, in CSS pixels
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
  splitBtn: $("split-btn"),
  extractBtn: $("extract-btn"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  grid: $("grid"),
  status: $("status"),
  dropOverlay: $("drop-overlay"),
};

const state = {
  files: [], // { name, bytes, pdf (pdf.js), doc (pdf-lib, null when protected) }
  pages: [], // { id, file, index (0-based), baseRotation, rotation (added by the user), selected, el, canvas, rendered }
  lastClicked: null, // for shift-click range selection
  dragging: null,
  dirty: false,
  busy: false,
};
let nextId = 1;

/* ---------- status messages ---------- */

let statusTimer = 0;
function showStatus(text, { error = false, sticky = false, ms = error ? 6000 : 2500 } = {}) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle("error", error);
  els.status.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => (els.status.hidden = true), ms);
}
function hideStatus() {
  clearTimeout(statusTimer);
  els.status.hidden = true;
}

/* ---------- adding PDFs ---------- */

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!files.length) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  const failed = [];
  const protectedNames = [];
  let added = 0;
  for (const [i, file] of files.entries()) {
    showStatus(`PDFを読み込み中…（${i + 1}/${files.length}）`, { sticky: true });
    try {
      const entry = await addFile(file);
      added += entry.pdf.numPages;
      if (!entry.doc) protectedNames.push(entry.name);
    } catch (err) {
      console.error(err);
      failed.push({ name: file.name, reason: describeLoadError(err) });
    }
  }
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

function describeLoadError(err) {
  if (err?.name === "PasswordException") return "開くのにパスワードが必要なPDFは使えません";
  return "PDFを読み込めませんでした";
}

async function addFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js detaches the buffer it is given
    cMapUrl: asset("lib/pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("lib/pdfjs/standard_fonts/"),
  }).promise;
  // pdf-lib can't decrypt, so pages of a protected PDF are saved as images rendered by pdf.js.
  const loaded = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const doc = loaded.isEncrypted ? null : loaded;
  const entry = { name: file.name || "document.pdf", bytes, pdf, doc };
  state.files.push(entry);

  for (let index = 0; index < pdf.numPages; index++) {
    const page = await pdf.getPage(index + 1);
    const view = {
      id: nextId++,
      file: entry,
      index,
      baseRotation: page.rotate,
      rotation: 0,
      selected: false,
      el: null,
      canvas: null,
      rendered: false,
    };
    createCard(view);
    state.pages.push(view);
    els.grid.append(view.el);
  }
  state.dirty = true;
  return entry;
}

/* ---------- page cards ---------- */

const thumbObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const view = state.pages.find((p) => p.el === entry.target);
    if (view && !view.rendered) renderThumb(view);
  }
}, { root: els.viewer, rootMargin: "400px" });

function createCard(view) {
  const li = document.createElement("li");
  li.className = "card";
  li.tabIndex = 0;
  li.draggable = true;
  li.innerHTML = `
    <span class="check" aria-hidden="true">✓</span>
    <div class="thumb"><div class="placeholder"></div></div>
    <div class="label"></div>
    <div class="card-actions">
      <button class="mini" data-act="left" title="前へ移動" aria-label="前へ移動">◀</button>
      <button class="mini" data-act="rotate" title="右に90°回転" aria-label="右に90°回転">⟳</button>
      <button class="mini" data-act="right" title="後ろへ移動" aria-label="後ろへ移動">▶</button>
      <button class="mini danger" data-act="delete" title="このページを外す" aria-label="このページを外す">✕</button>
    </div>`;
  view.el = li;

  li.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "left") movePage(view, -1);
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
    }
  });

  li.addEventListener("dragstart", (e) => {
    state.dragging = view;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(view.id));
  });
  li.addEventListener("dragend", () => {
    state.dragging = null;
    li.classList.remove("dragging");
    clearDropMarks();
  });
  li.addEventListener("dragover", (e) => {
    if (!state.dragging || state.dragging === view) return;
    e.preventDefault();
    e.stopPropagation();
    const after = dropAfter(e, li);
    clearDropMarks();
    li.classList.add(after ? "drop-after" : "drop-before");
  });
  li.addEventListener("drop", (e) => {
    if (!state.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const moving = state.dragging;
    if (moving !== view) {
      const after = dropAfter(e, li);
      state.pages.splice(state.pages.indexOf(moving), 1);
      state.pages.splice(state.pages.indexOf(view) + (after ? 1 : 0), 0, moving);
      state.dirty = true;
      syncOrder();
    }
    clearDropMarks();
  });

  thumbObserver.observe(li);
}

function dropAfter(e, el) {
  const r = el.getBoundingClientRect();
  return e.clientX > r.left + r.width / 2;
}

function clearDropMarks() {
  for (const el of els.grid.querySelectorAll(".drop-before, .drop-after")) {
    el.classList.remove("drop-before", "drop-after");
  }
}

async function renderThumb(view) {
  view.rendered = true;
  const token = (view.renderToken = {});
  try {
    const page = await view.file.pdf.getPage(view.index + 1);
    const rotation = (view.baseRotation + view.rotation) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = window.devicePixelRatio || 1;
    const scale = (THUMB_PX / Math.max(base.width, base.height)) * dpr;
    const viewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${viewport.width / dpr}px`;
    canvas.style.height = `${viewport.height / dpr}px`;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
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
  syncOrder();
  view.el.focus();
}

function rotatePages(views, delta) {
  for (const view of views) {
    view.rotation = (view.rotation + delta + 360) % 360;
    renderThumb(view);
  }
  state.dirty = true;
  updateUi();
}

function removePages(views) {
  for (const view of views) {
    thumbObserver.unobserve(view.el);
    view.el.remove();
  }
  state.pages = state.pages.filter((p) => !views.includes(p));
  // Let go of files that no longer have any pages on screen.
  const used = new Set(state.pages.map((p) => p.file));
  for (const file of state.files.filter((f) => !used.has(f))) file.pdf.destroy();
  state.files = state.files.filter((f) => used.has(f));
  state.dirty = state.pages.length > 0;
  updateUi();
}

// Rotate/delete act on the selected pages, or on every page when none are selected.
function targetPages() {
  const selected = state.pages.filter((p) => p.selected);
  return selected.length ? selected : state.pages;
}

function syncOrder() {
  els.grid.append(...state.pages.map((p) => p.el));
  updateUi();
}

function updateUi() {
  const total = state.pages.length;
  const selected = state.pages.filter((p) => p.selected).length;
  const multiFile = state.files.length > 1;
  state.pages.forEach((view, i) => {
    view.el.classList.toggle("selected", view.selected);
    view.el.setAttribute("aria-selected", String(view.selected));
    const label = view.el.querySelector(".label");
    const source = multiFile ? `${view.file.name} ` : "";
    const turned = view.rotation ? ` ・${view.rotation}°` : "";
    label.innerHTML = "";
    label.append(Object.assign(document.createElement("b"), { textContent: `${i + 1}` }),
      ` （${source}p.${view.index + 1}${turned}）`);
    label.title = `${view.file.name} の ${view.index + 1}ページ目`;
    view.el.querySelector('[data-act="left"]').disabled = i === 0;
    view.el.querySelector('[data-act="right"]').disabled = i === total - 1;
  });

  els.welcome.hidden = total > 0;
  els.count.textContent = total ? (selected ? `${selected} / ${total}ページ選択中` : `全${total}ページ`) : "";
  const none = total === 0 || state.busy;
  for (const btn of [els.selectAll, els.selectNone, els.rotateLeft, els.rotateRight, els.clearBtn, els.splitBtn, els.saveBtn]) {
    btn.disabled = none;
  }
  els.selectNone.disabled = none || selected === 0;
  els.deleteBtn.disabled = none || selected === 0;
  els.extractBtn.disabled = none || selected === 0;
  const scope = selected ? "選んだページ" : "全ページ";
  els.rotateLeft.title = `${scope}を左に90°回転`;
  els.rotateRight.title = `${scope}を右に90°回転`;
}

/* ---------- saving ---------- */

async function buildPdf(views) {
  const out = await PDFDocument.create();
  // Copy runs of pages from the same file together so shared resources are copied once.
  let i = 0;
  while (i < views.length) {
    const file = views[i].file;
    let j = i;
    while (j < views.length && views[j].file === file) j++;
    const run = views.slice(i, j);
    if (!file.doc) {
      for (const view of run) await addRasterPage(out, view);
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
  return out.save();
}

// Draws a page of a protected PDF as an image, the same as printing it, already turned upright.
async function addRasterPage(out, view) {
  const page = await view.file.pdf.getPage(view.index + 1);
  const rotation = (view.baseRotation + view.rotation) % 360;
  const size = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: RASTER_SCALE, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  canvas.width = canvas.height = 0;
  const image = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  out.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
}

function baseName(name) {
  return name.replace(/\.pdf$/i, "") || "document";
}

function outputName(suffix) {
  const first = baseName(state.pages[0].file.name);
  return state.files.length > 1 ? `${first}など_${suffix}.pdf` : `${first}_${suffix}.pdf`;
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
    const bytes = await buildPdf(state.pages);
    download(bytes, outputName(state.files.length > 1 ? "結合" : "編集済み"));
    state.dirty = false;
    showStatus("保存しました");
  });
}

function saveSelected() {
  const views = state.pages.filter((p) => p.selected);
  if (!views.length) return;
  return withBusy("PDFを作成中…", async () => {
    const bytes = await buildPdf(views);
    download(bytes, outputName("抜き出し"));
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
      download(bytes, `${baseName(view.file.name)}_${n}.pdf`);
      // Chrome drops downloads fired too close together.
      await new Promise((r) => setTimeout(r, 250));
    }
    state.dirty = false;
    showStatus(`${views.length}個のPDFに分けて保存しました`);
  });
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
  if (state.dirty && !confirm("並べたページをすべて外して最初からやり直しますか？")) return;
  removePages(state.pages.slice());
});
els.saveBtn.addEventListener("click", saveAll);
els.extractBtn.addEventListener("click", saveSelected);
els.splitBtn.addEventListener("click", saveEachPage);

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "a" && state.pages.length && !e.target.closest("input, textarea")) {
    e.preventDefault();
    setAllSelected(true);
  } else if (e.key === "Escape") {
    setAllSelected(false);
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty && state.pages.length) e.preventDefault();
});

// Drag & drop PDFs anywhere on the page (page cards handle their own reordering drags).
let dragDepth = 0;
const isFileDrag = (e) => [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropOverlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!isFileDrag(e)) return;
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  addFiles(e.dataTransfer.files);
});

// Offline support once the page has been opened online.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

updateUi();

// Hook for automated tests.
window.__pdfPages = { state, addFiles, buildPdf, rotatePages, removePages, movePage, toggleSelect };
