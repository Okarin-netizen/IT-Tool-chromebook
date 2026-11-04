/*! かおトリ v1.6.1 自己診断 | (c) 2026 技術 岡田 | MIT License */
(async () => {
  "use strict";
  const C = window.KAO_CORE;
  const list = document.getElementById("list");
  const results = [];
  function report(name, ok, detail) {
    results.push(ok);
    const li = document.createElement("li");
    li.className = ok ? "ok" : "ng";
    const m = document.createElement("span");
    m.className = "m";
    m.textContent = ok ? "✓ OK" : "✕ NG";
    li.append(m, name);
    if (detail) {
      const s = document.createElement("small");
      s.textContent = detail;
      li.appendChild(s);
    }
    list.appendChild(li);
  }
  async function test(name, fn) {
    try {
      const r = await fn();
      report(name, r === true || (r && r.ok), r && r.detail);
    } catch (e) {
      report(name, false, "エラー: " + ((e && e.message) || e));
    }
  }

  /* --- 試験用のJPEG（撮影場所 GPS と向き=6 を含む EXIF を入れる） --- */
  function makeExif() {
    const t = [];
    const w16 = (v) => t.push((v >> 8) & 255, v & 255);
    const w32 = (v) => t.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
    t.push(0x4d, 0x4d);
    w16(42);
    w32(8);
    // IFD0: 2項目（向き・GPSへのポインタ）
    w16(2);
    w16(0x0112);
    w16(3);
    w32(1);
    w16(6);
    w16(0);
    w16(0x8825);
    w16(4);
    w32(1);
    w32(8 + 2 + 24 + 4);
    w32(0);
    // GPS IFD: 緯度の向き 'N' と 緯度（35/1, 40/1, 0/1）
    w16(2);
    w16(0x0001);
    w16(2);
    w32(2);
    t.push(0x4e, 0, 0, 0);
    w16(0x0002);
    w16(5);
    w32(3);
    w32(8 + 2 + 24 + 4 + 2 + 24 + 4);
    w32(0);
    for (const v of [35, 1, 40, 1, 0, 1]) w32(v);
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t];
    const len = body.length + 2;
    return Uint8Array.from([0xff, 0xe1, len >> 8, len & 255, ...body]);
  }
  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, "#d33");
    gr.addColorStop(1, "#36c");
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `hsl(${(i * 37) % 360},70%,${30 + ((i * 13) % 50)}%)`;
      g.fillRect((i * 53) % w, (i * 97) % h, 9, 9);
    }
    return c;
  }
  const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
  async function jpegWithGps() {
    const b = new Uint8Array(await (await toBlob(makeCanvas(64, 48), "image/jpeg", 0.9)).arrayBuffer());
    // SOI の直後に APP1(EXIF) とコメントを差し込む
    const com = Uint8Array.from([0xff, 0xfe, 0, 10, ...[..."secret!!"].map((c) => c.charCodeAt(0))]);
    return new Blob([b.subarray(0, 2), makeExif(), com, b.subarray(2)], { type: "image/jpeg" });
  }
  const has = (arr, str) => {
    const s = [...str].map((c) => c.charCodeAt(0));
    outer: for (let i = 0; i + s.length <= arr.length; i++) {
      for (let j = 0; j < s.length; j++) if (arr[i + j] !== s[j]) continue outer;
      return true;
    }
    return false;
  };
  function findApp1(b) {
    let p = 2;
    while (p + 4 <= b.length && b[p] === 0xff) {
      const m = b[p + 1];
      if (m === 0xda) break;
      const len = (b[p + 2] << 8) | b[p + 3];
      if (m === 0xe1) return b.subarray(p + 4, p + 2 + len);
      p += 2 + len;
    }
    return null;
  }

  await test("撮影場所（GPS）などの情報を消せる", async () => {
    const src = await jpegWithGps();
    const sb = new Uint8Array(await src.arrayBuffer());
    if (!C.hasJpegExif(sb)) return { ok: false, detail: "試験用の写真に情報が入っていません" };
    const r = await C.stripMeta(src);
    const ob = new Uint8Array(await r.blob.arrayBuffer());
    const app1 = findApp1(ob);
    const noGps = !has(ob, "secret!!") && !C.hasJpegExif(ob) && !(app1 && app1.length > 40);
    return {
      ok: noGps && r.removed.includes("EXIF") && r.removed.includes("コメント"),
      detail: `消した情報: ${r.removed.join("・")}（${sb.length}→${ob.length} バイト）`,
    };
  });
  await test("写真の向きの情報は残る", async () => {
    const r = await C.stripMeta(await jpegWithGps());
    const ob = new Uint8Array(await r.blob.arrayBuffer());
    const app1 = findApp1(ob);
    return {
      ok: !!app1 && C.exifOrientation(app1) === 6,
      detail: `向き = ${app1 ? C.exifOrientation(app1) : "なし"}`,
    };
  });
  await test("情報を消しても写真として開ける", async () => {
    const r = await C.stripMeta(await jpegWithGps());
    const bmp = await createImageBitmap(r.blob);
    return { ok: bmp.width > 0, detail: `${bmp.width}×${bmp.height}` };
  });
  await test("PNG の文字情報を消せる", async () => {
    const pb = new Uint8Array(await (await toBlob(makeCanvas(16, 16), "image/png")).arrayBuffer());
    const txt = [..."Comment\0hello"].map((c) => c.charCodeAt(0));
    const chunk = new Uint8Array(12 + txt.length);
    new DataView(chunk.buffer).setUint32(0, txt.length);
    chunk.set([116, 69, 88, 116], 4);
    chunk.set(txt, 8);
    const src = new Blob([pb.subarray(0, 33), chunk, pb.subarray(33)], { type: "image/png" });
    const r = await C.stripMeta(src);
    const ob = new Uint8Array(await r.blob.arrayBuffer());
    return {
      ok: r.removed.includes("tEXt") && !has(ob, "hello"),
      detail: `消した情報: ${r.removed.join("・")}`,
    };
  });
  await test("ファイルサイズを上限（KB）以内に収める", async () => {
    const c = makeCanvas(800, 600);
    const enc = (q) => toBlob(c, "image/jpeg", q);
    const full = await enc(0.95);
    const max = Math.max(5, Math.round(full.size / 1024 / 3));
    const r = await C.fitToKB(enc, max);
    return {
      ok: !r.over && r.blob.size <= max * 1024,
      detail: `${Math.round(full.size / 1024)}KB → ${Math.round(r.blob.size / 1024)}KB（上限 ${max}KB・画質 ${Math.round(r.q * 100)}）`,
    };
  });
  await test("収まらないときは「上限超え」と知らせる", async () => {
    const c = makeCanvas(800, 600);
    const r = await C.fitToKB((q) => toBlob(c, "image/jpeg", q), 1);
    return { ok: r.over === true, detail: `${Math.round(r.blob.size / 1024)}KB（上限 1KB）` };
  });

  /* --- グループ分け（人工の顔データで確認） --- */
  function rng(seed) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  function unit(v) {
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  }
  function people(nPeople, perPerson, noise, seed) {
    const r = rng(seed);
    const centers = [];
    const faces = [];
    for (let i = 0; i < nPeople; i++) centers.push(unit(Array.from({ length: 128 }, () => r() - 0.5)));
    let photo = 0;
    for (let k = 0; k < perPerson; k++)
      for (let i = 0; i < nPeople; i++) {
        faces.push({ who: i, photoId: photo++, desc: unit(centers[i].map((x) => x + (r() - 0.5) * noise)) });
      }
    return { centers, faces };
  }
  const pure = (gs) => gs.every((g) => new Set(g.map((f) => f.who)).size === 1);
  await test("同じ人の顔を1つにまとめる", () => {
    const { faces } = people(5, 4, 0.04, 7);
    const gs = C.cluster(faces, 0.45);
    return { ok: gs.length === 5 && pure(gs), detail: `20個の顔 → ${gs.length}人` };
  });
  await test("同じ写真に写っている顔は別の人にする", () => {
    const faces = [
      { photoId: 1, desc: [0, 0, 1] },
      { photoId: 1, desc: [0, 0.01, 1] },
      { photoId: 2, desc: [0, 0, 1] },
    ];
    const gs = C.cluster(faces, 0.45);
    return {
      ok: gs.length === 2 && gs.every((g) => new Set(g.map((f) => f.photoId)).size === g.length),
      detail: `${gs.length}人に分けました`,
    };
  });
  await test("クラスの人数を指定すると、その人数に近づける", () => {
    const { faces } = people(4, 3, 0.09, 11);
    const loose = C.cluster(faces, 0.2);
    const gs = C.cluster(faces, 0.2, 4, 0.9);
    return {
      ok: gs.length === 4 && pure(gs) && loose.length > 4,
      detail: `指定なし ${loose.length}人 → 人数4を指定 ${gs.length}人`,
    };
  });
  await test("見本写真の名前をグループに対応づける", () => {
    const { centers, faces } = people(3, 3, 0.04, 21);
    const gs = C.cluster(faces, 0.45).map((g) => ({ faces: g, who: g[0].who }));
    const r = rng(99);
    const refs = ["あおき", "いとう", "うえだ"].map((name, i) => ({
      name,
      desc: unit(centers[i].map((x) => x + (r() - 0.5) * 0.04)),
    }));
    refs.push({ name: "知らない人", desc: unit(Array.from({ length: 128 }, () => r() - 0.5)) });
    const m = C.matchNames(gs, refs, 0.5);
    let ok = m.size === 3;
    for (const [gi, v] of m) if (v.ref.name !== ["あおき", "いとう", "うえだ"][gs[gi].who]) ok = false;
    return { ok, detail: `${m.size}人に名前がつきました（見本にない人は対応なし）` };
  });
  await test("台紙の並べ方（L判に証明写真 30×24mm）", () => {
    const g = C.layoutGrid(89, 127, 24, 30, 3, 2, 0);
    return {
      ok: g.cols === 3 && g.rows === 3 && g.per === 9,
      detail: `${g.cols}列 × ${g.rows}行 = ${g.per}枚`,
    };
  });
  await test("ファイル名に使えない文字を置きかえる", () => {
    const s = window.KaoCommon.safeFileName("3年1組/山田:花子?");
    return { ok: s === "3年1組_山田_花子_", detail: s };
  });

  const ng = results.filter((x) => !x).length;
  const sum = document.getElementById("summary");
  sum.className = ng ? "ng" : "ok";
  sum.textContent = ng ? `${results.length}項目中 ${ng}項目が NG です` : `すべて OK（${results.length}項目）`;
  window.__selftest = { total: results.length, ng };
})();
