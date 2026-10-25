// pdf.js set up for this site: worker, character maps and fonts from shared/vendor.
import * as pdfjsLib from "../vendor/pdfjs-4.10.38/pdf.min.mjs";

const PDFJS = new URL("../vendor/pdfjs-4.10.38/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";

export { pdfjsLib };

// Starts opening a PDF and returns pdf.js's loading task (`.promise` gives the document).
// pdf.js detaches the buffer it is given, so pass a copy when the bytes are used again.
export function openPdf(data) {
  return pdfjsLib.getDocument({
    data,
    cMapUrl: PDFJS + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: PDFJS + "standard_fonts/",
  });
}

// pdf-lib cannot decrypt, so a protected (encrypted) PDF is rebuilt from page images
// rendered by pdf.js, the same as printing it. `onPage(num, count)` reports progress.
export async function rasterizePdf(pdf, { scale = 2, onPage } = {}) {
  const doc = await window.PDFLib.PDFDocument.create();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  for (let num = 1; num <= pdf.numPages; num++) {
    onPage?.(num, pdf.numPages);
    const page = await pdf.getPage(num);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const { width, height } = page.getViewport({ scale: 1 });
    doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    page.cleanup();
  }
  canvas.width = canvas.height = 0;
  return doc;
}
