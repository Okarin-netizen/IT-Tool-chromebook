// Writing animated GIFs, without a library. All frames share one palette of 256 colors (chosen by
// median cut from all of them), so colors do not flicker from frame to frame. The format:
// https://www.w3.org/Graphics/GIF/spec-gif89a.txt

const COLORS = 256;
const SAMPLE_LIMIT = 120000; // pixels looked at to choose the palette
const MIN_CODE_SIZE = 8; // bits per pixel index
const MAX_CODE = 4095; // LZW codes are at most 12 bits
const CACHE_BITS = 5; // nearest-color lookups are cached by the top 5 bits of each channel

// frames: [ImageData] all the same size. delayMs: how long each one shows. loop: true to repeat
// forever. Returns the bytes of the GIF file.
export function encodeGif(frames, { delayMs, loop }) {
  const { width, height } = frames[0];
  const palette = choosePalette(frames);
  const out = new ByteWriter();
  out.text("GIF89a");
  out.short(width);
  out.short(height);
  out.bytes([0xf7, 0, 0]); // a global palette of 256 colors; background 0; square pixels
  for (const [r, g, b] of palette) out.bytes([r, g, b]);
  if (loop) out.bytes([0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), 3, 1, 0, 0, 0]); // repeat forever
  const lookup = nearestColorLookup(palette);
  const delay = Math.max(2, Math.round(delayMs / 10)); // in 1/100 s; browsers slow down anything under 2
  for (const frame of frames) {
    out.bytes([0x21, 0xf9, 4, 0x04, delay & 0xff, delay >> 8, 0, 0]); // keep the frame, no transparency
    out.bytes([0x2c, 0, 0, 0, 0]);
    out.short(width);
    out.short(height);
    out.bytes([0]); // no palette of its own, not interlaced
    out.bytes([MIN_CODE_SIZE]);
    writeBlocks(out, lzw(indexed(frame, lookup)));
  }
  out.bytes([0x3b]);
  return out.result();
}

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));

/* ---------- palette ---------- */

// Median cut: start with one box holding every sampled color, keep splitting the box with the
// widest spread of colors at its median, and take the average color of each box.
function choosePalette(frames) {
  let boxes = [samples(frames)];
  while (boxes.length < COLORS) {
    const widest = boxes.reduce((best, box) => (box.length > 1 && spread(box).range > spread(best).range ? box : best), boxes[0]);
    if (widest.length < 2) break;
    const { channel } = spread(widest);
    widest.sort((a, b) => a[channel] - b[channel]);
    const half = widest.length >> 1;
    boxes = boxes.filter((box) => box !== widest);
    boxes.push(widest.slice(0, half), widest.slice(half));
  }
  const palette = boxes.map(average);
  while (palette.length < COLORS) palette.push([0, 0, 0]);
  return palette;
}

function samples(frames) {
  const total = frames.reduce((sum, f) => sum + f.width * f.height, 0);
  const step = Math.max(1, Math.floor(total / SAMPLE_LIMIT));
  const colors = [];
  for (const { data } of frames) {
    for (let i = 0; i < data.length; i += step * 4) colors.push([data[i], data[i + 1], data[i + 2]]);
  }
  return colors;
}

// The channel (0 red, 1 green, 2 blue) whose values spread widest in `box`, and how wide.
// Remembered on the box, since a box does not change once made.
function spread(box) {
  if (box.spread) return box.spread;
  let channel = 0;
  let range = -1;
  for (let c = 0; c < 3; c++) {
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

function average(box) {
  const sum = [0, 0, 0];
  for (const color of box) for (let c = 0; c < 3; c++) sum[c] += color[c];
  return sum.map((s) => Math.round(s / Math.max(1, box.length)));
}

// A function from a color to the index of the nearest palette color.
function nearestColorLookup(palette) {
  const cache = new Int16Array(1 << (CACHE_BITS * 3)).fill(-1);
  const shift = 8 - CACHE_BITS;
  return (r, g, b) => {
    const key = ((r >> shift) << (CACHE_BITS * 2)) | ((g >> shift) << CACHE_BITS) | (b >> shift);
    if (cache[key] < 0) cache[key] = nearest(palette, r, g, b);
    return cache[key];
  };
}

function nearest(palette, r, g, b) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const distance = (pr - r) ** 2 * 3 + (pg - g) ** 2 * 4 + (pb - b) ** 2 * 2;
    if (distance < bestDistance) [best, bestDistance] = [i, distance];
  }
  return best;
}

function indexed({ data }, lookup) {
  const indices = new Uint8Array(data.length / 4);
  for (let i = 0; i < indices.length; i++) indices[i] = lookup(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  return indices;
}

/* ---------- compression ---------- */

// LZW as GIF uses it: variable-width codes, starting with a clear code and ending with the
// end code, with the table started again when it is full.
function lzw(indices) {
  const clear = 1 << MIN_CODE_SIZE;
  const end = clear + 1;
  const bits = new BitWriter();
  let table = new Map();
  let codeSize = MIN_CODE_SIZE + 1;
  let next = end + 1;
  bits.write(clear, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    bits.write(prefix, codeSize);
    if (next <= MAX_CODE) {
      table.set(key, next);
      if (next === 1 << codeSize) codeSize++;
      next++;
    } else {
      bits.write(clear, codeSize);
      table = new Map();
      codeSize = MIN_CODE_SIZE + 1;
      next = end + 1;
    }
    prefix = k;
  }
  bits.write(prefix, codeSize);
  bits.write(end, codeSize);
  return bits.result();
}

// The compressed data in blocks of at most 255 bytes, each with its length first.
function writeBlocks(out, bytes) {
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.subarray(i, i + 255);
    out.bytes([block.length]);
    out.bytes(block);
  }
  out.bytes([0]);
}

class BitWriter {
  constructor() {
    this.buffer = new Uint8Array(4096);
    this.length = 0;
    this.current = 0;
    this.used = 0;
  }

  write(code, size) {
    this.current |= code << this.used;
    this.used += size;
    while (this.used >= 8) {
      this.push(this.current & 0xff);
      this.current >>= 8;
      this.used -= 8;
    }
  }

  push(byte) {
    if (this.length === this.buffer.length) {
      const bigger = new Uint8Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = byte;
  }

  result() {
    if (this.used > 0) this.push(this.current & 0xff);
    this.used = 0;
    this.current = 0;
    return this.buffer.subarray(0, this.length);
  }
}

class ByteWriter {
  constructor() {
    this.parts = [];
  }

  bytes(list) {
    this.parts.push(list instanceof Uint8Array ? list.slice() : Uint8Array.from(list));
  }

  text(text) {
    this.bytes(ascii(text));
  }

  short(n) {
    this.bytes([n & 0xff, (n >> 8) & 0xff]);
  }

  result() {
    const out = new Uint8Array(this.parts.reduce((sum, p) => sum + p.length, 0));
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}
