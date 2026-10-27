// Saving files and taking files dropped on the page.

export const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// "report.pdf" → "report"
export const baseName = (name) => name.replace(/\.pdf$/i, "");

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Shows the drop overlay (#drop-overlay) while files are dragged over the page and passes
// dropped files to `onFiles`. Drags that carry no files (moving a page card) are left alone.
// Files opened with the installed tool from the Chromebook Files app ("Open with", set up by
// file_handlers in manifest.webmanifest) arrive the same way.
export function onFileDrop(onFiles) {
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
