import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";

const { PDFDocument, rgb, degrees } = window.PDFLib;

const asset = (path) => new URL(path, location.href).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = asset("lib/pdfjs/pdf.worker.min.mjs");

const FONT_URL = asset("fonts/NotoSansJP-Regular.ttf");
const SUBSET_WASM_URL = asset("lib/harfbuzz-subset.wasm");
const FONT_FAMILY = "PdfTextJP";
const LINE_HEIGHT = 1.25; // must match .tbox line-height in style.css
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  fontSize: $("font-size"),
  deleteBtn: $("delete-btn"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomLabel: $("zoom-label"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  pages: $("pages"),
  status: $("status"),
  dropOverlay: $("drop-overlay"),
};

const state = {
  fileName: "document.pdf",
  bytes: null, // original PDF bytes (never handed to pdf.js, which detaches buffers)
  pdf: null, // pdf.js document
  pages: [], // { num, viewport (scale 1), el, canvas, layer, rendered, task }
  items: [], // { page, x, y, size, color, text, el, box }
  active: null,
  scale: 1,
  size: 12,
  color: "#000000",
  baselineRatio: 1.0, // first-line baseline / font size, measured from the real font
  dirty: false,
};

/* ---------- status messages ---------- */

let statusTimer = 0;
function showStatus(text, { error = false, sticky = false } = {}) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle("error", error);
  els.status.hidden = false;
  if (!sticky) statusTimer = setTimeout(() => (els.status.hidden = true), error ? 6000 : 2500);
}
function hideStatus() {
  clearTimeout(statusTimer);
  els.status.hidden = true;
}

/* ---------- font ---------- */

const fontReady = (async () => {
  await document.fonts.load(`100px ${FONT_FAMILY}`, "あA");
  // Measure where the first baseline sits inside a line box so the saved PDF
  // puts each line exactly where it appears on screen.
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;` +
    `font:100px/${LINE_HEIGHT} ${FONT_FAMILY};margin:0;padding:0;border:0`;
  const marker = document.createElement("span");
  marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  probe.append("あA", marker);
  document.body.append(probe);
  state.baselineRatio = marker.offsetTop / 100;
  probe.remove();
})();

let fontBytesPromise = null;
function loadFontBytes() {
  fontBytesPromise ??= fetch(FONT_URL).then((r) => {
    if (!r.ok) throw new Error("フォントを読み込めませんでした");
    return r.arrayBuffer();
  });
  return fontBytesPromise;
}

// pdf-lib's built-in subsetting drops glyphs from Noto Sans JP, so the font is
// cut down to just the characters in use with HarfBuzz and embedded as-is.
let subsetterPromise = null;
function loadSubsetter() {
  subsetterPromise ??= fetch(SUBSET_WASM_URL)
    .then((r) => r.arrayBuffer())
    .then((buf) => WebAssembly.instantiate(buf))
    .then(({ instance }) => instance.exports);
  return subsetterPromise;
}

async function subsetFont(text) {
  const [hb, fontBytes] = await Promise.all([loadSubsetter(), loadFontBytes()]);
  const ptr = hb.malloc(fontBytes.byteLength);
  new Uint8Array(hb.memory.buffer).set(new Uint8Array(fontBytes), ptr);
  const blob = hb.hb_blob_create(ptr, fontBytes.byteLength, 2 /* writable */, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0));
  const sub = hb.hb_subset_or_fail(face, input);
  hb.hb_subset_input_destroy(input);
  try {
    if (!sub) throw new Error("フォントの準備に失敗しました");
    const out = hb.hb_face_reference_blob(sub);
    const data = hb.hb_blob_get_data(out, 0);
    const bytes = new Uint8Array(hb.memory.buffer).slice(data, data + hb.hb_blob_get_length(out));
    hb.hb_blob_destroy(out);
    return bytes;
  } finally {
    if (sub) hb.hb_face_destroy(sub);
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
}

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (state.dirty && !confirm("書き込んだ文字は保存されていません。別のPDFを開きますか？")) return;
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({
      data: bytes.slice(),
      cMapUrl: asset("lib/pdfjs/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: asset("lib/pdfjs/standard_fonts/"),
    }).promise;

    resetDocument();
    state.bytes = bytes;
    state.pdf = pdf;
    state.fileName = file.name || "document.pdf";
    document.title = `${state.fileName} - PDF文字入れ`;

    for (let num = 1; num <= pdf.numPages; num++) {
      const page = await pdf.getPage(num);
      state.pages.push(createPageView(num, page.getViewport({ scale: 1 })));
    }
    els.welcome.hidden = true;
    els.saveBtn.disabled = false;
    setScale(fitWidthScale());
    els.viewer.scrollTop = 0;
    hideStatus();
    showStatus("文字を入れたい場所をクリックしてください");
  } catch (err) {
    console.error(err);
    const msg = err?.name === "PasswordException"
      ? "パスワード付きのPDFは開けません"
      : "PDFを開けませんでした";
    showStatus(msg, { error: true });
  }
}

function resetDocument() {
  observer.disconnect();
  state.pages.forEach((p) => p.task?.cancel());
  state.pdf?.destroy();
  state.pages = [];
  state.items = [];
  state.active = null;
  state.dirty = false;
  els.pages.replaceChildren();
  updateActiveUi();
}

function createPageView(num, viewport) {
  const el = document.createElement("div");
  el.className = "page";
  el.dataset.num = num;
  const canvas = document.createElement("canvas");
  const layer = document.createElement("div");
  layer.className = "layer";
  const label = document.createElement("div");
  label.className = "page-num";
  label.textContent = `${num} / ${state.pdf.numPages}`;
  el.append(canvas, layer, label);
  els.pages.append(el);

  const view = { num, viewport, el, canvas, layer, rendered: false, task: null };
  layer.addEventListener("pointerdown", (e) => {
    if (e.target !== layer || e.button !== 0) return;
    e.preventDefault();
    const rect = layer.getBoundingClientRect();
    const x = (e.clientX - rect.left) / state.scale;
    const y = (e.clientY - rect.top) / state.scale - (state.size * LINE_HEIGHT) / 2;
    addItem(view, x, Math.max(0, y));
  });
  observer.observe(el);
  return view;
}

/* ---------- rendering ---------- */

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const view = state.pages.find((p) => p.el === entry.target);
      if (view && !view.rendered) renderPage(view);
    }
  },
  { root: els.viewer, rootMargin: "600px 0px" },
);

async function renderPage(view) {
  view.rendered = true;
  view.task?.cancel();
  const page = await state.pdf.getPage(view.num);
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: state.scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  view.task = task;
  try {
    await task.promise;
    view.canvas.replaceWith(canvas);
    view.canvas = canvas;
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(err);
  } finally {
    if (view.task === task) view.task = null;
  }
}

function fitWidthScale() {
  const maxWidth = Math.max(...state.pages.map((p) => p.viewport.width));
  const available = els.viewer.clientWidth - 90; // viewer + page list side padding
  return clampScale(Math.min(1.5, available / maxWidth));
}

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function setScale(scale) {
  const viewer = els.viewer;
  const ratio = scale / state.scale;
  const centerY = (viewer.scrollTop + viewer.clientHeight / 2) * ratio;
  state.scale = scale;
  els.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  for (const view of state.pages) {
    view.el.style.width = `${view.viewport.width * scale}px`;
    view.el.style.height = `${view.viewport.height * scale}px`;
    view.rendered = false;
  }
  state.items.forEach(layoutItem);
  viewer.scrollTop = centerY - viewer.clientHeight / 2;
  // Re-render whatever is on screen now.
  for (const view of state.pages) {
    observer.unobserve(view.el);
    observer.observe(view.el);
  }
}

/* ---------- text items ---------- */

function addItem(view, x, y) {
  const item = { page: view.num, x, y, size: state.size, color: state.color, text: "" };

  const box = document.createElement("div");
  box.className = "titem";
  box.style.position = "absolute";

  const ta = document.createElement("textarea");
  ta.className = "tbox";
  ta.spellcheck = false;
  ta.wrap = "off";
  ta.rows = 1;
  ta.setAttribute("aria-label", "文字");

  const handle = document.createElement("div");
  handle.className = "handle";
  handle.textContent = "✥";
  handle.title = "ドラッグで移動";

  const del = document.createElement("div");
  del.className = "tdel";
  del.textContent = "✕";
  del.title = "削除";

  box.append(ta, handle, del);
  view.layer.append(box);
  Object.assign(item, { el: ta, box });
  state.items.push(item);
  layoutItem(item);

  ta.addEventListener("input", () => {
    item.text = ta.value;
    state.dirty = true;
    autosize(item);
  });
  ta.addEventListener("focus", () => setActive(item));
  ta.addEventListener("blur", () => {
    // Drop boxes that were opened but never typed into.
    setTimeout(() => {
      if (!item.text.trim() && document.activeElement !== ta) removeItem(item);
    }, 0);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ta.blur();
  });
  del.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    removeItem(item);
  });
  enableDrag(item, handle);

  ta.focus();
  return item;
}

function layoutItem(item) {
  const s = state.scale;
  item.box.style.left = `${item.x * s}px`;
  item.box.style.top = `${item.y * s}px`;
  item.el.style.fontSize = `${item.size * s}px`;
  item.el.style.color = item.color;
  autosize(item);
}

function autosize(item) {
  const ta = item.el;
  ta.style.width = "0px";
  ta.style.height = "0px";
  ta.style.width = `${ta.scrollWidth + 2}px`;
  ta.style.height = `${ta.scrollHeight}px`;
  // Keep the controls clear of the text itself.
  const handle = item.box.querySelector(".handle");
  const del = item.box.querySelector(".tdel");
  handle.style.left = "-26px";
  handle.style.top = "-2px";
  del.style.left = `${ta.offsetWidth + 4}px`;
  del.style.top = "-2px";
}

function removeItem(item) {
  const i = state.items.indexOf(item);
  if (i === -1) return;
  state.items.splice(i, 1);
  item.box.remove();
  if (state.active === item) setActive(null);
  if (item.text.trim()) state.dirty = true;
}

function setActive(item) {
  state.active?.box.classList.remove("active");
  state.active = item;
  if (item) {
    item.box.classList.add("active");
    state.size = item.size;
    state.color = item.color;
  }
  updateActiveUi();
}

function updateActiveUi() {
  els.deleteBtn.disabled = !state.active;
  els.fontSize.value = String(state.size);
  if (els.fontSize.value !== String(state.size)) {
    const opt = new Option(String(state.size), String(state.size));
    els.fontSize.add(opt);
    els.fontSize.value = String(state.size);
  }
  document.querySelectorAll(".swatch").forEach((b) => {
    b.classList.toggle("selected", b.dataset.color === state.color);
  });
}

function enableDrag(item, handle) {
  let start = null;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    start = { px: e.clientX, py: e.clientY, x: item.x, y: item.y };
    setActive(item);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start) return;
    item.x = start.x + (e.clientX - start.px) / state.scale;
    item.y = start.y + (e.clientY - start.py) / state.scale;
    layoutItem(item);
    state.dirty = true;
  });
  const end = () => {
    if (!start) return;
    start = null;
    item.el.focus();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/* ---------- saving ---------- */

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function outputName() {
  const base = state.fileName.replace(/\.pdf$/i, "");
  return `${base}_記入済み.pdf`;
}

async function save() {
  if (!state.bytes) return;
  els.saveBtn.disabled = true;
  showStatus("PDFを作成中…", { sticky: true });
  try {
    await fontReady;
    const doc = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    doc.registerFontkit(window.fontkit);
    const items = state.items.filter((item) => item.text.trim());
    const font = items.length
      ? await doc.embedFont(await subsetFont(items.map((i) => i.text).join("")), { subset: false })
      : null;

    for (const item of items) {
      const page = doc.getPage(item.page - 1);
      const viewport = state.pages[item.page - 1].viewport;
      const color = hexToRgb(item.color);
      const rotate = degrees(viewport.rotation);
      item.text.split("\n").forEach((line, i) => {
        if (!line) return;
        const baseline = item.y + item.size * (state.baselineRatio + i * LINE_HEIGHT);
        const [x, y] = viewport.convertToPdfPoint(item.x, baseline);
        page.drawText(line, { x, y, size: item.size, font, color, rotate });
      });
    }

    const out = await doc.save();
    download(new Blob([out], { type: "application/pdf" }), outputName());
    state.dirty = false;
    showStatus("保存しました（ダウンロードフォルダを確認してください）");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。このPDFは書き込みが制限されている可能性があります", { error: true });
  } finally {
    els.saveBtn.disabled = false;
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ---------- toolbar & global events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});

els.fontSize.addEventListener("change", () => {
  state.size = Number(els.fontSize.value);
  if (state.active) {
    state.active.size = state.size;
    layoutItem(state.active);
    state.active.el.focus();
    state.dirty = true;
  }
});

document.querySelectorAll(".swatch").forEach((btn) => {
  btn.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the text box
  btn.addEventListener("click", () => {
    state.color = btn.dataset.color;
    if (state.active) {
      state.active.color = state.color;
      layoutItem(state.active);
      state.dirty = true;
    }
    updateActiveUi();
  });
});

els.deleteBtn.addEventListener("pointerdown", (e) => e.preventDefault());
els.deleteBtn.addEventListener("click", () => state.active && removeItem(state.active));

els.zoomIn.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale * 1.2)));
els.zoomOut.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale / 1.2)));
els.saveBtn.addEventListener("click", save);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// Drag & drop a PDF anywhere on the page.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.dropOverlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  const file = [...e.dataTransfer.files].find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (file) openFile(file);
  else showStatus("PDFファイルをドロップしてください", { error: true });
});

// Offline support once the page has been opened online.
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Start downloading the font early so saving is quick.
loadFontBytes().catch(() => {});
loadSubsetter().catch(() => {});

// Hook for automated tests.
window.__pdfText = { state, openFile, addItem, save, setScale, fontReady };
