// "次のツールで開く": hands what a tool would save straight to another tool, so a photo can go
// 画像→PDF → ページ番号・透かし入れ → PDF圧縮 without saving and opening each file in between
// (like BentoPDF's and Stirling-PDF's chaining of tools). The files wait in IndexedDB; the next
// tool picks them up in onFileDrop (files.js) when it opens with "#handoff".
import { captureDownloads, currentTool } from "./files.js";
import { kvSet } from "./kv.js";
import { showStatus } from "./status.js";
import { readZip } from "./unzip.js";

export const HANDOFF_KEY = "handoff";

const PDF_TOOLS = [
  ["pdf-pages", "PDF結合・分割・回転"],
  ["pdf-text", "PDF文字入れ"],
  ["pdf-sign", "PDFに手書き・署名"],
  ["pdf-stamp", "ページ番号・透かし入れ"],
  ["pdf-booklet", "冊子印刷"],
  ["pdf-compress", "PDF圧縮"],
  ["pdf-image", "PDF→画像"],
  ["pdf-extract", "PDF文字取り出し"],
];
const IMAGE_TOOLS = [
  ["image-pdf", "画像→PDF"],
  ["image-resize", "画像を小さく"],
  ["image-annotate", "画像に書き込み"],
];

// ZIPs (several pages or images) are opened up, since the next tools take the files themselves.
async function unpack(files) {
  const out = [];
  for (const file of files) {
    if (!/\.zip$/i.test(file.name)) {
      out.push(file);
      continue;
    }
    for (const entry of await readZip(await file.arrayBuffer())) {
      const type = /\.pdf$/i.test(entry.name) ? "application/pdf" : /\.png$/i.test(entry.name) ? "image/png" : /\.jpe?g$/i.test(entry.name) ? "image/jpeg" : /\.webp$/i.test(entry.name) ? "image/webp" : "";
      out.push(new File([entry.bytes], entry.name.split("/").at(-1), { type }));
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
  const targets = (kind === "pdf" ? PDF_TOOLS : IMAGE_TOOLS).filter(([dir]) => dir !== here);
  const wrap = document.createElement("div");
  wrap.className = "next-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn next-btn";
  btn.title = "保存せずに、できたファイルを別のツールで開く";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6"/></svg>次のツールで開く';
  const menu = document.createElement("div");
  menu.className = "next-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const title = document.createElement("div");
  title.className = "next-title";
  title.textContent = "保存せずに次のツールで開く";
  menu.append(title);
  for (const [dir, name] of targets) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "next-item";
    item.setAttribute("role", "menuitem");
    item.dataset.tool = dir;
    item.textContent = name;
    item.addEventListener("click", () => {
      close();
      sendTo(dir, save);
    });
    menu.append(item);
  }
  wrap.append(btn, menu);
  saveBtn.after(wrap);

  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
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
