// Copying to the clipboard. Both return true when it worked.

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard permission: copy through a hidden textarea instead.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

// `png` is a PNG Blob, or a promise of one: Chrome wants the ClipboardItem made right away,
// while the click still counts as a user action.
export async function copyImage(png) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}
