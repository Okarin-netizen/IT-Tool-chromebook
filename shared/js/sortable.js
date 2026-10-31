// Reordering a list of cards by dragging them, with a mouse, a pen or a finger.
// A mouse or pen drag starts once the pointer moves a little; on a touch screen a quick
// swipe scrolls the list, and holding still for a moment first picks the card up.
// While dragging, a small picture follows the pointer, the card it would land next to is
// marked with the class "drop-before" or "drop-after", and the list scrolls near its edges.
// Escape puts the card back.
//
// Each item is an object with an `el` (the card). Options:
//   scroller      the element that scrolls the list
//   items()       the items in their current order
//   canStart(e, item)   false to ignore a press (on a button in the card, while saving …)
//   carry(item)   the items that move together when `item` is dragged (default: just it)
//   ghost(item, moving) the contents of the picture that follows the pointer
//   onDrop(moving, target, after)  put `moving` just before (or after) `target`

const LONG_PRESS_MS = 350; // touch: hold this long before a card starts to drag
const DRAG_SLOP = 8; // px the pointer may wander before a press counts as a drag (or a scroll)
const SCROLL_EDGE = 60; // px from the top/bottom of the scroller where dragging scrolls it
const SCROLL_STEP = 20; // most px scrolled per frame

export function createSortable({ scroller, items, canStart = () => true, carry = (item) => [item], ghost, onDrop }) {
  let press = null; // { item, pointerId, x, y, touch, timer } while a button/finger is down on a card
  let drag = null; // { moving, ghost, target, after, x, y, raf } once the press has become a drag
  let dragged = false; // the click that ends a drag must not count as a click on the card

  function attach(el, item) {
    el.addEventListener("pointerdown", (e) => {
      dragged = false;
      if (!e.isPrimary || e.button !== 0 || !canStart(e, item)) return;
      const touch = e.pointerType !== "mouse";
      press = { item, pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch, timer: 0 };
      if (touch) press.timer = setTimeout(() => startDrag(press.x, press.y), LONG_PRESS_MS);
    });
    el.addEventListener("contextmenu", (e) => {
      if (press?.touch || drag) e.preventDefault(); // the long press on a touch screen
    });
  }

  function endPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }

  window.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_SLOP) return;
      if (press.touch) return endPress(); // moved before the long press: it is a scroll
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
    cancel();
  });
  // Registered before the tool's own keys, so Escape only puts the card back.
  window.addEventListener("keydown", (e) => {
    if (!drag || e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  });
  // Keep the list from scrolling under a finger that is dragging a card.
  scroller.addEventListener("touchmove", (e) => {
    if (drag) e.preventDefault();
  }, { passive: false });

  function startDrag(x, y) {
    clearTimeout(press.timer);
    const { item } = press;
    const moving = carry(item);
    const box = document.createElement("div");
    box.className = "drag-ghost";
    box.append(...ghost(item, moving));
    document.body.append(box);
    for (const it of moving) it.el.classList.add("dragging");
    document.body.classList.add("is-dragging");
    drag = { moving, ghost: box, target: null, after: false, x, y, raf: 0 };
    dragged = true;
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
    drag.target = hit?.item ?? null;
    drag.after = hit?.after ?? false;
    if (hit) hit.item.el.classList.add(hit.after ? "drop-after" : "drop-before");
  }

  // The card nearest the pointer, preferring the row it is on, and which side of it to drop on.
  function dropTarget(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const item of items()) {
      const r = item.el.getBoundingClientRect();
      const dx = distanceOutside(x, r.left, r.right);
      const dy = distanceOutside(y, r.top, r.bottom);
      const dist = dy * 4 + dx;
      if (dist < bestDist) {
        bestDist = dist;
        best = { item, after: x > r.left + r.width / 2 };
      }
    }
    return best;
  }

  // How far `v` lies outside the range from `low` to `high` (0 inside it).
  function distanceOutside(v, low, high) {
    if (v < low) return low - v;
    if (v > high) return v - high;
    return 0;
  }

  function clearDropMarks() {
    for (const el of document.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
  }

  function autoScroll() {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    let dy = 0;
    if (drag.y < r.top + SCROLL_EDGE) dy = -(r.top + SCROLL_EDGE - drag.y);
    else if (drag.y > r.bottom - SCROLL_EDGE) dy = drag.y - (r.bottom - SCROLL_EDGE);
    if (dy) {
      scroller.scrollTop += Math.max(-SCROLL_STEP, Math.min(SCROLL_STEP, dy / 3));
      moveDrag(drag.x, drag.y);
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function stopDrag() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    drag.ghost.remove();
    for (const it of drag.moving) it.el.classList.remove("dragging");
    document.body.classList.remove("is-dragging");
    clearDropMarks();
    drag = null;
  }

  function finishDrag() {
    const { moving, target, after } = drag;
    stopDrag();
    if (target) onDrop(moving, target, after);
  }

  function cancel() {
    stopDrag();
    endPress();
  }

  return {
    attach,
    cancel,
    get dragging() {
      return !!drag;
    },
    // True after a press that became a drag, until the next press.
    get dragged() {
      return dragged;
    },
  };
}
