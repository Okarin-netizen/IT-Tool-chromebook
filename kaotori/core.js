/*! かおトリ v1.6.1 | (c) 2026 技術 岡田 | MIT License */
/* 画面に依存しない計算部分（自己診断ページからもテストできるように分けている） */
(() => {
'use strict';

/* ---------- 写真の隠れた情報（撮影場所など）を消す ---------- */
function u16(b, p, le) { return le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]; }
function u32(b, p, le) { return le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; }

/* EXIF（APP1の中身）から向き（Orientation）だけを読む */
function exifOrientation(seg) {
  // seg: "Exif\0\0" から始まる APP1 の中身
  if (seg.length < 14 || String.fromCharCode(seg[0], seg[1], seg[2], seg[3]) !== 'Exif') return 1;
  const t = 6, le = seg[t] === 0x49;
  const ifd = t + u32(seg, t + 4, le);
  if (ifd + 2 > seg.length) return 1;
  const n = u16(seg, ifd, le);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > seg.length) break;
    if (u16(seg, e, le) === 0x0112) { const v = u16(seg, e + 8, le); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}
/* 向きだけを持つ最小のEXIF */
function minimalExif(orientation) {
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const len = body.length + 2;
  return Uint8Array.from([0xFF, 0xE1, len >> 8, len & 255, ...body]);
}
/* JPEG: EXIF・XMP・IPTC・コメント・埋め込みサムネイルを消す（画質は変わらない）。
 * 写真の向きの情報だけは残す。 */
function stripJpeg(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;
  const out = [Uint8Array.from([0xFF, 0xD8])];
  let p = 2, orientation = 1, insertedAt = -1, removed = [];
  while (p + 4 <= b.length) {
    if (b[p] !== 0xFF) return null;
    const m = b[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xD9) break;
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
    const len = u16(b, p + 2, false);
    const seg = b.subarray(p, p + 2 + len);
    if (m === 0xDA) { out.push(b.subarray(p)); p = b.length; break; } // 画像本体はそのまま
    const keep = m === 0xE0 || m === 0xE2 || m === 0xEE || m < 0xE0 || (m > 0xEF && m !== 0xFE);
    if (m === 0xE1) {
      const o = exifOrientation(seg.subarray(4));
      if (o !== 1) orientation = o;
      removed.push(String.fromCharCode(seg[4], seg[5], seg[6], seg[7]) === 'Exif' ? 'EXIF' : 'XMP');
    } else if (!keep) removed.push(m === 0xFE ? 'コメント' : m === 0xED ? 'IPTC' : 'APP' + (m - 0xE0));
    if (keep) { out.push(seg); if (m === 0xE0) insertedAt = out.length; }
    p += 2 + len;
  }
  if (orientation !== 1) out.splice(insertedAt > 0 ? insertedAt : 1, 0, minimalExif(orientation));
  return { parts: out, removed, orientation };
}
/* PNG: 文字情報・EXIF・日時のチャンクを消す */
function stripPng(b) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => b[i] === v)) return null;
  const out = [b.subarray(0, 8)], removed = [];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = u32(b, p, false);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const end = p + 12 + len;
    if (['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'].includes(type)) removed.push(type);
    else out.push(b.subarray(p, end));
    p = end;
    if (type === 'IEND') break;
  }
  return { parts: out, removed, orientation: 1 };
}
/* ファイルから隠れた情報を消した Blob を返す。対応外の形式は null（呼び出し側で作り直す） */
async function stripMeta(blob) {
  const b = new Uint8Array(await blob.arrayBuffer());
  const r = stripJpeg(b) || stripPng(b);
  if (!r) return null;
  return { blob: new Blob(r.parts, { type: blob.type || (b[0] === 0xFF ? 'image/jpeg' : 'image/png') }), removed: r.removed, orientation: r.orientation };
}
/* テスト・確認用: JPEG の中に EXIF（撮影場所を含みうる）があるか */
function hasJpegExif(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return false;
  let p = 2;
  while (p + 4 <= b.length && b[p] === 0xFF) {
    const m = b[p + 1]; if (m === 0xDA || m === 0xD9) break;
    const len = u16(b, p + 2, false);
    if (m === 0xE1 && String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]) === 'Exif' && len > 40) return true;
    p += 2 + len;
  }
  return false;
}

/* ---------- ファイルサイズを上限（KB）に収める ---------- */
/* encodeAt(q) は画質 q（0〜1）で Blob を返す関数 */
async function fitToKB(encodeAt, maxKB, startQ = 0.95, minQ = 0.15) {
  const limit = maxKB * 1024;
  let best = await encodeAt(startQ);
  if (!maxKB || best.size <= limit) return { blob: best, q: startQ, over: false };
  let lo = minQ, hi = startQ, okBlob = null, okQ = 0;
  const low = await encodeAt(lo);
  if (low.size > limit) return { blob: low, q: lo, over: true };
  okBlob = low; okQ = lo;
  for (let i = 0; i < 8; i++) {
    const mq = (lo + hi) / 2;
    const b = await encodeAt(mq);
    if (b.size <= limit) { okBlob = b; okQ = mq; lo = mq; } else hi = mq;
  }
  return { blob: okBlob, q: okQ, over: false };
}

/* ---------- 顔のグループ分け ---------- */
function dist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
/* 平均連結法。同じ写真の顔どうしは同じ人にしない。
 * target（人数）を指定すると、maxThr までの範囲でその人数に近づくまでまとめる。 */
function cluster(faces, thr, target = 0, maxThr = 0.58) {
  const n = faces.length;
  const D = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = dist(faces[i].desc, faces[j].desc); D[i][j] = D[j][i] = d; }
  const alive = new Array(n).fill(true), size = new Array(n).fill(1);
  const members = faces.map((f) => [f]);
  const photos = faces.map((f) => new Set([f.photoId]));
  let count = n;
  const limit = target ? Math.max(thr, maxThr) : thr;
  for (;;) {
    let bi = -1, bj = -1, best = limit;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const Di = D[i];
      for (let j = i + 1; j < n; j++) {
        if (!alive[j] || Di[j] >= best) continue;
        let clash = false;
        for (const p of photos[j]) if (photos[i].has(p)) { clash = true; break; }
        if (clash) continue;
        best = Di[j]; bi = i; bj = j;
      }
    }
    if (bi < 0) break;
    if (best >= thr && (!target || count <= target)) break;
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const d = (D[bi][k] * size[bi] + D[bj][k] * size[bj]) / (size[bi] + size[bj]);
      D[bi][k] = D[k][bi] = d;
    }
    size[bi] += size[bj]; alive[bj] = false; count--;
    members[bi].push(...members[bj]);
    for (const p of photos[bj]) photos[bi].add(p);
  }
  return members.filter((_, i) => alive[i]).sort((a, b) => b.length - a.length);
}

/* 見本写真（名前つき）とグループを対応づける。距離の近い組から順に1対1で決める。 */
function matchNames(groups, refs, maxDist = 0.5) {
  const pairs = [];
  groups.forEach((g, gi) => refs.forEach((r, ri) => {
    let best = Infinity;
    for (const f of g.faces) if (f.desc) best = Math.min(best, dist(f.desc, r.desc));
    // 1枚だけ似ている偶然を避けるため、上位の平均も見る
    const ds = g.faces.filter((f) => f.desc).map((f) => dist(f.desc, r.desc)).sort((a, b) => a - b).slice(0, 3);
    const avg = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : Infinity;
    const score = Math.min(best * 0.5 + avg * 0.5, avg);
    if (score < maxDist) pairs.push({ gi, ri, score });
  }));
  pairs.sort((a, b) => a.score - b.score);
  const usedG = new Set(), usedR = new Set(), result = new Map();
  for (const p of pairs) {
    if (usedG.has(p.gi) || usedR.has(p.ri)) continue;
    usedG.add(p.gi); usedR.add(p.ri); result.set(p.gi, { ref: refs[p.ri], score: p.score });
  }
  return result;
}

/* ---------- 台紙の並べ方 ---------- */
function layoutGrid(pw, ph, fw, fh, margin, gap, label) {
  const cols = Math.floor((pw - 2 * margin + gap) / (fw + gap));
  const rows = Math.floor((ph - 2 * margin + gap) / (fh + label + gap));
  return { cols: Math.max(0, cols), rows: Math.max(0, rows), per: Math.max(0, cols) * Math.max(0, rows) };
}

/* ---------- ファイル名 ---------- */
function sanitize(s) { return String(s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim(); }

window.KAO_CORE = { stripMeta, stripJpeg, stripPng, exifOrientation, hasJpegExif, minimalExif, fitToKB, dist, cluster, matchNames, layoutGrid, sanitize };
})();
