// pdf-lib and fontkit are large and only needed when a PDF is saved (or its pages are read),
// so they are loaded the first time a tool asks for them instead of when the page opens.
import { loadScript } from "./load-script.js";
import { LIB } from "./vendor.js";

export const loadPdfLib = () => loadScript(`${LIB.pdfLib}/pdf-lib.min.js`, "PDFLib");
export const loadFontkit = () => loadScript(`${LIB.fontkit}/fontkit.umd.min.js`, "fontkit");
