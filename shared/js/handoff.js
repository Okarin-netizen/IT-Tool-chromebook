// "次のツールで開く": hands what a tool would save straight to another tool, so a photo can go
// 画像→PDF → ページ番号・透かし入れ → PDF圧縮 without saving and opening each file in between
// (like BentoPDF's and Stirling-PDF's chaining of tools). The files wait in IndexedDB; the next
// tool picks them up in onFileDrop (files.js) when it opens with "#handoff".
import { captureDownloads, currentTool } from "./files.js";
import { kvSet } from "./kv.js";
import { showStatus } from "./status.js";
import { TOOLS } from "./tools.js";
import { readZip } from "./unzip.js";

export const HANDOFF_KEY = "handoff";

// The type each file in a ZIP gets, by its extension; the next tools sort files by type.
const TYPES = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

// ZIPs (several pages or images) are opened up, since the next tools take the files themselves.
async function unpack(files) {
  const out = [];
  for (const file of files) {
    if (!/\.zip$/i.test(file.name)) {
      out.push(file);
      continue;
    }
    for (const entry of await readZip(await file.arrayBuffer())) {
      const name = entry.name.split("/").at(-1);
      const ext = name.split(".").at(-1).toLowerCase();
      out.push(new File([entry.bytes], name, { type: TYPES[ext] ?? "" }));
    }
  }
  return out;
}

async function sendTo(tool, save) {
  let files;
  try {
    files = await captureDownloads(save);
    if (!files.length) return; // nothing to save yet, or saving failed and said so
    files = await unpack(files);
    await kvSet(HANDOFF_KEY, { to: tool, at: Date.now(), files });
  } catch (err) {
    console.error(err);
    showStatus("次のツールに渡せませんでした。「保存」してから開いてください", { error: true });
    return;
  }
  // The work goes along to the next tool, so the tool's "unsaved changes" warning is skipped.
  window.addEventListener("beforeunload", (e) => e.stopImmediatePropagation(), { capture: true });
  location.href = new URL(`../${tool}/#handoff`, location.href).href;
}

// Adds a "次のツールで開く" menu right after `saveBtn`. `save` is the tool's own save; it must
// return a promise that settles after download(). `kind` is what it saves: "pdf" or "image".
export function addNextTool({ saveBtn, save, kind }) {
  const here = currentTool();
  // Tools made for this kind first (画像→PDF before PDF文字取り出し for a photo).
  const targets = TOOLS.filter((tool) => tool.takes?.includes(kind) && tool.id !== here)
    .sort((a, b) => (a.takes[0] !== kind) - (b.takes[0] !== kind));
  const btn = menuButton();
  const menu = document.createElement("div");
  menu.className = "next-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const title = document.createElement("div");
  title.className = "next-title";
  title.textContent = "保存せずに次のツールで開く";
  menu.append(title, ...targets.map(({ id, name }) => menuItem(id, name, () => {
    close();
    sendTo(id, save);
  })));
  const wrap = document.createElement("div");
  wrap.className = "next-wrap";
  wrap.append(btn, menu);
  saveBtn.after(wrap);

  function close() {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  }
  btn.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector(".next-item")?.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!wrap.contains(e.target)) close();
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      btn.focus();
    }
  });
  // Usable whenever saving is.
  const sync = () => (btn.disabled = saveBtn.disabled);
  new MutationObserver(sync).observe(saveBtn, { attributes: true, attributeFilter: ["disabled"] });
  sync();
}

function menuButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn next-btn";
  btn.title = "保存せずに、できたファイルを別のツールで開く";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6"/></svg>次のツールで開く';
  return btn;
}

function menuItem(id, name, onClick) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "next-item";
  item.setAttribute("role", "menuitem");
  item.dataset.tool = id;
  item.textContent = name;
  item.addEventListener("click", onClick);
  return item;
}
