// Small helpers for the photo tools (写真の情報・写真を直す・並べて1枚に・大きく分けて印刷・
// 背景を消す・GIF): opening a photo the right way up, naming the result, and a canvas of a size.
import { readableImage } from "./heic.js";

// The photo as an ImageBitmap, turned upright from its Exif orientation (photos taken sideways).
// iPhone photos (HEIC) are turned into JPEG first.
export async function loadPhoto(file) {
  return createImageBitmap(await readableImage(file), { imageOrientation: "from-image" });
}

// "写真.jpg" → "写真"
export const stripExtension = (name) => (name || "").replace(/\.[^.]+$/, "") || "写真";

export function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

// The size of `width`×`height` made to fit within `longSide` on its longer side (never larger).
export function fitWithin(width, height, longSide) {
  const k = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// The output type for a photo: PNG stays PNG (it may have see-through parts or be a drawing),
// everything else becomes JPG.
export function outputType(file) {
  return file?.type === "image/png" ? { type: "image/png", ext: "png" } : { type: "image/jpeg", ext: "jpg" };
}
