import { openPdf, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { makeZip } from "../shared/js/zip.js";
import { readZip } from "../shared/js/unzip.js";
import { registerOffline } from "../shared/js/offline.js";

const { PDFDocument, degrees, BlendMode } = window.PDFLib;

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const INK_SCALE = 4; // 288 dpi for the ink layer in the saved PDF
const INK_MAX_PX = 4096; // longest side of a saved ink image
const MARKER_FACTOR = 6; // highlighter width = pen width × this
const SCORE_H = 34; // height of a new score, in page points
const SEAL_COLOR = "#d7261e";
const SEAL_FONT = '"Noto Serif CJK JP", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif';
const TEXT_FONT = 'system-ui, "Noto Sans JP", sans-serif';
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
  // Everything is in page points with a top-left origin, as the page is shown (rotation applied).
  // `page` is a page view id, unique across all files.
  // stroke: { type, page, tool: "pen"|"marker", color, width, points: [[x, y], …] }
  // stamp:  { type, page, kind, text, color, x, y, w, h }
  // text:   { type, page, text, color, x, y, w, h }
  // score:  { type, page, value, max, color, x, y, w, h }  (one per file)
  items: [],
  history: [[]],
  historyPos: 0,
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
  { id: "yoku", label: "よくできました", seal: true, shape: "rect", w: 104, h: 26, text: "よくできました" },
  { id: "saiteishutsu", label: "再提出", seal: true, shape: "rect", w: 66, h: 26, text: "再提出" },
];
const stampDef = (id) => STAMPS.find((s) => s.id === id);

const sealFont = (size) => `bold ${size}px ${SEAL_FONT}`;
const textFont = (h) => `${h * 0.85}px ${TEXT_FONT}`;
const scoreFonts = (h) => [`bold ${h * 0.82}px ${TEXT_FONT}`, `bold ${h * 0.46}px ${TEXT_FONT}`];
const scoreSuffix = (max) => (max ? ` / ${max}` : "点");

const measureCtx = document.createElement("canvas").getContext("2d");
function textWidth(text, font) {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// Text and scores grow sideways with what is typed; their height sets the font size.
function fitWidth(item) {
  if (item.type === "text") {
    item.w = textWidth(item.text, textFont(item.h)) + 2;
  } else if (item.type === "score") {
    const [big, small] = scoreFonts(item.h);
    item.w = textWidth(item.value, big) + textWidth(scoreSuffix(item.max), small) + item.h * 0.3;
  }
}

function drawStamp(ctx, item) {
  const def = stampDef(item.kind);
  const { x, y, w, h, text } = item;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = item.color;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = x + w / 2;
  const cy = y + h / 2;
  const s = Math.min(w, h);
  switch (def.shape) {
    case "circle": {
      const lw = s * 0.06;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2 - lw / 2, h / 2 - lw / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      const inner = s - lw * 2;
      const fs = Math.min(inner * 0.8 / [...text].length, inner * 0.6);
      ctx.font = sealFont(fs);
      ctx.fillText(text, cx, cy);
      break;
    }
    case "rect": {
      const lw = h * 0.07;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, h * 0.12);
      ctx.stroke();
      const fs = Math.min(h * 0.6, (w * 0.86) / [...text].length);
      ctx.font = sealFont(fs);
      ctx.fillText(text, cx, cy);
      break;
    }
    default: {
      ctx.translate(x, y);
      ctx.scale(w, h);
      ctx.lineWidth = def.shape === "hanamaru" ? 0.045 : 0.11;
      ctx.beginPath();
      if (def.shape === "check") {
        ctx.moveTo(0.1, 0.55);
        ctx.lineTo(0.4, 0.84);
        ctx.lineTo(0.92, 0.14);
      } else if (def.shape === "ring") {
        ctx.arc(0.5, 0.5, 0.44, 0, Math.PI * 2);
      } else if (def.shape === "cross") {
        ctx.moveTo(0.12, 0.12);
        ctx.lineTo(0.88, 0.88);
        ctx.moveTo(0.88, 0.12);
        ctx.lineTo(0.12, 0.88);
      } else if (def.shape === "triangle") {
        ctx.moveTo(0.5, 0.08);
        ctx.lineTo(0.94, 0.9);
        ctx.lineTo(0.06, 0.9);
        ctx.closePath();
      } else if (def.shape === "hanamaru") {
        // A spiral in the middle, ringed with petals.
        for (let t = 0; t <= 1; t += 0.01) {
          const a = t * Math.PI * 4.6 - Math.PI / 2;
          const r = 0.03 + t * 0.25;
          const px = 0.5 + r * Math.cos(a);
          const py = 0.5 + r * Math.sin(a);
          if (t === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        const n = 9;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          const px = 0.5 + 0.34 * Math.cos(a);
          const py = 0.5 + 0.34 * Math.sin(a);
          ctx.moveTo(px + 0.12 * Math.cos(a - 1.9), py + 0.12 * Math.sin(a - 1.9));
          ctx.arc(px, py, 0.12, a - 1.9, a + 1.9);
        }
      }
      ctx.stroke();
    }
  }
  ctx.restore();
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

function lighten(hex, amount = 0.5) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function tracePath(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    ctx.lineTo(pts[0][0] + 0.01, pts[0][1]); // a dot
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function drawStroke(ctx, item) {
  ctx.save();
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = item.tool === "marker" ? lighten(item.color) : item.color;
  ctx.lineWidth = item.width;
  ctx.beginPath();
  tracePath(ctx, item.points);
  ctx.stroke();
  ctx.restore();
}

function drawItem(ctx, item) {
  if (item.type === "stroke") drawStroke(ctx, item);
  else if (item.type === "stamp") drawStamp(ctx, item);
  else if (item.type === "text") drawText(ctx, item);
  else if (item.type === "score") drawScore(ctx, item);
}

// Highlighter goes underneath so it never covers pen ink (the layer is opaque within itself).
function drawItems(ctx, items) {
  const markers = items.filter((i) => i.type === "stroke" && i.tool === "marker");
  for (const item of markers) drawItem(ctx, item);
  for (const item of items) if (!markers.includes(item)) drawItem(ctx, item);
}

function bounds(item) {
  if (item.type !== "stroke") return { x: item.x, y: item.y, w: item.w, h: item.h };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of item.points) {
    x1 = Math.min(x1, x); y1 = Math.min(y1, y);
    x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  const r = item.width / 2;
  return { x: x1 - r, y: y1 - r, w: x2 - x1 + item.width, h: y2 - y1 + item.width };
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hits(item, x, y, tolerance) {
  if (item.type === "stroke") {
    const reach = item.width / 2 + tolerance;
    const pts = item.points;
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= reach;
    for (let i = 1; i < pts.length; i++) if (distToSegment(x, y, pts[i - 1], pts[i]) <= reach) return true;
    return false;
  }
  return x >= item.x - tolerance && x <= item.x + item.w + tolerance &&
    y >= item.y - tolerance && y <= item.y + item.h + tolerance;
}

function itemAt(page, x, y, tolerance, types) {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i];
    if (item.page === page && (!types || types.includes(item.type)) && hits(item, x, y, tolerance)) return item;
  }
  return null;
}

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
  if (added) setScale(wasEmpty ? fitWidthScale() : state.scale);
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
  view.el.style.width = `${viewport.width * state.scale}px`;
  view.el.style.height = `${viewport.height * state.scale}px`;
  ink.addEventListener("pointerdown", (e) => onPointerDown(e, view));
  ink.addEventListener("dblclick", (e) => onDoubleClick(e, view));
  resize.addEventListener("pointerdown", (e) => onResizeDown(e, view));
  file.views.push(view);
  state.pages.set(view.id, view);
  viewByEl.set(el, view);
  observer.observe(el);
  unloader.observe(el);
  return view;
}

function removeFile(file) {
  commitEditor();
  const count = fileItems(file).length;
  if (count && !confirm(`「${file.name}」の書き込み（${count}個）は保存されていません。一覧から外しますか？`)) return;
  for (const view of file.views) {
    observer.unobserve(view.el);
    unloader.unobserve(view.el);
    view.task?.cancel();
    state.pages.delete(view.id);
  }
  file.pdf.destroy();
  file.section.remove();
  file.row.remove();
  state.files = state.files.filter((f) => f !== file);
  state.items = state.items.filter((i) => state.pages.has(i.page));
  // Undo steps could bring back ink for pages that are gone, so start the history over.
  state.history = [structuredClone(state.items)];
  state.historyPos = 0;
  if (state.selected && !state.pages.has(state.selected.page)) state.selected = null;
  els.welcome.hidden = state.files.length > 0;
  updateCurrent();
  updateUi();
}

/* ---------- file list ---------- */

function scoreLabel(item) {
  return item.max ? `${item.value}/${item.max}` : `${item.value}点`;
}

function refreshRow(file) {
  if (!file?.row) return;
  const items = fileItems(file);
  const score = items.find((i) => i.type === "score");
  const parts = [`${file.views.length}ページ`];
  if (items.length) parts.push(`書き込み${items.length}`);
  file.rowMeta.textContent = parts.join("・");
  file.row.classList.toggle("marked", items.length > 0);
  file.row.dataset.score = score ? scoreLabel(score) : "";
  file.headScore.textContent = score ? scoreLabel(score) : "";
}
function refreshAllRows() {
  state.files.forEach(refreshRow);
  const done = state.files.filter((f) => fileItems(f).length).length;
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

const viewByEl = new WeakMap();
const viewOf = (el) => viewByEl.get(el);

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const view = viewOf(entry.target);
      if (view && !view.rendered) renderPage(view);
    }
  },
  { root: els.viewer, rootMargin: "600px 0px" },
);

// With dozens of students the page images would fill up memory, so pages far off screen are dropped.
const unloader = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const view = viewOf(entry.target);
      if (!view?.rendered) continue;
      view.task?.cancel();
      view.rendered = false;
      view.canvas.width = view.canvas.height = 0;
      view.ink.width = view.ink.height = 0;
    }
  },
  { root: els.viewer, rootMargin: "2500px 0px" },
);

async function renderPage(view) {
  view.rendered = true;
  view.task?.cancel();
  const dpr = window.devicePixelRatio || 1;
  view.ink.width = Math.floor(view.viewport.width * state.scale * dpr);
  view.ink.height = Math.floor(view.viewport.height * state.scale * dpr);
  renderInk(view);
  const page = await view.file.pdf.getPage(view.num);
  const viewport = page.getViewport({ scale: state.scale * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  view.task = task;
  try {
    await task.promise;
    if (view.rendered) {
      view.canvas.replaceWith(canvas);
      view.canvas = canvas;
    }
  } catch (err) {
    if (err?.name !== "RenderingCancelledException") console.error(err);
  } finally {
    if (view.task === task) view.task = null;
    page.cleanup();
  }
}

function renderInk(view) {
  const { ink } = view;
  updateSelbox(view);
  if (!ink.width) return;
  const ctx = ink.getContext("2d");
  const k = ink.width / view.viewport.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ink.width, ink.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const items = state.items.filter((i) => i.page === view.id && i !== state.editing?.item);
  if (state.drawing?.page === view.id) items.push(state.drawing);
  drawItems(ctx, items);
}

function renderPageInk(id) {
  const view = state.pages.get(id);
  if (view) renderInk(view);
}

function updateSelbox(view) {
  const item = state.selected;
  if (!item || item.page !== view.id) {
    view.selbox.hidden = true;
    return;
  }
  const b = bounds(item);
  const pad = 3;
  const s = state.scale;
  Object.assign(view.selbox.style, {
    left: `${b.x * s - pad}px`,
    top: `${b.y * s - pad}px`,
    width: `${b.w * s + pad * 2}px`,
    height: `${b.h * s + pad * 2}px`,
  });
  view.selbox.classList.toggle("no-resize", item.type === "stroke");
  view.selbox.hidden = false;
}

function fitWidthScale() {
  let maxWidth = 1;
  for (const view of state.pages.values()) maxWidth = Math.max(maxWidth, view.viewport.width);
  const available = els.viewer.clientWidth - 90; // viewer + page list side padding
  return clampScale(Math.min(1.5, available / maxWidth));
}

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function setScale(scale) {
  commitEditor();
  const viewer = els.viewer;
  const ratio = scale / state.scale;
  const centerY = (viewer.scrollTop + viewer.clientHeight / 2) * ratio;
  state.scale = scale;
  els.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  for (const view of state.pages.values()) {
    view.el.style.width = `${view.viewport.width * scale}px`;
    view.el.style.height = `${view.viewport.height * scale}px`;
    view.rendered = false;
    updateSelbox(view);
  }
  viewer.scrollTop = centerY - viewer.clientHeight / 2;
  // Re-render whatever is on screen now.
  for (const view of state.pages.values()) {
    observer.unobserve(view.el);
    observer.observe(view.el);
  }
}

/* ---------- editing ---------- */

function pagePoint(e, view) {
  const rect = view.el.getBoundingClientRect();
  return [(e.clientX - rect.left) / state.scale, (e.clientY - rect.top) / state.scale];
}

// Follows one pointer until it is released; calls back with page points.
function track(e, view, onMove, onUp) {
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const events = ev.getCoalescedEvents?.() ?? [];
    for (const ce of events.length ? events : [ev]) onMove(pagePoint(ce, view), ce);
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    onUp?.(ev.type === "pointercancel");
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
}

function onPointerDown(e, view) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  closeMenus();
  commitEditor();
  const [x, y] = pagePoint(e, view);
  const tolerance = 4 / state.scale;

  if (state.tool === "pen" || state.tool === "marker") {
    e.preventDefault();
    select(null);
    const width = state.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
    state.drawing = { type: "stroke", page: view.id, tool: state.tool, color: state.color, width, points: [[x, y]] };
    renderInk(view);
    const minStep = 0.6 / state.scale;
    track(e, view, ([px, py]) => {
      const pts = state.drawing.points;
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(px - lx, py - ly) < minStep) return;
      pts.push([px, py]);
      renderInk(view);
    }, (cancelled) => {
      const stroke = state.drawing;
      state.drawing = null;
      if (!cancelled) {
        state.items.push(stroke);
        commit();
      }
      renderInk(view);
    });
  } else if (state.tool === "eraser") {
    e.preventDefault();
    select(null);
    let erased = false;
    const erase = ([px, py]) => {
      const reach = 8 / state.scale;
      const before = state.items.length;
      state.items = state.items.filter((item) => item.page !== view.id || !hits(item, px, py, reach));
      if (state.items.length !== before) {
        erased = true;
        renderInk(view);
      }
    };
    erase([x, y]);
    track(e, view, erase, () => erased && commit());
  } else if (state.tool === "select") {
    const item = itemAt(view.id, x, y, tolerance);
    select(item);
    if (!item) return; // let touch scrolling happen
    e.preventDefault();
    let last = [x, y];
    let moved = false;
    track(e, view, ([px, py]) => {
      moveItem(item, px - last[0], py - last[1]);
      last = [px, py];
      moved = true;
      renderInk(view);
    }, () => moved && commit());
  } else if (state.tool === "stamp") {
    e.preventDefault();
    const item = newStamp(state.stamp, view.id, x, y);
    state.items.push(item);
    commit();
    select(item);
    // Keep dragging right away to fine-tune where it lands.
    let last = [x, y];
    track(e, view, ([px, py]) => {
      moveItem(item, px - last[0], py - last[1]);
      last = [px, py];
      renderInk(view);
    }, () => commit(true));
  } else if (state.tool === "text") {
    e.preventDefault();
    const hit = itemAt(view.id, x, y, tolerance, ["text"]);
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
      const from = existing.page;
      existing.page = view.id;
      existing.x = x;
      existing.y = y - existing.h / 2;
      commit();
      renderPageInk(from);
      openEditor(existing);
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
  const [x, y] = pagePoint(e, view);
  const item = itemAt(view.id, x, y, 4 / state.scale, ["text", "score"]);
  if (item) openEditor(item);
}

function moveItem(item, dx, dy) {
  if (item.type === "stroke") {
    for (const p of item.points) {
      p[0] += dx;
      p[1] += dy;
    }
  } else {
    item.x += dx;
    item.y += dy;
  }
}

function onResizeDown(e, view) {
  const item = state.selected;
  if (!item || item.type === "stroke") return;
  e.preventDefault();
  e.stopPropagation();
  const [sx, sy] = pagePoint(e, view);
  const start = { w: item.w, h: item.h };
  const aspect = item.h / item.w;
  track(e, view, ([px, py]) => {
    const grow = Math.max((px - sx) / start.w, (py - sy) / start.h);
    const w = Math.max(8, start.w * (1 + grow));
    item.w = w;
    item.h = w * aspect;
    renderInk(view);
  }, () => commit());
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
  const { item, input, isNew } = editing;
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

/* ---------- selection & history ---------- */

function select(item) {
  const prev = state.selected;
  state.selected = item;
  if (prev && prev !== item) renderPageInk(prev.page);
  if (item) renderPageInk(item.page);
  updateUi();
}

function deleteSelected() {
  const item = state.selected;
  if (!item) return;
  state.items = state.items.filter((i) => i !== item);
  state.selected = null;
  commit();
  renderPageInk(item.page);
}

// Records the current items as a new undo step. `replace` folds a follow-up drag into the last step.
function commit(replace = false) {
  if (!replace) {
    state.history.length = state.historyPos + 1;
    state.historyPos++;
  }
  state.history[state.historyPos] = structuredClone(state.items);
  state.dirty = true;
  refreshAllRows();
  updateUi();
}

function restore(pos) {
  commitEditor(true);
  if (pos < 0 || pos >= state.history.length) return;
  state.historyPos = pos;
  state.items = structuredClone(state.history[pos]);
  state.selected = null;
  state.dirty = true;
  state.pages.forEach(renderInk);
  refreshAllRows();
  updateUi();
}
const undo = () => restore(state.historyPos - 1);
const redo = () => restore(state.historyPos + 1);

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
  const item = state.selected;
  if (item && !(item.type === "stamp" && stampDef(item.kind).seal)) {
    item.color = color;
    commit();
    renderPageInk(item.page);
  }
  renderStampChoices();
  updateUi();
}

function updateUi() {
  const open = state.files.length > 0;
  for (const btn of els.tools) btn.classList.toggle("selected", btn.dataset.tool === state.tool);
  for (const sw of els.swatches) sw.classList.toggle("selected", sw.dataset.color === state.color);
  els.undoBtn.disabled = !open || state.historyPos === 0;
  els.redoBtn.disabled = !open || state.historyPos >= state.history.length - 1;
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

function previewCanvas(draw, w, h, box = 50) {
  const dpr = window.devicePixelRatio || 1;
  const k = Math.min(box / w, box / h, 2.2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * k * dpr);
  canvas.height = Math.ceil(h * k * dpr);
  canvas.style.width = `${w * k}px`;
  canvas.style.height = `${h * k}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(k * dpr, k * dpr);
  draw(ctx);
  return canvas;
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
      btn.append(previewCanvas((ctx) => drawStamp(ctx, item), item.w, item.h, def.shape === "rect" ? 110 : 46));
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

// Draws one page's ink onto a transparent PNG cropped to where the ink is.
async function renderInkImage(view, items) {
  const { width, height } = view.viewport;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const item of items) {
    const b = bounds(item);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  x1 = Math.max(0, Math.floor(x1 - 2));
  y1 = Math.max(0, Math.floor(y1 - 2));
  x2 = Math.min(width, Math.ceil(x2 + 2));
  y2 = Math.min(height, Math.ceil(y2 + 2));
  if (x2 <= x1 || y2 <= y1) return null;
  const box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  const k = Math.min(INK_SCALE, INK_MAX_PX / Math.max(box.w, box.h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.w * k);
  canvas.height = Math.ceil(box.h * k);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(k, 0, 0, k, -box.x * k, -box.y * k);
  drawItems(ctx, items);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0;
  return { box, png: new Uint8Array(await blob.arrayBuffer()) };
}

// Returns { bytes, rebuilt } for one student's marked-up PDF.
async function buildPdf(file, progress) {
  const items = fileItems(file);
  if (!items.length) return { bytes: file.bytes, rebuilt: false }; // nothing written: hand back the original
  const original = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const rebuilt = original.isEncrypted;
  const doc = rebuilt ? await rasterizePdf(file.pdf, { onPage: progress }) : original;
  for (const view of file.views) {
    const pageItems = items.filter((i) => i.page === view.id);
    if (!pageItems.length) continue;
    const ink = await renderInkImage(view, pageItems);
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
  const item = state.selected;
  if (item?.type === "stroke") {
    item.width = item.tool === "marker" ? state.width * MARKER_FACTOR : state.width;
    commit();
    renderPageInk(item.page);
  }
});

els.textSize.addEventListener("change", () => {
  state.textSize = Number(els.textSize.value);
  const item = state.selected;
  if (item?.type === "text") {
    item.h = state.textSize;
    fitWidth(item);
    commit();
    renderPageInk(item.page);
  }
});

els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.deleteBtn.addEventListener("click", deleteSelected);
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
      deleteSelected();
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
