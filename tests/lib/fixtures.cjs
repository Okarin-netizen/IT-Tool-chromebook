// Test files made on the fly: PDFs (with pdf-lib from the repository), PNG images, and a ZIP reader.
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..", "..");

function findPdfLib() {
  const candidates = ["shared/vendor/pdf-lib-1.17.1/pdf-lib.min.js", "pdf-text/lib/pdf-lib.min.js"];
  const found = candidates.map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
  if (!found) throw new Error("pdf-lib が見つかりません");
  return require(found);
}
const PDFLib = findPdfLib();

/* ---------- PNG ---------- */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

// A colourful RGB picture with some noise, so it does not compress to nothing.
const pngCache = new Map();
function png(width, height) {
  const key = `${width}x${height}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 64) - 32;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = Math.max(0, Math.min(255, (x * 255) / width + noise()));
      raw[i + 1] = Math.max(0, Math.min(255, (y * 255) / height + noise()));
      raw[i + 2] = Math.max(0, Math.min(255, 160 + noise()));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  pngCache.set(key, out);
  return out;
}

/* ---------- PDF ---------- */

const pdfCache = new Map();
const pdfKey = (pages, image) => `${pages}${image ? "-image" : ""}`;

async function makePdf(pages, { image = false } = {}) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const picture = image ? await doc.embedPng(png(1200, 900)) : null;
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Smoke test page ${n}`, { x: 60, y: 760, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawRectangle({ x: 60, y: 600, width: 200, height: 100, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 2 });
    if (picture) page.drawImage(picture, { x: 60, y: 120, width: 475, height: 356 });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// A one-page form with a text field "name" and a check box "agree" (an AcroForm).
async function makeFormPdf() {
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Name:", { x: 60, y: 742, size: 14, font });
  page.drawText("Agree:", { x: 60, y: 682, size: 14, font });
  const form = doc.getForm();
  form.createTextField("name").addToPage(page, { x: 130, y: 735, width: 240, height: 24 });
  form.createCheckBox("agree").addToPage(page, { x: 130, y: 675, width: 18, height: 18 });
  return Buffer.from(await doc.save());
}

// PDFs are built once up front because building is async and the tests ask for them often.
async function prepare() {
  for (const [pages, image] of [[1, false], [2, false], [3, false], [6, false], [2, true]]) {
    pdfCache.set(pdfKey(pages, image), await makePdf(pages, { image }));
  }
  pdfCache.set("form", await makeFormPdf());
}

function pdf(pages, { image = false } = {}) {
  const bytes = pdfCache.get(pdfKey(pages, image));
  if (!bytes) throw new Error(`テスト用PDF（${pages}ページ）が用意されていません`);
  return bytes;
}

/* ---------- ZIP ---------- */

// Names of the entries in a ZIP file, read from its central directory.
function zipNames(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("ZIPファイルではありません");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIPの目次が壊れています");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const formPdf = () => pdfCache.get("form");


/* ---------- Exif ---------- */

// An Exif block (APP1) like a phone's: maker, model, the time taken and where (GPS), big-endian.
function exifBlock({ make = "Apple", model = "iPhone 15", taken = "2026:11:04 08:15:30", lat = [35, 41, 22.2], lon = [139, 41, 30.1], orientation = 1 } = {}) {
  const ascii = (text) => Buffer.from(text + "\0", "latin1");
  const short = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const long = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const rationals = (numbers) => Buffer.concat(numbers.map((n) => Buffer.concat([long(Math.round(n * 100)), long(100)])));
  // Lays out IFDs one after another; values over 4 bytes go after each IFD.
  const ifds = [
    [[0x010f, 2, ascii(make)], [0x0110, 2, ascii(model)], [0x0112, 3, short(orientation)], [0x8769, 4, null], [0x8825, 4, null]],
    [[0x9003, 2, ascii(taken)]],
    [[1, 2, Buffer.from("N\0\0\0", "latin1")], [2, 5, rationals(lat)], [3, 2, Buffer.from("E\0\0\0", "latin1")], [4, 5, rationals(lon)]],
  ];
  const sizes = ifds.map((list) => 2 + list.length * 12 + 4 + list.reduce((sum, [, , value]) => sum + (value && value.length > 4 ? value.length : 0), 0));
  const offsets = [8, 8 + sizes[0], 8 + sizes[0] + sizes[1]];
  ifds[0][3][2] = long(offsets[1]);
  ifds[0][4][2] = long(offsets[2]);
  const parts = [Buffer.from("MM\0\x2a", "latin1"), long(8)];
  ifds.forEach((list, n) => {
    let extra = offsets[n] + 2 + list.length * 12 + 4;
    const head = [short(list.length)];
    const tail = [];
    for (const [tag, type, value] of list) {
      const COUNTS = { 2: value.length, 3: 1, 4: 1, 5: value.length / 8 };
      const count = COUNTS[type];
      const field = Buffer.alloc(4);
      if (value.length <= 4) value.copy(field);
      else { field.writeUInt32BE(extra); tail.push(value); extra += value.length; }
      head.push(short(tag), short(type), long(count), field);
    }
    parts.push(...head, long(0), ...tail);
  });
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), ...parts]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), length, body]);
}

// A JPEG with a phone's Exif (with GPS) put in right after its start.
function withExif(jpeg, options) {
  return Buffer.concat([jpeg.subarray(0, 2), exifBlock(options), jpeg.subarray(2)]);
}

module.exports = { PDFLib, prepare, pdf, formPdf, png, zipNames, withExif };
