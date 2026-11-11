// The 見くらべ view: the original and the compressed picture on top of each other, with a line to
// drag left and right. Left of the line is the original, right of it the compressed one. Like
// Squoosh's comparison slider, written for this tool. Zoom shows the pixels up close.

const ZOOMS = [0, 1, 2, 4]; // 0 = the whole picture fits; otherwise CSS pixels per original pixel
const KEY_STEP = 0.05; // how far the arrow keys move the line (part of the width)
const PIXELATED_FROM = 2; // from this zoom on, pixels are shown as squares instead of blurred

// els: { wrap, scroll, stage, before, after, divider, beforeTag, afterTag, zoomOut, zoomIn, zoomLabel }
export function createCompare(els) {
  const view = { split: 0.5, zoom: 0, width: 0, height: 0 };

  // picture: { draw(canvas) — draws the original at width×height, width, height } or null.
  function showOriginal(picture) {
    if (!picture) {
      els.before.width = els.before.height = 0;
      return;
    }
    view.width = picture.width;
    view.height = picture.height;
    els.before.width = picture.width;
    els.before.height = picture.height;
    picture.draw(els.before);
    layout();
  }

  // blob: the compressed file, or null while it is being made.
  function showCompressed(blob) {
    if (els.after.src) URL.revokeObjectURL(els.after.src);
    els.after.removeAttribute("src");
    if (blob) els.after.src = URL.createObjectURL(blob);
    els.after.hidden = !blob;
  }

  function setTags(beforeText, afterText) {
    els.beforeTag.textContent = beforeText;
    els.afterTag.textContent = afterText;
  }

  /* ---------- size and zoom ---------- */

  function scale() {
    if (ZOOMS[view.zoom]) return ZOOMS[view.zoom];
    const room = els.scroll.getBoundingClientRect();
    return Math.min(1, room.width / view.width, room.height / view.height);
  }

  function layout() {
    if (!view.width) return;
    const k = scale();
    els.stage.style.width = `${Math.round(view.width * k)}px`;
    els.stage.style.height = `${Math.round(view.height * k)}px`;
    els.stage.classList.toggle("pixelated", k >= PIXELATED_FROM);
    els.zoomLabel.textContent = ZOOMS[view.zoom] ? `${ZOOMS[view.zoom] * 100}%` : "全体";
    els.zoomOut.disabled = view.zoom === 0;
    els.zoomIn.disabled = view.zoom === ZOOMS.length - 1;
    placeLine();
  }

  // Zooms keeping the middle of what is shown in the middle.
  function zoomBy(step) {
    const next = Math.max(0, Math.min(ZOOMS.length - 1, view.zoom + step));
    if (next === view.zoom) return;
    const { scroll } = els;
    const middleX = (scroll.scrollLeft + scroll.clientWidth / 2) / scroll.scrollWidth;
    const middleY = (scroll.scrollTop + scroll.clientHeight / 2) / scroll.scrollHeight;
    view.zoom = next;
    layout();
    scroll.scrollLeft = middleX * scroll.scrollWidth - scroll.clientWidth / 2;
    scroll.scrollTop = middleY * scroll.scrollHeight - scroll.clientHeight / 2;
    placeLine();
  }

  /* ---------- the line ---------- */

  // The line stays where it is on the screen while the picture scrolls under it, so the clip of
  // the compressed picture is worked out from where the picture is now.
  function placeLine() {
    const box = els.wrap.getBoundingClientRect();
    const stage = els.stage.getBoundingClientRect();
    const lineX = box.left + view.split * box.width;
    const clipLeft = Math.max(0, Math.min(stage.width, lineX - stage.left));
    els.after.style.clipPath = `inset(0 0 0 ${clipLeft}px)`;
    els.divider.style.left = `${view.split * 100}%`;
    els.divider.setAttribute("aria-valuenow", String(Math.round(view.split * 100)));
  }

  function moveLine(split) {
    view.split = Math.max(0, Math.min(1, split));
    placeLine();
  }

  function dragLine(e) {
    e.preventDefault();
    els.divider.setPointerCapture(e.pointerId);
    const follow = (move) => {
      const box = els.wrap.getBoundingClientRect();
      moveLine((move.clientX - box.left) / box.width);
    };
    const stop = () => {
      els.divider.removeEventListener("pointermove", follow);
      els.divider.removeEventListener("pointerup", stop);
      els.divider.removeEventListener("pointercancel", stop);
    };
    els.divider.addEventListener("pointermove", follow);
    els.divider.addEventListener("pointerup", stop);
    els.divider.addEventListener("pointercancel", stop);
  }

  const LINE_KEYS = { ArrowLeft: -KEY_STEP, ArrowRight: KEY_STEP, Home: -1, End: 1 };

  function lineKey(e) {
    if (!(e.key in LINE_KEYS)) return;
    e.preventDefault();
    moveLine(view.split + LINE_KEYS[e.key]);
  }

  // A mouse or pen moves a zoomed picture by dragging it (fingers scroll it as usual).
  function dragPicture(e) {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const { scroll } = els;
    const start = { x: e.clientX, y: e.clientY, left: scroll.scrollLeft, top: scroll.scrollTop };
    scroll.setPointerCapture(e.pointerId);
    const follow = (move) => {
      scroll.scrollLeft = start.left - (move.clientX - start.x);
      scroll.scrollTop = start.top - (move.clientY - start.y);
    };
    const stop = () => scroll.removeEventListener("pointermove", follow);
    scroll.addEventListener("pointermove", follow);
    scroll.addEventListener("pointerup", stop, { once: true });
    scroll.addEventListener("pointercancel", stop, { once: true });
  }

  els.divider.addEventListener("pointerdown", dragLine);
  els.divider.addEventListener("keydown", lineKey);
  els.scroll.addEventListener("pointerdown", dragPicture);
  els.scroll.addEventListener("scroll", placeLine);
  els.zoomOut.addEventListener("click", () => zoomBy(-1));
  els.zoomIn.addEventListener("click", () => zoomBy(1));
  new ResizeObserver(layout).observe(els.wrap);

  return { showOriginal, showCompressed, setTags, view, moveLine };
}
