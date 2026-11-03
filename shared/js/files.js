// Saving files and taking files dropped on the page.
import { kvDelete, kvGet } from "./kv.js";

export const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// "report.pdf" → "report" (".pdf" alone → "document")
export const baseName = (name) => name.replace(/\.pdf$/i, "") || "document";

// 1234567 → "1.23 MB". Counted in 1000s, as upload forms count, so a file shown as
// "500 KB" is never over a 500 KB limit.
export function formatSize(bytes) {
  const MB = 1000 * 1000;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 2 : 1)} MB`;
}

// The folder name of the tool this page is ("pdf-pages").
export const currentTool = () => location.pathname.replace(/[^/]*$/, "").split("/").filter(Boolean).at(-1) ?? "";

let capture = null;

// Saves happen in bursts (one file per page, a ZIP and its CSV), so names saved within this
// time are listed in one notice.
const NOTICE_GROUP_MS = 1500;
let noticeNames = [];
let noticeAt = 0;

// A notice that stays until it is closed: people who seldom use computers lose track of
// where a download went, and the short status message is gone before they look.
function showSavedNotice(name) {
  const now = Date.now();
  if (now - noticeAt > NOTICE_GROUP_MS) noticeNames = [];
  noticeAt = now;
  noticeNames.push(name);
  let box = document.getElementById("saved-notice");
  if (!box) {
    box = document.createElement("div");
    box.id = "saved-notice";
    box.className = "saved-notice";
    box.setAttribute("role", "status");
    document.body.append(box);
  }
  const what = noticeNames.length === 1 ? `「${noticeNames[0]}」` : `${noticeNames.length}個のファイル`;
  box.innerHTML = `<div class="saved-text"><strong></strong><span>ファイルアプリの「ダウンロード」で見られます。Classroom では「追加」→「ファイル」→「ダウンロード」から選べます。</span></div><button type="button" class="btn saved-close">閉じる</button>`;
  box.querySelector("strong").textContent = `「ダウンロード」フォルダに${what}を保存しました`;
  box.querySelector(".saved-close").addEventListener("click", () => (box.hidden = true));
  box.hidden = false;
}

export function download(blob, name) {
  if (capture) {
    capture.push(new File([blob], name, { type: blob.type }));
    return;
  }
  showSavedNotice(name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Runs `save` (which calls download()) and returns the files it would have downloaded.
export async function captureDownloads(save) {
  const files = [];
  capture = files;
  try {
    await save();
  } finally {
    capture = null;
  }
  return files;
}

// Files handed over by "次のツールで開く" (handoff.js) in the last few minutes.
async function takeHandoff() {
  if (location.hash !== "#handoff") return [];
  history.replaceState(null, "", location.pathname + location.search);
  const tool = currentTool();
  try {
    const job = await kvGet("handoff");
    await kvDelete("handoff");
    return job?.to === tool && Date.now() - job.at < 10 * 60 * 1000 ? job.files : [];
  } catch {
    return [];
  }
}

// Shows the drop overlay (#drop-overlay) while files are dragged over the page and passes
// dropped files to `onFiles`. Drags that carry no files (moving a page card) are left alone.
// Files opened with the installed tool from the Chromebook Files app ("Open with", set up by
// file_handlers in manifest.webmanifest) and files handed over from another tool arrive the
// same way.
export function onFileDrop(onFiles) {
  // After the rest of the tool's start-up code has run.
  setTimeout(async () => {
    const files = await takeHandoff();
    if (files.length) onFiles(files);
  });
  window.launchQueue?.setConsumer(async ({ files }) => {
    if (files?.length) onFiles(await Promise.all(files.map((handle) => handle.getFile())));
  });
  const overlay = document.getElementById("drop-overlay");
  const isFileDrag = (e) => [...e.dataTransfer.types].includes("Files");
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!isFileDrag(e)) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", (e) => {
    if (!isFileDrag(e)) return;
    if (--depth <= 0) {
      depth = 0;
      overlay.hidden = true;
    }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!isFileDrag(e)) return;
    depth = 0;
    overlay.hidden = true;
    onFiles([...e.dataTransfer.files]);
  });
}
