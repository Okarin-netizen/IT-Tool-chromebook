// A small key-value store in IndexedDB (like the idb-keyval library Excalidraw uses), for
// things too big for localStorage, such as the PDFs of work in progress. Every call resolves
// even when IndexedDB is not available (a private window): reads give undefined.
const DB = "itc-kv";
const STORE = "kv";
let opening = null;

function db() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // A store that could not be opened (site data blocked for a moment) is tried again next time.
    opening.catch(() => (opening = null));
  }
  return opening;
}

async function run(mode, fn) {
  try {
    const tx = (await db()).transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    return await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("kv:", err);
    return undefined;
  }
}

export const kvGet = (key) => run("readonly", (s) => s.get(key));
export const kvSet = (key, value) => run("readwrite", (s) => s.put(value, key));
export const kvDelete = (key) => run("readwrite", (s) => s.delete(key));
export const kvCount = () => run("readonly", (s) => s.count());
// Erases everything kept here (このサイトについて「全部消す」).
export const kvClear = () => run("readwrite", (s) => s.clear());
