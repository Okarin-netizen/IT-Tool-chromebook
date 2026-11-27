#!/usr/bin/env node
// Looks through every tool's code, without a browser, for ways of writing that work on a
// Chromebook or Windows (Chrome / Edge) but not on an iPad (Safari).
//
//   node tests/ipad-pitfalls.mjs              # every tool and shared/
//   node tests/ipad-pitfalls.mjs calc lottery # only these folders
//
// A line that is fine on purpose can say why with a comment containing  ipad-ok: <reason>
// (the loop may add one only for a double click that already has a button doing the same thing,
// and must name that button; a person checks these in the pull request).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../shared/js/tools.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const only = process.argv.slice(2);
const folders = only.length ? only : ["shared/js", "shared/css", ...TOOLS.map((t) => t.id), "index.html"];

// Each rule: which files, what to look for, and (optional) something that, when found in the
// same file, shows the code already has another way for Safari.
const RULES = [
  { ext: /\.(js|html)$/, find: /\.filter\s*=(?!=)/, unless: null,
    why: "canvas の ctx.filter は iPad の Safari で効かない（shared/js/blur.js の drawBlurred か grayscale を使う）" },
  { ext: /\.(js|html)$/, find: /show(Save|Open)FilePicker|showDirectoryPicker/, unless: /in\s+window|typeof\s+window\.show|\?\.\(/,
    why: "ファイルを選ぶ・保存する画面（File System Access API）は Safari にない。ない時の別のやり方が要る" },
  { ext: /\.(js|html)$/, find: /webkitdirectory/, unless: /<input(?![^>]*webkitdirectory)[^>]*type="file"[^>]*multiple/,
    why: "フォルダを選ぶ（webkitdirectory）は iPad ではできない。ファイルをまとめて選ぶ・ZIP など別の道を用意する" },
  { ext: /\.(js|html)$/, find: /(toBlob|toDataURL|convertToBlob|canvasToBlob)\([^)]*webp/i, unless: /\.type\s*[!=]==|webpOk|supportsWebp|canEncode/i,
    why: "Safari は canvas から WebP を作れず、黙って PNG になる。できた形式を確かめる" },
  { ext: /\.(js|html)$/, find: /video\/webm|audio\/webm/, unless: /isTypeSupported/,
    why: "Safari の録画・録音は WebM でなく MP4。MediaRecorder.isTypeSupported で選ぶ" },
  { ext: /\.(js|html)$/, find: /addEventListener\(\s*["'](mousedown|mousemove|mouseup|mouseenter|mouseleave)["']/, unless: null,
    why: "mouse のイベントは指やペンで動かないことがある。pointerdown / pointermove / pointerup を使う" },
  { ext: /\.(js|html)$/, find: /["']dblclick["']|ondblclick/, unless: null,
    why: "ダブルクリック（ダブルタップ）は iPad では拡大になることがある。同じことがボタンなどでもできるようにする（できているなら、その行に ipad-ok: とそのボタンを書く）" },
  { ext: /\.(js|html)$/, find: /navigator\.vibrate(?!\?\.)/, unless: null,
    why: "iPad はふるえない（navigator.vibrate がない）。ないときにエラーにならないこと" },
  { ext: /\.(js|html)$/, find: /\.requestFullscreen\(/, unless: /webkitRequestFullscreen|shared\/js\/fullscreen\.js|from\s+["'][./]*shared\/js\/fullscreen/,
    why: "iPad の Safari は全画面に webkitRequestFullscreen が要る（shared/js/fullscreen.js を使う）" },
  { ext: /\.css$|\.html$/, find: /(?<![\w-])100vh/, unless: /100dvh/,
    why: "iPad の Safari では 100vh が画面より高くなり、下が隠れる。100dvh を使う（古い端末用に 100vh を先に書いてもよい）" },
];

// A :hover rule that is the only way to show something (opacity / visibility / display).
const HOVER_REVEAL = /:hover[^{]*\{[^}]*(opacity\s*:\s*1|visibility\s*:\s*visible|display\s*:\s*(block|flex|grid|inline))/g;

const problems = [];
const walk = (rel) => {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return problems.push(`${rel}: ない`);
  if (fs.statSync(full).isFile()) return check(rel);
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (["vendor", "node_modules", "shots"].includes(entry.name)) continue;
    // blur.js is the Safari fallback for ctx.filter itself (it checks before using it).
    if (path.join(rel, entry.name) === path.join("shared", "js", "blur.js")) continue;
    walk(path.join(rel, entry.name));
  }
};
const check = (rel) => {
  if (!/\.(js|mjs|html|css)$/.test(rel)) return;
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const lines = text.split("\n");
  for (const rule of RULES) {
    if (!rule.ext.test(rel) || (rule.unless && rule.unless.test(text))) continue;
    lines.forEach((line, i) => {
      if (rule.find.test(line) && !line.includes("ipad-ok:")) problems.push(`${rel}:${i + 1}  ${rule.why}`);
    });
  }
  if (/\.(css|html)$/.test(rel)) {
    for (const match of text.matchAll(HOVER_REVEAL)) {
      const line = text.slice(0, match.index).split("\n").length;
      const selector = match[0].split("{")[0].trim();
      const touchToo = /@media\s*\(hover:\s*none\)|\(pointer:\s*coarse\)|:focus-within/.test(text);
      if (!touchToo && !lines[line - 1].includes("ipad-ok:")) {
        problems.push(`${rel}:${line}  マウスを乗せたときだけ出るもの（${selector}）は iPad では出せない。いつも出すか、@media (hover: none) で出す`);
      }
    }
  }
};

folders.forEach(walk);
if (problems.length) {
  console.log(problems.map((p) => `NG ${p}`).join("\n"));
  console.log(`\n${problems.length}件`);
  process.exit(1);
}
console.log("すべて通りました");
