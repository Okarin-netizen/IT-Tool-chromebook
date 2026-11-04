// How 写真を直す changes a photo: first its shape (turning, the four corners, the tilt), then its
// colors (a photo's brightness and colors, or a board or a print made easy to read). The same
// code makes the small preview and the full-size photo that is saved.
import { makeCanvas } from "../shared/js/photo.js";
import { warp } from "../shared/js/straighten.js";

const AUTO_CUT = 0.005; // auto levels ignore this share of the darkest and brightest pixels
const AUTO_MIN_RANGE = 40; // a channel with less spread than this is left alone (a gray wall)
const BG_CELL = 24; // px of the photo per pixel of the background map (boards and prints)
const BG_RADIUS = 2; // cells looked at around each cell for the paper's (or board's) color
const BG_BLUR = 8; // px, softens the background map when it is blown back up
const WARMTH_STEP = 0.25; // how much red/blue one step of 色み adds or takes away (of 255)

/* ---------- shape ---------- */

// The photo turned, straightened and tilted, at most `maxPx` on its long side.
// `corners` are fractions of the turned photo: [[x, y] × 4] from top-left clockwise, or null.
export function shape(source, { rotation, flip, corners, tilt }, maxPx) {
  let canvas = turned(source, rotation, flip, maxPx);
  if (corners) {
    const points = corners.map(([x, y]) => [x * canvas.width, y * canvas.height]);
    canvas = warp(canvas, points, maxPx);
  }
  if (tilt) canvas = tilted(canvas, tilt);
  return canvas;
}

export function turned(source, rotation, flip, maxPx) {
  const sideways = rotation % 180 !== 0;
  const width = sideways ? source.height : source.width;
  const height = sideways ? source.width : source.height;
  const k = Math.min(1, maxPx / Math.max(width, height));
  const canvas = makeCanvas(width * k, height * k);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (flip) ctx.scale(-1, 1);
  const drawWidth = sideways ? canvas.height : canvas.width;
  const drawHeight = sideways ? canvas.width : canvas.height;
  ctx.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  return canvas;
}

// Turned by `degrees` and enlarged just enough that no empty corners show; the size stays.
function tilted(canvas, degrees) {
  const angle = (Math.abs(degrees) * Math.PI) / 180;
  const { width, height } = canvas;
  const zoom = Math.cos(angle) + (Math.max(width, height) / Math.min(width, height)) * Math.sin(angle);
  const out = makeCanvas(width, height);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.translate(width / 2, height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.scale(zoom, zoom);
  ctx.drawImage(canvas, -width / 2, -height / 2);
  return out;
}

/* ---------- colors ---------- */

// Changes the colors of `canvas` in place, by the settings of the chosen mode.
export function recolor(canvas, settings) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (settings.mode === "board") boardLook(image, canvas, settings.board);
  else photoLook(image, settings.photo);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function photoLook(image, photo) {
  const levels = photo.auto ? autoLevels(image.data) : null;
  const tables = [0, 1, 2].map((channel) => photoTable(channel, photo, levels?.[channel]));
  const px = image.data;
  const saturation = 1 + photo.saturation / 100;
  for (let i = 0; i < px.length; i += 4) {
    const r = tables[0][px[i]];
    const g = tables[1][px[i + 1]];
    const b = tables[2][px[i + 2]];
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    px[i] = gray + (r - gray) * saturation;
    px[i + 1] = gray + (g - gray) * saturation;
    px[i + 2] = gray + (b - gray) * saturation;
  }
}

// What each value 0–255 of one channel becomes: stretched (auto), brighter or darker (a curve,
// so white stays white), more or less contrast, warmer or cooler.
function photoTable(channel, photo, level) {
  const table = new Uint8ClampedArray(256);
  const gamma = Math.pow(2, -photo.brightness / 80);
  const contrast = photo.contrast >= 0 ? 1 + photo.contrast / 50 : 1 + photo.contrast / 125;
  const warmthByChannel = [photo.warmth * WARMTH_STEP, 0, -photo.warmth * WARMTH_STEP];
  for (let v = 0; v < 256; v++) {
    let x = v;
    if (level) x = ((x - level.low) * 255) / (level.high - level.low);
    x = 255 * Math.pow(Math.min(1, Math.max(0, x / 255)), gamma);
    x = (x - 128) * contrast + 128;
    table[v] = x + warmthByChannel[channel];
  }
  return table;
}

// For each channel, the values below and above which only AUTO_CUT of the pixels lie, or null
// for a channel too even to stretch.
function autoLevels(px) {
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < px.length; i += 4) {
    histograms[0][px[i]]++;
    histograms[1][px[i + 1]]++;
    histograms[2][px[i + 2]]++;
  }
  const total = px.length / 4;
  return histograms.map((histogram) => {
    const low = percentile(histogram, total * AUTO_CUT);
    const high = percentile(histogram, total * (1 - AUTO_CUT));
    return high - low >= AUTO_MIN_RANGE ? { low, high } : null;
  });
}

function percentile(histogram, count) {
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen >= count) return v;
  }
  return 255;
}

/* ---------- boards and prints ---------- */

// White paper or a whiteboard: each pixel is divided by the paper's own color nearby, which
// takes away shadows, uneven light and the yellow of room lights; then the paper is made white
// and the writing dark. A blackboard is the other way round: the board's color nearby is taken
// away, so the board becomes black and the chalk bright.
function boardLook(image, canvas, board) {
  const dark = board.kind === "blackboard";
  const background = backgroundMap(canvas, dark);
  const px = image.data;
  const strength = board.strength / 100;
  const low = dark ? 0.04 + strength * 0.16 : 0.3 + strength * 0.35;
  const high = dark ? 0.75 - strength * 0.3 : 0.97 - strength * 0.12;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = px[i + c];
      const bg = background[i + c];
      const ratio = dark ? (v - bg) / Math.max(32, 255 - bg) : v / Math.max(16, bg);
      px[i + c] = ((ratio - low) / (high - low)) * 255;
    }
    if (dark && board.invert) invertBrightness(px, i);
  }
  if (board.color !== "color") toGray(px, board.color === "bw");
}

// Turns light into dark and dark into light but keeps the hue, so yellow chalk stays yellowish.
function invertBrightness(px, i) {
  const gray = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  const shift = 255 - 2 * gray;
  px[i] += shift;
  px[i + 1] += shift;
  px[i + 2] += shift;
}

function toGray(px, blackAndWhite) {
  for (let i = 0; i < px.length; i += 4) {
    let gray = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    // Black and white for photocopies, with a short soft step so edges are not jagged.
    if (blackAndWhite) gray = Math.min(255, Math.max(0, (gray - 150) * 6 + 128));
    px[i] = px[i + 1] = px[i + 2] = gray;
  }
}

// The color of the paper (the brightest nearby) or of the board (the darkest nearby) around
// each pixel, per channel: worked out on a small copy, then blown back up smoothly.
function backgroundMap(canvas, dark) {
  const { width, height } = canvas;
  const sw = Math.max(1, Math.round(width / BG_CELL));
  const sh = Math.max(1, Math.round(height / BG_CELL));
  const small = makeCanvas(sw, sh);
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const image = sctx.getImageData(0, 0, sw, sh);
  const spread = spreadExtreme(image.data, sw, sh, dark);
  image.data.set(spread);
  sctx.putImageData(image, 0, 0);
  const big = makeCanvas(width, height);
  const bctx = big.getContext("2d", { willReadFrequently: true });
  bctx.filter = `blur(${BG_BLUR}px)`;
  bctx.drawImage(small, 0, 0, width, height);
  return bctx.getImageData(0, 0, width, height).data;
}

// Each cell takes the brightest (or darkest) value of each channel within BG_RADIUS cells.
function spreadExtreme(px, width, height, dark) {
  const out = new Uint8ClampedArray(px.length);
  const pick = dark ? Math.min : Math.max;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let best = px[o + c];
        for (let dy = -BG_RADIUS; dy <= BG_RADIUS; dy++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -BG_RADIUS; dx <= BG_RADIUS; dx++) {
            const xx = Math.min(width - 1, Math.max(0, x + dx));
            best = pick(best, px[(yy * width + xx) * 4 + c]);
          }
        }
        out[o + c] = best;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
