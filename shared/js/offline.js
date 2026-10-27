// Registers the site-wide service worker (../../sw.js) and asks it to keep this page's files
// for offline use. `files` are paths relative to the page.
import { loadJson, saveJson } from "./storage.js";

const ROOT = new URL("../../", import.meta.url); // the repository root
// Tools opened lately, newest first, for "最近使ったもの" on the top page.
export const RECENT_KEY = "portal-recent-v1";
// Shared files are small, so every page keeps all of them. The first visit is not yet
// controlled by the worker, so anything it loads has to be in the list to open offline later.
const SHARED = [
  "css/base.css",
  "js/offline.js", "js/status.js", "js/files.js", "js/storage.js", "js/pdf.js", "js/font-jp.js",
  "js/zip.js", "js/unzip.js", "js/ink.js", "js/history.js", "js/lazy.js", "js/page-viewer.js", "js/pdf-lib.js", "js/password.js", "js/kv.js", "js/heic.js", "js/handoff.js",
].map((f) => new URL(`shared/${f}`, ROOT).href);

function rememberVisit() {
  const tool = location.pathname.slice(ROOT.pathname.length).split("/")[0];
  if (!tool || !location.pathname.startsWith(ROOT.pathname) || /^[_.]|^tests$|\./.test(tool)) return;
  const list = loadJson(RECENT_KEY, []);
  saveJson(RECENT_KEY, [tool, ...(Array.isArray(list) ? list : []).filter((t) => t !== tool)].slice(0, 8));
}

export async function registerOffline(files = []) {
  rememberVisit();
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL("sw.js", ROOT), { scope: ROOT.pathname });
    const worker = await activeWorker(reg);
    worker.postMessage({ type: "precache", urls: [...files.map((f) => new URL(f, location.href).href), ...SHARED] });
    // Old per-tool workers (…/pdf-text/ etc.) take priority over the root one, so remove them.
    // Only this site's folders are checked: other sites on the same domain are left alone.
    const old = (await navigator.serviceWorker.getRegistrations())
      .filter((r) => r.scope !== reg.scope && r.scope.startsWith(reg.scope));
    await Promise.all(old.map((r) => r.unregister()));
    // Their caches go on a later visit, once no old worker can still be using them.
    if (!old.length) worker.postMessage({ type: "drop-legacy" });
  } catch {
    // Offline use is optional; the tool still works online.
  }
}

// `navigator.serviceWorker.ready` is not used: while an old per-tool worker is still
// registered, it would return that one instead of the root worker.
function activeWorker(reg) {
  if (reg.active) return Promise.resolve(reg.active);
  const sw = reg.installing || reg.waiting;
  return new Promise((resolve) => {
    sw.addEventListener("statechange", () => {
      if (sw.state === "activated") resolve(sw);
    });
  });
}
