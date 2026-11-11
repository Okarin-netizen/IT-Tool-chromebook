// Choosing a small set of colors (a palette) for a picture, and finding the nearest palette color
// for each pixel. Used to write GIFs (写真をつなげてGIF) and PNGs with fewer colors (画像を圧縮).
// Colors are [red, green, blue, alpha], 0–255 each; pictures without transparency have alpha 255.

const SAMPLE_LIMIT = 120000; // pixels looked at to choose the palette
const CACHE_BITS = 5; // other colors are remembered by the top 5 bits of red, green and blue…
const ALPHA_CACHE_BITS = 3; // …and the top 3 bits of alpha

// Median cut: start with one box holding every sampled color, keep splitting the box with the
// widest spread of colors at its median, and take one color for each box (representative()).
// images: [ImageData]. Returns at most `colors` colors (fewer when the picture has fewer).
export function choosePalette(images, colors) {
  let boxes = [samples(images)];
  while (boxes.length < colors) {
    const widest = boxes.reduce((best, box) => (box.length > 1 && spread(box).range > spread(best).range ? box : best), boxes[0]);
    if (widest.length < 2 || spread(widest).range === 0) break;
    const { channel } = spread(widest);
    widest.sort((a, b) => a[channel] - b[channel]);
    const half = widest.length >> 1;
    boxes = boxes.filter((box) => box !== widest);
    boxes.push(widest.slice(0, half), widest.slice(half));
  }
  return boxes.map(representative);
}

// Every color of the picture with each pixel's place in that list, or null when it has more than
// `colors` colors. A picture with few colors (a screenshot, a drawing) then loses nothing.
export function exactPalette({ data }, colors) {
  const pixels = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
  const places = new Map();
  const palette = [];
  const indices = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    let place = places.get(pixels[i]);
    if (place === undefined) {
      if (places.size === colors) return null;
      place = places.size;
      places.set(pixels[i], place);
      palette.push([...data.subarray(i * 4, i * 4 + 4)]);
    }
    indices[i] = place;
  }
  return { palette, indices };
}

function samples(images) {
  const total = images.reduce((sum, image) => sum + image.width * image.height, 0);
  const step = Math.max(1, Math.floor(total / SAMPLE_LIMIT));
  const colors = [];
  for (const { data } of images) {
    for (let i = 0; i < data.length; i += step * 4) colors.push([data[i], data[i + 1], data[i + 2], data[i + 3]]);
  }
  return colors;
}

// The channel (0 red, 1 green, 2 blue, 3 alpha) whose values spread widest in `box`, and how
// wide. Remembered on the box, since a box does not change once made.
function spread(box) {
  if (box.spread) return box.spread;
  let channel = 0;
  let range = -1;
  for (let c = 0; c < 4; c++) {
    let low = 255;
    let high = 0;
    for (const color of box) {
      low = Math.min(low, color[c]);
      high = Math.max(high, color[c]);
    }
    if (high - low > range) [channel, range] = [c, high - low];
  }
  box.spread = { channel, range };
  return box.spread;
}

// The color most of the box has, when there is one (the white of a page, the color of a
// heading), so that it stays exactly that color; otherwise the average of the box.
function representative(box) {
  const counts = new Map();
  let top = null;
  let topCount = 0;
  for (const color of box) {
    const key = colorKey(...color);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > topCount) [top, topCount] = [color, count];
  }
  if (topCount * 2 >= box.length) return [...top];
  return average(box);
}

function average(box) {
  const sum = [0, 0, 0, 0];
  for (const color of box) for (let c = 0; c < 4; c++) sum[c] += color[c];
  return sum.map((s) => Math.round(s / Math.max(1, box.length)));
}

// A function from a color to the index of the nearest palette color. A color that is in the
// palette (the page's white, a heading's color) always gets its own index. Other colors are
// remembered by the top bits of each channel, which keeps photos with millions of colors fast.
export function nearestColorLookup(palette) {
  const exact = new Map(palette.map((color, index) => [colorKey(...color), index]));
  const cache = new Int16Array(1 << (CACHE_BITS * 3 + ALPHA_CACHE_BITS)).fill(-1);
  const shift = 8 - CACHE_BITS;
  const alphaShift = 8 - ALPHA_CACHE_BITS;
  return (r, g, b, a = 255) => {
    const index = exact.get(colorKey(r, g, b, a));
    if (index !== undefined) return index;
    const rgb = ((r >> shift) << (CACHE_BITS * 2)) | ((g >> shift) << CACHE_BITS) | (b >> shift);
    const key = ((a >> alphaShift) << (CACHE_BITS * 3)) | rgb;
    if (cache[key] < 0) cache[key] = nearest(palette, r, g, b, a);
    return cache[key];
  };
}

const colorKey = (r, g, b, a = 255) => ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

// The eye tells green apart best and blue least, so the channels are weighted (and alpha most,
// since a see-through pixel turning solid shows clearly).
function nearest(palette, r, g, b, a) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb, pa = 255] = palette[i];
    const distance = (pr - r) ** 2 * 3 + (pg - g) ** 2 * 4 + (pb - b) ** 2 * 2 + (pa - a) ** 2 * 6;
    if (distance < bestDistance) [best, bestDistance] = [i, distance];
  }
  return best;
}

// Each pixel of `image` as the index of its nearest palette color. Pass the same `lookup` for
// several pictures with one palette (the frames of a GIF), so its cache is shared.
export function indexPixels({ data }, palette, lookup = nearestColorLookup(palette)) {
  const indices = new Uint8Array(data.length / 4);
  for (let i = 0; i < indices.length; i++) indices[i] = lookup(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);
  return indices;
}
