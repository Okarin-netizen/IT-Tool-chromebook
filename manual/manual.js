// 説明書: with no hash, the list of all tools; with #<tool folder>, that tool's manual.
// The content is in data.js. Each manual prints on one A4 sheet (see manual.css).
import { MANUAL } from "./data.js";
import { registerOffline } from "../shared/js/offline.js";
import { LAST_UPDATED, formatDate } from "../shared/js/changelog.js";

const $ = (id) => document.getElementById(id);
const WHO = { teacher: "先生用", student: "生徒用", all: "生徒も先生も" };
const PAGE_TITLE = "説明書 - Chromebook便利ツール";

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function renderList() {
  const groups = [...new Set(MANUAL.map((t) => t.group))];
  $("groups").replaceChildren(...groups.map((group) => {
    const items = MANUAL.filter((t) => t.group === group).map((t) => {
      const icon = el("img", { src: `../${t.id}/icon.svg`, alt: "", width: 32, height: 32 });
      const who = t.who === "teacher" ? el("span", { className: "for", textContent: "先生用" }) : "";
      return el("li", {}, el("a", { href: `#${t.id}` }, icon, el("span", { textContent: t.name }), who));
    });
    return el("section", { className: "m-group" }, el("h2", { textContent: group }), el("ul", { className: "m-list" }, ...items));
  }));
}

function renderManual(t) {
  document.documentElement.style.setProperty("--tool", t.color);
  $("m-group").textContent = t.group;
  $("m-icon").src = `../${t.id}/icon.svg`;
  $("m-name").replaceChildren(t.name, el("span", { className: "tag", textContent: WHO[t.who] }));
  $("m-lead").textContent = t.lead;
  $("m-open").href = `../${t.id}/`;
  $("m-when").replaceChildren(...t.when.map((w) => el("li", { textContent: w })));
  $("m-steps").replaceChildren(...t.steps.map((s) => el("li", {}, el("b", { textContent: s.t }), el("span", { textContent: s.d }))));
  $("m-shot").src = `shots/${t.id}.webp`;
  $("m-shot").alt = `${t.name}の画面`;
  $("m-buttons").replaceChildren(...t.buttons.map(([name, what]) =>
    el("tr", {}, el("th", { scope: "row", textContent: name }), el("td", { textContent: what }))));
  $("m-qa").replaceChildren(...t.qa.flatMap(([q, a]) => [el("dt", { textContent: q }), el("dd", { textContent: a })]));
  $("m-tips").replaceChildren(...t.tips.map((w) => el("li", { textContent: w })));
  $("m-note").textContent = t.note;
  $("m-url").textContent = new URL(`../${t.id}/`, location.href).href;
  document.title = `${t.name}の説明書 - Chromebook便利ツール`;
}

function show() {
  const id = decodeURIComponent(location.hash.slice(1));
  const tool = MANUAL.find((t) => t.id === id);
  $("list").hidden = Boolean(tool);
  $("manual").hidden = !tool;
  if (tool) {
    renderManual(tool);
    window.scrollTo(0, 0);
    $("m-name").focus({ preventScroll: true });
  } else {
    document.title = PAGE_TITLE;
    document.documentElement.style.removeProperty("--tool");
  }
}

$("m-print").addEventListener("click", () => window.print());
window.addEventListener("hashchange", show);
for (const node of document.querySelectorAll(".updated")) node.textContent = formatDate(LAST_UPDATED);
renderList();
show();

// Every manual with its screen picture and icon (about 1MB in all) is kept for offline use.
registerOffline([
  "./", "index.html", "manual.css", "manual.js", "data.js",
  ...MANUAL.flatMap((t) => [`shots/${t.id}.webp`, `../${t.id}/icon.svg`]),
]);
