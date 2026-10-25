// Registers the site-wide service worker (../../sw.js) and asks it to keep this page's files
// for offline use. `files` are paths relative to the page.
const ROOT = new URL("../../", import.meta.url); // the repository root

export async function registerOffline(files = []) {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL("sw.js", ROOT), { scope: ROOT.pathname });
    const worker = await activeWorker(reg);
    worker.postMessage({ type: "precache", urls: files.map((f) => new URL(f, location.href).href) });
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
