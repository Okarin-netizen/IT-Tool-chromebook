// Writing animated GIFs, without a library. All frames share one palette of 256 colors (chosen by
// median cut from all of them), so colors do not flicker from frame to frame. The format:
// https://www.w3.org/Graphics/GIF/spec-gif89a.txt

import { choosePalette, indexPixels, nearestColorLookup } from "../shared/js/palette.js";

const COLORS = 256;
const MIN_CODE_SIZE = 8; // bits per pixel index
const MAX_CODE = 4095; // LZW codes are at most 12 bits

// frames: [ImageData] all the same size. delayMs: how long each one shows. loop: true to repeat
// forever. Returns the bytes of the GIF file.
export function encodeGif(frames, { delayMs, loop }) {
  const { width, height } = frames[0];
  const palette = choosePalette(frames, COLORS);
  while (palette.length < COLORS) palette.push([0, 0, 0, 255]);
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
    writeBlocks(out, lzw(indexPixels(frame, palette, lookup)));
  }
  out.bytes([0x3b]);
  return out.result();
}

const ascii = (text) => [...text].map((c) => c.charCodeAt(0));

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
