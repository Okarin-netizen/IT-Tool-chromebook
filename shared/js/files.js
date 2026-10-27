// Saving files and taking files dropped on the page.
import { kvDelete, kvGet } from "./kv.js";

export const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// "report.pdf" → "report"
export const baseName = (name) => name.replace(/\.pdf$/i, "");

// The folder name of the tool this page is ("pdf-pages").
export const currentTool = () => location.pathname.replace(/[^/]*$/, "").split("/").filter(Boolean).at(-1) ?? "";

let capture = null;

export function download(blob, name) {
  if (capture) {
    capture.push(new File([blob], name, { type: blob.type }));
    return;
  }
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
