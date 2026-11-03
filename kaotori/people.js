/*! かおトリ v1.6.1 | (c) 2026 技術 岡田 | MIT License */
/* 顔で人ごとに写真を分ける
 * 顔の特徴（128個の数値）はメモリ上だけで扱い、保存・送信はしない。 */
(() => {
'use strict';
const K = window.__kaotori;
const C = window.KAO_CORE;
const $ = (id) => document.getElementById(id);

const rec = { ready: false, loading: null };
let groups = [];          // [{id, name, auto, faces:[face]}]
let refs = [];            // 見本写真 [{name, desc, thumb}]（メモリのみ）
let nextGroupId = 1;

/* ---------- 顔認識モデルの読み込み（必要になった時だけ） ---------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src;
    s.onload = res; s.onerror = () => rej(new Error(src + ' が見つかりません'));
    document.head.appendChild(s);
  });
}
async function loadRecognizer() {
  if (rec.ready) return;
  if (!rec.loading) rec.loading = (async () => {
    if (!window.faceapi) await loadScript('../shared/vendor/face-api-1.7.15/face-api.js');
    if (!window.KAO_REC_MODEL) await loadScript('../shared/vendor/face-api-1.7.15/face-recognition-model.js');
    const tf = faceapi.tf;
    try { await tf.setBackend('webgl'); await tf.ready(); }
    catch { await tf.setBackend('cpu'); await tf.ready(); }
    const res = await fetch('data:application/octet-stream;base64,' + window.KAO_REC_MODEL);
    const buf = await res.arrayBuffer();
    const weightMap = tf.io.decodeWeights(buf, window.KAO_REC_MANIFEST);
    await faceapi.nets.faceRecognitionNet.loadFromWeightMap(weightMap);
    window.KAO_REC_MODEL = null;
    rec.ready = true;
  })();
  try { await rec.loading; } catch (e) { rec.loading = null; throw e; }
}

/* ---------- 顔をそろえて特徴を計算 ---------- */
const chip = document.createElement('canvas'); chip.width = chip.height = 150;
function alignedChip(bmp, f) {
  const em = K.mid(f.eyeL, f.eyeR);
  const ang = Math.atan2(f.eyeR.y - f.eyeL.y, f.eyeR.x - f.eyeL.x);
  const ed = Math.hypot(f.eyeR.x - f.eyeL.x, f.eyeR.y - f.eyeL.y);
  const cd = Math.max(1, (f.chin.x - em.x) * -Math.sin(ang) + (f.chin.y - em.y) * Math.cos(ang));
  // 目の間隔とあごまでの距離から倍率を決める（横顔でも崩れにくいよう両方を使う）
  const s = Math.min(0.5 * (42 / Math.max(ed, 1)) + 0.5 * (70 / cd), 3 * 70 / cd);
  const ctx = chip.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 150, 150);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.translate(75, 55); ctx.scale(s, s); ctx.rotate(-ang); ctx.translate(-em.x, -em.y);
  ctx.drawImage(bmp, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return chip;
}
function makeThumb(bmp, f) {
  const c = K.makeCanvas(84, 84); const ctx = c.getContext('2d');
  const b = f.box, side = Math.max(b.w, b.h) * 1.5;
  ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 84, 84);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, b.x + b.w / 2 - side / 2, b.y + b.h / 2 - side / 2, side, side, 0, 0, 84, 84);
  return c;
}
async function describe(bmp, f) {
  const d = await faceapi.nets.faceRecognitionNet.computeFaceDescriptor(alignedChip(bmp, f));
  return Float32Array.from(d);
}
async function describeAll() {
  const photos = K.state.photos.filter((p) => !p.error);
  const todo = [];
  for (const p of photos) for (const f of p.faces) if (f.include && !f.desc) todo.push([p, f]);
  let done = 0;
  for (const p of photos) {
    const mine = todo.filter((t) => t[0] === p); if (!mine.length) continue;
    const bmp = await K.getBitmap(p);
    for (const [, f] of mine) {
      f.desc = await describe(bmp, f);
      f.peopleThumb = makeThumb(bmp, f);
      done++; K.setBusyBar(done / todo.length);
      if (done % 4 === 0) { await K.tick(); K.checkCancel(); }
    }
  }
}

/* ---------- グループ分け ---------- */
async function run() {
  const faces = () => K.state.photos.flatMap((p) => p.error ? [] : p.faces.filter((f) => f.include));
  if (!faces().length) { alert('先に写真を読み込んでください（使う顔が1つもありません）'); return; }
  if (groups.length && !confirm('グループ分けをやり直します。付けた名前や手で移した内容はリセットされます。よろしいですか？')) return;
  K.resetCancel();
  try {
    K.showBusy('顔認識の準備をしています…', 0);
    await loadRecognizer();
    K.setBusyText('顔の特徴を計算しています…（データは保存されません）');
    await describeAll();
    K.setBusyText('似ている顔をまとめています…');
    await K.tick();
    const list = faces().filter((f) => f.desc);
    if (list.length > 1500) throw new Error('顔が多すぎます（1500人分まで）。写真を分けて実行してください。');
    const target = Math.max(0, Math.round(parseFloat($('peopleTarget').value) || 0));
    // 人数を指定したときは、少しだけ（+0.03）ゆるめてまとめる。ゆるめすぎると別の人が混ざるため
    const thr = parseFloat($('peopleThr').value);
    groups = C.cluster(list, thr, target, thr + 0.03).map((fs) => ({ id: nextGroupId++, name: '', auto: false, faces: fs }));
    applyRefs();
    K.logWork('人ごとのグループ分け', `顔${list.length}人分 → ${groups.length}グループ${target ? `（人数指定 ${target}）` : ''}`);
  } catch (e) {
    console.error(e);
    if (e.cancelled) alert('グループ分けを中止しました'); else alert('グループ分けに失敗しました: ' + (e.message || e));
  } finally { K.hideBusy(); K.resetCancel(); }
  render();
}

/* ---------- 見本写真（名前.jpg）で名前を付ける ---------- */
async function loadRefs(files) {
  files = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|bmp)$/i.test(f.name));
  if (!files.length) return;
  if (!K.ai.ready) { alert('AIの準備ができてから、もう一度お試しください'); return; }
  K.resetCancel();
  const failed = [];
  try {
    K.showBusy('見本写真を読み込んでいます…', 0);
    await loadRecognizer();
    for (let i = 0; i < files.length; i++) {
      let file = files[i];
      const name = C.sanitize(file.name.replace(/\.[^.]+$/, '').replace(/[_\-\s]*\d+$/, '')) || file.name;
      K.setBusyText(`見本写真を読み込んでいます（${i + 1} / ${files.length}）`);
      try {
        if (K.isHeic(file)) file = await K.heicToJpeg(file);
        const bmp = await K.decodeFile(file);
        const cands = await K.detectFaces(bmp);
        if (!cands.length) { failed.push(file.name); bmp.close?.(); continue; }
        const best = cands.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0]; // いちばん大きく写った顔
        const geo = K.refineFace(bmp, best);
        const f = { box: best.box, ...geo };
        refs = refs.filter((r) => r.name !== name);
        refs.push({ name, desc: await describe(bmp, f), thumb: makeThumb(bmp, f) });
        bmp.close?.();
      } catch (e) { if (e.cancelled) throw e; console.warn(e); failed.push(file.name); }
      K.setBusyBar((i + 1) / files.length);
    }
  } catch (e) { if (e.cancelled) alert('見本写真の読み込みを中止しました'); else alert('見本写真の読み込みに失敗しました: ' + e.message); }
  finally { K.hideBusy(); K.resetCancel(); }
  K.logWork('見本写真の読み込み', `${refs.length}人分（顔が見つからない写真 ${failed.length}枚）`);
  const matched = applyRefs();
  $('refInfo').hidden = false;
  $('refInfo').textContent = `見本写真 ${refs.length}人分を読み込みました（メモリのみ・保存しません）。` +
    (groups.length ? `${matched}人のグループに名前を付けました。` : '「顔を比べてグループ分け」を押すと、似ている人に名前が付きます。') +
    (failed.length ? `　顔が見つからなかった写真: ${failed.join('、')}` : '');
  render();
}
/* 名前が空のグループ（または前に自動で付けたグループ）へ、見本の名前を付ける */
function applyRefs() {
  if (!refs.length || !groups.length) return 0;
  const manualNames = new Set(groups.filter((g) => g.name && !g.auto).map((g) => g.name));
  const usable = refs.filter((r) => !manualNames.has(r.name));
  const target = groups.filter((g) => !g.name || g.auto);
  for (const g of target) { g.name = ''; g.auto = false; }
  const m = C.matchNames(target, usable, 0.52);
  for (const [gi, { ref }] of m) { target[gi].name = ref.name; target[gi].auto = true; }
  return m.size;
}

/* ---------- 画面 ---------- */
const pad = (n) => String(n).padStart(2, '0');
function label(g, i) { return g.name.trim() || `人物${pad(i + 1)}`; }
const photoCount = (g) => new Set(g.faces.map((f) => f.photoId)).size;
/* 「その他」にする人: 名前がなく、写っている写真が少ない人。
 * クラスの人数を指定したときは、写真の多い順にその人数までを本体にし、残りも「その他」にする。 */
let mainSet = null;
function updateMainSet() {
  const target = Math.max(0, Math.round(parseFloat($('peopleTarget').value) || 0));
  if (!target) { mainSet = null; return; }
  const named = groups.filter((g) => g.name.trim()).length;
  const rest = groups.filter((g) => !g.name.trim()).sort((a, b) => photoCount(b) - photoCount(a) || b.faces.length - a.faces.length);
  mainSet = new Set(rest.slice(0, Math.max(0, target - named)));
}
function isOther(g) {
  if (g.name.trim()) return false;
  if (photoCount(g) < Math.max(1, parseInt($('peopleMin').value, 10) || 2)) return true;
  return mainSet ? !mainSet.has(g) : false;
}
function render() {
  const box = $('peopleList'); box.textContent = '';
  let dl = document.getElementById('refNames');
  if (!dl) { dl = document.createElement('datalist'); dl.id = 'refNames'; document.body.appendChild(dl); }
  dl.textContent = '';
  for (const r of refs) { const o = document.createElement('option'); o.value = r.name; dl.appendChild(o); }
  // 使わなくなった顔・取り消した写真の顔を外し、空のグループは消す
  const live = new Set(K.state.photos.map((p) => p.id));
  for (const g of groups) g.faces = g.faces.filter((f) => f.include && live.has(f.photoId));
  groups = groups.filter((g) => g.faces.length);
  updateMainSet();
  const main = groups.filter((g) => !isOther(g));
  const others = groups.filter((g) => isOther(g));
  $('peopleCount').textContent = groups.length ? main.length : '-';
  $('peopleZip').disabled = !groups.length;
  const nPhotos = K.state.photos.filter((p) => !p.error).length;
  const named = groups.filter((g) => g.name.trim()).length;
  $('peopleInfo').textContent = groups.length
    ? `${nPhotos}枚の写真から ${main.length}人に分けました（「その他」${others.length}件・名前あり ${named}人）。間違いは顔をドラッグして直せます。名前を入れると、その名前のフォルダで保存されます。`
    : '写真を読み込んでから「顔を比べてグループ分け」を押してください。顔をドラッグして別の人へ移したり、グループの名前を付けたりできます。';
  groups.forEach((g, i) => { if (!isOther(g)) box.appendChild(groupCard(g, i)); });
  if (others.length) {
    const h = document.createElement('div'); h.className = 'people-sub';
    h.textContent = `その他：写っている写真が少ない人${mainSet ? "・クラスの人数より多い分" : ""}（${others.length}件）— 同じ人がいれば上のグループへドラッグしてください`;
    box.appendChild(h);
    groups.forEach((g, i) => { if (isOther(g)) box.appendChild(groupCard(g, i)); });
  }
  if (groups.length) {
    const nz = document.createElement('div'); nz.className = 'pgroup newzone'; nz.textContent = '＋ ここにドラッグすると新しい人として分けます';
    dropTarget(nz, () => { const g = { id: nextGroupId++, name: '', auto: false, faces: [] }; groups.push(g); return g; });
    // 人が多くても届くよう、ドラッグ先は画面の下に固定して表示する
    const dock = document.createElement('div'); dock.className = 'pdock';
    dock.appendChild(nz);
    box.appendChild(dock);
    const ex = document.createElement('div'); ex.className = 'pgroup newzone exclude'; ex.textContent = 'ここにドラッグすると「顔ではない／使わない」にします';
    dropTarget(ex, null);
    dock.appendChild(ex);
  }
}
function groupCard(g, i) {
  const card = document.createElement('div'); card.className = 'pgroup';
  const head = document.createElement('div'); head.className = 'phead';
  const rep = g.faces[0].peopleThumb;
  if (rep) { const c = K.makeCanvas(48, 48); c.getContext('2d').drawImage(rep, 0, 0, 48, 48); c.className = 'prep'; head.appendChild(c); }
  const name = document.createElement('input'); name.type = 'text'; name.value = g.name; name.placeholder = `人物${pad(i + 1)}（名前を入力）`;
  name.setAttribute('list', 'refNames');
  name.addEventListener('input', () => { g.name = name.value; g.auto = false; });
  name.addEventListener('change', () => render());
  head.appendChild(name);
  if (g.auto) {
    const ref = refs.find((r) => r.name === g.name);
    const tag = document.createElement('span'); tag.className = 'pauto'; tag.textContent = '見本と一致';
    if (ref?.thumb) { const c = K.makeCanvas(28, 28); c.getContext('2d').drawImage(ref.thumb, 0, 0, 28, 28); tag.prepend(c); }
    head.appendChild(tag);
  }
  const cnt = document.createElement('span'); cnt.className = 'pcount'; cnt.textContent = `写真 ${photoCount(g)}枚`; head.appendChild(cnt);
  const merge = document.createElement('select'); merge.title = 'ほかの人とまとめる';
  merge.innerHTML = '<option value="">ほかの人とまとめる…</option>';
  groups.forEach((o, j) => { if (o !== g && o.faces.length) { const op = document.createElement('option'); op.value = o.id; op.textContent = label(o, j); merge.appendChild(op); } });
  merge.addEventListener('change', () => {
    const o = groups.find((x) => x.id === +merge.value); if (!o) return;
    g.faces.push(...o.faces); o.faces = []; if (!g.name && o.name) { g.name = o.name; g.auto = o.auto; } render();
  });
  head.appendChild(merge);
  card.appendChild(head);
  const body = document.createElement('div'); body.className = 'pfaces';
  for (const f of g.faces) {
    const t = document.createElement('div'); t.className = 'pface';
    const photo = K.state.photos.find((p) => p.id === f.photoId);
    t.title = `${photo?.name || ''}\nドラッグで別の人へ移動（指は長押ししてから）／ダブルクリックで写真を開く`;
    if (f.peopleThumb) { const c = K.makeCanvas(84, 84); c.getContext('2d').drawImage(f.peopleThumb, 0, 0); t.appendChild(c); }
    dragSource(t, f, g);
    t.addEventListener('dblclick', () => { const idx = K.state.photos.indexOf(photo); if (idx >= 0) { K.state.current = idx; K.showTab('photo'); K.refreshAll(); } });
    body.appendChild(t);
  }
  card.appendChild(body);
  dropTarget(card, () => g);
  return card;
}
/* ---------- 顔を別の人へ動かす（マウス・ペン・指） ---------- */
// Pointer events rather than HTML drag and drop, so a finger can move faces on a touch screen
// too. A mouse or pen drag starts once the pointer moves a little; a finger holds still for a
// moment first (a quick swipe still scrolls the list). Escape puts the face back.
const LONG_PRESS_MS = 350; // touch: hold this long before a face starts to move
const DRAG_SLOP = 8;       // px the pointer may wander before a press counts as a drag (or a scroll)
const SCROLL_EDGE = 60;    // px from the top/bottom of the list where dragging scrolls it
const SCROLL_STEP = 20;    // most px scrolled per frame
const dropGroups = new WeakMap(); // drop area element → function giving its group (null: 使わない)
let press = null; // { tile, face, from, pointerId, x, y, touch, timer } while a face is pressed
let drag = null;  // { ghost, target, x, y, raf } once the press has become a drag

function dropTarget(el, getGroup) { dropGroups.set(el, getGroup); }

function dragSource(tile, face, from) {
  tile.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    const touch = e.pointerType !== 'mouse';
    press = { tile, face, from, pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch, timer: 0 };
    if (touch) press.timer = setTimeout(() => startDrag(press.x, press.y), LONG_PRESS_MS);
    else e.preventDefault(); // no text selection while dragging with a mouse
  });
  tile.addEventListener('contextmenu', (e) => { if (press?.touch || drag) e.preventDefault(); });
}

function endPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

window.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  if (!drag) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_SLOP) return;
    if (press.touch) { endPress(); return; } // moved before the long press: it is a scroll
    startDrag(e.clientX, e.clientY);
  }
  moveDrag(e.clientX, e.clientY);
});
window.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  if (drag) finishDrag();
  endPress();
});
window.addEventListener('pointercancel', (e) => {
  if (!press || e.pointerId !== press.pointerId) return;
  stopDrag(); endPress();
});
window.addEventListener('keydown', (e) => {
  if (!drag || e.key !== 'Escape') return;
  e.preventDefault(); stopDrag(); endPress();
});
// Keep the page from scrolling under a finger that is moving a face.
document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

function startDrag(x, y) {
  clearTimeout(press.timer);
  const ghost = document.createElement('div'); ghost.className = 'pface-ghost';
  const src = press.tile.querySelector('canvas');
  if (src) { const c = K.makeCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); ghost.appendChild(c); }
  document.body.appendChild(ghost);
  press.tile.classList.add('dragging');
  drag = { ghost, target: null, x, y, raf: 0 };
  if (press.touch) navigator.vibrate?.(15);
  moveDrag(x, y);
  drag.raf = requestAnimationFrame(autoScroll);
}

function moveDrag(x, y) {
  drag.x = x; drag.y = y;
  drag.ghost.style.transform = `translate(${x}px, ${y}px)`;
  let el = document.elementFromPoint(x, y);
  while (el && !dropGroups.has(el)) el = el.parentElement;
  if (drag.target !== el) {
    drag.target?.classList.remove('over');
    el?.classList.add('over');
    drag.target = el;
  }
}

// Near the top or bottom of the list, scroll it so far-away people can be reached. Not while
// over the drop areas fixed at the bottom (新しい人・使わない).
function autoScroll() {
  if (!drag) return;
  const pane = $('pane-people');
  const r = pane.getBoundingClientRect();
  const overDock = drag.target?.closest('.pdock');
  let dy = 0;
  if (drag.y < r.top + SCROLL_EDGE) dy = -(r.top + SCROLL_EDGE - drag.y);
  else if (drag.y > r.bottom - SCROLL_EDGE && !overDock) dy = drag.y - (r.bottom - SCROLL_EDGE);
  if (dy) { pane.scrollTop += Math.max(-SCROLL_STEP, Math.min(SCROLL_STEP, dy / 3)); moveDrag(drag.x, drag.y); }
  drag.raf = requestAnimationFrame(autoScroll);
}

function stopDrag() {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  drag.ghost.remove();
  drag.target?.classList.remove('over');
  press?.tile.classList.remove('dragging');
  drag = null;
}

function finishDrag() {
  const { target } = drag;
  const { face, from } = press;
  stopDrag();
  if (target) moveFace(face, from, dropGroups.get(target));
}

function moveFace(f, from, getGroup) {
  if (getGroup) {
    const to = getGroup(); if (to === from) return;
    from.faces = from.faces.filter((x) => x !== f); to.faces.push(f);
  } else {
    from.faces = from.faces.filter((x) => x !== f); f.include = false; K.refreshAll();
  }
  render();
}

/* ---------- 保存 ---------- */
/* 撮影場所などの情報を消す。JPEG/PNGは画質を変えずに消し、それ以外はJPEGに作り直す */
async function cleanFile(file) {
  const r = await C.stripMeta(file);
  if (r) return { blob: r.blob, name: file.name };
  const bmp = await K.decodeFile(file);
  const c = K.makeCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0); bmp.close?.();
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
  return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}
async function saveZip() {
  const named = $('peopleNamedOnly').checked, withOthers = $('peopleOthers').checked, strip = $('peopleStrip').checked;
  const list = groups.map((g, i) => ({ g, name: C.sanitize(label(g, i)), other: isOther(g) }))
    .filter((x) => x.g.faces.length && (!named || x.g.name.trim()) && (withOthers || !x.other));
  if (!list.length) { alert(named ? '名前を付けた人がいません' : '保存する人がいません'); return; }
  K.resetCancel();
  try {
    K.showBusy('人ごとのフォルダにまとめています…', 0);
    const zip = new JSZip();
    const usedFolders = new Set();
    const cleaned = new Map(); // 同じ写真は一度だけ処理する
    const csv = [['名前', '写真の枚数', '写真のファイル名']];
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      let folder = list[i].other ? 'その他' : list[i].name;
      if (!list[i].other) { while (usedFolders.has(folder)) folder += '_'; usedFolders.add(folder); }
      const photos = [...new Set(list[i].g.faces.map((f) => f.photoId))].map((id) => K.state.photos.find((p) => p.id === id)).filter(Boolean);
      const usedNames = new Set();
      const names = [];
      for (const p of photos) {
        let entry = { blob: p.file, name: p.file.name };
        if (strip) { if (!cleaned.has(p.id)) cleaned.set(p.id, await cleanFile(p.file)); entry = cleaned.get(p.id); }
        let fn = entry.name; const dot = fn.lastIndexOf('.');
        while (usedNames.has(fn.toLowerCase())) fn = fn.slice(0, dot) + '_' + fn.slice(dot);
        usedNames.add(fn.toLowerCase()); names.push(fn);
        zip.file(`${folder}/${fn}`, entry.blob); total++;
      }
      csv.push([list[i].other ? `その他（${list[i].name}）` : folder, String(photos.length), names.join(' / ')]);
      K.setBusyBar((i + 1) / list.length);
      await K.tick(); K.checkCancel();
    }
    const esc = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    zip.file('人ごとの写真一覧.csv', '﻿' + csv.map((r) => r.map(esc).join(',')).join('\r\n'));
    K.setBusyText('ZIPを作っています…');
    const blob = await zip.generateAsync({ type: 'blob' });
    K.download(blob, `かおトリ_人ごと_${K.stamp()}.zip`);
    K.logWork('人ごとの保存', `${list.length}人分・写真${total}枚${strip ? '（撮影場所などの情報を削除）' : ''}`);
  } catch (e) { console.error(e); if (e.cancelled) alert('保存を中止しました'); else alert('保存に失敗しました: ' + e.message); }
  finally { K.hideBusy(); K.resetCancel(); }
}

$('peopleRun').addEventListener('click', run);
$('peopleZip').addEventListener('click', saveZip);
$('peopleMin').addEventListener('input', () => render());
$('peopleTarget').addEventListener('change', () => render());
$('refBtn').addEventListener('click', () => $('refInput').click());
$('refInput').addEventListener('change', () => { const f = [...$('refInput').files]; $('refInput').value = ''; loadRefs(f); });

window.KAO_PEOPLE = {
  show() { render(); },
  reset() { groups = []; refs = []; $('refInfo').hidden = true; render(); },
  // テスト用
  _groups: () => groups, _refs: () => refs,
};
})();
