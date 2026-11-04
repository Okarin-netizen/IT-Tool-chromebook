// Straightening photos of prints, and the "scan" look. Written without OpenCV (several MB), but
// along the same lines as jscanify: find the paper, take the point farthest from its middle in
// each quarter as a corner, then stretch the four corners back to a rectangle.

const DETECT_PX = 360; // the photo is shrunk to this before looking for the paper
const MIN_PAPER = 0.15; // the paper must cover at least this much of the photo
const BG_CELL = 24; // px of the photo per pixel of the paper's brightness map (scanLook)
const LOW = 0.45; // brightness relative to the paper nearby that becomes black (scanLook)
const HIGH = 0.9; // … and that becomes white

// Corners [top-left, top-right, bottom-right, bottom-left] as [x, y] in the canvas' pixels,
// or null when no paper stands out from the background.
export function detectCorners(canvas) {
  const k = Math.min(1, DETECT_PX / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k));
  const h = Math.max(1, Math.round(canvas.height * k));
  const gray = blurredGray(canvas, w, h);
  const paper = largestBrightArea(gray, w, otsu(gray));
  if (paper.size < gray.length * MIN_PAPER) return null;
  const corners = farthestCorners(paper, w);
  if (corners.includes(null)) return null;
  return corners.map(([x, y]) => [Math.min(canvas.width, (x + 0.5) / k), Math.min(canvas.height, (y + 0.5) / k)]);
}

// The canvas shrunk to w × h and blurred, as one brightness byte per pixel. The blur smooths
// away the writing, so the paper is one bright area.
function blurredGray(canvas, w, h) {
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.filter = "blur(2px)";
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    const [r, g, b] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
  }
  return gray;
}

// Paper is the bright part: the largest connected area brighter than `threshold`.
// Returns { label, id, size }: every pixel's area number, the paper's number, and its size.
function largestBrightArea(gray, w, threshold) {
  const label = new Int32Array(gray.length);
  const stack = new Int32Array(gray.length);
  const bright = (p) => gray[p] > threshold;
  let id = 0;
  let size = 0;
  let next = 1;
  for (let start = 0; start < gray.length; start++) {
    if (label[start] || !bright(start)) continue;
    // Flood fill from `start` to its four neighbours.
    let count = 0;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    while (top) {
      const p = stack[--top];
      count++;
      const x = p % w;
      const above = p - w;
      const below = p + w;
      const left = x > 0 ? p - 1 : -1;
      const right = x < w - 1 ? p + 1 : -1;
      for (const q of [above, below, left, right]) {
        if (q >= 0 && q < gray.length && !label[q] && bright(q)) {
          label[q] = next;
          stack[top++] = q;
        }
      }
    }
    if (count > size) [id, size] = [next, count];
    next++;
  }
  return { label, id, size };
}

// In each quarter around the paper's middle, its pixel farthest from the middle
// ([top-left, top-right, bottom-right, bottom-left]; null for a quarter it does not reach).
function farthestCorners({ label, id, size }, w) {
  let cx = 0;
  let cy = 0;
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== id) continue;
    cx += p % w;
    cy += (p / w) | 0;
  }
  cx /= size;
  cy /= size;
  const corners = [null, null, null, null];
  const far = [-1, -1, -1, -1];
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== id) continue;
    const x = p % w;
    const y = (p / w) | 0;
    const quarter = quarterOf(x < cx, y < cy);
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d > far[quarter]) [far[quarter], corners[quarter]] = [d, [x, y]];
  }
  return corners;
}

// 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
function quarterOf(left, top) {
  if (top) return left ? 0 : 1;
  return left ? 3 : 2;
}

// Otsu's threshold: the brightness that best splits the pixels into a dark and a bright group.
function otsu(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB || wB === gray.length) continue;
    sumB += i * hist[i];
    const wF = gray.length - wB;
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) [best, t] = [between, i];
  }
  return t;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// A new canvas with the quadrilateral `corners` of `canvas` stretched to a rectangle as big as its
// longer edges (at most maxPx on the long side).
export function warp(canvas, corners, maxPx) {
  const [tl, tr, br, bl] = corners;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, maxPx / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));

  const toQuad = squareToQuad(corners);
  const sample = bilinearSampler(canvas);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  const img = octx.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    for (let i = 0; i < w; i++) {
      const [x, y] = toQuad((i + 0.5) / w, v);
      sample(x - 0.5, y - 0.5, img.data, (j * w + i) * 4);
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Maps (u, v) in the unit square to the quadrilateral [tl, tr, br, bl]
// (Heckbert's square-to-quad projection).
function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  return (u, v) => {
    const z = g * u + h * v + 1;
    return [(a * u + b * v + x0) / z, (d * u + e * v + y0) / z];
  };
}

// A function that writes the colour of `canvas` at (x, y) (in pixels, between pixel centres
// blended) into `dst` at `o`, opaque.
function bilinearSampler(canvas) {
  const sw = canvas.width;
  const sh = canvas.height;
  const src = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  return (x, y, dst, o) => {
    const sx = Math.min(sw - 1.001, Math.max(0, x));
    const sy = Math.min(sh - 1.001, Math.max(0, y));
    const ix = sx | 0;
    const iy = sy | 0;
    const fx = sx - ix;
    const fy = sy - iy;
    const p00 = (iy * sw + ix) * 4; // the four pixels around (x, y)
    const p10 = p00 + 4;
    const p01 = p00 + sw * 4;
    const p11 = p01 + 4;
    for (let ch = 0; ch < 3; ch++) {
      const top = src[p00 + ch] + (src[p10 + ch] - src[p00 + ch]) * fx;
      const bottom = src[p01 + ch] + (src[p11 + ch] - src[p01 + ch]) * fx;
      dst[o + ch] = top + (bottom - top) * fy;
    }
    dst[o + 3] = 255;
  };
}

// The "scan" look, in place: shadows and uneven light are evened out by dividing by the paper's
// own brightness nearby, then the paper is made white and the writing dark.
export function scanLook(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const bg = paperBrightness(canvas);
  for (let i = 0; i < px.length; i += 4) {
    const gray = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    const r = gray / Math.max(16, bg[i]);
    const v = Math.max(0, Math.min(255, ((r - LOW) / (HIGH - LOW)) * 255));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// The paper's brightness around each pixel of `canvas` (RGBA, the same in R, G and B): a small
// copy where each pixel takes the brightest of its neighbours (so writing drops out), blown
// back up smoothly.
function paperBrightness(canvas) {
  const { width: w, height: h } = canvas;
  const sw = Math.max(1, Math.round(w / BG_CELL));
  const sh = Math.max(1, Math.round(h / BG_CELL));
  const small = document.createElement("canvas");
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const s = sctx.getImageData(0, 0, sw, sh);
  const lum = new Uint8Array(sw * sh);
  for (let i = 0; i < lum.length; i++) lum[i] = Math.max(s.data[i * 4], s.data[i * 4 + 1], s.data[i * 4 + 2]);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const m = brightestAround(lum, sw, sh, x, y);
      const o = (y * sw + x) * 4;
      s.data[o] = s.data[o + 1] = s.data[o + 2] = m;
    }
  }
  sctx.putImageData(s, 0, 0);
  const big = document.createElement("canvas");
  big.width = w;
  big.height = h;
  const bctx = big.getContext("2d", { willReadFrequently: true });
  bctx.filter = "blur(8px)";
  bctx.drawImage(small, 0, 0, w, h);
  return bctx.getImageData(0, 0, w, h).data;
}

// The largest value in the 3 × 3 square around (x, y), the edges repeated.
function brightestAround(lum, w, h, x, y) {
  let m = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx));
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      m = Math.max(m, lum[yy * w + xx]);
    }
  }
  return m;
}
