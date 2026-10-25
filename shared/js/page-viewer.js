// The scrolling, zoomable column of PDF pages in PDF文字入れ, PDFに手書き・署名 and PDF一括採点.
// Pages are drawn by pdf.js when they come near the screen and freed when they are far away.
//
// The tool keeps state.scale and gives page views { num, viewport (scale 1), el, canvas, rendered, task }.
//   viewer, zoomLabel  the scrolling element and the "100%" label
//   views()            every page view, in order
//   pdfOf(view)        the pdf.js document the view's page belongs to
//   onRender(view)     optional: just before the page is drawn (sign and grade size their ink here)
//   onRelease(view)    optional: when the page's pictures are freed
//   onScale(view)      optional: for each page after the zoom changed
import { createLazyRenderer } from "./lazy.js";

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;

export const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function createPageViewer({ state, viewer, zoomLabel, views, pdfOf, onRender, onRelease, onScale }) {
  async function render(view) {
    view.rendered = true;
    view.task?.cancel();
    onRender?.(view);
    const page = await pdfOf(view).getPage(view.num);
    const dpr = window.devicePixelRatio || 1;
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

  // Zooms, keeping the middle of the screen where it was.
  function setScale(scale) {
    const ratio = scale / state.scale;
    const centerY = (viewer.scrollTop + viewer.clientHeight / 2) * ratio;
    state.scale = scale;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    for (const view of views()) {
      size(view);
      onScale?.(view);
    }
    viewer.scrollTop = centerY - viewer.clientHeight / 2;
    lazy.redrawAll(views());
  }

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
    zoom: (factor) => setScale(clampScale(state.scale * factor)),
  };
}
