// Reading and removing the information stored inside photo files (Exif and the like): when and
// where a photo was taken, with what phone, by whom. Removing works on the file's bytes, so the
// picture itself is not compressed again (JPEG and PNG); other kinds are drawn again instead.

const TEXT = new TextDecoder("latin1");
const UTF8 = new TextDecoder("utf-8");

// Exif tags shown to the user. https://exiftool.org/TagNames/EXIF.html
const TAGS = {
  0x010f: "make",
  0x0110: "model",
  0x0112: "orientation",
  0x0131: "software",
  0x0132: "dateTime",
  0x013b: "artist",
  0x8298: "copyright",
  0x8769: "exifIfd",
  0x8825: "gpsIfd",
  0x9003: "dateTimeOriginal",
  0xa430: "ownerName",
  0xa431: "serialNumber",
  0xa434: "lensModel",
};
const GPS_TAGS = { 1: "latRef", 2: "lat", 3: "lonRef", 4: "lon", 5: "altRef", 6: "alt" };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// JPEG markers kept when cleaning: everything but APP1 (Exif, XMP), APP3–APP13 and APP15
// (maker notes, IPTC, Photoshop) and comments. APP0 (JFIF), the color profile in APP2 and
// Adobe's APP14 (needed to decode some JPEGs correctly) stay.
const APP0 = 0xe0;
const APP2 = 0xe2;
const APP14 = 0xee;
const COMMENT = 0xfe;
const START_OF_SCAN = 0xda;
const END_OF_IMAGE = 0xd9;

// PNG chunks with words in them (text, Exif, the time it was saved).
const PNG_INFO_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]);

/* ---------- reading ---------- */

// What is stored in the file: { kind, exif: {...} | null, extras: ["XMP", ...] }.
export function readInfo(bytes) {
  const kind = fileKind(bytes);
  if (kind === "jpeg") return { kind, ...readJpeg(bytes) };
  if (kind === "png") return { kind, ...readPng(bytes) };
  // WebP and HEIC keep the Exif block as is somewhere in the file: look for its header.
  return { kind, exif: findExif(bytes), extras: findXmp(bytes) ? ["XMP"] : [] };
}

export function fileKind(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0x89 && TEXT.decode(bytes.subarray(1, 4)) === "PNG") return "png";
  if (TEXT.decode(bytes.subarray(0, 4)) === "RIFF" && TEXT.decode(bytes.subarray(8, 12)) === "WEBP") return "webp";
  if (TEXT.decode(bytes.subarray(4, 8)) === "ftyp") return "heic";
  if (TEXT.decode(bytes.subarray(0, 3)) === "GIF") return "gif";
  return "other";
}

// The segments before the picture data: [{ marker, start, end, data }] (data is without the
// marker and length).
function jpegSegments(bytes) {
  const segments = [];
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === START_OF_SCAN) break;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    segments.push({ marker, start: i, end: i + 2 + length, data: bytes.subarray(i + 4, i + 2 + length) });
    i += 2 + length;
  }
  return segments;
}

function readJpeg(bytes) {
  let exif = null;
  const extras = [];
  for (const { marker, data } of jpegSegments(bytes)) {
    const head = TEXT.decode(data.subarray(0, 30));
    if (marker === 0xe1 && head.startsWith("Exif\0")) exif = readTiff(data.subarray(6));
    else if (marker === 0xe1 && head.startsWith("http://ns.adobe.com/xap")) extras.push("XMP（編集ソフトの記録）");
    else if (marker === 0xed) extras.push("IPTC（作者・説明など）");
    else if (marker === COMMENT) extras.push(`コメント「${UTF8.decode(data).slice(0, 40)}」`);
    else if (marker === APP2 && head.startsWith("MPF")) extras.push("ほかの画像（深度・縮小画像など）");
  }
  return { exif, extras };
}

function pngChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = view.getUint32(i);
    const type = TEXT.decode(bytes.subarray(i + 4, i + 8));
    chunks.push({ type, start: i, end: i + 12 + length, data: bytes.subarray(i + 8, i + 8 + length) });
    i += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function readPng(bytes) {
  let exif = null;
  const extras = [];
  for (const { type, data } of pngChunks(bytes)) {
    if (type === "eXIf") exif = readTiff(data);
    else if (type === "tIME") extras.push("保存した日時");
    else if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      const key = TEXT.decode(data.subarray(0, data.indexOf(0)));
      extras.push(key === "XML:com.adobe.xmp" ? "XMP（編集ソフトの記録）" : `文字の情報「${key}」`);
    }
  }
  return { exif, extras };
}

function indexOfText(bytes, text, from = 0) {
  const codes = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = from; i <= bytes.length - codes.length; i++) {
    for (let j = 0; j < codes.length; j++) if (bytes[i + j] !== codes[j]) continue outer;
    return i;
  }
  return -1;
}

function findExif(bytes) {
  for (let at = indexOfText(bytes, "Exif\0\0"); at >= 0; at = indexOfText(bytes, "Exif\0\0", at + 1)) {
    const tiff = bytes.subarray(at + 6);
    const order = TEXT.decode(tiff.subarray(0, 2));
    if (order === "II" || order === "MM") return readTiff(tiff);
  }
  return null;
}

const findXmp = (bytes) => indexOfText(bytes, "<x:xmpmeta") >= 0;

// Reads the tags in TAGS (and the GPS ones) from a TIFF block (the inside of an Exif block).
export function readTiff(tiff) {
  try {
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const little = TEXT.decode(tiff.subarray(0, 2)) === "II";
    const reader = { tiff, view, little };
    const info = readIfd(reader, view.getUint32(4, little), TAGS);
    if (info.exifIfd) Object.assign(info, readIfd(reader, info.exifIfd, TAGS));
    if (info.gpsIfd) info.gps = gpsPosition(readIfd(reader, info.gpsIfd, GPS_TAGS));
    delete info.exifIfd;
    delete info.gpsIfd;
    return info;
  } catch (err) {
    console.warn(err);
    return null;
  }
}

function readIfd(reader, offset, names) {
  const { view, little } = reader;
  const out = {};
  const count = view.getUint16(offset, little);
  for (let n = 0; n < count; n++) {
    const entry = offset + 2 + n * 12;
    const name = names[view.getUint16(entry, little)];
    if (!name) continue;
    const value = readValue(reader, entry);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function readValue({ tiff, view, little }, entry) {
  const type = view.getUint16(entry + 2, little);
  const count = view.getUint32(entry + 4, little);
  const size = (TYPE_SIZE[type] ?? 1) * count;
  const at = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
  if (at + size > tiff.length) return undefined;
  if (type === 2) return UTF8.decode(tiff.subarray(at, at + count)).replace(/\0+$/, "").trim();
  if (type === 3) return view.getUint16(at, little);
  if (type === 4) return view.getUint32(at, little);
  if (type === 5 || type === 10) {
    const numbers = [];
    for (let i = 0; i < count; i++) {
      const top = view.getUint32(at + i * 8, little);
      const bottom = view.getUint32(at + i * 8 + 4, little);
      numbers.push(bottom ? top / bottom : 0);
    }
    return count === 1 ? numbers[0] : numbers;
  }
  if (type === 1 || type === 7) return tiff[at];
  return undefined;
}

// Degrees, minutes and seconds → { lat, lon } in degrees (south and west negative), or null.
function gpsPosition(gps) {
  if (!Array.isArray(gps.lat) || !Array.isArray(gps.lon)) return null;
  const degrees = ([d, m, s]) => d + m / 60 + s / 3600;
  const lat = degrees(gps.lat) * (gps.latRef === "S" ? -1 : 1);
  const lon = degrees(gps.lon) * (gps.lonRef === "W" ? -1 : 1);
  if (!lat && !lon) return null;
  return { lat, lon, alt: typeof gps.alt === "number" ? gps.alt : null };
}

/* ---------- removing ---------- */

// A JPEG without the information, the picture data untouched. When the photo was taken sideways
// a tiny Exif block with only the orientation is kept, so it still shows the right way up.
export function cleanJpeg(bytes, orientation = 1) {
  const keep = [bytes.subarray(0, 2)];
  if (orientation > 1 && orientation <= 8) keep.push(orientationBlock(orientation));
  let i = 2;
  for (const segment of jpegSegments(bytes)) {
    if (keepSegment(segment)) keep.push(bytes.subarray(segment.start, segment.end));
    i = segment.end;
  }
  keep.push(bytes.subarray(i, endOfImage(bytes, i)));
  return concat(keep);
}

function keepSegment({ marker, data }) {
  if (marker === APP0 || marker === APP14) return true;
  if (marker === APP2) return TEXT.decode(data.subarray(0, 11)) === "ICC_PROFILE";
  const isApp = marker >= 0xe1 && marker <= 0xef;
  return !isApp && marker !== COMMENT;
}

// Where the first picture ends. Phones put more pictures after it (depth maps, previews), and
// those may carry their own Exif, so everything after the end mark is left out.
function endOfImage(bytes, from) {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] !== 0xff) continue;
    const next = bytes[i + 1];
    if (next === END_OF_IMAGE) return i + 2;
    const inData = next === 0 || next === 0xff || (next >= 0xd0 && next <= 0xd7);
    if (inData) continue;
    // A marker between scans of a progressive JPEG (tables, the next scan): skip over it.
    i += 1 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return bytes.length;
}

// APP1 "Exif" with one tag: Orientation (big-endian TIFF).
function orientationBlock(orientation) {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0, 0, 0];
  const body = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff];
  const length = body.length + 2;
  return new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...body]);
}

export function cleanPng(bytes) {
  const keep = [bytes.subarray(0, 8)];
  for (const chunk of pngChunks(bytes)) {
    if (!PNG_INFO_CHUNKS.has(chunk.type)) keep.push(bytes.subarray(chunk.start, chunk.end));
  }
  return concat(keep);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
