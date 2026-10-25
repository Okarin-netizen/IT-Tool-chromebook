// pdf-lib and fontkit are large and only needed when a PDF is saved (or its pages are read),
// so they are loaded the first time a tool asks for them instead of when the page opens.
const VENDOR = new URL("../vendor/", import.meta.url).href;
const loading = new Map();

function loadScript(path, name) {
  if (window[name]) return Promise.resolve(window[name]);
  if (!loading.has(path)) {
    loading.set(path, new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = VENDOR + path;
      script.onload = () => resolve(window[name]);
      script.onerror = () => {
        loading.delete(path); // try again next time
        script.remove();
        reject(new Error(`could not load ${path}`));
      };
      document.head.append(script);
    }));
  }
  return loading.get(path);
}

export const loadPdfLib = () => loadScript("pdf-lib-1.17.1/pdf-lib.min.js", "PDFLib");
export const loadFontkit = () => loadScript("fontkit-1.1.1/fontkit.umd.min.js", "fontkit");
