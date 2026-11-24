// Turning figures into files: a PNG to paste into a handout, or an A4 PDF with one figure per page.
import { figureSvg, placeName } from "./drawing.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { loadPdfLib } from "../shared/js/pdf-lib.js";

const IMAGE_WIDTH = 2400; // px: sharp when printed across an A4 page
const A4_LONG = 841.89; // pt
const A4_SHORT = 595.28; // pt
const PAGE_MARGIN = 28; // pt, about 1 cm

// Draws the figure's SVG on a canvas. The browser draws the words with the Chromebook's own fonts.
async function figureCanvas(doc, index, pixels) {
  const svg = figureSvg(doc, index, pixels);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function figurePng(doc, index, pixels = IMAGE_WIDTH) {
  return canvasToBlob(await figureCanvas(doc, index, pixels), "image/png");
}

// One A4 page per figure, turned the same way as the yard, the figure as large as fits.
export async function figuresPdf(doc, indices) {
  const { PDFDocument } = await loadPdfLib();
  const pdf = await PDFDocument.create();
  pdf.setTitle(indices.length === 1 ? doc.figures[indices[0]].name : placeName(doc));
  const landscape = doc.width >= doc.height;
  const pageWidth = landscape ? A4_LONG : A4_SHORT;
  const pageHeight = landscape ? A4_SHORT : A4_LONG;
  for (const index of indices) {
    const png = await figurePng(doc, index);
    const image = await pdf.embedPng(await png.arrayBuffer());
    const scale = Math.min((pageWidth - PAGE_MARGIN * 2) / image.width, (pageHeight - PAGE_MARGIN * 2) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
  }
  return pdf.save();
}
