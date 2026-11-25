// Checks, without a browser, that every place which names a tool agrees with shared/js/tools.js:
// its page (<title>, the app bar, manifest), its color (style.css --accent, theme-color,
// manifest, 説明書, the icon's tile), README.md, and that line icons with the same name look
// the same on every page.
// Run it after adding or renaming a tool:  node tests/consistency.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../shared/js/tools.js";
import { MANUAL } from "../manual/data.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const exists = (file) => fs.existsSync(path.join(ROOT, file));
const problems = [];
const expect = (ok, message) => {
  if (!ok) problems.push(message);
};

// ---------- each tool's own files ----------
const manualById = new Map(MANUAL.map((entry) => [entry.id, entry]));
const readme = read("README.md");

// _template/ is checked too, since new tools start as a copy of it (it is on no list).
const TEMPLATE = { id: "_template", name: "新しいツール", template: true };

for (const { id, name, template } of [...TOOLS, TEMPLATE]) {
  for (const file of ["index.html", "style.css", "app.js", "icon.svg", "manifest.webmanifest"]) {
    expect(exists(`${id}/${file}`), `${id}/${file} がない`);
  }
  if (!exists(`${id}/index.html`)) continue;
  const html = read(`${id}/index.html`);
  const manifest = JSON.parse(read(`${id}/manifest.webmanifest`));
  const title = html.match(/<title>(.*?)<\/title>/)?.[1];
  const appTitle = html.match(/class="app-title"[^>]*>([^<]*)</)?.[1];
  expect(title === name, `${id}: <title> が「${title}」（tools.js は「${name}」）`);
  expect(appTitle === name, `${id}: 上のバーの名前が「${appTitle}」（tools.js は「${name}」）`);
  expect(manifest.name === name, `${id}: manifest の name が「${manifest.name}」`);
  expect(template || readme.includes(`| [\`${id}/\`](${id}/) | ${name} |`), `${id}: README.md の表に「${name}」の行がない`);

  // One color per tool, written in five places.
  const colors = {
    "style.css --accent": read(`${id}/style.css`).match(/--accent:\s*([^;]+);/)?.[1].trim(),
    "theme-color": html.match(/name="theme-color" content="([^"]+)"/)?.[1],
    "manifest theme_color": manifest.theme_color,
    "manual/data.js color": template ? manifest.theme_color : manualById.get(id)?.color,
    "icon.svg tile": read(`${id}/icon.svg`).match(/<rect [^>]*fill="([^"]+)"/)?.[1],
  };
  const distinct = new Set(Object.values(colors).map((c) => c?.toLowerCase()));
  expect(distinct.size === 1, `${id}: 色がそろっていない ${JSON.stringify(colors)}`);
}

// ---------- line icons ----------
// Each page draws its icons from an inline <svg class="sprite">. An icon name (i-trash, i-copy…)
// must look the same on every page, so copy the <symbol> from a tool that already has it.
const symbolPattern = /<symbol id="(i-[^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g;
const drawings = new Map(); // icon name → drawing → pages
const pages = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && exists(`${entry.name}/index.html`))
  .map((entry) => entry.name);
for (const page of pages) {
  for (const [, icon, body] of read(`${page}/index.html`).matchAll(symbolPattern)) {
    const drawing = body.replace(/\s+/g, " ").trim();
    if (!drawings.has(icon)) drawings.set(icon, new Map());
    const byDrawing = drawings.get(icon);
    byDrawing.set(drawing, [...(byDrawing.get(drawing) ?? []), page]);
  }
}
for (const [icon, byDrawing] of drawings) {
  if (byDrawing.size === 1) continue;
  const list = [...byDrawing.values()].map((where) => where.join("・")).join(" / ");
  problems.push(`アイコン ${icon} の絵がページによってちがう: ${list}`);
}

// ---------- result ----------
if (problems.length) {
  console.log(problems.map((p) => `NG ${p}`).join("\n"));
  process.exit(1);
}
console.log("すべて通りました");
