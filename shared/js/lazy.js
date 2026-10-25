// Draws page pictures only when they come near the screen, and frees them again once they are
// far away, so a long PDF does not fill up the Chromebook's memory.
//
//   render(view)   draw the view; it must set view.rendered = true
//   release(view)  free its pictures (view.rendered is already false); keep the outer size
//   show(view)     optional: an already drawn view came near the screen again
//
// Views are objects with an `el` (the element that scrolls into view).
export function createLazyRenderer({ root, renderMargin = "600px 0px", releaseMargin = "2500px 0px", render, release, show }) {
  const views = new WeakMap();
  const nearby = new WeakSet();

  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const view = views.get(entry.target);
      if (!view) continue;
      if (!entry.isIntersecting) {
        nearby.delete(view);
        continue;
      }
      nearby.add(view);
      if (!view.rendered) render(view);
      else show?.(view);
    }
  }, { root, rootMargin: renderMargin });

  const far = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const view = views.get(entry.target);
      if (!view?.rendered) continue;
      view.rendered = false;
      release(view);
    }
  }, { root, rootMargin: releaseMargin });

  return {
    add(view) {
      views.set(view.el, view);
      near.observe(view.el);
      far.observe(view.el);
    },
    remove(view) {
      near.unobserve(view.el);
      far.unobserve(view.el);
      views.delete(view.el);
    },
    clear() {
      near.disconnect();
      far.disconnect();
    },
    // Whether the view is within renderMargin of the screen.
    isNear: (view) => nearby.has(view),
    // Draws again whatever is near the screen now (after zooming, or a change to every page).
    // Views further away are freed now and drawn when they come near.
    redrawAll(list) {
      for (const view of list) {
        if (view.rendered) {
          view.rendered = false;
          if (!nearby.has(view)) release(view);
        }
        near.unobserve(view.el);
        near.observe(view.el);
      }
    },
  };
}

// Frees a canvas's pixels but keeps the space it takes on the page.
export function freeCanvas(canvas) {
  if (!canvas.width) return;
  if (canvas.offsetWidth) {
    canvas.style.width = `${canvas.offsetWidth}px`;
    canvas.style.height = `${canvas.offsetHeight}px`;
  }
  canvas.width = canvas.height = 0;
}
