import { openPdf, rasterizePdf } from "../shared/js/pdf.js";
import { showStatus, hideStatus } from "../shared/js/status.js";
import { isPdf, baseName, download, onFileDrop } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { createLazyRenderer } from "../shared/js/lazy.js";
import { registerOffline } from "../shared/js/offline.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";

// Never change a key (or the shape of what is saved) once the tool is in use: users would lose
// their settings. Add a new key instead.
const SETTINGS_KEY = "pdf-booklet-settings-v1";
const PREVIEW_PX = 340; // preview width of a sideways sheet, in CSS pixels
const A4 = { width: 595, height: 842 }; // shown in the help before a PDF is opened
const THUMB_PX = 72; // width of a page in the page order list, in CSS pixels
const LONG_PRESS_MS = 350; // touch: hold this long before a page starts to drag
const DRAG_SLOP = 8; // px the pointer may wander before a press counts as a drag (or a scroll)
const SCROLL_EDGE = 60; // px from the top/bottom of the viewer where dragging scrolls it

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $("file-input"),
  fileName: $("file-name"),
  saveBtn: $("save-btn"),
  printBtn: $("print-btn"),
  viewer: $("viewer"),
  welcome: $("welcome"),
  sheets: $("sheets"),
  order: $("order"),
  thumbs: $("thumbs"),
  orderReset: $("order-reset"),
  paper: $("paper"),
  paperHelp: $("paper-help"),
  bindingHelp: $("binding-help"),
  backCover: $("back-cover"),
  spineOn: $("spine-on"),
  spineOpts: $("spine-opts"),
  spineMode: $("spine-mode"),
  spinePos: $("spine-pos"),
  spinePosRow: $("spine-pos-row"),
  spineSubject: $("spine-subject"),
  spineGrade: $("spine-grade"),
  spinePairRows: [...document.querySelectorAll(".spine-pair")],
  spineColor: $("spine-color"),
  spineWidth: $("spine-width"),
  summary: $("summary"),
  summaryText: $("summary-text"),
};
const bindingInputs = [...document.querySelectorAll("input[name=binding]")];

const state = {
  // { name, bytes (never handed to pdf.js, which detaches buffers), pdf (pdf.js) }
  file: null,
  // each page's size as shown (scale 1, turned by its /Rotate): { width, height }
  pages: [],
  // the booklet's pages in reading order, as indexes into `pages` (changed by dragging)
  order: [],
  // one small picture per page for the page order list: { index, el, canvas, rendered }
  thumbs: [],
  // the sides of the sheets in printing order: { sheet, back, slots: [page index or null, …], el, canvas, rendered }
  sides: [],
  busy: false,
  generation: 0, // bumped when the preview is rebuilt, so late drawings of old sides are dropped
};

/* ---------- settings ---------- */

function readSettings() {
  return {
    binding: bindingInputs.find((el) => el.checked)?.value ?? "left",
    paper: els.paper.value,
    backCover: els.backCover.checked,
    spine: {
      on: els.spineOn.checked,
      mode: els.spineMode.value,
      pos: els.spinePos.value,
      subject: Number(els.spineSubject.value),
      grade: Number(els.spineGrade.value),
      color: els.spineColor.value,
      width: Number(els.spineWidth.value),
    },
  };
}

function restoreSettings() {
  const saved = loadJson(SETTINGS_KEY, {});
  if (saved.binding) for (const el of bindingInputs) el.checked = el.value === saved.binding;
  if ([...els.paper.options].some((o) => o.value === saved.paper)) els.paper.value = saved.paper;
  els.backCover.checked = !!saved.backCover;
  const spine = saved.spine ?? {};
  els.spineOn.checked = !!spine.on;
  const fields = [[els.spineMode, spine.mode], [els.spinePos, spine.pos], [els.spineSubject, String(spine.subject)],
    [els.spineGrade, String(spine.grade)], [els.spineColor, spine.color], [els.spineWidth, String(spine.width)]];
  for (const [el, value] of fields) {
    if ([...el.options].some((o) => o.value === value)) el.value = value;
  }
}

/* ---------- the order of the pages ---------- */

// The sides of the sheets for the current page order, with indexes into `pages`.
function bookletSides(settings) {
  return planBooklet(state.order.length, settings).sides
    .map((slots) => slots.map((p) => (p === null ? null : state.order[p])));
}

// Saddle stitching: every sheet holds 4 pages, 2 on each side, and the sheets are stacked and
// folded in the middle. The outer sheet carries the first 2 and the last 2 pages, the next one
// the 2 after and the 2 before those, and so on. Returns the sides in printing order (front of
// sheet 1, back of sheet 1, front of sheet 2, …), each as [left, right] page indexes (or
// [top, bottom] for wide pages), with null for an added blank page.
// Printed on both sides flipping on the short edge, the back of each half is the next page.
function planBooklet(count, { binding = "left", backCover = false } = {}) {
  const total = Math.max(4, Math.ceil(count / 4) * 4);
  const blanks = total - count;
  const order = [...Array(count).keys()];
  const pad = Array(blanks).fill(null);
  // A back cover stays the very last page; the blanks go just before it.
  if (backCover && count > 1) order.splice(count - 1, 0, ...pad);
  else order.push(...pad);
  const sides = [];
  for (let i = 0; i < total / 4; i++) {
    const front = [order[total - 1 - 2 * i], order[2 * i]];
    const back = [order[2 * i + 1], order[total - 2 - 2 * i]];
    // Bound on the right (vertical Japanese text), the book opens the other way.
    if (binding === "right") {
      front.reverse();
      back.reverse();
    }
    sides.push(front, back);
  }
  return { sides, total, blanks };
}

// The sheet the pages are printed on, and the two halves of it (in PDF points, origin at the
// lower left). Upright pages go side by side on a sideways sheet; wide pages go one above the
// other on an upright sheet, making a booklet bound at the top. "same" uses paper the size of
// the first page (A4 pages shrink onto A4 paper, an A5 booklet); "double" fits two pages at
// their own size (A4 pages on A3 paper, an A4 booklet).
function sheetLayout(first, paper) {
  const { width: w, height: h } = first;
  const stacked = w > h;
  let sheetW, sheetH;
  if (paper === "double") [sheetW, sheetH] = stacked ? [w, h * 2] : [w * 2, h];
  else [sheetW, sheetH] = [h, w];
  const cells = stacked
    ? [{ x: 0, y: sheetH / 2, w: sheetW, h: sheetH / 2 }, { x: 0, y: 0, w: sheetW, h: sheetH / 2 }]
    : [{ x: 0, y: 0, w: sheetW / 2, h: sheetH }, { x: sheetW / 2, y: 0, w: sheetW / 2, h: sheetH }];
  return { stacked, width: sheetW, height: sheetH, cells };
}

// Where a page of the shown size lands in a cell: as large as fits, in the middle.
function fit(cell, width, height) {
  const k = Math.min(cell.w / width, cell.h / height);
  const w = width * k;
  const h = height * k;
  return { k, x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

// The line on the spine, like on entrance exam booklets: bands printed across the fold of the
// outer sheet's front (the side with the covers), so once folded they wrap round the spine and
// show on the edge of a stack of booklets. A different color or position for each kind of
// booklet lets them be told apart and sorted without opening them; positions, like the steps
// of collating marks, also work on a black-and-white printer.
//   "single": one band in one of 5 places, or the whole length of the spine
//   "pair":   two groups of places, 9 for the subject in the upper part of the spine and 3 for
//             the grade in the lower part, so 27 kinds of booklet each get their own pair
// Returns the bands in PDF points ([{ x, y, w, h }, …]); none when the line is off.
const SPINE_GROUPS = {
  subject: { from: 0.04, to: 0.58, slots: 9, length: 0.75 },
  grade: { from: 0.66, to: 0.96, slots: 3, length: 0.7 },
};

function spineBands(layout, spine) {
  if (!spine?.on) return [];
  const along = layout.stacked ? layout.width : layout.height; // the length of the fold
  // Places are measured from the top of the spine (the left end for a booklet bound at the top).
  const spans = [];
  if (spine.mode === "pair") {
    for (const [group, slot] of [[SPINE_GROUPS.subject, spine.subject], [SPINE_GROUPS.grade, spine.grade]]) {
      const step = ((group.to - group.from) * along) / group.slots;
      const length = step * group.length;
      spans.push([group.from * along + step * slot + (step - length) / 2, length]);
    }
  } else if (spine.pos === "full") {
    spans.push([0, along]);
  } else {
    const length = along / 8;
    spans.push([(along * (Number(spine.pos) + 1)) / 6 - length / 2, length]);
  }
  const width = spine.width;
  return spans.map(([from, length]) => (layout.stacked
    ? { x: from, y: layout.height / 2 - width / 2, w: length, h: width }
    : { x: layout.width / 2 - width / 2, y: layout.height - from - length, w: width, h: length }));
}

const PAPER_NAMES = [["A3", 842, 1191], ["A4", 595, 842], ["A5", 420, 595], ["B4", 729, 1032], ["B5", 516, 729], ["レター", 612, 792]];

function paperName(width, height, { turn = true } = {}) {
  const [short, long] = width < height ? [width, height] : [height, width];
  const match = PAPER_NAMES.find(([, s, l]) => Math.abs(s - short) < 6 && Math.abs(l - long) < 6);
  const name = match ? match[0] : `${Math.round((width * 25.4) / 72)}×${Math.round((height * 25.4) / 72)} mm`;
  return match && turn && width > height ? `${name} 横` : name;
}

/* ---------- opening a PDF ---------- */

async function openFiles(list) {
  const file = [...list].find(isPdf);
  if (!file) {
    showStatus("PDFファイルを選んでください", { error: true });
    return;
  }
  showStatus("PDFを読み込み中…", { sticky: true });
  let bytes, pdf;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    pdf = await openPdf(bytes.slice(), { name: file.name }).promise;
  } catch (err) {
    console.error(err);
    showStatus(err?.name === "PasswordException" ? "パスワードが入力されなかったので開けませんでした" : `PDFを開けませんでした: ${file.name}`, { error: true });
    return;
  }
  const pages = [];
  for (let num = 1; num <= pdf.numPages; num++) {
    const { width, height } = (await pdf.getPage(num)).getViewport({ scale: 1 });
    pages.push({ width, height });
  }
  state.file?.pdf.destroy();
  state.file = { name: file.name || "document.pdf", bytes, pdf };
  state.pages = pages;
  state.order = pages.map((_, i) => i);
  buildThumbs();
  document.title = `${state.file.name} - 冊子印刷`;
  els.fileName.textContent = `${state.file.name}（${pages.length}ページ）`;
  els.welcome.hidden = true;
  update();
  els.viewer.scrollTop = 0;
  hideStatus();
}

/* ---------- preview ---------- */

const previews = createLazyRenderer({
  root: els.viewer,
  render: renderSide,
  release: (side) => (side.canvas.width = side.canvas.height = 0),
});

function rebuildPreview(settings) {
  previews.clear();
  state.generation++;
  els.sheets.replaceChildren();
  state.sides = [];
  if (!state.file) return;
  const layout = sheetLayout(state.pages[state.order[0]], settings.paper);
  const sides = bookletSides(settings);
  const cssW = layout.width > layout.height ? PREVIEW_PX : PREVIEW_PX * 0.7;
  const cssH = (cssW * layout.height) / layout.width;
  sides.forEach((slots, i) => {
    const el = document.createElement("li");
    el.className = "side";
    const canvas = document.createElement("canvas");
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = canvas.height = 0;
    const label = document.createElement("div");
    label.className = "label";
    const sheet = Math.floor(i / 2) + 1;
    const nums = slots.map((p) => (p === null ? "白紙" : `${p + 1}`)).join(layout.stacked ? "／" : "｜");
    label.innerHTML = `<b>${sheet}枚目の${i % 2 ? "裏" : "表"}</b>　`;
    label.append(nums);
    el.append(canvas, label);
    els.sheets.append(el);
    const bands = i === 0 ? spineBands(layout, settings.spine) : [];
    // With two lines, the preview also outlines every place a line can go, as a key.
    const guides = i === 0 && settings.spine.on && settings.spine.mode === "pair"
      ? Array.from({ length: 9 }, (_, n) => spineBands(layout, { ...settings.spine, subject: n, grade: n % 3 })).flat()
      : [];
    const side = { sheet, back: i % 2 === 1, slots, layout, bands, guides, bandColor: settings.spine.color, el, canvas, cssW, rendered: false };
    state.sides.push(side);
    previews.add(side);
  });
}

async function renderSide(side) {
  side.rendered = true;
  const generation = state.generation;
  const { layout, canvas } = side;
  const scale = (side.cssW * (window.devicePixelRatio || 1)) / layout.width;
  const out = document.createElement("canvas");
  out.width = Math.round(layout.width * scale);
  out.height = Math.round(layout.height * scale);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  for (const [slot, index] of side.slots.entries()) {
    const cell = layout.cells[slot];
    if (index === null) {
      // An added blank page: a faint note, so it is clear the space is meant to be empty.
      ctx.fillStyle = "#b8bec8";
      ctx.font = `${Math.round(14 * (window.devicePixelRatio || 1))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("白紙", (cell.x + cell.w / 2) * scale, (layout.height - cell.y - cell.h / 2) * scale);
      continue;
    }
    const size = state.pages[index];
    const at = fit(cell, size.width, size.height);
    try {
      const page = await state.file.pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: at.k * scale });
      const pic = document.createElement("canvas");
      pic.width = Math.ceil(viewport.width);
      pic.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: pic.getContext("2d"), viewport }).promise;
      if (generation !== state.generation || !side.rendered) return;
      ctx.drawImage(pic, at.x * scale, (layout.height - at.y - at.h) * scale, at.w * scale, at.h * scale);
      pic.width = pic.height = 0;
    } catch (err) {
      console.error(err);
    }
  }
  if (generation !== state.generation || !side.rendered) return;
  // The fold.
  ctx.strokeStyle = "#c5cad3";
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  if (layout.stacked) {
    ctx.moveTo(0, out.height / 2);
    ctx.lineTo(out.width, out.height / 2);
  } else {
    ctx.moveTo(out.width / 2, 0);
    ctx.lineTo(out.width / 2, out.height);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "#c5cad3";
  ctx.lineWidth = 1;
  for (const g of side.guides) ctx.strokeRect(g.x * scale + 0.5, (layout.height - g.y - g.h) * scale + 0.5, g.w * scale - 1, g.h * scale - 1);
  ctx.fillStyle = side.bandColor;
  for (const band of side.bands) {
    ctx.fillRect(band.x * scale, (layout.height - band.y - band.h) * scale, band.w * scale, band.h * scale);
  }
  canvas.width = out.width;
  canvas.height = out.height;
  canvas.getContext("2d").drawImage(out, 0, 0);
  out.width = out.height = 0;
}

/* ---------- the page order list ---------- */

const thumbPreviews = createLazyRenderer({
  root: els.viewer,
  render: renderThumb,
  release: (thumb) => (thumb.canvas.width = thumb.canvas.height = 0),
});

function buildThumbs() {
  thumbPreviews.clear();
  els.thumbs.replaceChildren();
  state.thumbs = state.pages.map((size, index) => {
    const el = document.createElement("li");
    el.className = "thumb";
    el.tabIndex = 0;
    el.title = "ドラッグして並べかえ（Alt＋←→ でも動かせます）";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 0;
    canvas.style.width = `${THUMB_PX}px`;
    canvas.style.height = `${(THUMB_PX * size.height) / size.width}px`;
    const num = document.createElement("span");
    num.className = "num";
    el.append(canvas, num);
    const thumb = { index, el, canvas, num, rendered: false };
    el.addEventListener("pointerdown", (e) => pressThumb(e, thumb));
    el.addEventListener("contextmenu", (e) => {
      if (press?.touch || drag) e.preventDefault(); // long press on a touch screen
    });
    el.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      e.preventDefault();
      const at = state.order.indexOf(index) + (e.key === "ArrowLeft" ? -1 : 1);
      if (at < 0 || at >= state.order.length) return;
      const next = state.order.filter((i) => i !== index);
      next.splice(at, 0, index);
      setOrder(next);
      el.focus();
    });
    thumbPreviews.add(thumb);
    return thumb;
  });
  showOrder();
}

async function renderThumb(thumb) {
  thumb.rendered = true;
  const file = state.file;
  const page = await file.pdf.getPage(thumb.index + 1);
  const viewport = page.getViewport({ scale: (THUMB_PX * (window.devicePixelRatio || 1)) / state.pages[thumb.index].width });
  const pic = document.createElement("canvas");
  pic.width = Math.ceil(viewport.width);
  pic.height = Math.ceil(viewport.height);
  try {
    await page.render({ canvasContext: pic.getContext("2d"), viewport }).promise;
  } catch (err) {
    console.error(err);
  }
  if (state.file !== file || !thumb.rendered) return;
  thumb.canvas.width = pic.width;
  thumb.canvas.height = pic.height;
  const ctx = thumb.canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, pic.width, pic.height);
  ctx.drawImage(pic, 0, 0);
  pic.width = pic.height = 0;
}

// Puts the pictures in the current order. Each shows its place in the booklet, and the
// original page number when that differs.
function showOrder() {
  els.order.hidden = !state.file;
  state.order.forEach((index, at) => {
    const thumb = state.thumbs[index];
    els.thumbs.append(thumb.el);
    thumb.num.textContent = index === at ? `${at + 1}` : `${at + 1}（元の${index + 1}）`;
  });
  els.orderReset.disabled = state.order.every((index, at) => index === at);
}

function setOrder(next) {
  if (next.every((index, at) => index === state.order[at])) return;
  state.order = next;
  showOrder();
  update();
}

/* ---------- dragging pages (mouse, touch and pen) ---------- */

let press = null; // { thumb, pointerId, x, y, touch, timer } while a button/finger is down on a page
let drag = null; // { thumb, ghost, target, after, x, y, raf } once the press has become a drag

function pressThumb(e, thumb) {
  if (!e.isPrimary || e.button !== 0 || state.busy) return;
  const touch = e.pointerType !== "mouse";
  press = { thumb, pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch, timer: 0 };
  // On a touch screen a quick swipe scrolls; holding still first picks the page up.
  if (touch) press.timer = setTimeout(() => startDrag(press.x, press.y), LONG_PRESS_MS);
}

function endPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

window.addEventListener("pointermove", (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  if (!drag) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_SLOP) return;
    if (press.touch) return endPress(); // moved before the long press: it's a scroll
    startDrag(e.clientX, e.clientY);
  }
  moveDrag(e.clientX, e.clientY);
});
window.addEventListener("pointerup", (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  if (drag) finishDrag();
  endPress();
});
window.addEventListener("pointercancel", (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  cancelDrag();
  endPress();
});
window.addEventListener("keydown", (e) => {
  if (drag && e.key === "Escape") {
    cancelDrag();
    endPress();
  }
});
// Keep the viewer from scrolling under a finger that is dragging a page.
els.viewer.addEventListener("touchmove", (e) => {
  if (drag) e.preventDefault();
}, { passive: false });

function startDrag(x, y) {
  clearTimeout(press.timer);
  const { thumb } = press;
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  if (thumb.canvas.width) {
    const copy = document.createElement("canvas");
    copy.width = thumb.canvas.width;
    copy.height = thumb.canvas.height;
    copy.style.width = thumb.canvas.style.width;
    copy.style.height = thumb.canvas.style.height;
    copy.getContext("2d").drawImage(thumb.canvas, 0, 0);
    ghost.append(copy);
  }
  document.body.append(ghost);
  thumb.el.classList.add("dragging");
  document.body.classList.add("is-dragging");
  drag = { thumb, ghost, target: null, after: false, x, y, raf: 0 };
  if (press.touch) navigator.vibrate?.(15);
  moveDrag(x, y);
  drag.raf = requestAnimationFrame(autoScroll);
}

function moveDrag(x, y) {
  drag.x = x;
  drag.y = y;
  drag.ghost.style.transform = `translate(${x}px, ${y}px)`;
  const hit = dropTarget(x, y);
  clearDropMarks();
  drag.target = hit?.thumb ?? null;
  drag.after = hit?.after ?? false;
  if (hit) hit.thumb.el.classList.add(hit.after ? "drop-after" : "drop-before");
}

// The page nearest the pointer, preferring the row it is on, and which side of it to drop on.
function dropTarget(x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const thumb of state.thumbs) {
    const r = thumb.el.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dist = dy * 4 + dx;
    if (dist < bestDist) {
      bestDist = dist;
      best = { thumb, after: x > r.left + r.width / 2 };
    }
  }
  return best;
}

function clearDropMarks() {
  for (const el of els.thumbs.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
}

function autoScroll() {
  if (!drag) return;
  const r = els.viewer.getBoundingClientRect();
  let dy = 0;
  if (drag.y < r.top + SCROLL_EDGE) dy = -(r.top + SCROLL_EDGE - drag.y);
  else if (drag.y > r.bottom - SCROLL_EDGE) dy = drag.y - (r.bottom - SCROLL_EDGE);
  if (dy) {
    els.viewer.scrollTop += Math.max(-20, Math.min(20, dy / 3));
    moveDrag(drag.x, drag.y);
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function cancelDrag() {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  drag.ghost.remove();
  drag.thumb.el.classList.remove("dragging");
  document.body.classList.remove("is-dragging");
  clearDropMarks();
  drag = null;
}

function finishDrag() {
  const { thumb, target, after } = drag;
  cancelDrag();
  if (target) movePage(thumb.index, target.index, after);
}

// Moves a page to just before or after another one.
function movePage(index, target, after) {
  if (index === target) return;
  const next = state.order.filter((i) => i !== index);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, index);
  setOrder(next);
}

/* ---------- controls ---------- */

function syncControls(settings = readSettings()) {
  const ready = !!state.file && !state.busy;
  els.saveBtn.disabled = !ready;
  els.printBtn.disabled = !ready;
  const first = state.pages[state.order[0]] ?? A4;
  const layout = sheetLayout(first, settings.paper);
  for (const el of bindingInputs) el.disabled = layout.stacked;
  els.spineOpts.classList.toggle("off", !settings.spine.on);
  const pair = settings.spine.mode === "pair";
  els.spinePosRow.hidden = pair;
  for (const el of els.spinePairRows) el.hidden = !pair;
  els.bindingHelp.hidden = !layout.stacked;
  const half = layout.cells[0];
  const sheet = paperName(layout.width, layout.height);
  const book = paperName(half.w, half.h, { turn: false });
  const pages = state.file ? `${paperName(first.width, first.height, { turn: false })}のページ` : "A4のPDFなら、ページ";
  els.paperHelp.textContent = settings.paper === "double"
    ? `${pages}を元の大きさのまま、${sheet}の紙に2ページずつ入れます（${book}の冊子になります）。`
    : `${pages}を縮小して、${sheet}の紙に2ページずつ入れます（${book}の冊子になります）。`;
  els.summary.hidden = !state.file;
  if (!state.file) return;
  const { total, blanks } = planBooklet(state.order.length, settings);
  els.summaryText.textContent = `${state.pages.length}ページ → ${sheet}の紙${total / 4}枚（両面）。`
    + (blanks ? `ページ数を4の倍数にするため、白紙を${blanks}ページ足しました。` : "");
}

function update() {
  const settings = readSettings();
  saveJson(SETTINGS_KEY, settings);
  syncControls(settings);
  rebuildPreview(settings);
}

/* ---------- saving ---------- */

async function buildPdf(settings) {
  const { PDFDocument, degrees, rgb } = await loadPdfLib();
  let src = await PDFDocument.load(state.file.bytes, { ignoreEncryption: true });
  const rebuilt = src.isEncrypted;
  if (rebuilt) {
    const onPage = (num, count) => showStatus(`保護されたPDFのため、ページを画像にしています… (${num}/${count})`, { sticky: true });
    src = await rasterizePdf(state.file.pdf, { onPage });
    showStatus("PDFを作成中…", { sticky: true });
  }
  const out = await PDFDocument.create();
  const pages = src.getPages();
  // A page with nothing on it (no content stream, like a blank page) cannot be embedded; its
  // half of the sheet is left empty.
  const embedded = [];
  for (const page of pages) embedded.push(page.node.Contents() ? await out.embedPage(page) : null);
  const shown = pages.map((page) => {
    const angle = ((page.getRotation().angle % 360) + 360) % 360;
    const { width, height } = page.getSize();
    return { angle, width: angle % 180 ? height : width, height: angle % 180 ? width : height };
  });
  const layout = sheetLayout(shown[state.order[0]], settings.paper);
  const bands = spineBands(layout, settings.spine);
  for (const [i, slots] of bookletSides(settings).entries()) {
    const sheet = out.addPage([layout.width, layout.height]);
    slots.forEach((index, slot) => {
      if (index === null || !embedded[index]) return;
      const { angle, width, height } = shown[index];
      const { k, x, y, w, h } = fit(layout.cells[slot], width, height);
      // A page turned by /Rotate (clockwise) is drawn turned the same way. pdf-lib turns the
      // drawing counterclockwise around its lower left corner, so that corner moves.
      const at = { 0: [x, y], 90: [x, y + h], 180: [x + w, y + h], 270: [x + w, y] }[angle];
      sheet.drawPage(embedded[index], { x: at[0], y: at[1], xScale: k, yScale: k, rotate: degrees(-angle) });
    });
    // Drawn over the pages, so it shows even where a cover is printed right up to the fold.
    if (i === 0) {
      for (const band of bands) sheet.drawRectangle({ x: band.x, y: band.y, width: band.w, height: band.h, color: hexToRgb(settings.spine.color, rgb) });
    }
  }
  return { bytes: await out.save(), rebuilt };
}

function hexToRgb(hex, rgb) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// Builds the booklet PDF; returns { blob, name, rebuilt }, or null when it failed (and said so).
async function makeBooklet() {
  if (!state.file || state.busy) return null;
  state.busy = true;
  syncControls();
  showStatus("PDFを作成中…", { sticky: true });
  try {
    const { bytes, rebuilt } = await buildPdf(readSettings());
    return { blob: new Blob([bytes], { type: "application/pdf" }), name: `${baseName(state.file.name)}_冊子.pdf`, rebuilt };
  } catch (err) {
    console.error(err);
    showStatus("PDFを作れませんでした", { error: true });
    return null;
  } finally {
    state.busy = false;
    syncControls();
  }
}

async function save() {
  const result = await makeBooklet();
  if (!result) return;
  download(result.blob, result.name);
  showStatus(result.rebuilt
    ? "保存しました（保護されたPDFは、元のページを画像として保存しています）"
    : "保存しました（ダウンロードフォルダを確認してください）");
}

// Opens the booklet in a new tab, where Chrome's PDF viewer can print it.
async function openForPrint() {
  if (!state.file || state.busy) return;
  // The tab is opened right away, while the click still counts, so it is not blocked as a pop-up.
  const tab = window.open("", "_blank");
  const result = await makeBooklet();
  if (!result) {
    tab?.close();
    return;
  }
  if (!tab) {
    download(result.blob, result.name);
    showStatus("新しいタブを開けなかったので、保存しました。保存したPDFを開いて印刷してください");
    return;
  }
  const url = URL.createObjectURL(result.blob);
  tab.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  showStatus("新しいタブで開きました。両面印刷・短辺とじで印刷してください", { ms: 6000 });
}

/* ---------- events ---------- */

els.fileInput.addEventListener("change", () => {
  openFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.saveBtn.addEventListener("click", save);
els.printBtn.addEventListener("click", openForPrint);
els.orderReset.addEventListener("click", () => setOrder(state.pages.map((_, i) => i)));
addNextTool({ saveBtn: els.saveBtn, save, kind: "pdf" });
for (const el of [...bindingInputs, els.paper, els.backCover, els.spineOn, els.spineMode, els.spinePos, els.spineSubject, els.spineGrade, els.spineColor, els.spineWidth]) el.addEventListener("change", update);
// Touching a setting of the spine line switches it on.
els.spineOpts.addEventListener("change", () => (els.spineOn.checked = true), true);

// Drag & drop a PDF anywhere on the page.
onFileDrop(openFiles);

restoreSettings();
syncControls();

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

// Hook for automated tests.
window.__pdfBooklet = { state, planBooklet, spineBands, movePage, buildPdf, save };
