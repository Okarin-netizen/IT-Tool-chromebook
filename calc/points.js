// Points worth marking on the graph, found by sampling: where a curve meets the x axis, where two
// curves cross, and the local maxima and minima. No page needed, so node can check it.
//
// A function is f(x) → number (NaN where it is not defined). Results are
// { kind: "zero" | "cross" | "max" | "min", x, y, of: [i] or [i, j] } with i, j the functions'
// positions in the list.

const SAMPLES = 600; // samples across the range; the points between them are refined
const MAX_POINTS = 200; // a wildly wiggling curve (sin(1/x)) should not flood the graph

const finite = (v) => (Number.isFinite(v) ? v : NaN);
const safe = (f) => (x) => {
  try {
    return finite(f(x));
  } catch {
    return NaN;
  }
};

// Whole-number and other float noise away: 0.9999999999 → 1, 1e-13 → 0.
export function tidy(v) {
  if (Math.abs(v) < 1e-9) return 0;
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-9 * Math.max(1, Math.abs(v)) ? r : v;
}

// x in [a, b] where g changes sign, by bisection. g(a) and g(b) have opposite signs.
function bisect(g, a, b, ga) {
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    const gm = g(m);
    if (Number.isNaN(gm)) return NaN;
    if (gm === 0) return m;
    if (Math.sign(gm) === Math.sign(ga)) [a, ga] = [m, gm];
    else b = m;
  }
  return (a + b) / 2;
}

// x in [a, c] where f is largest (sign 1) or smallest (sign -1), by golden-section search.
function golden(f, a, c, sign) {
  const k = (Math.sqrt(5) - 1) / 2;
  let x1 = c - k * (c - a);
  let x2 = a + k * (c - a);
  let f1 = sign * f(x1);
  let f2 = sign * f(x2);
  for (let i = 0; i < 100; i++) {
    if (f1 > f2) {
      [c, x2, f2] = [x2, x1, f1];
      x1 = c - k * (c - a);
      f1 = sign * f(x1);
    } else {
      [a, x1, f1] = [x1, x2, f2];
      x2 = a + k * (c - a);
      f2 = sign * f(x2);
    }
  }
  return (a + c) / 2;
}

// The x values in [x0, x1] where g is 0. A sign change only counts when g really gets close to
// 0 there: 1/x changes sign at its asymptote without ever being 0. Touching zeros (x² at 0) are
// found as a smallest |g| that is 0.
function zerosOf(g, x0, x1, scaleY) {
  const h = (x1 - x0) / SAMPLES;
  const xs = Array.from({ length: SAMPLES + 1 }, (_, i) => x0 + i * h);
  const ys = xs.map(g);
  const out = [];
  const near = (v) => Math.abs(v) <= 1e-7 * scaleY;
  for (let i = 0; i < SAMPLES; i++) {
    const [a, b, ga, gb] = [xs[i], xs[i + 1], ys[i], ys[i + 1]];
    if (Number.isNaN(ga) || Number.isNaN(gb)) continue;
    if (ga === 0) {
      out.push(a);
      continue;
    }
    if (Math.sign(ga) !== Math.sign(gb) && gb !== 0) {
      const x = bisect(g, a, b, ga);
      if (near(g(x))) out.push(x);
    } else if (i > 0 && !Number.isNaN(ys[i - 1]) && Math.abs(ga) < Math.abs(ys[i - 1]) && Math.abs(ga) <= Math.abs(gb)) {
      // |g| dips here: a curve that touches 0 without crossing.
      const x = golden((t) => Math.abs(g(t)), xs[i - 1], b, -1);
      if (near(g(x))) out.push(x);
    }
  }
  if (ys[SAMPLES] === 0) out.push(x1);
  return dedupe(out, h);
}

// Local maxima and minima of f strictly inside [x0, x1].
function extremaOf(f, x0, x1, scaleY) {
  const h = (x1 - x0) / SAMPLES;
  const xs = Array.from({ length: SAMPLES + 1 }, (_, i) => x0 + i * h);
  const ys = xs.map(f);
  const out = [];
  for (let i = 1; i < SAMPLES; i++) {
    const [ya, yb, yc] = [ys[i - 1], ys[i], ys[i + 1]];
    if ([ya, yb, yc].some(Number.isNaN)) continue;
    // A rise then a fall (or the reverse), not a flat stretch.
    const up = yb - ya;
    const down = yc - yb;
    const flat = 1e-12 * scaleY;
    let sign = 0;
    if (up > flat && down <= 0) sign = 1;
    else if (up < -flat && down >= 0) sign = -1;
    else continue;
    // On a flat top, the step after is also flat: that one is skipped by the "up" test.
    // Where the slope is 0, which pins x down far more exactly than comparing values near a
    // flat top; golden-section search if the slope does not change sign cleanly.
    const d = h * 1e-3;
    const slope = (t) => (f(t + d) - f(t - d)) / (2 * d);
    const [sa, sc] = [slope(xs[i - 1]), slope(xs[i + 1])];
    const x = Math.sign(sa) === -Math.sign(sc) && sa !== 0
      ? bisect(slope, xs[i - 1], xs[i + 1], sa)
      : golden(f, xs[i - 1], xs[i + 1], sign);
    const y = f(x);
    if (Number.isNaN(y)) continue;
    // A spike at an asymptote (1/x², tan x) is not a maximum: the curve keeps climbing.
    if (Math.abs(y) > 1e6 * scaleY) continue;
    out.push({ x, y, kind: sign > 0 ? "max" : "min" });
  }
  return dedupe(out, h, (p) => p.x);
}

function dedupe(list, h, xOf = (v) => v) {
  const out = [];
  for (const v of list.sort((a, b) => xOf(a) - xOf(b))) {
    if (!out.length || xOf(v) - xOf(out[out.length - 1]) > h / 2) out.push(v);
  }
  return out;
}

// All the points in x0..x1 for `funcs` (null entries are skipped). `scaleY` is the size of the
// visible y range, used to judge "close to 0".
export function findPoints(funcs, x0, x1, scaleY = x1 - x0) {
  const fs = funcs.map((f) => (f ? safe(f) : null));
  const points = [];
  fs.forEach((f, i) => {
    if (!f) return;
    for (const x of zerosOf(f, x0, x1, scaleY)) points.push({ kind: "zero", x: tidy(x), y: 0, of: [i] });
    for (const p of extremaOf(f, x0, x1, scaleY)) points.push({ kind: p.kind, x: tidy(p.x), y: tidy(p.y), of: [i] });
  });
  fs.forEach((f, i) => {
    if (!f) return;
    for (let j = i + 1; j < fs.length; j++) {
      const g = fs[j];
      if (!g) continue;
      const diff = (x) => f(x) - g(x);
      for (const x of zerosOf(diff, x0, x1, scaleY)) points.push({ kind: "cross", x: tidy(x), y: tidy(f(x)), of: [i, j] });
    }
  });
  return points.slice(0, MAX_POINTS);
}
