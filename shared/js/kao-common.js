/* かおトリ (kaotori) と かおかくし (kaokakushi) で同じ部分。
 *
 * The two tools came from 技術 岡田's own apps and load their code with plain <script> tags,
 * not ES modules, so this file is a plain script too: it puts its helpers on
 * window.KaoCommon. Load it before the tool's own scripts:
 *   <script src="../shared/js/kao-common.js"></script>
 * Comments stay in Japanese, like the rest of the two tools. */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);

/* 保存してから、ダウンロードの URL を手放すまでの時間 */
const REVOKE_URL_MS = 60000;

/* ---------- 画像・計算 ---------- */

/* 幅・高さを整数（1以上）にしたキャンバス */
function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/* 2つの四角 {x,y,w,h} の重なり。
 * iou: 重なり ÷ 2つを合わせた広さ、cover: 重なり ÷ 小さいほうの広さ（どちらも0〜1） */
function overlap(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  return {
    iou: inter / (areaA + areaB - inter || 1),
    cover: inter / (Math.min(areaA, areaB) || 1),
  };
}

/* ---------- AI（MediaPipe）の準備 ---------- */

/* base64 の文字 → バイト列 */
async function base64ToBytes(base64) {
  const res = await fetch('data:application/octet-stream;base64,' + base64);
  return new Uint8Array(await res.arrayBuffer());
}

/* MediaPipe に渡す WebAssembly の置き場所。
 * file:// で開いても動くように、base64 で持っている中身（shared/vendor/mediapipe-*）から作る */
async function mediaPipeFileset() {
  const loader = new Blob([window.KAO_WASM_LOADER], { type: 'text/javascript' });
  const wasm = new Blob([await base64ToBytes(window.KAO_WASM_B64)], { type: 'application/wasm' });
  return { wasmLoaderPath: URL.createObjectURL(loader), wasmBinaryPath: URL.createObjectURL(wasm) };
}

/* ---------- 保存 ---------- */

/* ファイル名に使えない文字を「_」にする */
function safeFileName(text) {
  return String(text).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
}

/* ファイル名に付ける今の日時「20261104_0930」 */
function fileTimeStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${date}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function download(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), REVOKE_URL_MS);
  // 保存した場所を、閉じるまで残るお知らせで出す（ほかのツールと同じ）
  import('./saved.js').then((m) => m.showSavedNotice(name)).catch(() => {});
}

/* ブラウザ内の設定。名前の前に `prefix`（「kaotori.」など）を付けて JSON で保存する */
function createStore(prefix) {
  return {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(prefix + key);
        return value == null ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      } catch { /* 保存できない環境でも動作は続ける */ }
    },
  };
}

/* 設定の入力欄（id の一覧）の値を、保存する形 { id: 値 } にする */
function readControls(ids) {
  const values = {};
  for (const id of ids) {
    const el = $(id);
    values[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return values;
}

/* readControls で保存した値を入力欄に戻す（保存にない欄はそのまま） */
function writeControls(ids, values) {
  for (const id of ids) {
    if (!(id in values)) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = values[id];
    else el.value = values[id];
  }
}

/* ---------- 画面 ---------- */

/* 処理中の表示（#busy の中の #busyText と #busyBar）。progress は 0〜1 */
const busy = {
  show(text, progress) {
    $('busy').hidden = false;
    busy.setText(text);
    busy.setBar(progress);
  },
  setText(text) {
    $('busyText').textContent = text;
    $('busyText').style.whiteSpace = 'pre-line';
  },
  setBar(progress) {
    $('busyBar').style.width = Math.round((progress || 0) * 100) + '%';
  },
  hide() {
    $('busy').hidden = true;
  },
};

/* 「このアプリについて」（#aboutDialog）を開く。今ネットワークにつながっているかも書く */
function openAbout() {
  $('netState').textContent = navigator.onLine
    ? '※ 現在このパソコンはネットワークにつながっていますが、このアプリは通信を行いません。'
    : '※ 現在このパソコンはネットワークにつながっていません。このままお使いいただけます。';
  $('aboutDialog').showModal();
}

/* 「このアプリについて」のリンク（#aboutLink）とオフラインの印（#offlineBadge） */
function bindAbout() {
  $('aboutLink').addEventListener('click', (e) => {
    e.preventDefault();
    openAbout();
  });
  $('offlineBadge').addEventListener('click', openAbout);
}

window.KaoCommon = {
  $, makeCanvas, overlap, base64ToBytes, mediaPipeFileset,
  safeFileName, fileTimeStamp, download, createStore, readControls, writeControls,
  busy, openAbout, bindAbout,
};
})();
