import { openPdf, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, download, onFileDrop } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { History } from "../shared/js/history.js";
import {
  MARKER_FACTOR, SEAL_COLOR, TEXT_FONT, textWidth, tracePath, drawStroke, drawStamp, previewCanvas, renderInkImage, createInkEditor,
} from "../shared/js/ink.js";
import { registerOffline } from "../shared/js/offline.js";

const { PDFDocument, degrees, BlendMode } = window.PDFLib;

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const SIGN_PT = 0.4; // signature pad units → PDF points when first placed
const MAX_SIGNS = 5;
const STORE = { name: "pdf-sign-name", signs: "pdf-sign-signatures" };

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  tools: document.querySelectorAll(".btn.tool"),
  stampBtn: $("stamp-btn"),
  stampMenu: $("stamp-menu"),
  sealName: $("seal-name"),
  sealList: $("seal-list"),
  markList: $("mark-list"),
  signBtn: $("sign-btn"),
  signMenu: $("sign-menu"),
  signList: $("sign-list"),
  newSignBtn: $("new-sign-btn"),
  swatches: document.querySelectorAll(".toolbar .swatch"),
  width: $("width"),
  undoBtn: $("undo-btn"),
  redoBtn: $("redo-btn"),
  deleteBtn: $("delete-btn"),
  zoomIn: $("zoom-in"),
  zoomOut: $("zoom-out"),
  zoomLabel: $("zoom-label"),
  saveBtn: $("save-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  pages: $("pages"),
  signDialog: $("sign-dialog"),
  signPad: $("sign-pad"),
  padSwatches: document.querySelectorAll(".pad-swatch"),
  padClear: $("pad-clear"),
  padOk: $("pad-ok"),
};

const state = {
  fileName: "document.pdf",
  bytes: null, // original PDF bytes (never handed to pdf.js, which detaches buffers)
  pdf: null, // pdf.js document
  pages: [], // { id (= page number), num, viewport (scale 1), el, canvas, ink, selbox, rendered, task }
  // Strokes and stamps as described in shared/js/ink.js, plus
  // sign: { type, page, sig: { strokes, w, h, width, color }, x, y, w, h }
  items: [],
  selected: null,
  drawing: null, // stroke being drawn
  tool: "pen",
  color: "#111111",
  width: 2,
  stamp: "name",
  signIndex: 0,
  signs: [],
  scale: 1,
  dirty: false,
};

/* ---------- stamps ---------- */

function today() {
  const d = new Date();
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

// Seals are always vermilion; marks use the current color.
const STAMPS = [
  { id: "name", label: "名前の印鑑", seal: true, shape: "circle", vertical: true, w: 40, h: 40, text: () => state.sealName.trim() || "印" },
  { id: "sumi", label: "済", seal: true, shape: "circle", w: 36, h: 36, text: () => "済" },
  { id: "kakunin", label: "確認", seal: true, shape: "circle", w: 40, h: 40, text: () => "確認" },
  { id: "teishutsu", label: "提出済", seal: true, shape: "rect", w: 66, h: 26, text: () => "提出済" },
  { id: "check", label: "チェック", shape: "check", w: 26, h: 26 },
  { id: "circle", label: "まる", shape: "ring", w: 28, h: 28 },
  { id: "cross", label: "ばつ", shape: "cross", w: 24, h: 24 },
  { id: "triangle", label: "さんかく", shape: "triangle", w: 28, h: 26 },
  { id: "date", label: "今日の日付", shape: "text", w: 0, h: 14, text: today },
];
const stampDef = (id) => STAMPS.find((s) => s.id === id);

function newStamp(id, page, cx, cy) {
  const def = stampDef(id);
  const text = def.text?.() ?? "";
  let { w, h } = def;
  if (def.shape === "text") w = textWidth(text, `${h * 0.85}px ${TEXT_FONT}`) + 2;
  return {
    type: "stamp", page, kind: id, text,
    color: def.seal ? SEAL_COLOR : state.color,
    x: cx - w / 2, y: cy - h / 2, w, h,
  };
}

/* ---------- drawing items ---------- */

function drawSign(ctx, item) {
  const { sig } = item;
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.scale(item.w / sig.w, item.h / sig.h);
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = sig.color;
  ctx.lineWidth = sig.width;
  for (const pts of sig.strokes) {
    ctx.beginPath();
    tracePath(ctx, pts);
    ctx.stroke();
  }
  ctx.restore();
}

function drawItem(ctx, item) {
  if (item.type === "stroke") drawStroke(ctx, item);
  else if (item.type === "stamp") drawStamp(ctx, item, stampDef(item.kind));
  else if (item.type === "sign") drawSign(ctx, item);
}

const history = new History(state);
const editor = createInkEditor({
  state,
  history,
  viewOf: (id) => state.pages[id - 1],
  allViews: () => state.pages,
  drawItem,
  updateUi,
});
const { renderInk, select, commit, undo, redo } = editor;

/* ---------- opening a PDF ---------- */

async function openFile(file) {
  if (!file) return;
  if (state.dirty && !confirm("書き込んだ内容は保存されていません。別のPDFを開きますか？")) return;
  showStatus("PDFを読み込み中…", { sticky: true });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(bytes.slice()).promise;

    resetDocument();
    state.bytes = bytes;
    state.pdf = pdf;
    state.fileName = file.name || "document.pdf";
    document.title = `${state.fileName} - PDFに手書き・署名`;

    for (let num = 1; num <= pdf.numPages; num++) {
      const page = await pdf.getPage(num);
      state.pages.push(createPageView(num, page.getViewport({ scale: 1 })));
    }
    els.welcome.hidden = true;
    setScale(fitWidthScale());
    els.viewer.scrollTop = 0;
    updateUi();
    hideStatus();
    showStatus(hintForTool());
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
  history.reset();
  state.selected = null;
  state.drawing = null;
  state.dirty = false;
  els.pages.replaceChildren();
}

function createPageView(num, viewport) {
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
  label.textContent = `${num} / ${state.pdf.numPages}`;
  el.append(canvas, ink, selbox, label);
  els.pages.append(el);

  const view = { id: num, num, viewport, el, canvas, ink, selbox, rendered: false, task: null };
  ink.addEventListener("pointerdown", (e) => onPointerDown(e, view));
  resize.addEventListener("pointerdown", (e) => editor.onResizeDown(e, view));
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
  const dpr = window.devicePixelRatio || 1;
  view.ink.width = Math.floor(view.viewport.width * state.scale * dpr);
  view.ink.height = Math.floor(view.viewport.height * state.scale * dpr);
  renderInk(view);
  const page = await state.pdf.getPage(view.num);
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
    editor.updateSelbox(view);
  }
  viewer.scrollTop = centerY - viewer.clientHeight / 2;
  // Re-render whatever is on screen now.
  for (const view of state.pages) {
    observer.unobserve(view.el);
    observer.observe(view.el);
  }
}

/* ---------- editing ---------- */

function onPointerDown(e, view) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  closeMenus();
  const point = editor.pagePoint(e, view);
  const [x, y] = point;

  if (state.tool === "pen" || state.tool === "marker") {
    editor.drawStrokeFrom(e, view, point);
  } else if (state.tool === "eraser") {
    editor.eraseFrom(e, view, point);
  } else if (state.tool === "select") {
    editor.selectFrom(e, view, point);
  } else if (state.tool === "stamp") {
    editor.placeFrom(e, view, newStamp(state.stamp, view.id, x, y), point);
  } else if (state.tool === "sign") {
    const sig = state.signs[state.signIndex];
    if (!sig) {
      e.preventDefault();
      openSignDialog();
      return;
    }
    let w = sig.w * SIGN_PT;
    let h = sig.h * SIGN_PT;
    const fit = Math.min(1, 180 / w, 70 / h);
    w *= fit;
    h *= fit;
    editor.placeFrom(e, view, { type: "sign", page: view.id, sig: structuredClone(sig), x: x - w / 2, y: y - h / 2, w, h }, point);
  }
}

/* ---------- toolbar state ---------- */

function hintForTool() {
  switch (state.tool) {
    case "pen": return "ページの上をなぞって書いてください";
    case "marker": return "線を引きたいところをなぞってください";
    case "eraser": return "消したい線やハンコをなぞってください";
    case "stamp": return `押したい場所をクリックしてください（${stampDef(state.stamp).label}）`;
    case "sign": return "署名を入れたい場所をクリックしてください";
    default: return "ハンコや線をドラッグして動かせます";
  }
}

function setTool(tool, { hint = true } = {}) {
  state.tool = tool;
  document.body.dataset.tool = tool;
  if (tool !== "select") select(null);
  if (tool === "marker" && state.color === "#111111") setColor("#facc15");
  else if (["pen", "stamp", "sign"].includes(tool) && state.color === "#facc15") setColor("#111111");
  updateUi();
  if (hint && state.pdf) showStatus(hintForTool());
}

function setColor(color) {
  state.color = color;
  const recolors = (item) => item.type === "stroke" || (item.type === "stamp" && !stampDef(item.kind).seal);
  editor.changeSelected(recolors, (item) => (item.color = color));
  renderStampChoices();
  updateUi();
}

function updateUi() {
  const open = !!state.pdf;
  for (const btn of els.tools) btn.classList.toggle("selected", btn.dataset.tool === state.tool);
  for (const sw of els.swatches) sw.classList.toggle("selected", sw.dataset.color === state.color);
  els.undoBtn.disabled = !open || !history.canUndo;
  els.redoBtn.disabled = !open || !history.canRedo;
  els.deleteBtn.disabled = !state.selected;
  els.saveBtn.disabled = !open;
}

/* ---------- menus ---------- */

function closeMenus() {
  els.stampMenu.hidden = true;
  els.signMenu.hidden = true;
}

function toggleMenu(menu) {
  const show = menu.hidden;
  closeMenus();
  menu.hidden = !show;
}

function renderStampChoices() {
  for (const [list, seal] of [[els.sealList, true], [els.markList, false]]) {
    list.replaceChildren(...STAMPS.filter((s) => !!s.seal === seal).map((def) => {
      const item = newStamp(def.id, 0, 0, 0);
      item.x = item.y = 0;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stamp-choice";
      btn.title = def.label;
      btn.setAttribute("aria-label", def.label);
      btn.classList.toggle("selected", state.stamp === def.id);
      btn.append(previewCanvas((ctx) => drawStamp(ctx, item, def), item.w, item.h, def.shape === "text" ? 62 : 46));
      btn.addEventListener("click", () => {
        state.stamp = def.id;
        closeMenus();
        renderStampChoices();
        setTool("stamp");
      });
      return btn;
    }));
    if (!seal) list.lastChild.style.gridColumn = "span 2";
  }
}

function renderSignChoices() {
  els.signList.replaceChildren(...state.signs.map((sig, i) => {
    const row = document.createElement("div");
    row.className = "sign-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sign-choice";
    btn.title = "この署名を使う";
    btn.classList.toggle("selected", i === state.signIndex);
    btn.append(previewCanvas((ctx) => drawSign(ctx, { sig, x: 0, y: 0, w: sig.w, h: sig.h }), sig.w, sig.h, 200));
    btn.style.height = "56px";
    btn.addEventListener("click", () => {
      state.signIndex = i;
      closeMenus();
      renderSignChoices();
      setTool("sign");
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn sign-del";
    del.textContent = "✕";
    del.title = "この署名を消す";
    del.addEventListener("click", () => {
      if (!confirm("この署名を消しますか？（PDFに入れた署名は消えません）")) return;
      state.signs.splice(i, 1);
      state.signIndex = 0;
      saveJson(STORE.signs, state.signs);
      renderSignChoices();
    });
    row.append(btn, del);
    return row;
  }));
}

/* ---------- signature pad ---------- */

const pad = {
  strokes: [],
  color: "#111111",
  width: 3,
  ctx: els.signPad.getContext("2d"),
  W: 560,
  H: 200,
};
els.signPad.width = pad.W * 2;
els.signPad.height = pad.H * 2;

function drawPad() {
  const { ctx } = pad;
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.clearRect(0, 0, pad.W, pad.H);
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = pad.color;
  ctx.lineWidth = pad.width;
  for (const pts of pad.strokes) {
    ctx.beginPath();
    tracePath(ctx, pts);
    ctx.stroke();
  }
}

function padPoint(e) {
  const rect = els.signPad.getBoundingClientRect();
  return [(e.clientX - rect.left) * (pad.W / rect.width), (e.clientY - rect.top) * (pad.H / rect.height)];
}

els.signPad.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  els.signPad.setPointerCapture(e.pointerId);
  const pts = [padPoint(e)];
  pad.strokes.push(pts);
  drawPad();
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const events = ev.getCoalescedEvents?.() ?? [];
    for (const ce of events.length ? events : [ev]) pts.push(padPoint(ce));
    drawPad();
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    els.signPad.removeEventListener("pointermove", move);
    els.signPad.removeEventListener("pointerup", up);
    els.signPad.removeEventListener("pointercancel", up);
  };
  els.signPad.addEventListener("pointermove", move);
  els.signPad.addEventListener("pointerup", up);
  els.signPad.addEventListener("pointercancel", up);
});

function openSignDialog() {
  closeMenus();
  pad.strokes = [];
  drawPad();
  els.signDialog.showModal();
}

function finishSign() {
  const all = pad.strokes.flat();
  if (!all.length) {
    showStatus("枠の中にサインを書いてください", { error: true });
    return;
  }
  // Crop to the ink so the signature sits tight inside its box.
  const m = pad.width;
  const x1 = Math.min(...all.map((p) => p[0])) - m;
  const y1 = Math.min(...all.map((p) => p[1])) - m;
  const x2 = Math.max(...all.map((p) => p[0])) + m;
  const y2 = Math.max(...all.map((p) => p[1])) + m;
  const round = (v) => Math.round(v * 10) / 10;
  const sig = {
    strokes: pad.strokes.map((pts) => pts.map(([x, y]) => [round(x - x1), round(y - y1)])),
    w: round(x2 - x1),
    h: round(y2 - y1),
    width: pad.width,
    color: pad.color,
  };
  state.signs.unshift(sig);
  state.signs.length = Math.min(state.signs.length, MAX_SIGNS);
  state.signIndex = 0;
  saveJson(STORE.signs, state.signs);
  renderSignChoices();
  els.signDialog.close();
  setTool("sign", { hint: false });
  showStatus(state.pdf ? "署名を入れたい場所をクリックしてください" : "PDFを開いてから、署名を入れたい場所をクリックしてください");
}

for (const sw of els.padSwatches) {
  sw.addEventListener("click", () => {
    pad.color = sw.dataset.color;
    for (const s of els.padSwatches) s.classList.toggle("selected", s === sw);
    drawPad();
  });
}
els.padClear.addEventListener("click", () => {
  pad.strokes = [];
  drawPad();
});
els.padOk.addEventListener("click", finishSign);

/* ---------- saving ---------- */

function outputName() {
  const base = state.fileName.replace(/\.pdf$/i, "");
  return `${base}_書き込み済み.pdf`;
}

let saving = false;
async function save() {
  if (!state.bytes || saving) return;
  saving = true;
  els.saveBtn.disabled = true;
  select(null);
  showStatus("PDFを作成中…", { sticky: true });
  try {
    await document.fonts.ready;
    const original = await PDFDocument.load(state.bytes, { ignoreEncryption: true });
    const rebuilt = original.isEncrypted;
    const onPage = (num, count) => showStatus(`保護されたPDFのため、ページを画像にしています… (${num}/${count})`, { sticky: true });
    const doc = rebuilt ? await rasterizePdf(state.pdf, { onPage }) : original;

    for (const view of state.pages) {
      const items = state.items.filter((i) => i.page === view.num);
      if (!items.length) continue;
      const ink = await renderInkImage(items, view.viewport, drawItem);
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

    const out = await doc.save();
    download(new Blob([out], { type: "application/pdf" }), outputName());
    state.dirty = false;
    showStatus(rebuilt
      ? "保存しました（保護されたPDFのため、元のページは画像として保存しています）"
      : "保存しました（ダウンロードフォルダを確認してください）");
  } catch (err) {
    console.error(err);
    showStatus("保存できませんでした。PDFが壊れているか、対応していない形式の可能性があります", { error: true });
  } finally {
    saving = false;
    updateUi();
  }
}

/* ---------- toolbar & global events ---------- */

els.fileInput.addEventListener("change", () => {
  openFile(els.fileInput.files[0]);
  els.fileInput.value = "";
});

for (const btn of els.tools) {
  const tool = btn.dataset.tool;
  if (tool === "stamp" || tool === "sign") continue;
  btn.addEventListener("click", () => {
    closeMenus();
    setTool(tool);
  });
}
els.stampBtn.addEventListener("click", () => toggleMenu(els.stampMenu));
els.signBtn.addEventListener("click", () => {
  if (!state.signs.length) openSignDialog();
  else toggleMenu(els.signMenu);
});
els.newSignBtn.addEventListener("click", openSignDialog);
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".menu-wrap")) closeMenus();
});

els.sealName.addEventListener("input", () => {
  state.sealName = els.sealName.value;
  saveJson(STORE.name, state.sealName);
  renderStampChoices();
});
els.sealName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    state.stamp = "name";
    closeMenus();
    renderStampChoices();
    setTool("stamp");
  }
});

for (const sw of els.swatches) sw.addEventListener("click", () => setColor(sw.dataset.color));

els.width.addEventListener("change", () => {
  state.width = Number(els.width.value);
  editor.changeSelected((item) => item.type === "stroke", (item) => {
    item.width = item.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
  });
});

els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.deleteBtn.addEventListener("click", editor.deleteSelected);
els.zoomIn.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale * 1.2)));
els.zoomOut.addEventListener("click", () => state.pdf && setScale(clampScale(state.scale / 1.2)));
els.saveBtn.addEventListener("click", save);

const SHORTCUTS = { v: "select", p: "pen", m: "marker", e: "eraser" };
document.addEventListener("keydown", (e) => {
  if (els.signDialog.open) return;
  const typing = e.target.closest("input, textarea, select");
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (key === "s") {
      e.preventDefault();
      save();
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
  } else if (SHORTCUTS[key]) {
    setTool(SHORTCUTS[key]);
  } else if (key === "h") {
    setTool("stamp");
  } else if (key === "s") {
    if (state.signs.length) setTool("sign");
    else openSignDialog();
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty && state.items.length) e.preventDefault();
});

// Drag & drop a PDF anywhere on the page.
onFileDrop((files) => {
  const pdf = files.find(isPdf);
  if (pdf) openFile(pdf);
  else showStatus("PDFファイルをドロップしてください", { error: true });
});

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

state.sealName = loadJson(STORE.name, "");
els.sealName.value = state.sealName;
state.signs = loadJson(STORE.signs, []).filter((s) => s?.strokes?.length && s.w > 0 && s.h > 0);
renderStampChoices();
renderSignChoices();
setTool("pen", { hint: false });
// Seal previews use the system's Japanese font, which may finish loading after first paint.
document.fonts.ready.then(renderStampChoices);

// Hook for automated tests.
window.__pdfSign = { state, openFile, save, setScale, setTool, undo, redo, commit, renderInk, finishSign, pad };
