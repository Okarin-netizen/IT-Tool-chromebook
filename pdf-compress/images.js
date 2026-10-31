// "画像だけ軽くする": the images inside the PDF are shrunk and saved again as JPEG, and
// everything else (text, lines, fonts) is kept as it is. Imported only when it is used,
// because it needs pdf-lib.
import { loadPdfLib } from "../shared/js/pdf-lib.js";
import { grayscale } from "../shared/js/canvas.js";

const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFStream, decodePDFRawStream } = await loadPdfLib();

const MIN_IMAGE_BYTES = 8 * 1024; // smaller images aren't worth re-encoding
const N = (name) => PDFName.of(name);
const DECODABLE = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);

// `gray` also makes the images black and white (text and lines keep their colors).
export async function compressImages(bytes, level, onProgress, { gray = false } = {}) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;

  const images = [];
  const masks = new Set(); // soft masks hold transparency, which JPEG would smear
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.lookup(N("Subtype")) !== N("Image")) continue;
    images.push([ref, obj]);
    for (const key of ["SMask", "Mask"]) {
      const mask = obj.dict.get(N(key));
      if (mask instanceof PDFRef) masks.add(mask.tag);
    }
  }

  const targets = images.filter(([ref]) => !masks.has(ref.tag));
  let replaced = 0;
  for (const [i, [ref, obj]] of targets.entries()) {
    onProgress(i + 1, targets.length);
    try {
      const jpeg = await reencodeImage(obj, level, gray);
      if (!jpeg) continue;
      const dict = obj.dict.clone(ctx);
      dict.set(N("Width"), ctx.obj(jpeg.width));
      dict.set(N("Height"), ctx.obj(jpeg.height));
      dict.set(N("ColorSpace"), N("DeviceRGB"));
      dict.set(N("BitsPerComponent"), ctx.obj(8));
      dict.set(N("Filter"), N("DCTDecode"));
      dict.delete(N("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(dict, jpeg.bytes));
      replaced++;
    } catch (err) {
      console.warn("skipped an image", err); // leave anything unusual untouched
    }
  }

  removeUnusedObjects(doc);
  return { bytes: await doc.save({ useObjectStreams: true }), replaced, images: targets.length };
}

// Returns { bytes, width, height } of a smaller JPEG, or null when the image is left as it is.
async function reencodeImage(stream, { maxPx, quality }, gray) {
  const dict = stream.dict;
  const original = stream.getContents();
  if (original.length < MIN_IMAGE_BYTES) return null;
  if (String(dict.lookup(N("ImageMask"))) === "true") return null;
  if (dict.has(N("Decode")) || dict.lookup(N("Mask")) instanceof PDFArray) return null;
  if (numberOf(dict, "BitsPerComponent") !== 8) return null;
  const width = numberOf(dict, "Width");
  const height = numberOf(dict, "Height");
  const comps = colorComponents(dict.lookup(N("ColorSpace")));
  if (!width || !height || !comps) return null;

  const filters = filterNames(dict.lookup(N("Filter")));
  let source;
  if (filters.length === 1 && filters[0] === "DCTDecode") {
    source = new Blob([stripExif(original)], { type: "image/jpeg" });
  } else if (filters.every((f) => DECODABLE.has(f))) {
    let raw = filters.length ? decodePDFRawStream(stream).decode() : original;
    const predictor = numberOf(decodeParms(dict), "Predictor") || 1;
    if (predictor >= 10) raw = unPng(raw, width * comps, comps);
    else if (predictor !== 1) return null;
    if (!raw || raw.length < width * height * comps) return null;
    source = toImageData(raw, width, height, comps);
  } else {
    return null; // JBIG2, CCITT, JPEG 2000 … are already compact
  }

  const scale = Math.min(1, maxPx / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (gray) grayscale(g, w, h);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // A gray image is wanted even when it is not much smaller.
  if (bytes.length > original.length * (gray ? 1 : 0.9)) return null;
  return { bytes, width: w, height: h };
}

function numberOf(dict, key) {
  const value = dict?.lookup(N(key));
  return typeof value?.asNumber === "function" ? value.asNumber() : 0;
}

function decodeParms(dict) {
  const parms = dict.lookup(N("DecodeParms"));
  if (parms instanceof PDFArray) return parms.size() ? dict.context.lookup(parms.get(0)) : null;
  return parms instanceof PDFDict ? parms : null;
}

function filterNames(filter) {
  if (!filter) return [];
  if (filter instanceof PDFArray) return filter.asArray().map((f) => String(f).slice(1));
  return [String(filter).slice(1)];
}

const COMPONENTS = { DeviceGray: 1, CalGray: 1, DeviceRGB: 3, CalRGB: 3 };

// 1 for gray, 3 for RGB; null for anything that needs more care (CMYK, indexed, Lab…).
function colorComponents(cs) {
  if (!cs) return null;
  if (cs instanceof PDFName) {
    const name = String(cs).slice(1);
    return COMPONENTS[name] ?? null;
  }
  if (cs instanceof PDFArray && cs.size()) {
    const kind = String(cs.lookup(0)).slice(1);
    if (kind === "CalGray") return 1;
    if (kind === "CalRGB") return 3;
    if (kind === "ICCBased") {
      const profile = cs.lookup(1);
      const n = profile instanceof PDFStream ? numberOf(profile.dict, "N") : 0;
      return n === 1 || n === 3 ? n : null;
    }
  }
  return null;
}

// Undo PNG row filters (PDF predictors 10–15).
function unPng(data, rowBytes, bpp) {
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y++) {
    const type = data[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y ? out[dst - rowBytes + x] : 0;
      const c = x >= bpp && y ? out[dst - rowBytes + x - bpp] : 0;
      let v = data[src + x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) v += paeth(a, b, c);
      else if (type !== 0) return null;
      out[dst + x] = v;
    }
  }
  return out;
}

// The PNG "Paeth" predictor: whichever of left, above and upper left is closest to
// left + above - upper left.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function toImageData(raw, width, height, comps) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += comps) {
    rgba[i * 4] = raw[j];
    rgba[i * 4 + 1] = raw[j + (comps === 3 ? 1 : 0)];
    rgba[i * 4 + 2] = raw[j + (comps === 3 ? 2 : 0)];
    rgba[i * 4 + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

// PDF viewers ignore EXIF rotation inside a JPEG but the browser applies it, so drop the EXIF block.
function stripExif(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  const parts = [jpeg.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1];
    if (marker === 0xda || marker < 0xe0 || marker > 0xef) break; // stop at the first non-APPn segment
    const len = (jpeg[pos + 2] << 8) | jpeg[pos + 3];
    if (marker !== 0xe1) parts.push(jpeg.subarray(pos, pos + 2 + len));
    pos += 2 + len;
  }
  parts.push(jpeg.subarray(pos));
  return new Blob(parts);
}

// Drop objects nothing points to (leftovers from earlier edits of the PDF).
function removeUnusedObjects(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt, ctx.trailerInfo.ID];
  while (stack.length) {
    const obj = stack.pop();
    if (!obj) continue;
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue;
      seen.add(obj.tag);
      stack.push(ctx.lookup(obj));
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) ctx.delete(ref);
  }
}
