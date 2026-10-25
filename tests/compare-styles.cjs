#!/usr/bin/env node
// Compares two folders written by `node tests/smoke.cjs --styles <dir>` and lists every element
// whose computed style differs. Also compares the screenshots saved next to them, if given.
//
//   node tests/compare-styles.cjs <before-dir> <after-dir>
"use strict";

const fs = require("fs");
const path = require("path");

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("使い方: node tests/compare-styles.cjs <前のフォルダ> <後のフォルダ>");
  process.exit(2);
}

let differences = 0;
for (const file of fs.readdirSync(a).filter((f) => f.endsWith(".json")).sort()) {
  const before = JSON.parse(fs.readFileSync(path.join(a, file), "utf8"));
  const afterPath = path.join(b, file);
  if (!fs.existsSync(afterPath)) {
    console.log(`${file}: 後のフォルダにない`);
    differences++;
    continue;
  }
  const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));
  const lines = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!before[key] || !after[key]) {
      lines.push(`  ${key}: ${before[key] ? "なくなった" : "増えた"}`);
      continue;
    }
    for (const prop of Object.keys(before[key])) {
      if (before[key][prop] !== after[key][prop]) lines.push(`  ${key} { ${prop}: ${before[key][prop]} → ${after[key][prop]} }`);
    }
  }
  if (lines.length) {
    differences += lines.length;
    console.log(`${file}: ${lines.length}件`);
    console.log(lines.slice(0, 40).join("\n"));
    if (lines.length > 40) console.log(`  …ほか${lines.length - 40}件`);
  }
}
console.log(differences ? `\n違いが${differences}件あります` : "\n違いはありません");
process.exit(differences ? 1 : 0);
