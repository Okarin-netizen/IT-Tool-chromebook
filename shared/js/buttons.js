// A small button that shows one of the page's line icons (a <symbol id="i-…"> in its sprite).
// `label` is shown on hover and read out by screen readers; `text` adds a word under the icon.
// `onClick` may be left out when the caller listens on a parent element instead.
export function iconButton(icon, label, onClick, { className = "btn icon", disabled = false, text = "" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.innerHTML = `<svg class="i" aria-hidden="true"><use href="#${icon}"/></svg>`;
  if (text) button.insertAdjacentHTML("beforeend", `<span class="mini-text">${text}</span>`);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}
