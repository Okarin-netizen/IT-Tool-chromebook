// The scrolling, zoomable column of PDF pages in PDF文字入れ, PDFに手書き・署名 and PDF一括採点.
// Pages are drawn by pdf.js when they come near the screen and freed when they are far away.
//
// The tool keeps state.scale and gives page views { num, viewport (scale 1), el, canvas, rendered, task }.
//   viewer, zoomLabel  the scrolling element and the "100%" label
//   views()            every page view, in order
//   pdfOf(view)        the pdf.js document the view's page belongs to
//   onRender(view)     optional: just before the page is drawn (sign and grade size their ink here)
//   onRendered(view, page)  optional: after the page is drawn (PDF文字入れ adds form fields here)
//   annotationMode()   optional: pdf.js AnnotationMode for drawing (forms are left out of the
//                      picture when they are shown as real input boxes instead)
//   onRelease(view)    optional: when the page's pictures are freed
//   onScale(view)      optional: for each page after the zoom changed
import { pixelRatio } from "./canvas.js";
import { createLazyRenderer } from "./lazy.js";

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

export const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// iPad Safari draws nothing on a canvas bigger than about 16.7 million pixels, which a page at
// 400% on a sharp screen goes past. Pages that big are drawn a little less sharp instead.
const MAX_CANVAS_PIXELS = 16_000_000;

// Canvas pixels per page point for `view` at zoom `scale` (the screen's sharpness, within the limit).
export function pixelScale(view, scale) {
  const wanted = scale * pixelRatio();
  const limit = Math.sqrt(MAX_CANVAS_PIXELS / (view.viewport.width * view.viewport.height));
  return Math.min(wanted, limit);
}

export function createPageViewer({ state, viewer, zoomLabel, views, pdfOf, onRender, onRendered, onRelease, onScale, annotationMode }) {
  async function render(view) {
    view.rendered = true;
    view.task?.cancel();
    onRender?.(view);
    const page = await pdfOf(view).getPage(view.num);
    const viewport = page.getViewport({ scale: pixelScale(view, state.scale) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const params = { canvasContext: canvas.getContext("2d"), viewport };
    if (annotationMode) params.annotationMode = annotationMode();
    const task = page.render(params);
    view.task = task;
    try {
      await task.promise;
      if (view.rendered) {
        view.canvas.replaceWith(canvas);
        view.canvas = canvas;
        await onRendered?.(view, page);
      }
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.error(err);
    } finally {
      if (view.task === task) view.task = null;
      page.cleanup();
    }
  }

  function release(view) {
    view.task?.cancel();
    view.canvas.width = view.canvas.height = 0;
    onRelease?.(view);
  }

  const lazy = createLazyRenderer({ root: viewer, renderMargin: "600px 0px", releaseMargin: "2500px 0px", render, release });

  function size(view) {
    view.el.style.width = `${view.viewport.width * state.scale}px`;
    view.el.style.height = `${view.viewport.height * state.scale}px`;
  }

  // The zoom at which the widest page fills the viewer (at most 150%).
  function fitWidthScale() {
    let maxWidth = 1;
    for (const view of views()) maxWidth = Math.max(maxWidth, view.viewport.width);
    const available = viewer.clientWidth - 90; // viewer + page list side padding
    return clampScale(Math.min(1.5, available / maxWidth));
  }

  // Zooms, keeping the middle of the screen where it was, or the spot at (clientX, clientY)
  // (where two fingers spread or pinched).
  function setScale(scale, { clientX, clientY } = {}) {
    const box = viewer.getBoundingClientRect();
    const x = clientX === undefined ? viewer.clientWidth / 2 : clientX - box.left;
    const y = clientY === undefined ? viewer.clientHeight / 2 : clientY - box.top;
    const ratio = scale / state.scale;
    const contentX = (viewer.scrollLeft + x) * ratio;
    const contentY = (viewer.scrollTop + y) * ratio;
    state.scale = scale;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    for (const view of views()) {
      size(view);
      onScale?.(view);
    }
    viewer.scrollTop = contentY - y;
    if (clientX !== undefined) viewer.scrollLeft = contentX - x;
    lazy.redrawAll(views());
  }

  // For two fingers (shared/js/pen.js scrollWithFinger): stretch within the zoom limits, then
  // draw the pages again at the new zoom where the fingers were.
  const pinchZoom = {
    limit: (factor) => clampScale(state.scale * factor) / state.scale,
    done: (factor, clientX, clientY) => setScale(clampScale(state.scale * factor), { clientX, clientY }),
  };

  return {
    add(view) {
      size(view);
      lazy.add(view);
    },
    remove(view) {
      lazy.remove(view);
      view.task?.cancel();
    },
    clear() {
      lazy.clear();
      for (const view of views()) view.task?.cancel();
    },
    fitWidthScale,
    setScale,
    pinchZoom,
    zoom: (factor) => setScale(clampScale(state.scale * factor)),
  };
}
