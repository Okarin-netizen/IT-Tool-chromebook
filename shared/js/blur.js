/* Blurring a picture on a canvas, on every browser.
 *
 * Chrome blurs with ctx.filter = "blur(...)", but Safari (and so every browser on an iPad or
 * iPhone) ignores ctx.filter and draws the picture sharp. Hiding faces with a blur that does
 * nothing is dangerous, so when the filter does not work the blur is done here by hand:
 * the picture is shrunk until the blur is only a few pixels wide, blurred with three box blurs
 * (which together look like the filter's Gaussian blur), and stretched back smoothly.
 *
 * A plain script, not an ES module, so かおトリ and かおかくし can load it with a <script> tag:
 *   <script src="../shared/js/blur.js"></script>
 * ES modules get it from canvas.js (drawBlurred). Both use globalThis.SiteBlur. */
(() => {
  "use strict";

  /* The largest blur worked out by hand, in pixels of the shrunk copy. Smaller is faster. */
  const WORK_RADIUS = 3;

  let filterWorks = null;

  /* Whether ctx.filter really blurs: a single white pixel has to spread to its neighbours. */
  function canvasFilterWorks() {
    if (SiteBlur.forceFallback) return false;
    if (filterWorks !== null) return filterWorks;
    filterWorks = false;
    try {
      const c = document.createElement("canvas");
      c.width = 9;
      c.height = 1;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      const dot = document.createElement("canvas");
      dot.width = 9;
      dot.height = 1;
      const dctx = dot.getContext("2d");
      dctx.fillStyle = "#fff";
      dctx.fillRect(4, 0, 1, 1);
      ctx.filter = "blur(2px)";
      if (ctx.filter !== "blur(2px)") return false;
      ctx.drawImage(dot, 0, 0);
      filterWorks = ctx.getImageData(2, 0, 1, 1).data[3] > 0;
    } catch {
      filterWorks = false;
    }
    return filterWorks;
  }

  /* Draws `source` (a canvas, image or bitmap) blurred by `radius` pixels of the destination.
   * from = {x, y, w, h}: the part of the source (all of it when left out).
   * to = {x, y, w, h}: where it goes on ctx (the same place and size when left out).
   * The source may be ctx's own canvas. The blur, the clip and the composite mode set on ctx
   * are used as they are; ctx.filter is left as "none". */
  function drawBlurred(ctx, source, radius, from, to) {
    const sw0 = source.width;
    const sh0 = source.height;
    const s = from || { x: 0, y: 0, w: sw0, h: sh0 };
    const d = to || s;
    if (s.w < 1 || s.h < 1 || d.w < 1 || d.h < 1) return;
    if (!(radius > 0)) {
      ctx.drawImage(source, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
      return;
    }
    if (canvasFilterWorks()) {
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(source, s.x, s.y, s.w, s.h, d.x, d.y, d.w, d.h);
      ctx.filter = "none";
      return;
    }
    ctx.filter = "none";
    // The blur measured in pixels of the source, and how far to shrink so it is WORK_RADIUS.
    const rs = radius * (s.w / d.w);
    const f = Math.min(1, WORK_RADIUS / rs, d.w / s.w, d.h / s.h);
    const tw = Math.max(1, Math.round(s.w * f));
    const th = Math.max(1, Math.round(s.h * f));
    const work = document.createElement("canvas");
    work.width = tw;
    work.height = th;
    const wctx = work.getContext("2d", { willReadFrequently: true });
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = "high";
    wctx.drawImage(source, s.x, s.y, s.w, s.h, 0, 0, tw, th);
    const image = wctx.getImageData(0, 0, tw, th);
    gaussianish(image.data, tw, th, rs * (tw / s.w));
    wctx.putImageData(image, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(work, 0, 0, tw, th, d.x, d.y, d.w, d.h);
    ctx.restore();
  }

  /* Three box blurs in a row, sized so together they match a Gaussian blur of `sigma`
   * (the same thing CSS blur() does). RGBA, edges repeated. */
  function gaussianish(px, w, h, sigma) {
    if (!(sigma > 0.2)) return;
    const n = 3;
    const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
    let lo = Math.floor(ideal);
    if (lo % 2 === 0) lo--;
    const hi = lo + 2;
    const m = Math.round((12 * sigma * sigma - n * lo * lo - 4 * n * lo - 3 * n) / (-4 * lo - 4));
    const tmp = new Uint8ClampedArray(px.length);
    for (let i = 0; i < n; i++) {
      const r = ((i < m ? lo : hi) - 1) / 2;
      if (r < 1) continue;
      boxPass(px, tmp, w, h, r, true);
      boxPass(tmp, px, w, h, r, false);
    }
  }

  /* One box blur of radius r along the rows (or the columns), from src into dst. */
  function boxPass(src, dst, w, h, r, rows) {
    const len = rows ? w : h;
    const lines = rows ? h : w;
    const step = rows ? 4 : w * 4;
    const scale = 1 / (r * 2 + 1);
    const last = len - 1;
    for (let line = 0; line < lines; line++) {
      const base = rows ? line * w * 4 : line * 4;
      for (let c = 0; c < 4; c++) {
        const at = (i) => src[base + Math.min(last, Math.max(0, i)) * step + c];
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += at(i);
        for (let i = 0; i < len; i++) {
          dst[base + i * step + c] = sum * scale;
          sum += at(i + r + 1) - at(i - r);
        }
      }
    }
  }

  const SiteBlur = { drawBlurred, canvasFilterWorks, forceFallback: false };
  globalThis.SiteBlur = SiteBlur;
})();
