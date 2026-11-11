// Loads a library from shared/vendor with a <script> tag the first time it is needed, for
// libraries that put themselves on `window` (pdf-lib, tesseract.js, Mediabunny…). Asking again
// while it loads, or after, gives the same library without loading it twice.
const VENDOR = new URL("../vendor/", import.meta.url).href;
const loading = new Map();

export function loadScript(path, name) {
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
