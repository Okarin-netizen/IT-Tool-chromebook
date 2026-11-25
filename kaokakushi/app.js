/*! かおかくし v1.0.1 | (c) 2026 技術 岡田 | MIT License */
/* かおかくし — 動画に写った顔へ自動でモザイク・ぼかし・目線を入れる
 * すべての処理はブラウザ内で行い、動画を外部へ送信しない。 */
/* global MPVision -- shared/vendor/mediapipe-tasks-vision の vision.js が用意する */
/* global SiteBlur -- shared/js/blur.js が用意する（ぼかし） */
(() => {
  "use strict";

  const VERSION = "1.0.1";
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
  const MB = window.Mediabunny;
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  /* ---------- 保存（ブラウザ内の設定のみ） ---------- */
  const store = createStore("kaokakushi.");

  /* ---------- 状態 ---------- */
  const state = {
    file: null,
    url: null,
    info: null, // {w,h,duration,fps,codec,audio,canDecode}
    frames: [], // 調べたコマ: {t}
    regions: [], // regions[コマ番号] = [{tid,x,y,w,h,kp}]（0〜1の割合）
    tracks: [], // {id,no,hide,first,last,tFirst,tLast,bestT,score,thumb}
    masks: [], // 手で追加した四角 {id,x,y,w,h,t0,t1}
    analyzed: false,
    method: "mosaic",
    drawing: false,
    sinkPreview: null, // 動画タグで再生できない形式のときの予備
    busy: false,
    nextMaskId: 1,
  };

  /* ---------- AI（MediaPipe 顔検出） ---------- */
  const ai = { detector: null, ready: false };
  async function initAI() {
    const st = $("aiStatus");
    try {
      if (!MB) throw new Error("lib/mediabunny.min.js が見つかりません");
      if (!window.MPVision || !window.KAO_WASM_B64 || !window.KAO_MODEL_DETECTOR)
        throw new Error("lib フォルダのファイルが見つかりません");
      if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined")
        throw new Error(
          "このブラウザは動画処理（WebCodecs）に対応していません。新しい Edge か Chrome で開いてください",
        );
      ai.detector = await MPVision.FaceDetector.createFromOptions(await mediaPipeFileset(), {
        baseOptions: { modelAssetBuffer: await base64ToBytes(window.KAO_MODEL_DETECTOR), delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.25,
        minSuppressionThreshold: 0.3,
      });
      window.KAO_WASM_B64 = window.KAO_MODEL_DETECTOR = window.KAO_WASM_LOADER = null; // メモリ節約
      ai.ready = true;
      st.className = "ai-status ready";
      $("aiStatusText").textContent = "顔を見つける準備ができました";
      updateButtons();
    } catch (e) {
      console.error(e);
      st.className = "ai-status error";
      $("aiStatusText").textContent = "顔を見つける部品を読み込めませんでした（" + (e.message || e) + "）";
    }
  }

  /* ---------- 便利関数 ---------- */
  function fmtTime(t, frac = true) {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return frac ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.floor(s)).padStart(2, "0")}`;
  }
  const lerp = (a, b, k) => a + (b - a) * k;
  function lerpRegion(a, b, k) {
    const r = {
      tid: a.tid,
      x: lerp(a.x, b.x, k),
      y: lerp(a.y, b.y, k),
      w: lerp(a.w, b.w, k),
      h: lerp(a.h, b.h, k),
      kp: null,
    };
    if (a.kp && b.kp) r.kp = a.kp.map((p, i) => ({ x: lerp(p.x, b.kp[i].x, k), y: lerp(p.y, b.kp[i].y, k) }));
    else r.kp = a.kp || b.kp;
    return r;
  }

  /* ---------- 顔検出（1コマ） ---------- */
  // 大きさの違う顔を拾うため、画面全体＋重なりのある小区画で検出する
  // 調べ方ごとの、小区画の大きさ（画面の短い辺に対する割合）
  const TILE_SIZES = { fast: [], small: [0.75, 0.42] };
  const DEFAULT_TILE_SIZES = [0.75];
  const TILE_STEP = 0.8; // となりの小区画へずらす幅（小区画の大きさに対する割合。1より小さいと重なる）
  const DETECT_MAX_SIDE = 640; // AIに渡す画像の長い辺（px）
  const MIN_FACE_PX = 8; // これより小さい顔は誤検出として捨てる（px）

  function makeTiles(width, height, mode) {
    const tiles = [{ x: 0, y: 0, w: width, h: height }];
    const fractions = TILE_SIZES[mode] ?? DEFAULT_TILE_SIZES;
    const shortSide = Math.min(width, height);
    for (const fraction of fractions) {
      const size = shortSide * fraction;
      const step = size * TILE_STEP;
      for (let y = 0; ; y += step) {
        const top = Math.min(y, height - size);
        for (let x = 0; ; x += step) {
          tiles.push({ x: Math.min(x, width - size), y: top, w: size, h: size });
          if (x + size >= width) break;
        }
        if (y + size >= height) break;
      }
    }
    return tiles;
  }
  const tileCanvas = makeCanvas(1, 1);
  const tileCtx = tileCanvas.getContext("2d", { willReadFrequently: true });

  // 1コマの顔を探す。位置は画面の幅・高さに対する割合（0〜1）で返す
  function detectFrame(source, width, height, tiles, minScore) {
    const found = [];
    for (const tile of tiles) {
      // 検出用に縮小して渡す（AIの入力は小さいので、大きな画像を渡しても精度は上がらず遅くなるだけ）
      const shrink = Math.min(1, DETECT_MAX_SIDE / Math.max(tile.w, tile.h));
      tileCanvas.width = Math.round(tile.w * shrink);
      tileCanvas.height = Math.round(tile.h * shrink);
      tileCtx.drawImage(source, tile.x, tile.y, tile.w, tile.h, 0, 0, tileCanvas.width, tileCanvas.height);
      const result = ai.detector.detect(tileCanvas);
      for (const detection of result.detections) {
        const score = detection.categories?.[0]?.score ?? 0;
        if (score < minScore) continue;
        const bounds = detection.boundingBox;
        const grow = 1 / shrink;
        const box = {
          x: (tile.x + bounds.originX * grow) / width,
          y: (tile.y + bounds.originY * grow) / height,
          w: (bounds.width * grow) / width,
          h: (bounds.height * grow) / height,
        };
        if (box.w * width < MIN_FACE_PX) continue;
        const keypoints = (detection.keypoints || []).map((p) => ({
          x: (tile.x + p.x * tile.w) / width,
          y: (tile.y + p.y * tile.h) / height,
        }));
        found.push({ ...box, score, kp: keypoints.length >= 2 ? keypoints : null });
      }
    }
    return keepBestOfOverlapping(found);
  }

  // 小区画が重なる所では同じ顔が何度も見つかるので、点数の高いものだけを残す
  function keepBestOfOverlapping(faces) {
    faces.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const face of faces) {
      const isDuplicate = kept.some((other) => {
        const o = overlap(other, face);
        return o.iou > 0.3 || o.cover > 0.6;
      });
      if (!isDuplicate) kept.push(face);
    }
    return kept;
  }

  /* ---------- 顔の追跡（同じ人の顔をコマをまたいでつなぐ） ---------- */
  // 1人の顔 = track（hits にコマごとの位置）。fi = コマの番号、t = 時刻（秒）
  const THUMB_PX = 96; // 一覧に出す顔の見本の大きさ

  function makeTracker(gapFrames) {
    const tracks = [];
    let nextId = 1;
    return {
      tracks,
      step(frameIndex, time, faces, canvas) {
        const recent = tracks.filter((track) => frameIndex - track.lastFi <= gapFrames);
        const pairs = [];
        for (const track of recent) {
          const expected = predictPosition(track, frameIndex);
          faces.forEach((face, faceIndex) => {
            const iou = overlap(expected, face).iou;
            const distance =
              Math.hypot(
                expected.x + expected.w / 2 - (face.x + face.w / 2),
                expected.y + expected.h / 2 - (face.y + face.h / 2),
              ) / Math.max(expected.w, face.w);
            const sizeRatio = Math.max(expected.w, face.w) / Math.min(expected.w, face.w);
            if ((iou > 0.15 || distance < 0.7) && sizeRatio < 1.8) {
              pairs.push({ track, faceIndex, cost: 1 - iou + distance });
            }
          });
        }
        // いちばん近い組から順に、まだ使っていない顔と追跡をつなぐ
        pairs.sort((a, b) => a.cost - b.cost);
        const usedTracks = new Set();
        const usedFaces = new Set();
        for (const pair of pairs) {
          if (usedTracks.has(pair.track) || usedFaces.has(pair.faceIndex)) continue;
          usedTracks.add(pair.track);
          usedFaces.add(pair.faceIndex);
          addHit(pair.track, frameIndex, time, faces[pair.faceIndex], canvas);
        }
        // つながらなかった顔は、新しく出てきた人
        faces.forEach((face, faceIndex) => {
          if (usedFaces.has(faceIndex)) return;
          const track = { id: nextId++, hits: [], lastFi: frameIndex, score: 0, thumb: null, bestT: time };
          tracks.push(track);
          addHit(track, frameIndex, time, face, canvas);
        });
      },
    };

    // 動きを考えて、このコマで顔がありそうな位置を少し先まで予測する
    function predictPosition(track, frameIndex) {
      const last = track.hits[track.hits.length - 1];
      if (track.hits.length < 2) return last;
      const before = track.hits[track.hits.length - 2];
      const ahead = Math.min(1, (frameIndex - last.fi) / Math.max(1, last.fi - before.fi));
      return {
        x: last.x + (last.x - before.x) * ahead,
        y: last.y + (last.y - before.y) * ahead,
        w: last.w,
        h: last.h,
      };
    }

    function addHit(track, frameIndex, time, face, canvas) {
      track.hits.push({
        fi: frameIndex,
        t: time,
        x: face.x,
        y: face.y,
        w: face.w,
        h: face.h,
        kp: face.kp,
        score: face.score,
      });
      track.lastFi = frameIndex;
      // いちばん大きく・はっきり写ったコマを一覧用の見本にする
      const quality = face.score * Math.sqrt(face.w * face.h);
      if (!track.thumb || quality > track.thumbQ) {
        track.thumbQ = quality;
        track.bestT = time;
        track.thumb = drawThumb(track.thumb, canvas, face);
      }
      track.score = Math.max(track.score, face.score);
    }

    // 顔のまわりを少し広めに切り抜いた正方形の見本
    function drawThumb(thumb, canvas, face) {
      const side = Math.max(face.w * canvas.width, face.h * canvas.height) * 1.6;
      const centerX = (face.x + face.w / 2) * canvas.width;
      const centerY = (face.y + face.h / 2) * canvas.height;
      const out = thumb || makeCanvas(THUMB_PX, THUMB_PX);
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#ddd";
      ctx.fillRect(0, 0, THUMB_PX, THUMB_PX);
      ctx.drawImage(canvas, centerX - side / 2, centerY - side / 2, side, side, 0, 0, THUMB_PX, THUMB_PX);
      return out;
    }
  }

  // 追跡結果を整える：ゆれをならし、見失ったすき間を埋め、出入りの前後も少し長めに隠す
  // regions[コマの番号] = そのコマで隠す顔の一覧
  function finalizeTracks(rawTracks, frameCount, frames, fpsEff) {
    const regions = Array.from({ length: frameCount }, () => []);
    const tracks = [];
    const pad = Math.max(2, Math.round(fpsEff * 0.25)); // 出入りの前後に足すコマ数
    let no = 1;
    const put = (frameIndex, region) => {
      if (frameIndex < 0 || frameIndex >= frameCount) return;
      regions[frameIndex].push({
        tid: region.tid,
        x: region.x,
        y: region.y,
        w: region.w,
        h: region.h,
        kp: region.kp,
      });
    };
    for (const track of rawTracks) {
      const hits = track.hits;
      if (hits.length === 1 && track.score < 0.6) continue; // 1コマだけのあいまいな検出は誤検出として捨てる
      const smooth = smoothHits(track.id, hits);
      for (let i = 0; i < smooth.length; i++) {
        const here = smooth[i];
        const next = smooth[i + 1];
        put(here.fi, here);
        if (!next) continue;
        // 見失ったコマは前後の位置から補間する
        for (let fi = here.fi + 1; fi < next.fi; fi++)
          put(fi, lerpRegion(here, next, (fi - here.fi) / (next.fi - here.fi)));
      }
      const firstHit = smooth[0];
      const lastHit = smooth[smooth.length - 1];
      for (let k = 1; k <= pad; k++) {
        put(firstHit.fi - k, firstHit);
        put(lastHit.fi + k, lastHit);
      }
      const first = Math.max(0, firstHit.fi - pad);
      const last = Math.min(frameCount - 1, lastHit.fi + pad);
      tracks.push({
        id: track.id,
        no: no++,
        hide: true,
        first,
        last,
        tFirst: frames[first].t,
        tLast: frames[last].t,
        bestT: track.bestT,
        score: track.score,
        thumb: track.thumb,
        hits: hits.length,
      });
    }
    return { tracks, regions };
  }

  // ゆれをならす（前後2コマずつとの重みつき平均。3コマより離れたコマは使わない）
  function smoothHits(trackId, hits) {
    return hits.map((hit, i) => {
      let sumX = 0;
      let sumY = 0;
      let sumW = 0;
      let sumH = 0;
      let total = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(hits.length - 1, i + 2); j++) {
        const near = hits[j];
        if (Math.abs(near.fi - hit.fi) > 3) continue;
        const weight = j === i ? 2 : 1;
        sumX += (near.x + near.w / 2) * weight;
        sumY += (near.y + near.h / 2) * weight;
        sumW += near.w * weight;
        sumH += near.h * weight;
        total += weight;
      }
      // 大きさは平均より少し大きい方へ寄せて、はみ出しを防ぐ
      const w = Math.max(sumW / total, hit.w);
      const h = Math.max(sumH / total, hit.h);
      return { tid: trackId, x: sumX / total - w / 2, y: sumY / total - h / 2, w, h, kp: hit.kp, fi: hit.fi };
    });
  }

  // 時刻 t に隠すべき顔の位置（前後のコマから補間）
  function regionsAt(t) {
    const frames = state.frames;
    if (!frames.length) return [];
    const eps = 0.25 / (state.info?.fps || 30);
    if (t + eps < frames[0].t) return state.regions[0].slice();
    // t より前で、いちばん近いコマを二分探索で探す
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= t + eps) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const before = state.regions[i];
    if (i + 1 >= frames.length) return before.slice();
    const k = Math.max(0, Math.min(1, (t - frames[i].t) / (frames[i + 1].t - frames[i].t)));
    if (k < 0.001) return before.slice();
    const after = state.regions[i + 1];
    const out = [];
    for (const a of before) {
      const b = after.find((r) => r.tid === a.tid);
      out.push(b ? lerpRegion(a, b, k) : a);
    }
    for (const b of after) if (!before.some((a) => a.tid === b.tid)) out.push(b);
    return out;
  }

  /* ---------- 隠す加工 ---------- */
  // 隠し方の設定（右の「隠し方」の欄）。k = 強さ 1〜5、area = 顔の箱に対する大きさ
  function hidingSettings() {
    return {
      method: state.method,
      k: +$("strength").value,
      area: parseFloat($("area").value),
      shape: $("shape").value,
      color: $("fillColor").value,
    };
  }
  const fxA = makeCanvas(1, 1);
  const fxB = makeCanvas(1, 1);
  const fxActx = fxA.getContext("2d");
  const fxBctx = fxB.getContext("2d");

  // 顔の箱（割合）から、隠す範囲（ピクセル）を求める
  function faceRect(r, width, height, area) {
    const bw = r.w * width;
    const bh = r.h * height;
    const w = bw * area;
    const h = bh * area * 1.18;
    const cx = (r.x + r.w / 2) * width;
    const cy = (r.y + r.h / 2) * height - bh * (area - 1) * 0.3;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }
  function clipShape(ctx, x, y, w, h, ellipse) {
    ctx.beginPath();
    if (ellipse) ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, PI * 2);
    else ctx.rect(x, y, w, h);
    ctx.clip();
  }
  function applyRegion(ctx, width, height, rc, method, hiding, ellipse) {
    let { x, y, w, h } = rc;
    // 画面の外にはみ出した分を切る（ただし形は保つ）
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    const src = ctx.canvas;
    if (method === "mosaic") {
      const blocks = [18, 13, 10, 7, 5][hiding.k - 1] || 10;
      const cell = Math.max(2, Math.min(w, h) / blocks);
      const sw = Math.max(1, Math.round((x1 - x0) / cell));
      const sh = Math.max(1, Math.round((y1 - y0) / cell));
      fxA.width = sw;
      fxA.height = sh;
      fxActx.imageSmoothingEnabled = true;
      fxActx.imageSmoothingQuality = "medium";
      fxActx.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, sw, sh);
      ctx.save();
      clipShape(ctx, x, y, w, h, ellipse);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(fxA, 0, 0, sw, sh, x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    } else if (method === "blur") {
      // 小さく縮めてからぼかすことで、強くて速いぼかしにする
      const rad = Math.max(2, Math.min(w, h) * [0.05, 0.08, 0.11, 0.15, 0.2][hiding.k - 1]);
      const pad = Math.ceil(rad * 2);
      const px0 = Math.max(0, x0 - pad);
      const py0 = Math.max(0, y0 - pad);
      const px1 = Math.min(width, x1 + pad);
      const py1 = Math.min(height, y1 + pad);
      const sc = Math.min(1, 160 / Math.max(px1 - px0, py1 - py0));
      const tw = Math.max(1, Math.round((px1 - px0) * sc));
      const th = Math.max(1, Math.round((py1 - py0) * sc));
      fxA.width = tw;
      fxA.height = th;
      fxB.width = tw;
      fxB.height = th;
      fxActx.drawImage(src, px0, py0, px1 - px0, py1 - py0, 0, 0, tw, th);
      // iPad（Safari）は ctx.filter が効かないので、SiteBlur が手作業でぼかす
      SiteBlur.drawBlurred(fxBctx, fxA, Math.max(1, rad * sc));
      fxActx.clearRect(0, 0, tw, th);
      SiteBlur.drawBlurred(fxActx, fxB, Math.max(1, rad * sc * 0.7));
      ctx.save();
      clipShape(ctx, x, y, w, h, ellipse);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(fxA, 0, 0, tw, th, px0, py0, px1 - px0, py1 - py0);
      ctx.restore();
    } else {
      // fill
      ctx.save();
      ctx.fillStyle = hiding.color;
      clipShape(ctx, x, y, w, h, ellipse);
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }
  function drawEyeBar(ctx, r, width, height, hiding) {
    let eL;
    let eR;
    if (r.kp && r.kp.length >= 2) {
      eR = { x: r.kp[0].x * width, y: r.kp[0].y * height };
      eL = { x: r.kp[1].x * width, y: r.kp[1].y * height };
    } else {
      eR = { x: (r.x + r.w * 0.3) * width, y: (r.y + r.h * 0.38) * height };
      eL = { x: (r.x + r.w * 0.7) * width, y: eR.y };
    }
    if (eL.x < eR.x) [eL, eR] = [eR, eL];
    const cx = (eL.x + eR.x) / 2;
    const cy = (eL.y + eR.y) / 2;
    const ang = Math.atan2(eL.y - eR.y, eL.x - eR.x);
    const bw = r.w * width;
    const d = Math.max(Math.hypot(eL.x - eR.x, eL.y - eR.y), bw * 0.36);
    const w = Math.max(d * 2.3, bw * (0.95 + (hiding.area - 1.15) * 0.4));
    const h = d * (0.42 + hiding.k * 0.09);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = hiding.color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  // ctx に描かれたコマへ、隠す加工をまとめて入れる
  function applyEffects(ctx, width, height, t, hiding) {
    const regs = regionsAt(t);
    for (const r of regs) {
      const track = trackById.get(r.tid);
      if (!track || !track.hide) continue;
      if (hiding.method === "eyebar") drawEyeBar(ctx, r, width, height, hiding);
      else
        applyRegion(
          ctx,
          width,
          height,
          faceRect(r, width, height, hiding.area),
          hiding.method,
          hiding,
          hiding.shape === "ellipse",
        );
    }
    for (const m of state.masks) {
      if (t < m.t0 - 1e-3 || t > m.t1 + 1e-3) continue;
      const method = hiding.method === "eyebar" ? "fill" : hiding.method;
      applyRegion(
        ctx,
        width,
        height,
        { x: m.x * width, y: m.y * height, w: m.w * width, h: m.h * height },
        method,
        hiding,
        false,
      );
    }
    return regs;
  }
  let trackById = new Map();

  /* ---------- 動画の読み込み ---------- */
  async function openVideo(file) {
    if (state.busy) return;
    resetAll();
    state.file = file;
    $("vTitle").textContent = file.name;
    const info = $("videoInfo");
    info.hidden = false;
    info.textContent = "動画を調べています…";
    try {
      const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) throw new Error("映像が入っていないファイルです");
      const at = await input.getPrimaryAudioTrack();
      const w = await vt.getDisplayWidth();
      const h = await vt.getDisplayHeight();
      const duration = await input.computeDuration();
      let fps = 30;
      try {
        const st = await vt.computePacketStats(120);
        if (st.averagePacketRate > 1) fps = st.averagePacketRate;
      } catch {}
      const canDecode = await vt.canDecode();
      state.info = { w, h, duration, fps, codec: vt.codec, audio: at ? at.codec : null, canDecode };
      info.innerHTML = "";
      const line = (s, cls) => {
        const d = document.createElement("div");
        d.textContent = s;
        if (cls) d.className = cls;
        info.appendChild(d);
      };
      line(`${w}×${h}　${fmtTime(duration)}　${Math.round(fps * 10) / 10}コマ/秒`);
      line(
        `映像: ${codecName(vt.codec)}　音声: ${at ? codecName(at.codec) : "なし"}　${(file.size / 1048576).toFixed(1)}MB`,
      );
      if (!canDecode) {
        line(
          "この動画の形式（" +
            codecName(vt.codec) +
            "）は、このパソコンのブラウザでは読み込めません。iPhoneの動画なら、iPhoneの「設定」→「カメラ」→「フォーマット」を「互換性優先」にして撮り直すか、H.264の形式にしてから使ってください。",
          "warn",
        );
        updateButtons();
        return;
      }
      await setupPreview(file, vt);
      $("scanInfo").textContent = "「顔を探す」を押してください。";
    } catch (e) {
      console.error(e);
      info.innerHTML = "";
      const d = document.createElement("div");
      d.className = "warn";
      d.textContent = "動画を読み込めませんでした（" + (e.message || e) + "）";
      info.appendChild(d);
      state.info = null;
    }
    updateButtons();
  }
  function codecName(c) {
    return (
      {
        avc: "H.264",
        hevc: "H.265(HEVC)",
        vp8: "VP8",
        vp9: "VP9",
        av1: "AV1",
        aac: "AAC",
        opus: "Opus",
        mp3: "MP3",
        vorbis: "Vorbis",
        flac: "FLAC",
        ac3: "AC-3",
        eac3: "E-AC-3",
      }[c] ||
      c ||
      "不明"
    );
  }

  /* ---------- プレビュー ---------- */
  const view = $("view");
  const vctx = view.getContext("2d");
  const video = $("video");
  let playing = false;
  let playRun = 0; // only the newest drawing loop keeps going (play, pause, play quickly)
  function previewSize() {
    const { w, h } = state.info;
    const s = Math.min(1, 1280 / Math.max(w, h));
    return { pw: Math.round(w * s), ph: Math.round(h * s) };
  }
  async function setupPreview(file, vt) {
    const { pw, ph } = previewSize();
    view.width = pw;
    view.height = ph;
    view.hidden = false;
    $("emptyMsg").hidden = true;
    fitView();
    state.url = URL.createObjectURL(file);
    const ok = await new Promise((res) => {
      const done = (v) => {
        video.onloadeddata = video.onerror = null;
        res(v);
      };
      video.onloadeddata = () => done(true);
      video.onerror = () => done(false);
      video.src = state.url;
      video.load();
      setTimeout(() => done(video.readyState >= 2), 8000);
    });
    if (!ok) {
      // ブラウザの動画再生では開けない形式：コマを1枚ずつ取り出してプレビューする
      state.sinkPreview = new MB.CanvasSink(vt, { width: pw, height: ph, fit: "fill" });
    }
    $("seek").max = Math.max(1, Math.round(state.info.duration * 1000));
    await seekTo(0);
  }
  function fitView() {
    if (view.hidden || !state.info) return;
    const st = $("stage");
    const aw = st.clientWidth - 16;
    const ah = st.clientHeight - 16;
    const s = Math.min(aw / view.width, ah / view.height);
    view.style.width = Math.max(50, Math.floor(view.width * s)) + "px";
    view.style.height = Math.max(30, Math.floor(view.height * s)) + "px";
  }
  window.addEventListener("resize", fitView);
  function curTime() {
    return state.sinkPreview ? state.sinkTime || 0 : video.currentTime;
  }
  async function seekTo(t) {
    if (!state.info) return;
    t = Math.max(0, Math.min(state.info.duration, t));
    if (state.sinkPreview) {
      state.sinkTime = t;
      const wc = await state.sinkPreview.getCanvas(t);
      if (wc) {
        state.sinkCanvas = wc.canvas;
        drawFrame(wc.canvas, t);
      }
      return;
    }
    await new Promise((res) => {
      const done = () => {
        video.removeEventListener("seeked", done);
        res();
      };
      video.addEventListener("seeked", done);
      video.currentTime = t;
      setTimeout(done, 3000);
    });
    drawFrame(video, video.currentTime);
  }
  function redraw() {
    if (!state.info) return;
    if (state.sinkPreview) {
      if (state.sinkCanvas) drawFrame(state.sinkCanvas, state.sinkTime);
    } else if (video.readyState >= 2) drawFrame(video, video.currentTime);
  }
  let lastNowKey = "";
  function drawFrame(src, t) {
    const width = view.width;
    const height = view.height;
    vctx.drawImage(src, 0, 0, width, height);
    const hiding = hidingSettings();
    let regs = [];
    if (state.analyzed) {
      if (!$("showOriginal").checked) regs = applyEffects(vctx, width, height, t, hiding);
      else regs = regionsAt(t);
    }
    if ($("showBoxes").checked) drawOverlay(regs, width, height, t, hiding);
    if (dragRect) {
      vctx.save();
      vctx.strokeStyle = "#2563eb";
      vctx.lineWidth = 2;
      vctx.setLineDash([6, 4]);
      vctx.strokeRect(dragRect.x * width, dragRect.y * height, dragRect.w * width, dragRect.h * height);
      vctx.restore();
    }
    // 時間表示
    $("timeLabel").textContent = `${fmtTime(t)} / ${fmtTime(state.info.duration)}`;
    if (!seeking) $("seek").value = Math.round(t * 1000);
    // 今写っている顔を一覧で強調
    const key = regs
      .map((r) => r.tid)
      .sort()
      .join(",");
    if (key !== lastNowKey) {
      lastNowKey = key;
      const now = new Set(regs.map((r) => r.tid));
      for (const el of $("trackList").children) el.classList.toggle("now", now.has(+el.dataset.tid));
    }
  }
  function drawOverlay(regs, width, height, t, hiding) {
    vctx.save();
    vctx.font = `bold ${Math.max(11, Math.round(width / 70))}px sans-serif`;
    vctx.lineWidth = Math.max(1.5, width / 640);
    for (const r of regs) {
      const track = trackById.get(r.tid);
      if (!track) continue;
      const rc = faceRect(r, width, height, hiding.area);
      vctx.setLineDash(track.hide ? [] : [6, 4]);
      vctx.strokeStyle = track.hide ? "rgba(22,163,74,.9)" : "rgba(239,68,68,.95)";
      vctx.strokeRect(rc.x, rc.y, rc.w, rc.h);
      const label = track.hide ? String(track.no) : `${track.no} 隠さない`;
      const tw = vctx.measureText(label).width + 8;
      const th = parseInt(vctx.font.match(/\d+/)[0], 10) + 4;
      vctx.fillStyle = track.hide ? "rgba(22,163,74,.9)" : "rgba(239,68,68,.95)";
      vctx.fillRect(rc.x, rc.y - th, tw, th);
      vctx.fillStyle = "#fff";
      vctx.fillText(label, rc.x + 4, rc.y - 5);
    }
    for (const m of state.masks) {
      if (t < m.t0 - 1e-3 || t > m.t1 + 1e-3) continue;
      vctx.setLineDash([4, 3]);
      vctx.strokeStyle = "rgba(37,99,235,.95)";
      vctx.strokeRect(m.x * width, m.y * height, m.w * width, m.h * height);
    }
    vctx.restore();
  }

  function play() {
    if (!state.info || state.sinkPreview || state.busy) return;
    video.muted = $("dropAudio").checked;
    video.play().catch(() => {});
  }
  function pause() {
    video.pause();
  }
  // The play button shows a line icon (the <symbol>s in index.html) and a word.
  function setPlayLabel(on) {
    $("playBtn").innerHTML =
      `<svg class="i" aria-hidden="true"><use href="#i-${on ? "pause" : "play"}"/></svg><span>${on ? "停止" : "再生"}</span>`;
  }
  video.addEventListener("play", () => {
    playing = true;
    setPlayLabel(true);
    loop();
  });
  video.addEventListener("pause", () => {
    playing = false;
    setPlayLabel(false);
    redraw();
  });
  video.addEventListener("ended", () => {
    playing = false;
    setPlayLabel(false);
  });
  function loop(run = ++playRun) {
    if (!playing || run !== playRun) return;
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback((now, meta) => {
        if (run !== playRun) return;
        drawFrame(video, meta.mediaTime);
        loop(run);
      });
    } else {
      requestAnimationFrame(() => {
        if (run !== playRun) return;
        drawFrame(video, video.currentTime);
        loop(run);
      });
    }
  }
  async function stepFrame(dir) {
    if (!state.info) return;
    pause();
    const fps = state.info.fps || 30;
    await seekTo(curTime() + dir / fps);
  }

  /* ---------- 顔を探す（解析） ---------- */
  const ANALYZE_MAX_SIDE = 1280; // 解析に使うコマの長い辺（px）
  const PREVIEW_MAX_WIDTH = 480; // 解析中・書き出し中に出す小さな画面の幅（px）
  const PROGRESS_EVERY_MS = 120; // 進み具合を書きかえる間かく
  let cancelFlag = false;
  async function analyze() {
    if (!ai.ready || !state.info || state.busy) return;
    pause();
    state.busy = true;
    cancelFlag = false;
    updateButtons();
    const mode = $("scanMode").value;
    const minScore = parseFloat($("sensitivity").value);
    const everyOther = $("everyOther").checked;
    const { w, h, duration, fps } = state.info;
    const shrink = Math.min(1, ANALYZE_MAX_SIDE / Math.max(w, h));
    const width = Math.max(2, Math.round(w * shrink));
    const height = Math.max(2, Math.round(h * shrink));
    const tiles = makeTiles(width, height, mode);
    const smallTiles = tiles.length - 1; // tiles[0] は画面全体
    const tilesPerFrame = Math.ceil(smallTiles / (mode === "small" ? 6 : 3));
    const fpsEff = everyOther ? fps / 2 : fps;
    const tracker = makeTracker(Math.max(3, Math.round(fpsEff * 0.7)));
    const frames = [];
    const startedAt = performance.now();
    showBusy("顔を探しています…", 0, true);
    const preview = $("busyPreview");
    preview.hidden = false;
    preview.width = Math.round(width * Math.min(1, PREVIEW_MAX_WIDTH / width));
    preview.height = Math.round((height * preview.width) / width);
    const previewCtx = preview.getContext("2d");
    try {
      const input = new MB.Input({ source: new MB.BlobSource(state.file), formats: MB.ALL_FORMATS });
      const videoTrack = await input.getPrimaryVideoTrack();
      const sink = new MB.CanvasSink(videoTrack, { width, height, fit: "fill", poolSize: 2 });
      let decoded = 0;
      let lastProgressAt = 0;
      for await (const frame of sink.canvases()) {
        if (cancelFlag) break;
        decoded++;
        if (everyOther && decoded % 2 === 0) continue;
        const frameIndex = frames.length;
        frames.push({ t: frame.timestamp });
        // 画面全体は毎コマ、小区画は数コマで一巡するように順番に調べる（追跡で間をつなぐ）
        const use = [tiles[0]];
        for (let j = 0; j < Math.min(tilesPerFrame, smallTiles); j++) {
          use.push(tiles[1 + ((frameIndex * tilesPerFrame + j) % smallTiles)]);
        }
        const faces = detectFrame(frame.canvas, width, height, use, minScore);
        tracker.step(frameIndex, frame.timestamp, faces, frame.canvas);
        const now = performance.now();
        if (now - lastProgressAt > PROGRESS_EVERY_MS) {
          lastProgressAt = now;
          const done = Math.min(1, frame.timestamp / Math.max(0.001, duration));
          busy.setText(
            `顔を探しています… ${Math.round(done * 100)}%\n見つかった顔: ${tracker.tracks.length}　残り ${restTimeText(startedAt, done)}`,
          );
          busy.setBar(done);
          drawAnalyzePreview(previewCtx, frame.canvas, faces);
          await yieldUI();
        }
      }
      if (cancelFlag) {
        busy.hide();
        state.busy = false;
        updateButtons();
        return;
      }
      if (!frames.length) throw new Error("コマを取り出せませんでした");
      const { tracks, regions } = finalizeTracks(tracker.tracks, frames.length, frames, fpsEff);
      state.frames = frames;
      state.regions = regions;
      state.tracks = tracks;
      trackById = new Map(tracks.map((t) => [t.id, t]));
      state.analyzed = true;
      const seconds = Math.round((performance.now() - startedAt) / 1000);
      $("scanInfo").textContent =
        `${tracks.length}人分の顔が見つかりました（${fmtTime(seconds, false)}かかりました）。プレビューで確認してください。`;
      renderTrackList();
    } catch (e) {
      console.error(e);
      alert("顔を探す途中で問題が起きました：" + (e.message || e));
    } finally {
      busy.hide();
      state.busy = false;
      updateButtons();
      redraw();
    }
  }

  // 解析中の小さな画面：今のコマと、見つかった顔の緑の枠
  function drawAnalyzePreview(ctx, frameCanvas, faces) {
    const { width, height } = ctx.canvas;
    ctx.drawImage(frameCanvas, 0, 0, width, height);
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    for (const face of faces)
      ctx.strokeRect(face.x * width, face.y * height, face.w * width, face.h * height);
  }

  /* ---------- 見つかった顔の一覧 ---------- */
  function renderTrackList() {
    const box = $("trackList");
    box.innerHTML = "";
    $("trackCount").textContent = state.tracks.length;
    for (const track of state.tracks) {
      const card = document.createElement("div");
      card.className = "tcard " + (track.hide ? "on" : "off");
      card.dataset.tid = track.id;
      card.title = "クリックでこの顔が写っている場面へ移動";
      if (track.thumb) card.appendChild(track.thumb);
      else card.appendChild(makeCanvas(96, 96));
      const tt = document.createElement("div");
      tt.className = "tt";
      tt.textContent = `${track.no}　${fmtTime(track.tFirst, false)}〜${fmtTime(track.tLast, false)}`;
      card.appendChild(tt);
      const lb = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = track.hide;
      cb.addEventListener("change", () => {
        setHide(track, cb.checked);
      });
      lb.addEventListener("click", (e) => e.stopPropagation());
      lb.append(cb, document.createTextNode("隠す"));
      card.appendChild(lb);
      card.addEventListener("click", () => {
        pause();
        seekTo(track.bestT);
      });
      box.appendChild(card);
    }
    lastNowKey = "__";
  }
  function setHide(track, v) {
    track.hide = v;
    const card = $("trackList").querySelector(`[data-tid="${track.id}"]`);
    if (card) {
      card.className = "tcard " + (v ? "on" : "off");
      card.querySelector("input").checked = v;
      lastNowKey = "__";
    }
    redraw();
  }

  /* ---------- 手で隠す範囲（名札など） ---------- */
  let dragRect = null;
  let dragStart = null;
  function toNorm(e) {
    const r = view.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  view.addEventListener("pointerdown", (e) => {
    if (!state.info || state.busy) return;
    const p = toNorm(e);
    if (state.drawing) {
      pause();
      dragStart = p;
      dragRect = { x: p.x, y: p.y, w: 0, h: 0 };
      view.setPointerCapture(e.pointerId);
      return;
    }
    // 顔をクリック → 隠す／隠さないを切り替え
    if (!state.analyzed) return;
    const hiding = hidingSettings();
    const width = view.width;
    const height = view.height;
    const regs = regionsAt(curTime());
    let hit = null;
    let best = Infinity;
    for (const r of regs) {
      const rc = faceRect(r, width, height, hiding.area);
      const px = p.x * width;
      const py = p.y * height;
      if (px >= rc.x && px <= rc.x + rc.w && py >= rc.y && py <= rc.y + rc.h) {
        const a = rc.w * rc.h;
        if (a < best) {
          best = a;
          hit = r;
        }
      }
    }
    if (hit) {
      const track = trackById.get(hit.tid);
      if (track) setHide(track, !track.hide);
    }
  });
  view.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const p = toNorm(e);
    dragRect = {
      x: Math.min(p.x, dragStart.x),
      y: Math.min(p.y, dragStart.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    };
    redraw();
  });
  view.addEventListener("pointerup", () => {
    if (!dragStart) return;
    const r = dragRect;
    dragStart = null;
    dragRect = null;
    if (r && r.w > 0.005 && r.h > 0.005) {
      state.masks.push({ id: state.nextMaskId++, ...r, t0: 0, t1: state.info.duration });
      renderMaskList();
    }
    setDrawing(false);
    redraw();
  });
  function setDrawing(v) {
    state.drawing = v;
    $("stage").classList.toggle("drawing", v);
    $("addMaskBtn").textContent = v ? "描くのをやめる" : "＋ 範囲を追加";
    $("addMaskBtn").classList.toggle("primary", v);
  }
  function renderMaskList() {
    const box = $("maskList");
    box.innerHTML = "";
    $("maskCount").textContent = state.masks.length;
    if (!state.masks.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "まだありません。";
      box.appendChild(p);
      return;
    }
    state.masks.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "mrow";
      const n = document.createElement("span");
      n.className = "mn";
      n.textContent = i + 1;
      const a = document.createElement("input");
      a.type = "number";
      a.step = "0.1";
      a.min = "0";
      a.value = m.t0.toFixed(1);
      a.title = "開始（秒）";
      const b = document.createElement("input");
      b.type = "number";
      b.step = "0.1";
      b.min = "0";
      b.value = m.t1.toFixed(1);
      b.title = "終了（秒）";
      a.addEventListener("change", () => {
        m.t0 = Math.max(0, +a.value || 0);
        redraw();
      });
      b.addEventListener("change", () => {
        m.t1 = Math.max(m.t0, +b.value || 0);
        redraw();
      });
      const fromNow = document.createElement("button");
      fromNow.className = "btn small ghost";
      fromNow.textContent = "今から";
      fromNow.title = "今の場面から隠し始める";
      fromNow.addEventListener("click", () => {
        m.t0 = Math.round(curTime() * 10) / 10;
        a.value = m.t0.toFixed(1);
        redraw();
      });
      const toNow = document.createElement("button");
      toNow.className = "btn small ghost";
      toNow.textContent = "今まで";
      toNow.title = "今の場面で隠し終える";
      toNow.addEventListener("click", () => {
        m.t1 = Math.round(curTime() * 10) / 10 + 0.05;
        b.value = m.t1.toFixed(1);
        redraw();
      });
      const del = document.createElement("button");
      del.className = "btn small ghost";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        state.masks = state.masks.filter((x) => x !== m);
        renderMaskList();
        redraw();
      });
      row.append(
        n,
        a,
        document.createTextNode("秒〜"),
        b,
        document.createTextNode("秒"),
        fromNow,
        toNow,
        del,
      );
      box.appendChild(row);
    });
  }

  /* ---------- 書き出し ---------- */
  const EXPORT_PREVIEW_EVERY_MS = 250; // 書き出し中に小さな画面を書きかえる間かく
  let conversion = null;

  // 「残り 約1分」のような、終わるまでの見込み。done = 0〜1
  function restTimeText(startedAt, done) {
    const elapsed = (performance.now() - startedAt) / 1000;
    const rest = done > 0.02 ? elapsed / done - elapsed : NaN;
    return isFinite(rest) ? "約" + fmtTime(rest, false) : "計算中";
  }

  // 書き出す動画の大きさ：「大きさ」で選んだ短い辺まで縮める（エンコーダーのため偶数にする）
  function outputSize(w, h) {
    const target = +$("outSize").value;
    if (!target || Math.min(w, h) <= target) return { width: w, height: h };
    const k = target / Math.min(w, h);
    return { width: Math.round((w * k) / 2) * 2, height: Math.round((h * k) / 2) * 2 };
  }

  // このブラウザで書き出せる形式を選ぶ：MP4（H.264 など）を優先し、だめなら WebM
  async function chooseFormat(width, height, quality) {
    const mp4 = new MB.Mp4OutputFormat({ fastStart: "in-memory" });
    const mp4Codecs = ["avc", "hevc", "vp9", "av1"].filter((c) => mp4.getSupportedVideoCodecs().includes(c));
    const mp4Codec = await MB.getFirstEncodableVideoCodec(mp4Codecs, { width, height, quality });
    if (mp4Codec) return { format: mp4, codec: mp4Codec };
    const webm = new MB.WebMOutputFormat();
    const webmCodec = await MB.getFirstEncodableVideoCodec(webm.getSupportedVideoCodecs(), {
      width,
      height,
      quality,
    });
    if (webmCodec) return { format: webm, codec: webmCodec };
    throw new Error("このブラウザでは動画を書き出せません（動画のエンコーダーがありません）");
  }

  async function exportVideo() {
    if (!state.analyzed || state.busy) return;
    pause();
    state.busy = true;
    cancelFlag = false;
    updateButtons();
    const effectSettings = hidingSettings();
    const startedAt = performance.now();
    showBusy("動画を書き出す準備をしています…", 0, true);
    const preview = $("busyPreview");
    preview.hidden = false;
    const previewCtx = preview.getContext("2d");
    try {
      const { w, h } = state.info;
      const { width: outWidth, height: outHeight } = outputSize(w, h);
      const quality = $("outQuality").value === "high" ? MB.QUALITY_HIGH : MB.QUALITY_MEDIUM;
      const { format, codec } = await chooseFormat(outWidth, outHeight, quality);
      const output = new MB.Output({ format, target: new MB.BufferTarget() });
      const input = new MB.Input({ source: new MB.BlobSource(state.file), formats: MB.ALL_FORMATS });
      const canvas = makeCanvas(outWidth, outHeight);
      const ctx = canvas.getContext("2d");
      preview.width = Math.round(outWidth * Math.min(1, PREVIEW_MAX_WIDTH / outWidth));
      preview.height = Math.round((outHeight * preview.width) / outWidth);
      let lastPreviewAt = 0;
      const videoOpts = {
        codec,
        quality,
        forceTranscode: true,
        allowTransformationMetadata: false,
        processedWidth: outWidth,
        processedHeight: outHeight,
        // 1コマずつ、顔を隠してから書き出しに渡す
        process: async (sample) => {
          if (cancelFlag) return null;
          const frameWidth = sample.displayWidth;
          const frameHeight = sample.displayHeight;
          if (canvas.width !== frameWidth || canvas.height !== frameHeight) {
            canvas.width = frameWidth;
            canvas.height = frameHeight;
          }
          sample.drawWithFit(ctx, { fit: "fill" });
          applyEffects(ctx, frameWidth, frameHeight, sample.timestamp, effectSettings);
          const now = performance.now();
          if (now - lastPreviewAt > EXPORT_PREVIEW_EVERY_MS) {
            lastPreviewAt = now;
            previewCtx.drawImage(canvas, 0, 0, preview.width, preview.height);
            await yieldUI();
          }
          return canvas;
        },
      };
      if (outWidth !== w || outHeight !== h) {
        videoOpts.width = outWidth;
        videoOpts.height = outHeight;
        videoOpts.fit = "fill";
      }
      conversion = await MB.Conversion.init({
        input,
        output,
        video: videoOpts,
        audio: $("dropAudio").checked ? { discard: true } : {},
        showWarnings: false,
      });
      if (!conversion.isValid) {
        const reasons = conversion.discardedTracks.map((d) => d.reason).join(", ");
        throw new Error("この動画は変換できません（" + reasons + "）");
      }
      const lostAudio =
        !$("dropAudio").checked &&
        state.info.audio &&
        conversion.discardedTracks.some((d) => d.track.type === "audio");
      conversion.onProgress = (done) => {
        busy.setText(
          `モザイク入りの動画を書き出しています… ${Math.round(done * 100)}%\n残り ${restTimeText(startedAt, done)}`,
        );
        busy.setBar(done);
      };
      await conversion.execute();
      if (cancelFlag) return;
      const ext = format.fileExtension || ".mp4";
      const blob = new Blob([output.target.buffer], { type: format.mimeType || "video/mp4" });
      const base = safeFileName(state.file.name.replace(/\.[^.]+$/, "")) || "video";
      download(blob, `${base}_かおかくし_${fileTimeStamp()}${ext}`);
      const seconds = Math.round((performance.now() - startedAt) / 1000);
      $("exportInfo").textContent =
        `保存しました（${(blob.size / 1048576).toFixed(1)}MB、${codecName(codec)}、${fmtTime(seconds, false)}かかりました）。` +
        (lostAudio ? "※ 音声はこのブラウザで変換できない形式のため入っていません。" : "") +
        "公開する前に、保存した動画を最後まで見て確認してください。";
    } catch (e) {
      if (!cancelFlag) {
        console.error(e);
        alert("動画の書き出し中に問題が起きました：" + (e.message || e));
      }
    } finally {
      conversion = null;
      busy.hide();
      state.busy = false;
      updateButtons();
    }
  }

  /* ---------- 処理中の表示 ---------- */
  function showBusy(text, progress, cancellable) {
    busy.show(text, progress);
    $("busyCancel").hidden = !cancellable;
    $("busyPreview").hidden = true;
  }
  $("busyCancel").addEventListener("click", async () => {
    cancelFlag = true;
    busy.setText("中止しています…");
    if (conversion) {
      try {
        await conversion.cancel();
      } catch {}
    }
  });

  /* ---------- 画面の操作 ---------- */
  function resetAll() {
    pause();
    if (state.url) URL.revokeObjectURL(state.url);
    video.removeAttribute("src");
    video.load();
    Object.assign(state, {
      file: null,
      url: null,
      info: null,
      frames: [],
      regions: [],
      tracks: [],
      masks: [],
      analyzed: false,
      sinkPreview: null,
      sinkCanvas: null,
      sinkTime: 0,
    });
    trackById = new Map();
    view.hidden = true;
    $("emptyMsg").hidden = false;
    $("trackList").innerHTML = "";
    $("trackCount").textContent = "0";
    renderMaskList();
    setDrawing(false);
    $("exportInfo").textContent = "顔を探したあとで保存できます。";
    $("scanInfo").textContent = "動画を選んでから押してください。";
    $("timeLabel").textContent = "0:00.0 / 0:00.0";
  }
  function updateButtons() {
    const has = !!(state.info && state.info.canDecode);
    $("scanBtn").disabled = !has || !ai.ready || state.busy;
    $("scanBtn").textContent = state.analyzed ? "もう一度 顔を探す" : "顔を探す";
    $("exportBtn").disabled = !state.analyzed || state.busy;
    for (const id of ["prevFrame", "nextFrame", "seek", "addMaskBtn"]) $(id).disabled = !has || state.busy;
    $("playBtn").disabled = !has || state.busy || !!state.sinkPreview;
    $("hideAll").disabled = $("showAll").disabled = !state.tracks.length;
  }

  $("fileInput").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) openVideo(f);
    e.target.value = "";
  });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    }),
  );
  drop.addEventListener("drop", (e) => {
    const f = [...e.dataTransfer.files].find(
      (x) => /^video\//.test(x.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(x.name),
    );
    if (f) openVideo(f);
  });
  // 画面のどこに落としても読み込めるように
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.target.closest && e.target.closest("#drop")) return;
    const f = [...(e.dataTransfer?.files || [])].find(
      (x) => /^video\//.test(x.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(x.name),
    );
    if (f) openVideo(f);
  });

  $("scanBtn").addEventListener("click", analyze);
  $("exportBtn").addEventListener("click", exportVideo);
  $("playBtn").addEventListener("click", () => (playing ? pause() : play()));
  $("prevFrame").addEventListener("click", () => stepFrame(-1));
  $("nextFrame").addEventListener("click", () => stepFrame(1));
  let seeking = false;
  let seekPending = null;
  let seekBusy = false;
  $("seek").addEventListener("input", async () => {
    seeking = true;
    pause();
    seekPending = +$("seek").value / 1000;
    if (seekBusy) return;
    seekBusy = true;
    while (seekPending != null) {
      const t = seekPending;
      seekPending = null;
      await seekTo(t);
    }
    seekBusy = false;
  });
  $("seek").addEventListener("change", () => {
    seeking = false;
  });
  $("addMaskBtn").addEventListener("click", () => setDrawing(!state.drawing));
  $("hideAll").addEventListener("click", () => {
    for (const t of state.tracks) t.hide = true;
    renderTrackList();
    redraw();
  });
  $("showAll").addEventListener("click", () => {
    for (const t of state.tracks) t.hide = false;
    renderTrackList();
    redraw();
  });
  $("methodSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-method]");
    if (!b) return;
    setMethod(b.dataset.method);
    saveSettings();
    redraw();
  });
  function setMethod(m) {
    state.method = m;
    for (const b of document.querySelectorAll("#methodSeg .seg-btn"))
      b.classList.toggle("active", b.dataset.method === m);
    $("colorField").hidden = !(m === "fill" || m === "eyebar");
    $("shape").disabled = m === "eyebar";
  }
  $("strength").addEventListener("input", () => {
    $("strengthOut").textContent = $("strength").value;
  });
  for (const id of ["strength", "area", "shape", "fillColor", "showBoxes", "showOriginal"])
    $(id).addEventListener("input", () => {
      saveSettings();
      redraw();
    });
  for (const id of ["scanMode", "sensitivity", "everyOther", "outSize", "outQuality", "dropAudio"])
    $(id).addEventListener("change", saveSettings);
  $("dropAudio").addEventListener("change", () => {
    video.muted = $("dropAudio").checked;
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input,select,textarea") || $("aboutDialog").open || state.busy || !state.info)
      return;
    if (e.key === " ") {
      e.preventDefault();
      playing ? pause() : play();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepFrame(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepFrame(1);
    } else if (e.key === "Escape" && state.drawing) setDrawing(false);
  });
  new ResizeObserver(fitView).observe($("stage"));

  bindAbout();

  /* ---------- 設定の保存・復元 ---------- */
  const SAVE_IDS = [
    "scanMode",
    "sensitivity",
    "everyOther",
    "strength",
    "area",
    "shape",
    "fillColor",
    "outSize",
    "outQuality",
    "dropAudio",
    "showBoxes",
  ];
  function saveSettings() {
    store.set("settings", { method: state.method, ...readControls(SAVE_IDS) });
  }
  function loadSettings() {
    const saved = store.get("settings", null) || {};
    writeControls(SAVE_IDS, saved);
    setMethod(saved.method || "mosaic");
    $("strengthOut").textContent = $("strength").value;
  }

  loadSettings();
  renderMaskList();
  updateButtons();
  // 「安心して使うために」は2回目からたたんでおく（11.6インチの画面でも手順がすぐ見えるように）
  (() => {
    try {
      if (localStorage.getItem("kaokakushi-safe-seen")) $("safeCard").open = false;
      localStorage.setItem("kaokakushi-safe-seen", "1");
    } catch {
      /* 覚えられない環境では毎回開いておく */
    }
  })();
  setTimeout(initAI, 50);

  // テスト用フック
  window.__kaokakushi = {
    VERSION,
    state,
    ai,
    regionsAt,
    settings: hidingSettings,
    openVideo,
    analyze,
    exportVideo,
    seekTo,
    setHide,
    makeTiles,
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
Promise.all([import("../shared/js/offline.js"), import("../shared/js/vendor.js")])
  .then(([{ registerOffline }, { OFFLINE }]) =>
    registerOffline([
      "./",
      "index.html",
      "style.css",
      "app.js",
      "icon.svg",
      "manifest.webmanifest",
      ...OFFLINE.mediabunny,
      ...OFFLINE.mediapipe,
      ...OFFLINE.faceDetector,
    ]),
  )
  .catch(() => {
    /* offline use is optional */
  });
