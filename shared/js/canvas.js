// Small canvas helpers.

// How many device pixels make one CSS pixel (2 on most Chromebook screens).
export const pixelRatio = () => window.devicePixelRatio || 1;

// canvas.toBlob as a promise. `quality` is used for JPEG and WebP.
export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), type, quality);
  });
}
