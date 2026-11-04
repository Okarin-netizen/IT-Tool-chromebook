/*! かおトリ v1.6.1 | (c) 2026 技術 岡田 | MIT License */
/* かおトリ — 集合写真の顔切り抜き・証明写真トリミング
 * すべての処理はブラウザ内で行い、画像を外部へ送信しない。 */
(() => {
  "use strict";

  const {
    $,
    makeCanvas,
    overlap,
    base64ToBytes,
    mediaPipeFileset,
    safeFileName,
    fileTimeStamp,
    download,
    createStore,
    readControls,
    writeControls,
    busy,
    bindAbout,
  } = window.KaoCommon;
  const PI = Math.PI;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));

  /* ---------- 保存（ブラウザ内） ---------- */
  const store = createStore("kaotori.");

  /* ---------- 状態 ---------- */
  const state = {
    photos: [], // {id,file,name,base,w,h,faces:[],error,thumbScale}
    current: -1,
    mode: "crop", // crop | id
    unit: "mm",
    orient: "portrait",
    zoom: 0, // 0 = 全体表示
    dragTarget: "face", // face | mask（プライバシー加工のとき）
    nextId: 1,
  };

  /* ---------- AI（MediaPipe） ---------- */
  const ai = { detector: null, landmarker: null, segmenter: null, ready: false, threshold: 0.45 };

  /* ---------- 中止と作業ログ ---------- */
  let cancelFlag = false;
  class Cancelled extends Error {
    constructor() {
      super("中止しました");
      this.cancelled = true;
    }
  }
  function checkCancel() {
    if (cancelFlag) throw new Cancelled();
  }
  /* 作業ログ: 件数と日時だけを記録し、写真・名前・顔データは記録しない */
  const workLog = [];
  function logWork(action, detail) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    workLog.push(
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}\t${action}\t${detail || ""}`,
    );
  }

  async function initAI() {
    const st = $("aiStatus");
    try {
      if (!window.MPVision || !window.KAO_WASM_B64 || !window.KAO_MODEL_DETECTOR)
        throw new Error("lib フォルダのファイルが見つかりません");
      const fileset = await mediaPipeFileset();
      ai.detector = await MPVision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: await base64ToBytes(window.KAO_MODEL_DETECTOR), delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.3,
        minSuppressionThreshold: 0.3,
      });
      ai.landmarker = await MPVision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: await base64ToBytes(window.KAO_MODEL_LANDMARKER), delegate: "CPU" },
        runningMode: "IMAGE",
        numFaces: 1,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
      });
      // メモリ節約: 巨大な文字列を解放
      try {
        // 背景の置き換え用（人物の切り抜き）
        ai.segmenter = await MPVision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: await base64ToBytes(window.KAO_MODEL_SEGMENTER), delegate: "CPU" },
          runningMode: "IMAGE",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      } catch (e) {
        console.warn("背景の置き換えは使えません", e);
      }
      window.KAO_WASM_B64 =
        window.KAO_MODEL_DETECTOR =
        window.KAO_MODEL_LANDMARKER =
        window.KAO_MODEL_DETECTOR_SHORT =
        window.KAO_MODEL_SEGMENTER =
          null;
      ai.ready = true;
      st.className = "ai-status ready";
      $("aiStatusText").textContent = "顔を見つける準備ができました";
      if (pendingFiles.length) {
        const f = pendingFiles.splice(0);
        addFiles(f);
      }
    } catch (e) {
      console.error(e);
      st.className = "ai-status error";
      $("aiStatusText").textContent = "顔を見つける部品を読み込めませんでした（" + (e.message || e) + "）";
    }
  }

  /* ---------- 画像の読み込み ---------- */
  const bmpCache = new Map(); // photoId -> ImageBitmap（最近使った3枚だけ保持）
  async function getBitmap(photo) {
    if (bmpCache.has(photo.id)) {
      const b = bmpCache.get(photo.id);
      bmpCache.delete(photo.id);
      bmpCache.set(photo.id, b);
      return b;
    }
    const b = await decodeFile(photo.file);
    bmpCache.set(photo.id, b);
    while (bmpCache.size > 3) {
      const [k, v] = bmpCache.entries().next().value;
      bmpCache.delete(k);
      try {
        v.close();
      } catch {}
    }
    return b;
  }
  async function decodeFile(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // 一部ブラウザ向けの予備手段
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  /* ---------- 顔検出 ---------- */

  async function detectFaces(bmp, onProgress) {
    const W = bmp.width;
    const H = bmp.height;
    const f = Math.min(1, 4000 / Math.max(W, H)); // 検出用の縮小率
    const dw = W * f;
    const dh = H * f;
    const L = Math.min(dw, dh);
    // 大きさの違う顔を拾うため、写真全体＋重なりのある小区画で検出する
    const tiles = [{ x: 0, y: 0, w: dw, h: dh }];
    for (const frac of [0.55, 0.3, 0.17]) {
      const T = L * frac;
      if (T < 160) continue;
      const step = T * 0.6;
      for (let y = 0; y < dh; y += step) {
        for (let x = 0; x < dw; x += step) {
          tiles.push({
            x: Math.min(x, Math.max(0, dw - T)),
            y: Math.min(y, Math.max(0, dh - T)),
            w: Math.min(T, dw),
            h: Math.min(T, dh),
          });
          if (x + T >= dw) break;
        }
        if (y + T >= dh) break;
      }
    }
    const raw = [];
    const tc = makeCanvas(1, 1);
    const tctx = tc.getContext("2d", { willReadFrequently: true });
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const s = Math.min(1, 640 / Math.max(t.w, t.h));
      tc.width = Math.round(t.w * s);
      tc.height = Math.round(t.h * s);
      tctx.imageSmoothingQuality = "high";
      tctx.drawImage(bmp, t.x / f, t.y / f, t.w / f, t.h / f, 0, 0, tc.width, tc.height);
      const res = ai.detector.detect(tc);
      for (const d of res.detections) {
        const score = d.categories?.[0]?.score ?? 0;
        if (score < ai.threshold) continue;
        const bb = d.boundingBox;
        const k = 1 / s / f;
        const box = {
          x: t.x / f + bb.originX * k,
          y: t.y / f + bb.originY * k,
          w: bb.width * k,
          h: bb.height * k,
        };
        if (box.w < 10) continue;
        const kp = (d.keypoints || []).map((p) => ({ x: (t.x + p.x * t.w) / f, y: (t.y + p.y * t.h) / f }));
        raw.push({ box, score, kp, tileScale: t.w / L });
      }
      if (onProgress) onProgress(i / tiles.length);
      await tick();
      checkCancel(); // 区画ごとに画面を更新し、中止できるようにする
    }
    // 重複の除去（信頼度の高いものを残す）
    raw.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const r of raw) {
      if (
        kept.some((k) => {
          const o = overlap(k.box, r.box);
          return o.iou > 0.3 || o.cover > 0.6;
        })
      )
        continue;
      kept.push(r);
    }
    return kept;
  }

  /* 目・あごの位置を詳しく求める（顔ごとに拡大して特徴点を検出） */
  const lmCanvas = makeCanvas(320, 320);
  function refineFace(bmp, cand) {
    const b = cand.box;
    const size = Math.max(b.w, b.h) * 2.0;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const sx = cx - size / 2;
    const sy = cy - size / 2;
    const ctx = lmCanvas.getContext("2d");
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, 320, 320);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, sx, sy, size, size, 0, 0, 320, 320);
    let res = null;
    try {
      res = ai.landmarker.detect(lmCanvas);
    } catch (e) {
      console.warn(e);
    }
    const lm = res?.faceLandmarks?.[0];
    const P = (p) => ({ x: sx + p.x * size, y: sy + p.y * size });
    if (lm && lm.length >= 468) {
      let a = P(lm[lm.length > 473 ? 468 : 33]);
      let c = P(lm[lm.length > 473 ? 473 : 263]);
      if (a.x > c.x) [a, c] = [c, a];
      const chin = P(lm[152]);
      // 特徴点が元の検出枠から大きく外れていたら採用しない
      const em = mid(a, c);
      if (Math.abs(em.x - cx) < b.w && Math.abs(em.y - cy) < b.h * 1.2) {
        return { eyeL: a, eyeR: c, chin, landmarks: true };
      }
    }
    // 予備: 検出器のキーポイントから推定
    let eL;
    let eR;
    if (cand.kp.length >= 2) {
      eL = cand.kp[0];
      eR = cand.kp[1];
      if (eL.x > eR.x) [eL, eR] = [eR, eL];
    } else {
      eL = { x: b.x + b.w * 0.3, y: b.y + b.h * 0.4 };
      eR = { x: b.x + b.w * 0.7, y: b.y + b.h * 0.4 };
    }
    const em = mid(eL, eR);
    const ang = Math.atan2(eR.y - eL.y, eR.x - eL.x);
    const dist = b.h * 0.62;
    return {
      eyeL: eL,
      eyeR: eR,
      chin: { x: em.x - Math.sin(ang) * dist, y: em.y + Math.cos(ang) * dist },
      landmarks: false,
    };
  }
  function mid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function sortFaces(faces) {
    // 段（行）ごとに左から右へ番号をつける
    const arr = faces.slice().sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2));
    const rows = [];
    for (const f of arr) {
      const cy = f.box.y + f.box.h / 2;
      const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(r.h, f.box.h) * 0.6);
      if (row) {
        row.items.push(f);
        row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length;
      } else rows.push({ cy, h: f.box.h, items: [f] });
    }
    rows.sort((a, b) => a.cy - b.cy);
    return rows.flatMap((r) => r.items.sort((a, b) => a.box.x - b.box.x));
  }

  function makeFace(photo, cand, geo, manual) {
    return {
      id: state.nextId++,
      photoId: photo.id,
      box: cand.box,
      score: cand.score ?? 1,
      eyeL: geo.eyeL,
      eyeR: geo.eyeR,
      chin: geo.chin,
      landmarks: geo.landmarks,
      // イラストやポスターの顔を拾いにくくするため、信頼度が低いものは最初「使わない」にする
      include: manual || cand.score >= 0.75 || (geo.landmarks && cand.score >= 0.62),
      manual: !!manual,
      adj: { dx: 0, dy: 0, s: 1, r: 0, hair: 0 },
      customName: "",
      thumb: null,
    };
  }

  async function processPhoto(photo, prog) {
    const bmp = await getBitmap(photo);
    photo.w = bmp.width;
    photo.h = bmp.height;
    const cands = await detectFaces(bmp, prog);
    const faces = [];
    for (const c of cands) faces.push(makeFace(photo, c, refineFace(bmp, c), false));
    photo.faces = sortFaces(faces);
  }

  /* ---------- HEIC（iPhone写真）をJPGに変換 ---------- */
  const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type);
  async function heicToJpeg(file) {
    // ブラウザ自体がHEICを開ける場合（Safariなど）はそのまま使う
    try {
      const b = await createImageBitmap(file);
      b.close();
      return file;
    } catch {
      /* 変換へ */
    }
    // The site's shared HEIC converter (heic-to, loaded only when a HEIC file shows up).
    const { readableImage } = await import("../shared/js/heic.js");
    const jpeg = await readableImage(file);
    return new File([jpeg], file.name.replace(/\.(heic|heif)$/i, "") + ".jpg", {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  }

  /* ---------- 写真の追加 ---------- */
  let pendingFiles = [];
  const OK_EXT = /\.(jpe?g|png|bmp|webp|gif|tiff?|heic|heif|avif)$/i;
  async function addFiles(files) {
    files = [...files].filter((f) => f.type.startsWith("image/") || OK_EXT.test(f.name));
    if (!files.length) return;
    if (!ai.ready) {
      pendingFiles.push(...files);
      busy.show("準備ができしだい読み込みます…", 0);
      waitAIThenHide();
      return;
    }
    cancelFlag = false;
    let doneCount = 0;
    let faceCount = 0;
    for (let i = 0; i < files.length; i++) {
      if (cancelFlag) {
        state.photos = state.photos.filter((p) => p.faces.length || p.error);
        break;
      }
      let file = files[i];
      const photo = {
        id: state.nextId++,
        file,
        name: file.name,
        base: file.name.replace(/\.[^.]+$/, ""),
        faces: [],
        masks: [],
        error: "",
      };
      state.photos.push(photo);
      try {
        if (isHeic(file)) {
          busy.show(
            `iPhoneの写真（HEIC）をJPGに変換しています（${i + 1} / ${files.length}）\n${file.name}`,
            i / files.length,
          );
          try {
            file = await heicToJpeg(file);
          } catch (e) {
            console.error(e);
            throw Object.assign(new Error("heic"), { heic: true });
          }
          photo.file = file;
          photo.converted = file !== files[i];
        }
        busy.show(`顔を探しています（${i + 1} / ${files.length}）\n${photo.name}`, i / files.length);
        await processPhoto(photo, (p) => busy.setBar((i + p) / files.length));
        doneCount++;
        faceCount += photo.faces.filter((f) => f.include).length;
      } catch (e) {
        if (!e.cancelled) console.error(e);
        if (e.cancelled) {
          state.photos = state.photos.filter((p) => p !== photo);
          break;
        }
        photo.error = e.heic
          ? "HEICを変換できませんでした（JPGに変換して読み込んでください）"
          : "読み込めませんでした";
      }
      if (state.current < 0 && !photo.error) state.current = state.photos.length - 1;
      renderPhotoList();
    }
    if (state.current < 0) state.current = 0;
    busy.hide();
    logWork("写真の読み込み", `${doneCount}枚・顔${faceCount}人${cancelFlag ? "（途中で中止）" : ""}`);
    if (cancelFlag) alert(`読み込みを中止しました（${doneCount}枚まで読み込み済み）`);
    cancelFlag = false;
    refreshAll();
  }
  async function waitAIThenHide() {
    while (!ai.ready && !$("aiStatus").classList.contains("error")) await sleep(200);
    if (!ai.ready) busy.hide();
  }

  /* ---------- 切り抜きの計算 ---------- */
  function num(id, d = 0) {
    const v = parseFloat($(id).value);
    return isFinite(v) ? v : d;
  }
  function settings() {
    const dpi = num("dpi", 350);
    const toPx = (v) => (state.unit === "mm" ? (v * dpi) / 25.4 : v);
    return {
      mode: state.mode,
      dpi,
      cropX: Math.max(1, num("cropX", 2)),
      cropY: Math.max(1, num("cropY", 1.9)),
      cropShift: num("cropShift", 0) / 100,
      resizeMode: $("resizeMode").value,
      resizeLong: num("resizeLong", 800),
      resizeW: num("resizeW", 600),
      resizeH: num("resizeH", 800),
      idW: toPx(num("idW", 30)),
      idH: toPx(num("idH", 40)),
      idFace: toPx(num("idFace", 26)),
      idTop: toPx(num("idTop", 4)),
      straighten: $("straighten").checked,
      hair: num("hair", 1.1),
      bg: $("bgColor").value,
      bgReplace:
        $("bgReplace").value === "none"
          ? ""
          : $("bgReplace").value === "custom"
            ? $("bgColor").value
            : $("bgReplace").value,
    };
  }

  /* 顔ごとの変換: 元画像の点 aSrc を出力の点 aOut に合わせ、倍率 scale・角度 rot で描く */
  function faceTransform(face, S) {
    const em = mid(face.eyeL, face.eyeR);
    const ang = S.straighten ? Math.atan2(face.eyeR.y - face.eyeL.y, face.eyeR.x - face.eyeL.x) : 0;
    const down = { x: -Math.sin(ang), y: Math.cos(ang) };
    const chinDist = Math.max(4, (face.chin.x - em.x) * down.x + (face.chin.y - em.y) * down.y);
    const k = S.hair + (face.adj.hair || 0);
    const headTop = { x: em.x - down.x * chinDist * k, y: em.y - down.y * chinDist * k };
    const faceH = chinDist * (1 + k);
    let W;
    let H;
    let scale;
    let aSrc;
    let aOut;
    if (S.mode === "id") {
      W = S.idW;
      H = S.idH;
      scale = S.idFace / faceH;
      aSrc = headTop;
      aOut = { x: W / 2, y: S.idTop };
    } else {
      const natW = faceH * 0.78 * S.cropX;
      const natH = faceH * S.cropY;
      const c = mid(headTop, face.chin);
      aSrc = { x: c.x + down.x * faceH * S.cropShift, y: c.y + down.y * faceH * S.cropShift };
      if (S.resizeMode === "long") {
        scale = S.resizeLong / Math.max(natW, natH);
        W = natW * scale;
        H = natH * scale;
      } else if (S.resizeMode === "fixed") {
        W = S.resizeW;
        H = S.resizeH;
        scale = Math.max(W / natW, H / natH);
      } else {
        scale = 1;
        W = natW;
        H = natH;
      }
      aOut = { x: W / 2, y: H / 2 };
    }
    W = Math.max(1, Math.round(W));
    H = Math.max(1, Math.round(H));
    return { W, H, scale, aSrc, aOut, ang, faceH, chinOut: aOut.y + (S.mode === "id" ? faceH * scale : 0) };
  }

  function renderFace(face, bmp, S, maxSide) {
    const T = faceTransform(face, S);
    const f = maxSide ? Math.min(1, maxSide / Math.max(T.W, T.H)) : 1;
    const c = makeCanvas(T.W * f, T.H * f);
    const ctx = c.getContext("2d");
    ctx.fillStyle = S.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.scale(f, f);
    ctx.translate(T.aOut.x + face.adj.dx * T.W, T.aOut.y + face.adj.dy * T.H);
    ctx.scale(T.scale * face.adj.s, T.scale * face.adj.s);
    ctx.rotate(-T.ang + (face.adj.r * PI) / 180);
    ctx.translate(-T.aSrc.x, -T.aSrc.y);
    ctx.drawImage(bmp, 0, 0);
    if (S.bgReplace && ai.segmenter) replaceBackground(c, S.bgReplace);
    return { canvas: c, T, f };
  }

  /* 人物以外（背景）を指定の色に置き換える */
  function replaceBackground(c, color) {
    let res;
    try {
      res = ai.segmenter.segment(c);
    } catch (e) {
      console.warn(e);
      return;
    }
    try {
      const m = res.confidenceMasks?.[res.confidenceMasks.length - 1];
      if (!m) return;
      const mw = m.width;
      const mh = m.height;
      const a = m.getAsFloat32Array();
      const mk = makeCanvas(mw, mh);
      const mctx = mk.getContext("2d");
      const img = mctx.createImageData(mw, mh);
      for (let i = 0; i < a.length; i++) {
        // 境目をなめらかにするため、確からしさを少し強調して透明度にする
        const v = Math.min(1, Math.max(0, (a[i] - 0.25) / 0.5));
        img.data[i * 4 + 3] = Math.round(v * 255);
      }
      mctx.putImageData(img, 0, 0);
      const person = makeCanvas(c.width, c.height);
      const pctx = person.getContext("2d");
      pctx.drawImage(c, 0, 0);
      pctx.globalCompositeOperation = "destination-in";
      pctx.filter = `blur(${Math.max(0.6, c.width / 400)}px)`;
      pctx.drawImage(mk, 0, 0, c.width, c.height);
      const ctx = c.getContext("2d");
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(person, 0, 0);
      ctx.restore();
    } finally {
      try {
        res.close?.();
      } catch {}
    }
  }

  /* ---------- プライバシー加工（モザイク・ぼかし・目線・塗りつぶし） ---------- */
  function privSettings() {
    return {
      face: $("privFace").value,
      mask: $("privMask").value,
      k: num("privStrength", 3),
      color: $("privColor").value,
      area: num("privArea", 1.35),
      shape: $("privShape").value,
    };
  }
  /* 写真全体を s 倍で描き、加工を入れたキャンバスを返す */
  function renderPrivacy(photo, bmp, s) {
    const P = privSettings();
    const c = makeCanvas(bmp.width * s, bmp.height * s);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const regions = [];
    if (P.face !== "none")
      for (const f of photo.faces) if (f.include) regions.push({ face: f, method: P.face });
    for (const m of photo.masks || []) regions.push({ rect: m, method: P.mask });
    for (const r of regions) {
      if (r.method === "eyebar") {
        drawEyeBar(ctx, r.face, s, P);
        continue;
      }
      let x;
      let y;
      let w;
      let h;
      let ellipse = false;
      if (r.face) {
        // 目とあごの位置から範囲を決める（顔だけ／頭まで／広め）
        const f = r.face;
        const em = mid(f.eyeL, f.eyeR);
        const cd = Math.max(f.box.h * 0.3, Math.hypot(f.chin.x - em.x, f.chin.y - em.y));
        let top;
        let bottom;
        if (P.area <= 1) {
          top = em.y - cd * 0.75;
          bottom = f.chin.y + cd * 0.06;
        } else {
          top = em.y - cd * 1.2;
          bottom = f.chin.y + cd * 0.12;
        }
        h = bottom - top;
        w = h * 0.84;
        const cx = (em.x + f.chin.x) / 2;
        const cy = (top + bottom) / 2;
        if (P.area > 1.5) {
          w *= 1.25;
          h *= 1.2;
        }
        x = cx - w / 2;
        y = cy - h / 2;
        ellipse = r.method === "fill" || P.shape === "ellipse";
      } else ({ x, y, w, h } = r.rect);
      x *= s;
      y *= s;
      w *= s;
      h *= s;
      x = Math.max(0, x);
      y = Math.max(0, y);
      w = Math.min(c.width - x, w);
      h = Math.min(c.height - y, h);
      if (w < 1 || h < 1) continue;
      if (r.method === "mosaic") {
        const blocks = [18, 13, 10, 7, 5][Math.round(P.k) - 1] || 10;
        const cell = Math.max(2, Math.min(w, h) / blocks);
        const sw = Math.max(1, Math.round(w / cell));
        const sh = Math.max(1, Math.round(h / cell));
        const t = makeCanvas(sw, sh);
        const tc = t.getContext("2d");
        tc.imageSmoothingQuality = "high";
        tc.drawImage(c, x, y, w, h, 0, 0, sw, sh);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        if (ellipse) {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, PI * 2);
          ctx.clip();
        }
        ctx.drawImage(t, 0, 0, sw, sh, x, y, w, h);
        ctx.restore();
      } else if (r.method === "blur") {
        const rad = Math.max(2, Math.min(w, h) * [0.04, 0.07, 0.1, 0.14, 0.2][Math.round(P.k) - 1]);
        ctx.save();
        ctx.beginPath();
        if (ellipse) ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, PI * 2);
        else ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.filter = `blur(${rad}px)`;
        // 2回重ねて、ぼかしの強さを確実にする
        ctx.drawImage(c, 0, 0);
        ctx.drawImage(c, 0, 0);
        ctx.restore();
      } else {
        // fill
        ctx.fillStyle = P.color;
        if (ellipse) {
          ctx.beginPath();
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, PI * 2);
          ctx.fill();
        } else ctx.fillRect(x, y, w, h);
      }
    }
    return c;
  }
  function drawEyeBar(ctx, f, s, P) {
    const em = mid(f.eyeL, f.eyeR);
    const ang = Math.atan2(f.eyeR.y - f.eyeL.y, f.eyeR.x - f.eyeL.x);
    const d = Math.max(Math.hypot(f.eyeR.x - f.eyeL.x, f.eyeR.y - f.eyeL.y), f.box.w * 0.35);
    const w = d * 2.5;
    const h = d * (0.45 + P.k * 0.08);
    ctx.save();
    ctx.translate(em.x * s, em.y * s);
    ctx.rotate(ang);
    ctx.fillStyle = P.color;
    ctx.fillRect((-w * s) / 2, (-h * s) / 2, w * s, h * s);
    ctx.restore();
  }

  /* ---------- 名前 ---------- */
  function includedFaces() {
    const out = [];
    for (const p of state.photos) for (const f of p.faces) if (f.include) out.push({ photo: p, face: f });
    return out;
  }
  function computeNames(list) {
    const mode = $("nameMode").value;
    const start = Math.round(num("startNo", 1));
    const digits = Math.max(1, Math.round(num("digits", 2)));
    const roster = $("roster")
      .value.split(/\r?\n/)
      .map((s) => s.split("\t")[0].trim())
      .filter(Boolean);
    const pad = (n) => String(n).padStart(digits, "0");
    const perPhoto = new Map();
    const used = new Map();
    return list.map(({ photo, face }, i) => {
      let n;
      if (face.customName) n = face.customName;
      else if (mode === "orig") {
        const c = (perPhoto.get(photo.id) || 0) + 1;
        perPhoto.set(photo.id, c);
        n = `${photo.base}_${pad(c + start - 1)}`;
      } else if (mode === "custom") n = `${$("customText").value}${pad(i + start)}`;
      else if (mode === "roster") n = roster[i] || `名簿なし_${pad(i + start)}`;
      else n = pad(i + start);
      n = safeFileName(n) || pad(i + start);
      const k = n.toLowerCase();
      if (used.has(k)) {
        const c = used.get(k) + 1;
        used.set(k, c);
        n = `${n}(${c})`;
      } else used.set(k, 1);
      return n;
    });
  }

  /* ---------- 写真ビュー ---------- */
  const pc = $("photoCanvas");
  let view = { scale: 1, bmp: null, photo: null };
  let drag = null;

  /* 顔の枠の色：使わない顔は赤、手で足した顔は青、見つけた顔は緑 */
  function faceBoxColor(face) {
    if (!face.include) return "#ef4444";
    if (face.manual) return "#3b82f6";
    return "#22c55e";
  }

  async function drawPhoto() {
    const photo = state.photos[state.current];
    $("emptyPhoto").hidden = !!photo;
    $("photoView").hidden = !photo;
    if (!photo) return;
    $("photoTitle").textContent =
      `${state.current + 1} / ${state.photos.length}　${photo.name}　（顔 ${photo.faces.filter((f) => f.include).length} / ${photo.faces.length}）`;
    if (photo.error) {
      pc.width = 600;
      pc.height = 200;
      const ctx = pc.getContext("2d");
      ctx.fillStyle = "#2b2f36";
      ctx.fillRect(0, 0, 600, 200);
      ctx.fillStyle = "#fff";
      ctx.font = "16px sans-serif";
      ctx.fillText(photo.error, 20, 100);
      return;
    }
    const bmp = await getBitmap(photo);
    view.bmp = bmp;
    view.photo = photo;
    const stage = $("stage");
    const fit = Math.min((stage.clientWidth - 4) / bmp.width, (stage.clientHeight - 4) / bmp.height);
    view.scale = state.zoom > 0 ? fit * state.zoom : fit;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(bmp.width * view.scale);
    const ch = Math.round(bmp.height * view.scale);
    pc.width = cw * dpr;
    pc.height = ch * dpr;
    pc.style.width = cw + "px";
    pc.style.height = ch + "px";
    const ctx = pc.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = "high";
    const priv = state.mode === "privacy";
    if (priv && !$("showOriginal").checked)
      ctx.drawImage(renderPrivacy(photo, bmp, view.scale * dpr), 0, 0, cw, ch);
    else ctx.drawImage(bmp, 0, 0, cw, ch);
    if (priv && !$("showBoxes").checked) {
      drawDragRect(ctx);
      return;
    }
    if (priv)
      for (const m of photo.masks) {
        const s = view.scale;
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#f59e0b";
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(m.x * s, m.y * s, m.w * s, m.h * s);
        ctx.setLineDash([]);
        ctx.fillStyle = "#f59e0b";
        ctx.fillRect(m.x * s, m.y * s - 18, 44, 18);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 12px sans-serif";
        ctx.fillText("隠す", m.x * s + 6, m.y * s - 5);
      }
    const names = new Map();
    const all = includedFaces();
    const nm = computeNames(all);
    all.forEach((x, i) => names.set(x.face.id, { no: i + 1, name: nm[i] }));
    for (const f of photo.faces) {
      const b = f.box;
      const s = view.scale;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = faceBoxColor(f);
      ctx.setLineDash(f.include ? [] : [6, 4]);
      ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
      ctx.setLineDash([]);
      const info = names.get(f.id);
      const label = info ? String(info.no) : "×";
      ctx.font = "bold 13px sans-serif";
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(b.x * s, b.y * s - 18, tw, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, b.x * s + 4, b.y * s - 5);
    }
    drawDragRect(ctx);
  }
  function drawDragRect(ctx) {
    if (drag && drag.kind === "new") {
      ctx.strokeStyle = dragIsMask() ? "#f59e0b" : "#3b82f6";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0);
      ctx.setLineDash([]);
    }
  }
  function dragIsMask() {
    return state.mode === "privacy" && state.dragTarget === "mask";
  }
  function hitMask(x, y) {
    const p = view.photo;
    if (!p) return null;
    const s = view.scale;
    return (
      [...p.masks]
        .reverse()
        .find((m) => x >= m.x * s && x <= (m.x + m.w) * s && y >= m.y * s && y <= (m.y + m.h) * s) || null
    );
  }

  function hitFace(x, y) {
    const p = view.photo;
    if (!p) return null;
    const s = view.scale;
    let best = null;
    for (const f of p.faces) {
      const b = f.box;
      if (x >= b.x * s && x <= (b.x + b.w) * s && y >= b.y * s && y <= (b.y + b.h) * s) {
        if (!best || b.w < best.box.w) best = f;
      }
    }
    return best;
  }
  function canvasPos(e) {
    const r = pc.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pc.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !view.photo) return;
    const p = canvasPos(e);
    drag = { kind: "maybe", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = canvasPos(e);
    drag.x1 = p.x;
    drag.y1 = p.y;
    if (drag.kind === "maybe" && Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 8) drag.kind = "new";
    if (drag.kind === "new") drawPhoto();
  });
  window.addEventListener("pointerup", async () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const photo = view.photo;
    if (!photo) return;
    if (d.kind === "maybe") {
      const f = hitFace(d.x0, d.y0);
      if (f) {
        f.include = !f.include;
        refreshAll();
      }
      return;
    }
    const s = view.scale;
    const x = Math.min(d.x0, d.x1) / s;
    const y = Math.min(d.y0, d.y1) / s;
    const w = Math.abs(d.x1 - d.x0) / s;
    const h = Math.abs(d.y1 - d.y0) / s;
    if (w < 8 || h < 8) {
      drawPhoto();
      return;
    }
    if (dragIsMask()) {
      photo.masks.push({ x, y, w, h });
      refreshAll();
      return;
    }
    const cand = { box: { x, y, w, h }, score: 1, kp: [] };
    const geo = refineFace(view.bmp, cand);
    if (!geo.landmarks) {
      // 枠をそのまま顔とみなす
      geo.eyeL = { x: x + w * 0.3, y: y + h * 0.42 };
      geo.eyeR = { x: x + w * 0.7, y: y + h * 0.42 };
      geo.chin = { x: x + w / 2, y: y + h * 0.98 };
    }
    photo.faces.push(makeFace(photo, cand, geo, true));
    photo.faces = sortFaces(photo.faces);
    refreshAll();
  });
  pc.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const p = canvasPos(e);
    const f = hitFace(p.x, p.y);
    const m = state.mode === "privacy" ? hitMask(p.x, p.y) : null;
    if (m) {
      view.photo.masks = view.photo.masks.filter((x) => x !== m);
      refreshAll();
      return;
    }
    if (f && f.manual) {
      const ph = view.photo;
      ph.faces = ph.faces.filter((x) => x !== f);
      refreshAll();
    }
  });
  pc.addEventListener("dblclick", (e) => {
    const p = canvasPos(e);
    const f = hitFace(p.x, p.y);
    if (f) {
      f.include = true;
      openAdjust(f);
    }
  });

  /* ---------- 一覧 ---------- */
  let gridJob = 0;
  async function drawGrid() {
    const job = ++gridJob;
    const grid = $("faceGrid");
    const list = includedFaces();
    $("faceCount").textContent = list.length;
    $("emptyFaces").hidden = list.length > 0;
    $("saveZipBtn").disabled = $("layoutZipBtn").disabled = $("printBtn").disabled = !list.length;
    $("clearBtn").disabled = !state.photos.length;
    updateLayoutInfo();
    if (state.mode === "privacy") {
      const okPhotos = state.photos.filter((p) => !p.error);
      $("saveZipBtn").disabled = !okPhotos.length;
      $("emptyFaces").hidden = okPhotos.length > 0;
      if ($("pane-faces").hidden) return;
      grid.textContent = "";
      grid.classList.add("wide");
      for (const photo of okPhotos) {
        const card = document.createElement("div");
        card.className = "fcard";
        card.title = "クリックで写真を開く";
        const c = makeCanvas(10, 10);
        card.appendChild(c);
        const fn = document.createElement("div");
        fn.className = "fn";
        fn.textContent = `${photo.base}_加工（顔 ${photo.faces.filter((f) => f.include).length}・隠す範囲 ${photo.masks.length}）`;
        card.appendChild(fn);
        card.addEventListener("click", () => {
          state.current = state.photos.indexOf(photo);
          state.zoom = 0;
          showTab("photo");
          refreshAll();
        });
        grid.appendChild(card);
        const bmp = await getBitmap(photo);
        if (job !== gridJob) return;
        const r = renderPrivacy(photo, bmp, Math.min(1, 520 / Math.max(bmp.width, bmp.height)));
        c.width = r.width;
        c.height = r.height;
        c.getContext("2d").drawImage(r, 0, 0);
        await tick();
      }
      return;
    }
    grid.classList.remove("wide");
    if ($("pane-faces").hidden) {
      grid.dataset.stale = "1";
      return;
    }
    grid.dataset.stale = "";
    const names = computeNames(list);
    const S = settings();
    grid.textContent = "";
    let lastPhoto = null;
    for (let i = 0; i < list.length; i++) {
      const { photo, face } = list[i];
      if (photo !== lastPhoto) {
        const h = document.createElement("div");
        h.className = "grid-head";
        h.textContent = photo.name;
        grid.appendChild(h);
        lastPhoto = photo;
      }
      const card = document.createElement("div");
      card.className = "fcard";
      card.title = "クリックで調整";
      const c = makeCanvas(10, 10);
      card.appendChild(c);
      const no = document.createElement("span");
      no.className = "no";
      no.textContent = i + 1;
      card.appendChild(no);
      if (face.adj.dx || face.adj.dy || face.adj.s !== 1 || face.adj.r || face.adj.hair) {
        const m = document.createElement("span");
        m.className = "adjmark";
        m.textContent = "調整済";
        card.appendChild(m);
      }
      const fn = document.createElement("div");
      fn.className = "fn";
      fn.textContent = names[i];
      card.appendChild(fn);
      card.addEventListener("click", () => openAdjust(face));
      grid.appendChild(card);
      const bmp = await getBitmap(photo);
      if (job !== gridJob) return;
      const r = renderFace(face, bmp, S, 260);
      c.width = r.canvas.width;
      c.height = r.canvas.height;
      c.getContext("2d").drawImage(r.canvas, 0, 0);
      if (i % 6 === 5) await tick();
    }
  }

  /* ---------- 手動調整 ---------- */
  const dlg = $("adjDialog");
  const ac = $("adjCanvas");
  let adjFace = null;
  let adjBmp = null;
  let adjDrag = null;

  async function openAdjust(face) {
    adjFace = face;
    const photo = state.photos.find((p) => p.id === face.photoId);
    adjBmp = await getBitmap(photo);
    const list = includedFaces();
    const idx = list.findIndex((x) => x.face === face);
    const names = computeNames(list);
    $("adjTitle").textContent =
      `${idx >= 0 ? idx + 1 + "人目 / " + list.length + "人" : "（使わない顔）"}　${photo.name}`;
    $("adjName").value = face.customName || (idx >= 0 ? names[idx] : "");
    $("adjName").placeholder = idx >= 0 ? names[idx] : "";
    $("adjInclude").checked = face.include;
    if (!dlg.open) dlg.showModal();
    drawAdjust();
  }
  function drawAdjust() {
    if (!adjFace) return;
    const S = settings();
    const r = renderFace(adjFace, adjBmp, S, 900);
    ac.width = r.canvas.width;
    ac.height = r.canvas.height;
    const ctx = ac.getContext("2d");
    ctx.drawImage(r.canvas, 0, 0);
    if ($("adjGuide").checked) {
      const f = r.f;
      const T = r.T;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(239,68,68,.9)";
      ctx.setLineDash([6, 4]);
      const line = (y) => {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(ac.width, y);
        ctx.stroke();
      };
      if (S.mode === "id") {
        line(S.idTop * f);
        line((S.idTop + S.idFace) * f);
      }
      ctx.strokeStyle = "rgba(37,99,235,.7)";
      ctx.beginPath();
      ctx.moveTo(ac.width / 2, 0);
      ctx.lineTo(ac.width / 2, ac.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  function adjAct(act) {
    const a = adjFace?.adj;
    if (!a) return;
    const step = 0.01;
    switch (act) {
      case "up":
        a.dy -= step;
        break;
      case "down":
        a.dy += step;
        break;
      case "left":
        a.dx -= step;
        break;
      case "right":
        a.dx += step;
        break;
      case "zoomin":
        a.s *= 1.03;
        break;
      case "zoomout":
        a.s /= 1.03;
        break;
      case "rotl":
        a.r -= 1;
        break;
      case "rotr":
        a.r += 1;
        break;
      case "reset":
        Object.assign(a, { dx: 0, dy: 0, s: 1, r: 0, hair: 0 });
        break;
      case "next":
      case "prev":
        return stepFace(act === "next" ? 1 : -1);
    }
    drawAdjust();
    scheduleRefresh(true);
  }
  function stepFace(d) {
    saveAdjName();
    const list = includedFaces();
    let idx = list.findIndex((x) => x.face === adjFace);
    if (idx < 0) idx = d > 0 ? -1 : list.length;
    const n = list[idx + d];
    if (n) openAdjust(n.face);
    else {
      dlg.close();
    }
  }
  function saveAdjName() {
    if (!adjFace) return;
    const v = $("adjName").value.trim();
    adjFace.customName = v && v !== $("adjName").placeholder ? v : "";
  }
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) adjAct(b.dataset.act);
  });
  dlg.addEventListener("close", () => {
    saveAdjName();
    adjFace = null;
    refreshAll();
  });
  $("adjGuide").addEventListener("change", drawAdjust);
  $("adjInclude").addEventListener("change", () => {
    if (adjFace) {
      adjFace.include = $("adjInclude").checked;
      scheduleRefresh();
    }
  });
  $("adjName").addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      stepFace(1);
    }
  });
  dlg.addEventListener("keydown", (e) => {
    const map = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
      "+": "zoomin",
      ";": "zoomin",
      "-": "zoomout",
      "[": "rotl",
      "]": "rotr",
      Enter: "next",
    };
    if (map[e.key]) {
      e.preventDefault();
      adjAct(map[e.key]);
    }
  });
  ac.addEventListener("pointerdown", (e) => {
    if (!adjFace) return;
    adjDrag = { x: e.clientX, y: e.clientY, rot: e.shiftKey || e.button === 2, start: { ...adjFace.adj } };
    e.preventDefault();
  });
  ac.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("pointermove", (e) => {
    if (!adjDrag || !adjFace) return;
    const r = ac.getBoundingClientRect();
    const dx = (e.clientX - adjDrag.x) / r.width;
    const dy = (e.clientY - adjDrag.y) / r.height;
    if (adjDrag.rot) adjFace.adj.r = adjDrag.start.r + dx * 60;
    else {
      adjFace.adj.dx = adjDrag.start.dx + dx;
      adjFace.adj.dy = adjDrag.start.dy + dy;
    }
    drawAdjust();
  });
  window.addEventListener("pointerup", () => {
    if (adjDrag) {
      adjDrag = null;
      scheduleRefresh(true);
    }
  });
  ac.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      adjAct(e.deltaY < 0 ? "zoomin" : "zoomout");
    },
    { passive: false },
  );

  /* ---------- 書き出し ---------- */
  function canvasToBlob(c, type, q) {
    return new Promise((r) => c.toBlob(r, type, q));
  }
  async function encode(canvas, dpi, useLimit = true) {
    const fmt = $("format").value;
    const type = fmt === "png" ? "image/png" : "image/jpeg";
    const q = Math.min(1, num("quality", 95) / 100);
    const maxKB = useLimit ? num("maxKB", 0) : 0;
    let blob;
    let over = false;
    if (fmt === "jpg" && maxKB > 0) {
      // 上限（KB）に収まるいちばん高い画質を探す
      const r = await KAO_CORE.fitToKB((qq) => canvasToBlob(canvas, type, qq), maxKB, q);
      blob = r.blob;
      over = r.over;
    } else {
      blob = await canvasToBlob(canvas, type, q);
      if (maxKB > 0 && blob.size > maxKB * 1024) over = true;
    }
    if (fmt === "jpg" && dpi) blob = await setJpegDpi(blob, dpi);
    return { blob, ext: fmt === "png" ? "png" : "jpg", over };
  }
  async function setJpegDpi(blob, dpi) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    // JFIF の APP0 があれば解像度を書き換える（印刷時に正しいサイズになるように）
    if (buf[2] === 0xff && buf[3] === 0xe0 && String.fromCharCode(...buf.slice(6, 10)) === "JFIF") {
      const d = Math.round(dpi);
      buf[13] = 1;
      buf[14] = d >> 8;
      buf[15] = d & 255;
      buf[16] = d >> 8;
      buf[17] = d & 255;
    }
    return new Blob([buf], { type: "image/jpeg" });
  }

  async function renderAllFaces(onEach) {
    const list = includedFaces();
    const names = computeNames(list);
    const S = settings();
    for (let i = 0; i < list.length; i++) {
      const bmp = await getBitmap(list[i].photo);
      const r = renderFace(list[i].face, bmp, S);
      await onEach(r.canvas, names[i], i, list.length);
      busy.setBar((i + 1) / list.length);
      if (i % 3 === 2) await tick();
      checkCancel();
    }
    return S;
  }

  $("saveZipBtn").addEventListener("click", async () => {
    let overCount = 0;
    let fileCount = 0;
    try {
      cancelFlag = false;
      busy.show("画像を書き出しています…", 0);
      const zip = new JSZip();
      if (state.mode === "privacy") {
        const photos = state.photos.filter((p) => !p.error);
        const used = new Set();
        for (let i = 0; i < photos.length; i++) {
          const bmp = await getBitmap(photos[i]);
          const { blob, ext, over } = await encode(renderPrivacy(photos[i], bmp, 1), 0);
          if (over) overCount++;
          fileCount++;
          let n = safeFileName(photos[i].base + "_加工");
          while (used.has(n)) n += "_";
          used.add(n);
          zip.file(`${n}.${ext}`, blob);
          busy.setBar((i + 1) / photos.length);
          await tick();
          checkCancel();
        }
        busy.setText("ZIPにまとめています…");
        download(await zip.generateAsync({ type: "blob" }), `かおトリ_加工_${fileTimeStamp()}.zip`);
        logWork("モザイク加工の保存", `${fileCount}枚`);
      } else {
        const dpi = state.mode === "id" ? num("dpi", 350) : 0;
        await renderAllFaces(async (c, name) => {
          const { blob, ext, over } = await encode(c, dpi);
          if (over) overCount++;
          fileCount++;
          zip.file(`${name}.${ext}`, blob);
        });
        busy.setText("ZIPにまとめています…");
        const out = await zip.generateAsync({ type: "blob" });
        download(out, `かおトリ_${fileTimeStamp()}.zip`);
        logWork(state.mode === "id" ? "証明写真の保存" : "顔の切り抜きの保存", `${fileCount}枚`);
      }
      if (overCount)
        alert(
          `${overCount}枚は、画質をいちばん下げても上限（${num("maxKB")}KB）に収まりませんでした。出力サイズを小さくしてください。`,
        );
    } catch (e) {
      if (e.cancelled) alert("保存を中止しました");
      else {
        alert("保存に失敗しました: " + e.message);
        console.error(e);
      }
    } finally {
      busy.hide();
      cancelFlag = false;
    }
  });

  /* 台紙レイアウト */
  function layoutSpec() {
    const S = settings();
    let [pw, ph] =
      $("paper").value === "custom"
        ? [num("paperW", 89), num("paperH", 127)]
        : $("paper").value.split("x").map(Number);
    if ((state.orient === "landscape") !== pw > ph) [pw, ph] = [ph, pw];
    const dpi = num("dpi", 350);
    const mm2px = (v) => (v * dpi) / 25.4;
    // 写真1枚の大きさ（mm）
    let fw;
    let fh;
    if (S.mode === "id") {
      fw = (S.idW * 25.4) / dpi;
      fh = (S.idH * 25.4) / dpi;
    } else {
      const any = includedFaces()[0];
      const T = any ? faceTransform(any.face, S) : { W: S.resizeW, H: S.resizeH };
      fw = (T.W * 25.4) / dpi;
      fh = (T.H * 25.4) / dpi;
    }
    const margin = num("pMargin", 4);
    const gap = num("pGap", 2);
    const label = $("showName").checked ? num("nameSize", 7) * 0.3528 * 1.6 : 0;
    const cols = Math.floor((pw - 2 * margin + gap) / (fw + gap));
    const rows = Math.floor((ph - 2 * margin + gap) / (fh + label + gap));
    return { pw, ph, fw, fh, margin, gap, label, cols, rows, per: Math.max(0, cols * rows), dpi, mm2px, S };
  }
  function updateLayoutInfo() {
    const L = layoutSpec();
    const n = includedFaces().length;
    $("layoutInfo").textContent =
      L.per > 0
        ? `1枚に ${L.cols}×${L.rows} = ${L.per}人（写真 ${L.fw.toFixed(1)}×${L.fh.toFixed(1)}mm）${n ? `／ 台紙 ${Math.ceil(n / L.per)}枚` : ""}`
        : "写真が台紙に入りません。台紙を大きくするか余白を減らしてください。";
  }
  async function renderLayouts() {
    const L = layoutSpec();
    if (L.per <= 0) throw new Error("写真と余白の組み合わせでは台紙に並べられません");
    const pages = [];
    const usedW = L.cols * L.fw + (L.cols - 1) * L.gap;
    const usedH = L.rows * (L.fh + L.label) + (L.rows - 1) * L.gap;
    const ox = (L.pw - usedW) / 2;
    const oy = (L.ph - usedH) / 2;
    let page = null;
    let ctx = null;
    await renderAllFaces(async (c, name, i) => {
      const k = i % L.per;
      if (k === 0) {
        page = makeCanvas(L.mm2px(L.pw), L.mm2px(L.ph));
        ctx = page.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, page.width, page.height);
        pages.push(page);
      }
      const col = k % L.cols;
      const row = Math.floor(k / L.cols);
      const x = L.mm2px(ox + col * (L.fw + L.gap));
      const y = L.mm2px(oy + row * (L.fh + L.label + L.gap));
      const w = L.mm2px(L.fw);
      const h = L.mm2px(L.fh);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(c, x, y, w, h);
      if ($("cutline").checked) {
        ctx.strokeStyle = "#9ca3af";
        ctx.lineWidth = Math.max(1, L.mm2px(0.1));
        const ext = L.mm2px(Math.min(L.gap, 3) / 2);
        ctx.beginPath();
        for (const yy of [y, y + h]) {
          ctx.moveTo(x - ext, yy);
          ctx.lineTo(x + w + ext, yy);
        }
        for (const xx of [x, x + w]) {
          ctx.moveTo(xx, y - ext);
          ctx.lineTo(xx, y + h + ext);
        }
        ctx.stroke();
      }
      if (L.label) {
        const fs = L.mm2px(num("nameSize", 7) * 0.3528);
        ctx.fillStyle = "#111";
        ctx.font = `${fs}px "Yu Gothic UI","Meiryo","Hiragino Sans",sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        let t = name;
        while (t.length > 1 && ctx.measureText(t).width > w * 1.05) t = t.slice(0, -1);
        ctx.fillText(t, x + w / 2, y + h + fs * 0.25);
      }
    });
    return { pages, L };
  }
  $("layoutZipBtn").addEventListener("click", async () => {
    try {
      busy.show("台紙を作っています…", 0);
      const { pages, L } = await renderLayouts();
      const zip = new JSZip();
      for (let i = 0; i < pages.length; i++) {
        const { blob, ext } = await encode(pages[i], L.dpi, false);
        zip.file(`台紙_${String(i + 1).padStart(2, "0")}.${ext}`, blob);
      }
      download(await zip.generateAsync({ type: "blob" }), `かおトリ_台紙_${fileTimeStamp()}.zip`);
    } catch (e) {
      alert(e.message);
      console.error(e);
    } finally {
      busy.hide();
    }
  });
  $("printBtn").addEventListener("click", async () => {
    try {
      busy.show("印刷用の台紙を作っています…", 0);
      const { pages, L } = await renderLayouts();
      const area = $("printArea");
      area.textContent = "";
      let st = document.getElementById("pageStyle");
      if (!st) {
        st = document.createElement("style");
        st.id = "pageStyle";
        document.head.appendChild(st);
      }
      st.textContent = `@page{size:${L.pw}mm ${L.ph}mm;margin:0}@media print{#printArea img{width:${L.pw}mm;height:${L.ph}mm}}`;
      for (const p of pages) {
        const img = new Image();
        img.src = URL.createObjectURL(await canvasToBlob(p, "image/png"));
        await img.decode();
        area.appendChild(img);
      }
      busy.hide();
      await sleep(100);
      window.print();
    } catch (e) {
      busy.hide();
      alert(e.message);
      console.error(e);
    }
  });

  /* ---------- プリセット ---------- */
  const BUILTIN = [
    { name: "履歴書 (30×40mm)", unit: "mm", w: 30, h: 40, face: 27, top: 4 },
    { name: "パスポート (35×45mm)", unit: "mm", w: 35, h: 45, face: 34, top: 4 },
    { name: "マイナンバーカード (35×45mm)", unit: "mm", w: 35, h: 45, face: 32, top: 5 },
    { name: "運転免許・各種証明 (24×30mm)", unit: "mm", w: 24, h: 30, face: 21, top: 3 },
    { name: "学生証 (24×30mm)", unit: "mm", w: 24, h: 30, face: 19, top: 3.5 },
    { name: "名簿用データ (480×600px)", unit: "px", w: 480, h: 600, face: 380, top: 60 },
  ];
  function presets() {
    return BUILTIN.map((p) => ({ ...p, builtin: true })).concat(store.get("presets", []));
  }
  function fillPresets(sel) {
    const s = $("idPreset");
    s.textContent = "";
    presets().forEach((p, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = (p.builtin ? "" : "（保存した形）") + p.name;
      s.appendChild(o);
    });
    if (sel != null) s.value = sel;
  }
  function applyPreset(i) {
    const p = presets()[i];
    if (!p) return;
    setUnit(p.unit, false);
    $("idW").value = p.w;
    $("idH").value = p.h;
    $("idFace").value = p.face;
    $("idTop").value = p.top;
    scheduleRefresh();
  }
  $("idPreset").addEventListener("change", () => applyPreset(+$("idPreset").value));
  $("presetSave").addEventListener("click", () => {
    const name = prompt(
      "この設定の名前を入力してください",
      `${$("idW").value}×${$("idH").value}${state.unit}`,
    );
    if (!name) return;
    const list = store.get("presets", []);
    list.push({
      name,
      unit: state.unit,
      w: num("idW"),
      h: num("idH"),
      face: num("idFace"),
      top: num("idTop"),
    });
    store.set("presets", list);
    fillPresets(BUILTIN.length + list.length - 1);
  });
  $("presetDel").addEventListener("click", () => {
    const i = +$("idPreset").value;
    if (i < BUILTIN.length) {
      alert("最初から入っているプリセットは削除できません");
      return;
    }
    const list = store.get("presets", []);
    if (!confirm(`「${list[i - BUILTIN.length].name}」を削除しますか？`)) return;
    list.splice(i - BUILTIN.length, 1);
    store.set("presets", list);
    fillPresets(0);
    applyPreset(0);
  });
  function setUnit(u, convert = true) {
    if (u === state.unit) return;
    const dpi = num("dpi", 350);
    if (convert)
      for (const id of ["idW", "idH", "idFace", "idTop"]) {
        const v = num(id);
        $(id).value = u === "px" ? Math.round((v * dpi) / 25.4) : Math.round(((v * 25.4) / dpi) * 10) / 10;
      }
    state.unit = u;
    document
      .querySelectorAll("[data-unit]")
      .forEach((b) => b.classList.toggle("active", b.dataset.unit === u));
    document.querySelectorAll("#idSettings .u").forEach((e) => {
      e.textContent = u;
    });
    for (const id of ["idW", "idH", "idFace", "idTop"]) $(id).step = u === "px" ? 1 : 0.5;
  }

  /* ---------- 画面の操作 ---------- */
  let refreshTimer = 0;
  function scheduleRefresh(soft) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshAll(soft), soft ? 400 : 250);
  }
  function refreshAll() {
    renderPhotoList();
    drawPhoto();
    drawGrid();
    saveSettings();
  }

  function renderPhotoList() {
    const ul = $("photoList");
    ul.textContent = "";
    state.photos.forEach((p, i) => {
      const li = document.createElement("li");
      if (i === state.current) li.className = "active";
      const a = document.createElement("span");
      a.className = "nm";
      a.textContent = p.name;
      const b = document.createElement("span");
      b.className = p.error ? "ct err" : "ct";
      const converted = p.converted ? "HEIC→JPG・" : "";
      b.textContent = p.error ? "読込エラー" : `${converted}顔 ${p.faces.filter((f) => f.include).length}`;
      li.append(a, b);
      li.addEventListener("click", () => {
        state.current = i;
        state.zoom = 0;
        showTab("photo");
        refreshAll();
      });
      ul.appendChild(li);
    });
  }
  function showTab(t) {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    $("pane-photo").hidden = t !== "photo";
    $("pane-faces").hidden = t !== "faces";
    $("pane-people").hidden = t !== "people";
    if (t === "faces") drawGrid();
    else if (t === "photo") drawPhoto();
    else window.KAO_PEOPLE?.show();
  }
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  function setMode(m) {
    state.mode = m;
    document
      .querySelectorAll("[data-mode]")
      .forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    $("cropSettings").hidden = m !== "crop";
    $("idSettings").hidden = m !== "id";
    const priv = m === "privacy";
    $("privSettings").hidden = !priv;
    $("privBar").hidden = !priv;
    $("cropOnly").hidden = priv;
    $("layoutDetails").hidden = priv;
    $("saveZipBtn").textContent = priv ? "加工した写真をZIPで保存" : "個別の画像をZIPで保存";
    $("facesTabLabel").textContent = priv ? "加工結果" : "切り抜き一覧";
    $("photoHint").textContent = priv
      ? "枠をクリック：加工する／しないの切り替え　・　「隠す範囲」を選んでドラッグ：名札などを隠す　・　右クリック：隠す範囲や手で追加した枠を削除"
      : "枠をクリック：使う／使わないの切り替え　・　何もない所をドラッグ：見落とした顔を追加　・　右クリック：手で追加した枠を削除";
    scheduleRefresh();
  }
  document.querySelectorAll("[data-drag]").forEach((b) =>
    b.addEventListener("click", () => {
      state.dragTarget = b.dataset.drag;
      document.querySelectorAll("[data-drag]").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  $("showBoxes").addEventListener("change", () => drawPhoto());
  $("showOriginal").addEventListener("change", () => drawPhoto());
  $("logBtn").addEventListener("click", () => {
    const head =
      "かおトリ 作業ログ（件数と日時のみ。写真・名前・顔のデータは含みません）\r\n日時\t作業\t内容\r\n";
    download(
      new Blob(["\ufeff" + head + (workLog.join("\r\n") || "（まだ作業はありません）")], {
        type: "text/plain",
      }),
      `かおトリ_作業ログ_${fileTimeStamp()}.txt`,
    );
  });
  $("privStrength").addEventListener("input", () => {
    $("privStrengthOut").textContent = $("privStrength").value;
  });
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  document.querySelectorAll("[data-unit]").forEach((b) =>
    b.addEventListener("click", () => {
      setUnit(b.dataset.unit);
      scheduleRefresh();
    }),
  );
  document.querySelectorAll("[data-orient]").forEach((b) =>
    b.addEventListener("click", () => {
      state.orient = b.dataset.orient;
      document.querySelectorAll("[data-orient]").forEach((x) => x.classList.toggle("active", x === b));
      updateLayoutInfo();
      saveSettings();
    }),
  );

  const fileInput = $("fileInput");
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((t) =>
    drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    }),
  );
  drop.addEventListener("drop", (e) => {
    e.stopPropagation();
    dropToFiles(e.dataTransfer).then(addFiles);
  });
  /* フォルダごと読み込み（ボタン） */
  $("folderBtn").addEventListener("click", (e) => {
    e.preventDefault();
    $("folderInput").click();
  });
  $("folderInput").addEventListener("change", () => {
    const files = [...$("folderInput").files].sort((a, b) =>
      (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, "ja", { numeric: true }),
    );
    $("folderInput").value = "";
    addFiles(files);
  });
  /* ドラッグ＆ドロップされたフォルダの中身も読む */
  async function dropToFiles(dt) {
    const items = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    if (!items.length) return [...dt.files];
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        out.push(await new Promise((res, rej) => entry.file(res, rej)));
        return;
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const b of batch) await walk(b);
        }
      }
    };
    for (const e of items) await walk(e);
    return out.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  }
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) dropToFiles(e.dataTransfer).then(addFiles);
  });

  $("clearBtn").addEventListener("click", () => {
    if (!confirm("読み込んだ写真と調整をすべて取り消しますか？（元の写真ファイルは消えません）")) return;
    state.photos = [];
    state.current = -1;
    for (const b of bmpCache.values())
      try {
        b.close();
      } catch {}
    bmpCache.clear();
    window.KAO_PEOPLE?.reset();
    refreshAll();
  });
  $("prevPhoto").addEventListener("click", () => {
    if (state.current > 0) {
      state.current--;
      state.zoom = 0;
      refreshAll();
    }
  });
  $("nextPhoto").addEventListener("click", () => {
    if (state.current < state.photos.length - 1) {
      state.current++;
      state.zoom = 0;
      refreshAll();
    }
  });
  $("zoomIn").addEventListener("click", () => {
    state.zoom = (state.zoom || 1) * 1.4;
    drawPhoto();
  });
  $("zoomOut").addEventListener("click", () => {
    state.zoom = Math.max(1, (state.zoom || 1) / 1.4);
    drawPhoto();
  });
  $("zoomFit").addEventListener("click", () => {
    state.zoom = 0;
    drawPhoto();
  });
  $("redetect").addEventListener("click", async () => {
    const p = state.photos[state.current];
    if (!p || p.error || !ai.ready) return;
    busy.show("もう一度顔を探しています…", 0);
    ai.threshold = parseFloat($("sensitivity").value);
    const manual = p.faces.filter((f) => f.manual);
    await processPhoto(p, busy.setBar);
    p.faces = sortFaces(p.faces.concat(manual));
    busy.hide();
    refreshAll();
  });
  $("sensitivity").addEventListener("change", () => {
    ai.threshold = parseFloat($("sensitivity").value);
    saveSettings();
  });
  window.addEventListener("resize", () => {
    if (!$("pane-photo").hidden) scheduleRefresh(true);
  });

  $("resizeMode").addEventListener("change", () => {
    $("resizeLongBox").hidden = $("resizeMode").value !== "long";
    $("resizeFixedBox").hidden = $("resizeMode").value !== "fixed";
  });
  $("nameMode").addEventListener("change", () => {
    $("customBox").hidden = $("nameMode").value !== "custom";
    $("rosterBox").hidden = $("nameMode").value !== "roster";
  });
  $("paper").addEventListener("change", () => {
    $("paperCustom").hidden = $("paper").value !== "custom";
  });
  $("cropShift").addEventListener("input", () => {
    $("cropShiftOut").textContent = $("cropShift").value;
  });
  $("hair").addEventListener("input", () => {
    $("hairOut").textContent = (+$("hair").value).toFixed(2);
  });
  document.querySelector(".side").addEventListener("input", (e) => {
    if (e.target.id !== "fileInput") scheduleRefresh();
  });
  document.querySelector(".side").addEventListener("change", (e) => {
    if (e.target.id !== "fileInput") scheduleRefresh();
  });
  bindAbout();

  /* ---------- 処理中の表示 ---------- */
  $("busyCancel").addEventListener("click", () => {
    cancelFlag = true;
    busy.setText("中止しています…");
  });

  /* ---------- 設定の保存・復元 ---------- */
  const SAVE_IDS = [
    "cropX",
    "cropY",
    "cropShift",
    "resizeMode",
    "resizeLong",
    "resizeW",
    "resizeH",
    "idW",
    "idH",
    "idFace",
    "idTop",
    "dpi",
    "straighten",
    "hair",
    "sensitivity",
    "bgColor",
    "nameMode",
    "customText",
    "startNo",
    "digits",
    "format",
    "quality",
    "paper",
    "paperW",
    "paperH",
    "pMargin",
    "pGap",
    "cutline",
    "showName",
    "nameSize",
    "privFace",
    "privMask",
    "privStrength",
    "privColor",
    "privArea",
    "privShape",
    "bgReplace",
    "maxKB",
  ];
  function saveSettings() {
    const o = {
      mode: state.mode,
      unit: state.unit,
      orient: state.orient,
      preset: $("idPreset").value,
      ...readControls(SAVE_IDS),
    };
    store.set("settings", o);
  }
  function loadSettings() {
    fillPresets(0);
    const o = store.get("settings", null);
    if (!o) {
      applyPreset(0);
      return;
    }
    writeControls(SAVE_IDS, o);
    if (o.preset != null && $("idPreset").querySelector(`option[value="${o.preset}"]`))
      $("idPreset").value = o.preset;
    state.unit = o.unit === "px" ? "mm" : "px";
    setUnit(o.unit || "mm", false);
    if (o.orient) document.querySelector(`[data-orient="${o.orient}"]`)?.click();
    setMode(o.mode || "crop");
    for (const id of ["resizeMode", "nameMode", "paper", "cropShift", "hair", "privStrength"])
      $(id).dispatchEvent(new Event(["cropShift", "hair", "privStrength"].includes(id) ? "input" : "change"));
    ai.threshold = parseFloat($("sensitivity").value);
  }

  loadSettings();
  refreshAll();
  // 「安心して使うために」は2回目からたたんでおく（11.6インチの画面でも手順がすぐ見えるように）
  (() => {
    try {
      if (localStorage.getItem("kaotori-safe-seen")) $("safeCard").open = false;
      localStorage.setItem("kaotori-safe-seen", "1");
    } catch {
      /* 覚えられない環境では毎回開いておく */
    }
  })();
  setTimeout(initAI, 50);

  // テスト用フック
  window.__kaotori = {
    state,
    ai,
    settings,
    includedFaces,
    computeNames,
    renderLayouts,
    getBitmap,
    mid,
    tick,
    showTab,
    refreshAll,
    detectFaces,
    refineFace,
    decodeFile,
    isHeic,
    heicToJpeg,
    logWork,
    checkCancel,
    resetCancel: () => {
      cancelFlag = false;
    },
    isCancelled: () => cancelFlag,
  };
})();

// 「安心して使うために」→ このアプリについて（説明の位置まで移動）
document.getElementById("safeLink").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("aboutLink").click();
  const h = [...document.querySelectorAll("#aboutDialog h4")].find((x) => x.textContent.includes("安心して"));
  if (h) h.scrollIntoView({ block: "start" });
});

// Keeps the tool working without a network once it has been opened (the site-wide service
// worker, see shared/js/offline.js). Libraries are listed in full: some load only when needed.
import("../shared/js/offline.js")
  .then(({ registerOffline }) =>
    registerOffline([
      "./",
      "index.html",
      "style.css",
      "app.js",
      "core.js",
      "people.js",
      "icon.svg",
      "manifest.webmanifest",
      "../shared/vendor/jszip-3.10.2/jszip.min.js",
      "../shared/vendor/mediapipe-tasks-vision-1.2.0/vision.js",
      "../shared/vendor/mediapipe-tasks-vision-1.2.0/wasm.js",
      "../shared/vendor/mediapipe-face-models/face-detector.js",
      "../shared/vendor/mediapipe-face-models/face-landmarker.js",
      "../shared/vendor/mediapipe-face-models/selfie-segmenter.js",
      "../shared/vendor/face-api-1.7.15/face-api.js",
      "../shared/vendor/face-api-1.7.15/face-recognition-model.js",
      "../shared/js/heic.js",
      "../shared/vendor/heic-to-1.6.6/heic-to.min.js",
    ]),
  )
  .catch(() => {
    /* offline use is optional */
  });
