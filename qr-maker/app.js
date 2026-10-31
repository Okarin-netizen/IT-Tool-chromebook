import { showStatus } from "../shared/js/status.js";
import { download } from "../shared/js/files.js";
import { addNextTool } from "../shared/js/handoff.js";
import { loadJson, saveJson } from "../shared/js/storage.js";
import { registerOffline } from "../shared/js/offline.js";
import { canvasToBlob } from "../shared/js/canvas.js";
import { copyImage } from "../shared/js/clipboard.js";
import qrcode from "../shared/vendor/qrcode-generator-2.0.4/qrcode.mjs";

// Never change a key (or the shape of what is saved) once the tool is in use. Add a new key instead.
const SETTINGS_KEY = "qr-maker-settings-v1"; // { text, caption, ecc, size }
const QUIET = 4; // white border around the code, in modules (the standard asks for 4)

// Byte mode with UTF-8, so Japanese text works; phones' camera apps read it as UTF-8.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

const $ = (id) => document.getElementById(id);
const els = {
  text: $("text"),
  caption: $("caption"),
  ecc: $("ecc"),
  size: $("size"),
  preview: $("preview"),
  info: $("info"),
  saveBtn: $("save-btn"),
  copyBtn: $("copy-btn"),
};

const saved = loadJson(SETTINGS_KEY, {});
els.text.value = typeof saved.text === "string" ? saved.text : "";
els.caption.value = typeof saved.caption === "string" ? saved.caption : "";
if (["L", "M", "Q", "H"].includes(saved.ecc)) els.ecc.value = saved.ecc;
if (["256", "512", "1024"].includes(String(saved.size))) els.size.value = String(saved.size);

// The QR code for `text`, or null when it is too long to fit in one.
function makeCode(text, ecc) {
  try {
    const qr = qrcode(0, ecc); // 0: the smallest version that fits
    qr.addData(text, "Byte");
    qr.make();
    return qr;
  } catch {
    return null;
  }
}

// Draws the code (and the caption under it) black on white, about `size` pixels wide.
function draw(canvas, qr, size, caption) {
  const n = qr.getModuleCount();
  const cell = Math.max(2, Math.floor(size / (n + QUIET * 2)));
  const width = cell * (n + QUIET * 2);
  const fontSize = Math.round(width / 14);
  const captionHeight = caption ? Math.round(fontSize * 1.6) : 0;
  canvas.width = width;
  canvas.height = width + captionHeight;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + QUIET) * cell, (r + QUIET) * cell, cell, cell);
    }
  }
  if (caption) {
    ctx.font = `600 ${fontSize}px system-ui, "Noto Sans JP", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Sits in the bottom quiet zone and the strip below it, shrunk to fit the width.
    const maxWidth = width - cell * 2;
    const scale = Math.min(1, maxWidth / ctx.measureText(caption).width);
    ctx.font = `600 ${Math.floor(fontSize * scale)}px system-ui, "Noto Sans JP", sans-serif`;
    ctx.fillText(caption, width / 2, width - cell * QUIET / 2 + captionHeight / 2);
  }
}

let current = null; // the QR code shown now

function update() {
  const text = els.text.value;
  const caption = els.caption.value.trim();
  saveJson(SETTINGS_KEY, { text, caption, ecc: els.ecc.value, size: Number(els.size.value) });
  current = text ? makeCode(text, els.ecc.value) : null;
  els.saveBtn.disabled = els.copyBtn.disabled = !current;
  els.preview.classList.toggle("empty", !current);
  els.info.classList.toggle("error", !!text && !current);
  if (!text) {
    els.info.textContent = "左にURLや文字を入れると、ここにQRコードができます。";
    return;
  }
  if (!current) {
    els.info.textContent = "長すぎてQRコードに入りません。文字を減らすか、「読み取りやすさ」を下げてください";
    return;
  }
  draw(els.preview, current, Number(els.size.value), caption);
  const n = current.getModuleCount();
  els.info.textContent = `${new TextEncoder().encode(text).length}バイト・${n}×${n}マス。スマートフォンのカメラで読み取れるか確かめてから配ってください。`;
}

const toBlob = () => canvasToBlob(els.preview, "image/png");

async function save() {
  if (!current) return;
  const caption = els.caption.value.trim().replace(/[\\/:*?"<>|]/g, "_");
  download(await toBlob(), `${caption || "QRコード"}.png`);
  showStatus("PNG画像を保存しました");
}

async function copy() {
  if (!current) return;
  if (await copyImage(toBlob())) showStatus("コピーしました。ドキュメントやスライドに Ctrl+V で貼り付けられます");
  else showStatus("コピーできませんでした。「PNGで保存」を使ってください", { error: true });
}

for (const el of [els.text, els.caption]) el.addEventListener("input", update);
for (const el of [els.ecc, els.size]) el.addEventListener("change", update);
els.saveBtn.addEventListener("click", save);
addNextTool({ saveBtn: els.saveBtn, save, kind: "image" });
els.copyBtn.addEventListener("click", copy);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});

// Keeps this tool working without a network once it has been opened.
registerOffline([
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
  "../shared/vendor/qrcode-generator-2.0.4/qrcode.mjs",
]);

update();

// Hook for automated tests.
window.__qrMaker = { update, makeCode, get current() { return current; } };
