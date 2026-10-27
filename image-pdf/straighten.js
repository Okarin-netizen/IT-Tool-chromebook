// Straightening photos of prints, and the "scan" look. Written without OpenCV (several MB), but
// along the same lines as jscanify: find the paper, take the point farthest from its middle in
// each quarter as a corner, then stretch the four corners back to a rectangle.

const DETECT_PX = 360; // the photo is shrunk to this before looking for the paper

// Corners [top-left, top-right, bottom-right, bottom-left] as [x, y] in the canvas' pixels,
// or null when no paper stands out from the background.
export function detectCorners(canvas) {
  const k = Math.min(1, DETECT_PX / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k));
  const h = Math.max(1, Math.round(canvas.height * k));
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  ctx.filter = "blur(2px)"; // smooths away the writing, so the paper is one bright area
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;

  // Paper is the bright part: the largest connected area above Otsu's threshold.
  const t = otsu(gray);
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 1;
  for (let s = 0; s < gray.length; s++) {
    if (label[s] || gray[s] <= t) continue;
    let size = 0, top = 0;
    stack[top++] = s;
    label[s] = next;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w;
      for (const q of [p - w, p + w, x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1]) {
        if (q >= 0 && q < gray.length && !label[q] && gray[q] > t) {
          label[q] = next;
          stack[top++] = q;
        }
      }
    }
    if (size > bestSize) [best, bestSize] = [next, size];
    next++;
  }
  if (bestSize < gray.length * 0.15) return null;

  let cx = 0, cy = 0;
  for (let p = 0; p < label.length; p++) if (label[p] === best) { cx += p % w; cy += (p / w) | 0; }
  cx /= bestSize;
  cy /= bestSize;
  const corners = [null, null, null, null];
  const far = [-1, -1, -1, -1];
  for (let p = 0; p < label.length; p++) {
    if (label[p] !== best) continue;
    const x = p % w, y = (p / w) | 0;
    const q = y < cy ? (x < cx ? 0 : 1) : (x < cx ? 3 : 2);
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d > far[q]) [far[q], corners[q]] = [d, [x, y]];
  }
  if (corners.includes(null)) return null;
  return corners.map(([x, y]) => [Math.min(canvas.width, (x + 0.5) / k), Math.min(canvas.height, (y + 0.5) / k)]);
}

function otsu(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
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

  // Maps (u, v) in the unit square to the quadrilateral (Heckbert's square-to-quad projection).
  const [x0, y0] = tl, [x1, y1] = tr, [x2, y2] = br, [x3, y3] = bl;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const hh = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;

  const sw = canvas.width, sh = canvas.height;
  const src = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  const img = octx.createImageData(w, h);
  const dst = img.data;
  for (let j = 0; j < h; j++) {
    const v = (j + 0.5) / h;
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w;
      const z = g * u + hh * v + 1;
      const sx = Math.min(sw - 1.001, Math.max(0, (a * u + b * v + c) / z - 0.5));
      const sy = Math.min(sh - 1.001, Math.max(0, (d * u + e * v + f) / z - 0.5));
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
      const p00 = (iy * sw + ix) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      const o = (j * w + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[p00 + ch] + (src[p10 + ch] - src[p00 + ch]) * fx;
        const bottom = src[p01 + ch] + (src[p11 + ch] - src[p01 + ch]) * fx;
        dst[o + ch] = top + (bottom - top) * fy;
      }
      dst[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// The "scan" look, in place: shadows and uneven light are evened out by dividing by the paper's
// own brightness nearby, then the paper is made white and the writing dark.
export function scanLook(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  // The paper's brightness: a small copy where each pixel takes the brightest of its
  // neighbours (so writing drops out), blown back up smoothly.
  const sw = Math.max(1, Math.round(w / 24)), sh = Math.max(1, Math.round(h / 24));
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
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(sw - 1, Math.max(0, x + dx)), yy = Math.min(sh - 1, Math.max(0, y + dy));
          m = Math.max(m, lum[yy * sw + xx]);
        }
      }
      const o = (y * sw + x) * 4;
      s.data[o] = s.data[o + 1] = s.data[o + 2] = m;
    }
  }
  sctx.putImageData(s, 0, 0);
  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = w;
  bgCanvas.height = h;
  const bctx = bgCanvas.getContext("2d", { willReadFrequently: true });
  bctx.filter = "blur(8px)";
  bctx.drawImage(small, 0, 0, w, h);
  const bg = bctx.getImageData(0, 0, w, h).data;

  const LOW = 0.45, HIGH = 0.9; // relative brightness that becomes black / white
  for (let i = 0; i < px.length; i += 4) {
    const gray = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    const r = gray / Math.max(16, bg[i]);
    const v = Math.max(0, Math.min(255, ((r - LOW) / (HIGH - LOW)) * 255));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
