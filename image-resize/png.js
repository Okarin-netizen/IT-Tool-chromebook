// Writing PNGs with fewer colors (a palette of at most 256), the way TinyPNG and UPNG.js make
// screenshots and drawings lighter without making them smaller. Written for this tool, without a
// library: the browser's CompressionStream does the zlib compression PNG needs.
// The format: https://www.w3.org/TR/png-3/

import { choosePalette, exactPalette, indexPixels } from "../shared/js/palette.js";
import { crc32 } from "../shared/js/zip.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const INDEXED_COLOR = 3; // PNG color type
const MAX_COLORS = 256;

// image: ImageData. colors: how many colors to keep at most (2–256). A picture that already has
// no more colors than that is kept exactly. Returns { blob, colors } (colors = how many were used),
// or null when `exactOnly` is set and the picture has more colors than that.
export async function encodePalettePng(image, colors, { exactOnly = false } = {}) {
  const limit = Math.min(MAX_COLORS, colors);
  const exact = exactPalette(image, limit);
  if (!exact && exactOnly) return null;
  const palette = exact ? exact.palette : choosePalette([image], limit);
  const indices = exact ? exact.indices : indexPixels(image, palette);
  const depth = bitDepth(palette.length);
  const data = await zlib(packRows(indices, image.width, image.height, depth));
  const parts = [Uint8Array.from(SIGNATURE), header(image.width, image.height, depth), paletteChunk(palette)];
  if (palette.some((color) => color[3] < 255)) parts.push(transparencyChunk(palette));
  parts.push(chunk("IDAT", data), chunk("IEND", new Uint8Array(0)));
  return { blob: new Blob(parts, { type: "image/png" }), colors: palette.length };
}

// Fewer colors fit in fewer bits per pixel: 2 colors in 1 bit, 4 in 2, 16 in 4.
function bitDepth(count) {
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  if (count <= 16) return 4;
  return 8;
}

// Each row starts with its filter type (0: none, which suits indexed pictures best), then the
// pixel indices packed `depth` bits each, the first pixel in the highest bits.
function packRows(indices, width, height, depth) {
  const rowBytes = Math.ceil((width * depth) / 8);
  const out = new Uint8Array((rowBytes + 1) * height);
  const perByte = 8 / depth;
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x++) {
      const shift = 8 - depth * ((x % perByte) + 1);
      out[row + Math.floor(x / perByte)] |= indices[y * width + x] << shift;
    }
  }
  return out;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function header(width, height, depth) {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  body[8] = depth;
  body[9] = INDEXED_COLOR;
  return chunk("IHDR", body); // compression, filter and interlace stay 0
}

function paletteChunk(palette) {
  return chunk("PLTE", Uint8Array.from(palette.flatMap(([r, g, b]) => [r, g, b])));
}

// The alpha of each palette color, up to the last one that is not fully solid.
function transparencyChunk(palette) {
  const alphas = palette.map((color) => color[3]);
  while (alphas.at(-1) === 255) alphas.pop();
  return chunk("tRNS", Uint8Array.from(alphas));
}

// A chunk: its length, its 4-letter type, the data, and a CRC of the type and data.
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
