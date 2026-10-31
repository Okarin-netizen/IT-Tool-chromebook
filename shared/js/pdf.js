// pdf.js set up for this site: worker, character maps and fonts from shared/vendor.
import * as pdfjsLib from "../vendor/pdfjs-4.10.38/pdf.min.mjs";
import { loadPdfLib } from "./pdf-lib.js";
import { askPassword } from "./password.js";
import { canvasToBlob } from "./canvas.js";

const PDFJS = new URL("../vendor/pdfjs-4.10.38/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";

export { pdfjsLib };

// The last password that worked is tried first on the next PDF, so a class set of files
// locked with the same password asks only once. It is kept in memory only.
let lastPassword = null;

// Starts opening a PDF and returns { promise, destroy } like pdf.js's loading task.
// pdf.js detaches the buffer it is given, so pass a copy when the bytes are used again.
// A PDF that needs a password to open asks for it (`name` is shown in the dialog); if the user
// gives up, the promise rejects with an error named "PasswordException".
export function openPdf(data, { name } = {}) {
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: PDFJS + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: PDFJS + "standard_fonts/",
  });
  let tried = null;
  let cancelled = false;
  task.onPassword = async (update, reason) => {
    if (reason === pdfjsLib.PasswordResponses.NEED_PASSWORD && lastPassword && tried === null) {
      update((tried = lastPassword));
      return;
    }
    // A wrong saved password counts as the first try, not as the user's mistake.
    const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD && tried !== lastPassword;
    const password = await askPassword(name, { retry });
    if (password === null) {
      cancelled = true;
      task.destroy();
    } else {
      update((tried = password));
    }
  };
  const promise = task.promise.then(
    (pdf) => {
      if (tried !== null) lastPassword = tried;
      return pdf;
    },
    (err) => {
      if (!cancelled) throw err;
      const e = new Error("password not given");
      e.name = "PasswordException";
      throw e;
    },
  );
  return { promise, destroy: () => task.destroy() };
}

export const isPasswordCancelled = (err) => err?.name === "PasswordException";

// The message shown when openPdf fails. `fallback` covers everything except a password the
// user did not give, so each tool can keep its own wording for a broken file.
export function openPdfError(err, fallback = "PDFを読み込めませんでした") {
  return isPasswordCancelled(err) ? "パスワードが入力されなかったので開けませんでした" : fallback;
}

// Draws a page on a new canvas and returns it. The paper is painted white first, because
// pdf.js leaves it transparent, which turns black in a JPEG.
// `rotation` defaults to the page's own; `annotationMode` is passed on to pdf.js.
export async function renderPage(page, scale, { rotation, annotationMode } = {}) {
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, annotationMode }).promise;
  return canvas;
}

// Adds a pdf.js page to the pdf-lib `doc` as a JPEG picture of itself, at its own size.
export async function addPageImage(doc, page, { scale = 2, quality = 0.9, rotation, annotationMode } = {}) {
  const canvas = await renderPage(page, scale, { rotation, annotationMode });
  const blob = await canvasToBlob(canvas, "image/jpeg", quality);
  canvas.width = canvas.height = 0;
  const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const { width, height } = page.getViewport({ scale: 1, rotation });
  doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
}

// pdf-lib cannot decrypt, so a protected (encrypted) PDF is rebuilt from page images
// rendered by pdf.js, the same as printing it. `onPage(num, count)` reports progress.
export async function rasterizePdf(pdf, { scale = 2, quality = 0.9, annotationMode, onPage } = {}) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  for (let num = 1; num <= pdf.numPages; num++) {
    onPage?.(num, pdf.numPages);
    const page = await pdf.getPage(num);
    await addPageImage(doc, page, { scale, quality, annotationMode });
    page.cleanup();
  }
  return doc;
}
