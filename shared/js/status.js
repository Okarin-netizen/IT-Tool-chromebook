// The short message at the bottom of the page (<div id="status" class="status">).
let timer = 0;

// Hides itself after `ms`; `sticky` keeps it until the next message (for work in progress).
export function showStatus(text, { error = false, sticky = false, ms = error ? 6000 : 2500 } = {}) {
  const el = document.getElementById("status");
  clearTimeout(timer);
  el.textContent = text;
  el.classList.toggle("error", error);
  el.hidden = false;
  if (!sticky) timer = setTimeout(() => (el.hidden = true), ms);
}

export function hideStatus() {
  clearTimeout(timer);
  document.getElementById("status").hidden = true;
}
