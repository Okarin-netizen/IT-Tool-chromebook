// Checks the bundled libraries (shared/vendor/) against shared/js/vendor.js, without a browser:
//   - every folder in shared/vendor/ is in LIB, and every LIB folder exists
//   - every file in OFFLINE exists
//   - paths written out in full (imports, <script> tags) name a folder from LIB and a real file
//   - a tool that uses a library also keeps it for offline use (its registerOffline list)
//
//   node tests/vendor-check.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { LIB, OFFLINE } from "../shared/js/vendor.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "shared", "vendor");
const problems = [];
const fail = (message) => problems.push(message);

// 1. Folders and LIB match.
const folders = readdirSync(VENDOR).filter((name) => statSync(join(VENDOR, name)).isDirectory());
const libFolders = new Set(Object.values(LIB));
for (const folder of folders) if (!libFolders.has(folder)) fail(`shared/vendor/${folder} が vendor.js の LIB にない`);
for (const folder of libFolders) if (!folders.includes(folder)) fail(`vendor.js の LIB の ${folder} が shared/vendor/ にない`);

// 2. OFFLINE files exist.
for (const [group, urls] of Object.entries(OFFLINE)) {
  for (const url of urls) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) fail(`OFFLINE.${group} のファイルがない: ${relative(ROOT, path)}`);
  }
}

// The site's own source files (not the libraries, not git, not the tests).
function sourceFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path !== VENDOR && path !== join(ROOT, "tests")) sourceFiles(path, out);
    } else if (/\.(m?js|html)$/.test(name)) out.push(path);
  }
  return out;
}

// 3. Paths written out in full.
const FULL_PATH = /(?:shared\/vendor|\.\.\/vendor)\/([\w.-]+)\/([\w./-]+\.(?:m?js|wasm|ttf))/g;
for (const file of sourceFiles()) {
  const text = readFileSync(file, "utf8");
  for (const [, folder, rest] of text.matchAll(FULL_PATH)) {
    const where = relative(ROOT, file);
    if (!libFolders.has(folder)) fail(`${where}: ${folder} は vendor.js の LIB にない（古い版のまま？）`);
    else if (!existsSync(join(VENDOR, folder, rest))) fail(`${where}: shared/vendor/${folder}/${rest} がない`);
  }
}

// 4. A tool that uses a library keeps it for offline use. HEIC and OCR are left out on purpose:
// they are large and are kept after their first use.
const NEEDS = [
  [/loadPdfLib\(/, "pdfLib"],
  [/shared\/js\/pdf\.js"/, "pdfjs"],
  [/shared\/js\/font-jp\.js"/, "fontJp"],
  [/LIB\.mediabunny|mediabunny\.min\.js/, "mediabunny"],
];
for (const tool of readdirSync(ROOT)) {
  const dir = join(ROOT, tool);
  if (tool.startsWith(".") || !statSync(dir).isDirectory() || !existsSync(join(dir, "app.js"))) continue;
  const code = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const offline = code.slice(code.indexOf("registerOffline("));
  for (const [uses, group] of NEEDS) {
    if (uses.test(code) && !offline.includes(`OFFLINE.${group}`)) fail(`${tool}: OFFLINE.${group} を registerOffline の一覧に入れていない（オフラインで使えない）`);
  }
}

if (problems.length) {
  for (const p of problems) console.log(`NG  ${p}`);
  process.exit(1);
}
console.log("すべて通りました");
