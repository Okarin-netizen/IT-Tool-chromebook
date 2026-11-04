// What the site's own pages (index.html, changelog.html, about.html) do alike: keep
// themselves for offline use, show the "最終更新" date and list the update history.
import { registerOffline } from "./offline.js";
import { LAST_UPDATED, formatDate } from "./changelog.js";

const SITE_PAGES = ["./", "index.html", "changelog.html", "about.html"];

// Call once at the end of each site page. `more` are extra files the page needs offline.
export function setUpSitePage(more = []) {
  registerOffline([...SITE_PAGES, ...more]);
  for (const el of document.querySelectorAll(".updated")) el.textContent = formatDate(LAST_UPDATED);
}

// Fills the history table `tbody`: one row per day, the date on the left, its items on the right.
export function renderChangelog(tbody, entries) {
  tbody.replaceChildren(...entries.map((entry) => {
    const date = document.createElement("th");
    date.textContent = formatDate(entry.date);
    const list = document.createElement("ul");
    list.append(...entry.items.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
    const items = document.createElement("td");
    items.append(list);
    const row = document.createElement("tr");
    row.append(date, items);
    return row;
  }));
}
