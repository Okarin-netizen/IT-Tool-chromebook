// What this site keeps in the browser, and a way to erase all of it (このサイトについて).
// Every key starts with a tool's folder name ("class-picker-v1", "pdf-image.format",
// "pdf-grade:session") or "portal-". GitHub Pages serves other sites from the same origin, so
// only these keys are removed, never the whole localStorage.
import { TOOLS } from "./tools.js";
import { kvCount, kvClear } from "./kv.js"; // PDF一括採点's work in progress, 次のツールで開く

const OWNERS = [...TOOLS.map((t) => t.id), "portal"];

export function isSiteKey(key) {
  return OWNERS.some((id) => {
    const rest = key.startsWith(id) ? key.slice(id.length) : null;
    return rest === "" || /^[-.:]/.test(rest ?? "");
  });
}

function siteKeys() {
  try {
    return Object.keys(localStorage).filter(isSiteKey);
  } catch {
    return [];
  }
}

// How many things are kept now, so the page can say "nothing to erase".
export async function countSiteData() {
  return siteKeys().length + ((await kvCount()) ?? 0);
}

// The offline copy of the pages (Cache Storage) is kept: it holds no one's data.
export async function clearSiteData() {
  for (const key of siteKeys()) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Blocked site data: nothing was stored either.
    }
  }
  await kvClear();
}
