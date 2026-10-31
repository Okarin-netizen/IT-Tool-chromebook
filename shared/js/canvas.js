// Small canvas helpers.

// How many device pixels make one CSS pixel (2 on most Chromebook screens).
export const pixelRatio = () => window.devicePixelRatio || 1;

// canvas.toBlob as a promise. `quality` is used for JPEG and WebP.
export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), type, quality);
  });
}

// Turns what is drawn on a 2D context (of a canvas or an OffscreenCanvas) into shades of gray,
// weighting red, green and blue as the eye does (ITU-R BT.601).
export function grayscale(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const y = Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
    px[i] = px[i + 1] = px[i + 2] = y;
  }
  ctx.putImageData(image, 0, 0);
}
