// pdf-lib and fontkit are large and only needed when a PDF is saved (or its pages are read),
// so they are loaded the first time a tool asks for them instead of when the page opens.
import { loadScript } from "./load-script.js";

export const loadPdfLib = () => loadScript("pdf-lib-1.17.1/pdf-lib.min.js", "PDFLib");
export const loadFontkit = () => loadScript("fontkit-1.1.1/fontkit.umd.min.js", "fontkit");
