// How one picture is compressed: its recipe (format, quality, colors) and the encoding, including
// fitting under a file size. The screen (app.js) only asks for results.

import { canvasToBlob } from "../shared/js/canvas.js";
import { cleanJpeg, cleanPng, readInfo } from "../shared/js/exif.js";
import { encodePalettePng } from "./png.js";

const MIN_SIDE = 160; // never shrink below this to reach a target size
const ANALYSIS_SIDE = 512; // the picture is looked at this small to guess whether it is a drawing
const DRAWING_MAX_COLORS = 5000; // fewer colors than this in that look: a screenshot or drawing
const PNG_STEPS = [256, 128, 64, 32, 16]; // colors tried, in order, to fit a PNG under a size
const LOWEST_QUALITY = 0.35; // JPG/WebP quality is never lowered below this to fit a size
const HIGHEST_QUALITY = 0.95;

// What 「仕上がり」 means for each format: JPG/WebP quality, and how many PNG colors (0 = all).
export const PRESETS = {
  "0.92": { quality: 0.92, colors: 0 },
  "0.8": { quality: 0.8, colors: 256 },
  "0.6": { quality: 0.6, colors: 64 },
};

/* ---------- looking at the original ---------- */

// Facts about the original used later: whether it looks like a drawing (few colors or see-through
// parts), and the file without its hidden information (Exif), for when the original is already
// smaller than anything this tool can make.
export async function examine(file, bitmap) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { kind: fileKind(bytes), drawing: looksLikeDrawing(bitmap), clean: cleanOriginal(bytes) };
}

function fileKind(bytes) {
  try {
    return readInfo(bytes).kind;
  } catch {
    return "other";
  }
}

function cleanOriginal(bytes) {
  try {
    const info = readInfo(bytes);
    if (info.kind === "jpeg") return new Blob([cleanJpeg(bytes, info.exif?.orientation)], { type: "image/jpeg" });
    if (info.kind === "png") return new Blob([cleanPng(bytes)], { type: "image/png" });
  } catch (err) {
    console.error(err);
  }
  return null;
}

function looksLikeDrawing(bitmap) {
  const k = Math.min(1, ANALYSIS_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false; // keep the original colors instead of blends of them
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = new Uint32Array(data.buffer);
  const seen = new Set();
  for (let i = 0; i < pixels.length; i++) {
    if (data[i * 4 + 3] < 255) return true; // see-through parts need PNG
    seen.add(pixels[i]);
    if (seen.size >= DRAWING_MAX_COLORS) return false;
  }
  return true;
}

/* ---------- the recipe ---------- */

// settings: the toolbar's { maxSide, format, mode, targetKb }. item.own: what was changed for this
// picture only ({ format, quality, colors }, any of them), or null.
export function recipeFor(item, settings) {
  const own = item.own ?? {};
  const preset = PRESETS[settings.mode] ?? PRESETS["0.8"];
  return {
    maxSide: settings.maxSide,
    format: own.format ?? chooseFormat(item, settings.format),
    quality: own.quality ?? preset.quality,
    colors: own.colors ?? preset.colors,
    targetBytes: settings.mode === "target" ? settings.targetKb * 1000 : 0,
  };
}

// 「おまかせ」: a photo becomes JPG, a screenshot or drawing (or anything see-through) PNG.
function chooseFormat(item, format) {
  if (format !== "auto") return format;
  const isPhotoFile = item.facts.kind === "jpeg" || item.facts.kind === "heic";
  if (!isPhotoFile && item.facts.drawing) return "image/png";
  return "image/jpeg";
}

/* ---------- drawing ---------- */

export const turnedSize = (bitmap, rotation) =>
  rotation % 180 ? { width: bitmap.height, height: bitmap.width } : { width: bitmap.width, height: bitmap.height };

// Draws the bitmap turned by `rotation` to fill a w×h canvas.
export function draw(ctx, bitmap, rotation, w, h) {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const [dw, dh] = rotation % 180 ? [h, w] : [w, h];
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function render(item, width, height, format) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: format === "image/png" });
  if (format === "image/jpeg") {
    // JPG has no transparency: see-through parts of a PNG would turn black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  draw(ctx, item.bitmap, item.rotation, width, height);
  return canvas;
}

function fit(item, maxSide) {
  const { width, height } = turnedSize(item.bitmap, item.rotation);
  const k = maxSide ? Math.min(1, maxSide / Math.max(width, height)) : 1;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/* ---------- encoding ---------- */

// One encoding of `canvas`: { blob, quality, colors } (quality for JPG/WebP, colors for PNG).
async function encode(canvas, format, { quality, colors }) {
  if (format !== "image/png") return { blob: await canvasToBlob(canvas, format, quality), quality };
  const plain = await canvasToBlob(canvas, format);
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  // "All colors" (0) still tries a palette, but only an exact one: a picture with at most 256
  // colors loses nothing by it.
  const fewer = await encodePalettePng(pixels, colors || 256, { exactOnly: colors === 0 });
  if (!fewer || plain.size <= fewer.blob.size) return { blob: plain, colors: 0 };
  return fewer;
}

// isCurrent(): false once the settings have changed, so a stale run stops early.
// Returns { blob, width, height, format, quality, colors, hit, kept } or null when stopped.
export async function compress(item, recipe, isCurrent) {
  const made = recipe.targetBytes ? await fitUnder(item, recipe, isCurrent) : await compressOnce(item, recipe);
  if (!made) return null;
  return keepOriginalIfSmaller(item, recipe, made);
}

async function compressOnce(item, recipe) {
  const { width, height } = fit(item, recipe.maxSide);
  const canvas = render(item, width, height, recipe.format);
  const result = await encode(canvas, recipe.format, recipe);
  canvas.width = canvas.height = 0;
  return { ...result, width, height, format: recipe.format, hit: true };
}

// The original, without its hidden information, when it is no bigger than what was made and would
// look the same: the same format, the same size, not turned. A picture is never made heavier.
function keepOriginalIfSmaller(item, recipe, made) {
  const clean = item.facts.clean;
  if (!clean || clean.type !== made.format || item.rotation) return made;
  const same = turnedSize(item.bitmap, item.rotation);
  if (same.width !== made.width || same.height !== made.height) return made;
  const fits = !recipe.targetBytes || clean.size <= recipe.targetBytes;
  if (!fits || clean.size > made.blob.size) return made;
  return { ...made, blob: clean, quality: undefined, colors: undefined, hit: true, kept: true };
}

/* ---------- fitting under a file size ---------- */

// Fits the picture under `targetBytes`: first by lowering the JPG/WebP quality (or the PNG
// colors), and only when even the lowest is too big by making it smaller and trying again.
// The same idea as the target-size mode of browser-image-compression and Squoosh's resize +
// quality, written for this tool.
async function fitUnder(item, recipe, isCurrent) {
  let { width, height } = fit(item, recipe.maxSide);
  const aspect = height / width;
  let smallest = null;
  for (let pass = 0; pass < 6; pass++) {
    const canvas = render(item, width, height, recipe.format);
    const found = await encodeUnder(canvas, recipe, isCurrent);
    canvas.width = canvas.height = 0;
    if (!found) return null;
    if (!smallest || found.smallest.blob.size < smallest.blob.size) smallest = { ...found.smallest, width, height };
    if (found.best) return { ...found.best, width, height, format: recipe.format, hit: true };
    if (!isCurrent()) return null;
    if (Math.max(width, height) <= MIN_SIDE) break;
    ({ width, height } = smallerSize(width, aspect, recipe.targetBytes / smallest.blob.size));
  }
  return { ...smallest, format: recipe.format, hit: false };
}

// Area shrinks with the square of the side, so the side shrinks by the square root of `ratio`.
function smallerSize(width, aspect, ratio) {
  const k = Math.max(0.3, Math.min(0.9, Math.sqrt(ratio) * 0.95));
  let w = Math.max(1, Math.round(width * k));
  let h = Math.max(1, Math.round(w * aspect));
  if (Math.max(w, h) < MIN_SIDE) {
    const up = MIN_SIDE / Math.max(w, h);
    w = Math.round(w * up);
    h = Math.round(h * up);
  }
  return { width: w, height: h };
}

// Encodes `canvas` as well as fits under the size. Returns { best, smallest } (each an encode()
// result; best is null when nothing fits), or null when stopped.
async function encodeUnder(canvas, recipe, isCurrent) {
  if (recipe.format === "image/png") return pngUnder(canvas, recipe, isCurrent);
  let best = null;
  let smallest = null;
  let low = LOWEST_QUALITY;
  let high = HIGHEST_QUALITY;
  for (let probe = 0; probe < 7; probe++) {
    if (!isCurrent()) return null;
    const quality = (low + high) / 2;
    const made = await encode(canvas, recipe.format, { quality });
    if (!smallest || made.blob.size < smallest.blob.size) smallest = made;
    if (made.blob.size > recipe.targetBytes) {
      high = quality;
      continue;
    }
    if (!best || made.blob.size > best.blob.size) best = made;
    if (made.blob.size > recipe.targetBytes * 0.9) break; // close enough
    low = quality;
  }
  return { best, smallest };
}

async function pngUnder(canvas, recipe, isCurrent) {
  let smallest = null;
  for (const colors of PNG_STEPS) {
    if (!isCurrent()) return null;
    const made = await encode(canvas, recipe.format, { colors });
    if (made.blob.size <= recipe.targetBytes) return { best: made, smallest: made };
    if (!smallest || made.blob.size < smallest.blob.size) smallest = made;
  }
  return { best: null, smallest };
}
