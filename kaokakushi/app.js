/*! かおかくし v1.0.1 | (c) 2026 技術 岡田 | MIT License */
/* かおかくし — 動画に写った顔へ自動でモザイク・ぼかし・目線を入れる
 * すべての処理はブラウザ内で行い、動画を外部へ送信しない。 */
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
  function makeTiles(W, H, mode) {
    const tiles = [{ x: 0, y: 0, w: W, h: H }];
    const fracs = TILE_SIZES[mode] ?? DEFAULT_TILE_SIZES;
    const L = Math.min(W, H);
    for (const frac of fracs) {
      const T = L * frac;
      const step = T * 0.8;
      for (let y = 0; ; y += step) {
        const ty = Math.min(y, H - T);
        for (let x = 0; ; x += step) {
          tiles.push({ x: Math.min(x, W - T), y: ty, w: T, h: T });
          if (x + T >= W) break;
        }
        if (y + T >= H) break;
      }
    }
    return tiles;
  }
  const tileCanvas = makeCanvas(1, 1);
  const tileCtx = tileCanvas.getContext("2d", { willReadFrequently: true });
  function detectFrame(src, W, H, tiles, thr) {
    const raw = [];
    for (const t of tiles) {
      // 検出用に縮小して渡す（AIの入力は小さいので、大きな画像を渡しても精度は上がらず遅くなるだけ）
      const s = Math.min(1, 640 / Math.max(t.w, t.h));
      tileCanvas.width = Math.round(t.w * s);
      tileCanvas.height = Math.round(t.h * s);
      tileCtx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, tileCanvas.width, tileCanvas.height);
      const res = ai.detector.detect(tileCanvas);
      for (const d of res.detections) {
        const score = d.categories?.[0]?.score ?? 0;
        if (score < thr) continue;
        const bb = d.boundingBox;
        const k = 1 / s;
        const box = {
          x: (t.x + bb.originX * k) / W,
          y: (t.y + bb.originY * k) / H,
          w: (bb.width * k) / W,
          h: (bb.height * k) / H,
        };
        if (box.w * W < 8) continue;
        const kp = (d.keypoints || []).map((p) => ({ x: (t.x + p.x * t.w) / W, y: (t.y + p.y * t.h) / H }));
        raw.push({ ...box, score, kp: kp.length >= 2 ? kp : null });
      }
    }
    raw.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const r of raw) {
      if (
        kept.some((k) => {
          const o = overlap(k, r);
          return o.iou > 0.3 || o.cover > 0.6;
        })
      )
        continue;
      kept.push(r);
    }
    return kept;
  }

  /* ---------- 顔の追跡（同じ人の顔をコマをまたいでつなぐ） ---------- */
  function makeTracker(gapFrames) {
    const tracks = [];
    let nextId = 1;
    return {
      tracks,
      step(fi, t, dets, canvas) {
        const active = tracks.filter((tr) => fi - tr.lastFi <= gapFrames);
        const pairs = [];
        for (const tr of active) {
          const p = tr.hits[tr.hits.length - 1];
          // 動きを考えて少し先を予測する
          const q = tr.hits.length >= 2 ? tr.hits[tr.hits.length - 2] : null;
          const k = q ? Math.min(1, (fi - p.fi) / Math.max(1, p.fi - q.fi)) : 0;
          const pred = q ? { x: p.x + (p.x - q.x) * k, y: p.y + (p.y - q.y) * k, w: p.w, h: p.h } : p;
          dets.forEach((d, di) => {
            const o = overlap(pred, d).iou;
            const dist =
              Math.hypot(pred.x + pred.w / 2 - (d.x + d.w / 2), pred.y + pred.h / 2 - (d.y + d.h / 2)) /
              Math.max(pred.w, d.w);
            const size = Math.max(pred.w, d.w) / Math.min(pred.w, d.w);
            if ((o > 0.15 || dist < 0.7) && size < 1.8) pairs.push({ tr, di, cost: 1 - o + dist });
          });
        }
        pairs.sort((a, b) => a.cost - b.cost);
        const usedT = new Set();
        const usedD = new Set();
        for (const p of pairs) {
          if (usedT.has(p.tr) || usedD.has(p.di)) continue;
          usedT.add(p.tr);
          usedD.add(p.di);
          addHit(p.tr, fi, t, dets[p.di], canvas);
        }
        dets.forEach((d, di) => {
          if (usedD.has(di)) return;
          const tr = { id: nextId++, hits: [], lastFi: fi, score: 0, thumb: null, bestT: t };
          tracks.push(tr);
          addHit(tr, fi, t, d, canvas);
        });
      },
    };
    function addHit(tr, fi, t, d, canvas) {
      tr.hits.push({ fi, t, x: d.x, y: d.y, w: d.w, h: d.h, kp: d.kp, score: d.score });
      tr.lastFi = fi;
      // いちばん大きく・はっきり写ったコマを一覧用の見本にする
      const q = d.score * Math.sqrt(d.w * d.h);
      if (!tr.thumb || q > tr.thumbQ) {
        tr.thumbQ = q;
        tr.score = Math.max(tr.score, d.score);
        tr.bestT = t;
        const W = canvas.width;
        const H = canvas.height;
        const s = Math.max(d.w * W, d.h * H) * 1.6;
        const cx = (d.x + d.w / 2) * W;
        const cy = (d.y + d.h / 2) * H;
        const c = tr.thumb || makeCanvas(96, 96);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ddd";
        ctx.fillRect(0, 0, 96, 96);
        ctx.drawImage(canvas, cx - s / 2, cy - s / 2, s, s, 0, 0, 96, 96);
        tr.thumb = c;
      }
      tr.score = Math.max(tr.score, d.score);
    }
  }

  // 追跡結果を整える：ゆれをならし、見失ったすき間を埋め、出入りの前後も少し長めに隠す
  function finalizeTracks(rawTracks, nFrames, frames, fpsEff) {
    const regions = Array.from({ length: nFrames }, () => []);
    const tracks = [];
    const pad = Math.max(2, Math.round(fpsEff * 0.25));
    let no = 1;
    for (const tr of rawTracks) {
      const H = tr.hits;
      if (H.length === 1 && tr.score < 0.6) continue; // 1コマだけのあいまいな検出は誤検出として捨てる
      // ゆれをならす（近くのコマの平均）
      const sm = H.map((h, i) => {
        let sx = 0;
        let sy = 0;
        let sw = 0;
        let sh = 0;
        let n = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(H.length - 1, i + 2); j++) {
          if (Math.abs(H[j].fi - h.fi) > 3) continue;
          const wgt = j === i ? 2 : 1;
          sx += (H[j].x + H[j].w / 2) * wgt;
          sy += (H[j].y + H[j].h / 2) * wgt;
          sw += H[j].w * wgt;
          sh += H[j].h * wgt;
          n += wgt;
        }
        // 大きさは平均より少し大きい方へ寄せて、はみ出しを防ぐ
        const w = Math.max(sw / n, h.w);
        const hh = Math.max(sh / n, h.h);
        return { tid: tr.id, x: sx / n - w / 2, y: sy / n - hh / 2, w, h: hh, kp: h.kp, fi: h.fi };
      });
      const put = (fi, r) => {
        if (fi >= 0 && fi < nFrames)
          regions[fi].push({ tid: r.tid, x: r.x, y: r.y, w: r.w, h: r.h, kp: r.kp });
      };
      for (let i = 0; i < sm.length; i++) {
        put(sm[i].fi, sm[i]);
        if (i + 1 < sm.length)
          for (let fi = sm[i].fi + 1; fi < sm[i + 1].fi; fi++)
            put(fi, lerpRegion(sm[i], sm[i + 1], (fi - sm[i].fi) / (sm[i + 1].fi - sm[i].fi)));
      }
      const f0 = sm[0].fi;
      const f1 = sm[sm.length - 1].fi;
      for (let k = 1; k <= pad; k++) {
        put(f0 - k, sm[0]);
        put(f1 + k, sm[sm.length - 1]);
      }
      const a = Math.max(0, f0 - pad);
      const b = Math.min(nFrames - 1, f1 + pad);
      tracks.push({
        id: tr.id,
        no: no++,
        hide: true,
        first: a,
        last: b,
        tFirst: frames[a].t,
        tLast: frames[b].t,
        bestT: tr.bestT,
        score: tr.score,
        thumb: tr.thumb,
        hits: H.length,
      });
    }
    return { tracks, regions };
  }

  // 時刻 t に隠すべき顔の位置（前後のコマから補間）
  function regionsAt(t) {
    const F = state.frames;
    if (!F.length) return [];
    let lo = 0;
    let hi = F.length - 1;
    const eps = 0.25 / (state.info?.fps || 30);
    if (t + eps < F[0].t) return state.regions[0].slice();
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (F[m].t <= t + eps) lo = m;
      else hi = m - 1;
    }
    const i = lo;
    const A = state.regions[i];
    if (i + 1 >= F.length) return A.slice();
    const k = Math.max(0, Math.min(1, (t - F[i].t) / (F[i + 1].t - F[i].t)));
    if (k < 0.001) return A.slice();
    const B = state.regions[i + 1];
    const out = [];
    for (const a of A) {
      const b = B.find((r) => r.tid === a.tid);
      out.push(b ? lerpRegion(a, b, k) : a);
    }
    for (const b of B) if (!A.some((a) => a.tid === b.tid)) out.push(b);
    return out;
  }

  /* ---------- 隠す加工 ---------- */
  function settings() {
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
  function faceRect(r, W, H, area) {
    const bw = r.w * W;
    const bh = r.h * H;
    const w = bw * area;
    const h = bh * area * 1.18;
    const cx = (r.x + r.w / 2) * W;
    const cy = (r.y + r.h / 2) * H - bh * (area - 1) * 0.3;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }
  function clipShape(ctx, x, y, w, h, ellipse) {
    ctx.beginPath();
    if (ellipse) ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, PI * 2);
    else ctx.rect(x, y, w, h);
    ctx.clip();
  }
  function applyRegion(ctx, W, H, rc, method, S, ellipse) {
    let { x, y, w, h } = rc;
    // 画面の外にはみ出した分を切る（ただし形は保つ）
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(W, x + w);
    const y1 = Math.min(H, y + h);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    const src = ctx.canvas;
    if (method === "mosaic") {
      const blocks = [18, 13, 10, 7, 5][S.k - 1] || 10;
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
      const rad = Math.max(2, Math.min(w, h) * [0.05, 0.08, 0.11, 0.15, 0.2][S.k - 1]);
      const pad = Math.ceil(rad * 2);
      const px0 = Math.max(0, x0 - pad);
      const py0 = Math.max(0, y0 - pad);
      const px1 = Math.min(W, x1 + pad);
      const py1 = Math.min(H, y1 + pad);
      const sc = Math.min(1, 160 / Math.max(px1 - px0, py1 - py0));
      const tw = Math.max(1, Math.round((px1 - px0) * sc));
      const th = Math.max(1, Math.round((py1 - py0) * sc));
      fxA.width = tw;
      fxA.height = th;
      fxB.width = tw;
      fxB.height = th;
      fxActx.drawImage(src, px0, py0, px1 - px0, py1 - py0, 0, 0, tw, th);
      fxBctx.filter = `blur(${Math.max(1, rad * sc)}px)`;
      fxBctx.drawImage(fxA, 0, 0);
      fxActx.clearRect(0, 0, tw, th);
      fxActx.filter = `blur(${Math.max(1, rad * sc * 0.7)}px)`;
      fxActx.drawImage(fxB, 0, 0);
      fxActx.filter = "none";
      ctx.save();
      clipShape(ctx, x, y, w, h, ellipse);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(fxA, 0, 0, tw, th, px0, py0, px1 - px0, py1 - py0);
      ctx.restore();
    } else {
      // fill
      ctx.save();
      ctx.fillStyle = S.color;
      clipShape(ctx, x, y, w, h, ellipse);
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }
  function drawEyeBar(ctx, r, W, H, S) {
    let eL;
    let eR;
    if (r.kp && r.kp.length >= 2) {
      eR = { x: r.kp[0].x * W, y: r.kp[0].y * H };
      eL = { x: r.kp[1].x * W, y: r.kp[1].y * H };
    } else {
      eR = { x: (r.x + r.w * 0.3) * W, y: (r.y + r.h * 0.38) * H };
      eL = { x: (r.x + r.w * 0.7) * W, y: eR.y };
    }
    if (eL.x < eR.x) [eL, eR] = [eR, eL];
    const cx = (eL.x + eR.x) / 2;
    const cy = (eL.y + eR.y) / 2;
    const ang = Math.atan2(eL.y - eR.y, eL.x - eR.x);
    const bw = r.w * W;
    const d = Math.max(Math.hypot(eL.x - eR.x, eL.y - eR.y), bw * 0.36);
    const w = Math.max(d * 2.3, bw * (0.95 + (S.area - 1.15) * 0.4));
    const h = d * (0.42 + S.k * 0.09);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.fillStyle = S.color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  // ctx に描かれたコマへ、隠す加工をまとめて入れる
  function applyEffects(ctx, W, H, t, S) {
    const regs = regionsAt(t);
    for (const r of regs) {
      const tr = trackById.get(r.tid);
      if (!tr || !tr.hide) continue;
      if (S.method === "eyebar") drawEyeBar(ctx, r, W, H, S);
      else applyRegion(ctx, W, H, faceRect(r, W, H, S.area), S.method, S, S.shape === "ellipse");
    }
    for (const m of state.masks) {
      if (t < m.t0 - 1e-3 || t > m.t1 + 1e-3) continue;
      const method = S.method === "eyebar" ? "fill" : S.method;
      applyRegion(ctx, W, H, { x: m.x * W, y: m.y * H, w: m.w * W, h: m.h * H }, method, S, false);
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
  let rafId = 0;
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
  let lastSrcReady = false;
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
    const W = view.width;
    const H = view.height;
    vctx.drawImage(src, 0, 0, W, H);
    const S = settings();
    let regs = [];
    if (state.analyzed) {
      if (!$("showOriginal").checked) regs = applyEffects(vctx, W, H, t, S);
      else regs = regionsAt(t);
    }
    if ($("showBoxes").checked) drawOverlay(regs, W, H, t, S);
    if (dragRect) {
      vctx.save();
      vctx.strokeStyle = "#2563eb";
      vctx.lineWidth = 2;
      vctx.setLineDash([6, 4]);
      vctx.strokeRect(dragRect.x * W, dragRect.y * H, dragRect.w * W, dragRect.h * H);
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
  function drawOverlay(regs, W, H, t, S) {
    vctx.save();
    vctx.font = `bold ${Math.max(11, Math.round(W / 70))}px sans-serif`;
    vctx.lineWidth = Math.max(1.5, W / 640);
    for (const r of regs) {
      const tr = trackById.get(r.tid);
      if (!tr) continue;
      const rc = faceRect(r, W, H, S.area);
      vctx.setLineDash(tr.hide ? [] : [6, 4]);
      vctx.strokeStyle = tr.hide ? "rgba(22,163,74,.9)" : "rgba(239,68,68,.95)";
      vctx.strokeRect(rc.x, rc.y, rc.w, rc.h);
      const label = tr.hide ? String(tr.no) : `${tr.no} 隠さない`;
      const tw = vctx.measureText(label).width + 8;
      const th = parseInt(vctx.font.match(/\d+/)[0], 10) + 4;
      vctx.fillStyle = tr.hide ? "rgba(22,163,74,.9)" : "rgba(239,68,68,.95)";
      vctx.fillRect(rc.x, rc.y - th, tw, th);
      vctx.fillStyle = "#fff";
      vctx.fillText(label, rc.x + 4, rc.y - 5);
    }
    for (const m of state.masks) {
      if (t < m.t0 - 1e-3 || t > m.t1 + 1e-3) continue;
      vctx.setLineDash([4, 3]);
      vctx.strokeStyle = "rgba(37,99,235,.95)";
      vctx.strokeRect(m.x * W, m.y * H, m.w * W, m.h * H);
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
  function loop() {
    if (!playing) return;
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback((now, meta) => {
        drawFrame(video, meta.mediaTime);
        loop();
      });
    } else {
      rafId = requestAnimationFrame(() => {
        drawFrame(video, video.currentTime);
        loop();
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
  let cancelFlag = false;
  async function analyze() {
    if (!ai.ready || !state.info || state.busy) return;
    pause();
    state.busy = true;
    cancelFlag = false;
    updateButtons();
    const mode = $("scanMode").value;
    const thr = parseFloat($("sensitivity").value);
    const everyOther = $("everyOther").checked;
    const { w, h, duration, fps } = state.info;
    // 解析用の大きさ（長い辺 1280 まで）
    const s = Math.min(1, 1280 / Math.max(w, h));
    const aw = Math.max(2, Math.round(w * s));
    const ah = Math.max(2, Math.round(h * s));
    const tiles = makeTiles(aw, ah, mode);
    const perFrame = Math.ceil((tiles.length - 1) / (mode === "small" ? 6 : 3));
    const fpsEff = everyOther ? fps / 2 : fps;
    const tracker = makeTracker(Math.max(3, Math.round(fpsEff * 0.7)));
    const frames = [];
    const t0 = performance.now();
    showBusy("顔を探しています…", 0, true);
    const prev = $("busyPreview");
    prev.hidden = false;
    prev.width = Math.round(aw * Math.min(1, 480 / aw));
    prev.height = Math.round((ah * prev.width) / aw);
    const pctx = prev.getContext("2d");
    try {
      const input = new MB.Input({ source: new MB.BlobSource(state.file), formats: MB.ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      const sink = new MB.CanvasSink(vt, { width: aw, height: ah, fit: "fill", poolSize: 2 });
      let n = 0;
      let lastUI = 0;
      for await (const wc of sink.canvases()) {
        if (cancelFlag) break;
        n++;
        if (everyOther && n % 2 === 0) continue;
        const fi = frames.length;
        frames.push({ t: wc.timestamp });
        // 画面全体は毎コマ、小区画は数コマで一巡するように順番に調べる（追跡で間をつなぐ）
        const use = [tiles[0]];
        for (let j = 0; j < Math.min(perFrame, tiles.length - 1); j++)
          use.push(tiles[1 + ((fi * perFrame + j) % (tiles.length - 1))]);
        const dets = detectFrame(wc.canvas, aw, ah, use, thr);
        tracker.step(fi, wc.timestamp, dets, wc.canvas);
        const now = performance.now();
        if (now - lastUI > 120) {
          lastUI = now;
          const p = Math.min(1, wc.timestamp / Math.max(0.001, duration));
          const el = (now - t0) / 1000;
          const rest = p > 0.02 ? el / p - el : NaN;
          busy.setText(
            `顔を探しています… ${Math.round(p * 100)}%\n見つかった顔: ${tracker.tracks.length}　残り ${isFinite(rest) ? "約" + fmtTime(rest, false) : "計算中"}`,
          );
          busy.setBar(p);
          pctx.drawImage(wc.canvas, 0, 0, prev.width, prev.height);
          pctx.strokeStyle = "#22c55e";
          pctx.lineWidth = 2;
          for (const d of dets)
            pctx.strokeRect(d.x * prev.width, d.y * prev.height, d.w * prev.width, d.h * prev.height);
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
      const sec = Math.round((performance.now() - t0) / 1000);
      $("scanInfo").textContent =
        `${tracks.length}人分の顔が見つかりました（${fmtTime(sec, false)}かかりました）。プレビューで確認してください。`;
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

  /* ---------- 見つかった顔の一覧 ---------- */
  function renderTrackList() {
    const box = $("trackList");
    box.innerHTML = "";
    $("trackCount").textContent = state.tracks.length;
    for (const tr of state.tracks) {
      const card = document.createElement("div");
      card.className = "tcard " + (tr.hide ? "on" : "off");
      card.dataset.tid = tr.id;
      card.title = "クリックでこの顔が写っている場面へ移動";
      if (tr.thumb) card.appendChild(tr.thumb);
      else card.appendChild(makeCanvas(96, 96));
      const tt = document.createElement("div");
      tt.className = "tt";
      tt.textContent = `${tr.no}　${fmtTime(tr.tFirst, false)}〜${fmtTime(tr.tLast, false)}`;
      card.appendChild(tt);
      const lb = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = tr.hide;
      cb.addEventListener("change", () => {
        setHide(tr, cb.checked);
      });
      lb.addEventListener("click", (e) => e.stopPropagation());
      lb.append(cb, document.createTextNode("隠す"));
      card.appendChild(lb);
      card.addEventListener("click", () => {
        pause();
        seekTo(tr.bestT);
      });
      box.appendChild(card);
    }
    lastNowKey = "__";
  }
  function setHide(tr, v) {
    tr.hide = v;
    const card = $("trackList").querySelector(`[data-tid="${tr.id}"]`);
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
    const S = settings();
    const W = view.width;
    const H = view.height;
    const regs = regionsAt(curTime());
    let hit = null;
    let best = Infinity;
    for (const r of regs) {
      const rc = faceRect(r, W, H, S.area);
      const px = p.x * W;
      const py = p.y * H;
      if (px >= rc.x && px <= rc.x + rc.w && py >= rc.y && py <= rc.y + rc.h) {
        const a = rc.w * rc.h;
        if (a < best) {
          best = a;
          hit = r;
        }
      }
    }
    if (hit) {
      const tr = trackById.get(hit.tid);
      if (tr) setHide(tr, !tr.hide);
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
  let conversion = null;
  async function exportVideo() {
    if (!state.analyzed || state.busy) return;
    pause();
    state.busy = true;
    cancelFlag = false;
    updateButtons();
    const S = settings();
    const t0 = performance.now();
    showBusy("動画を書き出す準備をしています…", 0, true);
    const prev = $("busyPreview");
    prev.hidden = false;
    const pctx = prev.getContext("2d");
    try {
      const { w, h } = state.info;
      const target = +$("outSize").value;
      let ow = w;
      let oh = h;
      if (target && Math.min(w, h) > target) {
        const k = target / Math.min(w, h);
        ow = Math.round((w * k) / 2) * 2;
        oh = Math.round((h * k) / 2) * 2;
      }
      const quality = $("outQuality").value === "high" ? MB.QUALITY_HIGH : MB.QUALITY_MEDIUM;
      let format = new MB.Mp4OutputFormat({ fastStart: "in-memory" });
      let codec = await MB.getFirstEncodableVideoCodec(
        ["avc", "hevc", "vp9", "av1"].filter((c) => format.getSupportedVideoCodecs().includes(c)),
        { width: ow, height: oh, quality },
      );
      if (!codec) {
        format = new MB.WebMOutputFormat();
        codec = await MB.getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), {
          width: ow,
          height: oh,
          quality,
        });
      }
      if (!codec) throw new Error("このブラウザでは動画を書き出せません（動画のエンコーダーがありません）");
      const output = new MB.Output({ format, target: new MB.BufferTarget() });
      const input = new MB.Input({ source: new MB.BlobSource(state.file), formats: MB.ALL_FORMATS });
      const canvas = makeCanvas(ow, oh);
      const ctx = canvas.getContext("2d");
      prev.width = Math.round(ow * Math.min(1, 480 / ow));
      prev.height = Math.round((oh * prev.width) / ow);
      let lastUI = 0;
      let frameNo = 0;
      const videoOpts = {
        codec,
        quality,
        forceTranscode: true,
        allowTransformationMetadata: false,
        processedWidth: ow,
        processedHeight: oh,
        process: async (sample) => {
          if (cancelFlag) return null;
          const W = sample.displayWidth;
          const H = sample.displayHeight;
          if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
          }
          sample.drawWithFit(ctx, { fit: "fill" });
          applyEffects(ctx, W, H, sample.timestamp, S);
          frameNo++;
          const now = performance.now();
          if (now - lastUI > 250) {
            lastUI = now;
            pctx.drawImage(canvas, 0, 0, prev.width, prev.height);
            await yieldUI();
          }
          return canvas;
        },
      };
      if (ow !== w || oh !== h) {
        videoOpts.width = ow;
        videoOpts.height = oh;
        videoOpts.fit = "fill";
      }
      conversion = await MB.Conversion.init({
        input,
        output,
        video: videoOpts,
        audio: $("dropAudio").checked ? { discard: true } : {},
        showWarnings: false,
      });
      if (!conversion.isValid)
        throw new Error(
          "この動画は変換できません（" + conversion.discardedTracks.map((d) => d.reason).join(", ") + "）",
        );
      const lostAudio =
        !$("dropAudio").checked &&
        state.info.audio &&
        conversion.discardedTracks.some((d) => d.track.type === "audio");
      conversion.onProgress = (p) => {
        const el = (performance.now() - t0) / 1000;
        const rest = p > 0.02 ? el / p - el : NaN;
        busy.setText(
          `モザイク入りの動画を書き出しています… ${Math.round(p * 100)}%\n残り ${isFinite(rest) ? "約" + fmtTime(rest, false) : "計算中"}`,
        );
        busy.setBar(p);
      };
      await conversion.execute();
      if (cancelFlag) return;
      const ext = format.fileExtension || ".mp4";
      const blob = new Blob([output.target.buffer], { type: format.mimeType || "video/mp4" });
      const base = safeFileName(state.file.name.replace(/\.[^.]+$/, "")) || "video";
      download(blob, `${base}_かおかくし_${fileTimeStamp()}${ext}`);
      const sec = Math.round((performance.now() - t0) / 1000);
      $("exportInfo").textContent =
        `保存しました（${(blob.size / 1048576).toFixed(1)}MB、${codecName(codec)}、${fmtTime(sec, false)}かかりました）。` +
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
    settings,
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
import("../shared/js/offline.js")
  .then(({ registerOffline }) =>
    registerOffline([
      "./",
      "index.html",
      "style.css",
      "app.js",
      "icon.svg",
      "manifest.webmanifest",
      "../shared/vendor/mediabunny-1.65.0/mediabunny.min.js",
      "../shared/vendor/mediapipe-tasks-vision-1.2.0/vision.js",
      "../shared/vendor/mediapipe-tasks-vision-1.2.0/wasm.js",
      "../shared/vendor/mediapipe-face-models/face-detector.js",
    ]),
  )
  .catch(() => {
    /* offline use is optional */
  });
