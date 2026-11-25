// Small canvas helpers.

// blur.js is a plain script (かおトリ and かおかくし load it with a <script> tag); importing it
// here runs it once and puts globalThis.SiteBlur in place.
import "./blur.js";

// How many device pixels make one CSS pixel (2 on most Chromebook screens).
export const pixelRatio = () => window.devicePixelRatio || 1;

// canvas.toBlob as a promise. `quality` is used for JPEG and WebP.
export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), type, quality);
  });
}

// Turns what is drawn on a 2D context (of a canvas or an OffscreenCanvas) into shades of gray,
// weighting red, green and blue as the eye does (ITU-R BT.601). `contrast` above 1 spreads the
// grays apart like CSS contrast(). Done by hand because Safari ignores ctx.filter.
export function grayscale(ctx, width, height, contrast = 1) {
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const gray = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    const y = Math.round((gray - 127.5) * contrast + 127.5);
    px[i] = px[i + 1] = px[i + 2] = y;
  }
  ctx.putImageData(image, 0, 0);
}

// Draws `source` blurred by `radius` pixels, also on Safari / iPad, where ctx.filter does nothing.
// from / to: {x, y, w, h} rectangles of the source and of ctx (all of the source, same place,
// when left out). See blur.js.
export const drawBlurred = (ctx, source, radius, from, to) => globalThis.SiteBlur.drawBlurred(ctx, source, radius, from, to);
