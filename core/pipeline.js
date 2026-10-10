// Ablauf: Foto zerlegen → Teile vermessen → mit der Vorlage vergleichen →
// zuordnen. Gemeinsam für Worker und Node-Werkzeuge.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  function simplify(contour, every) {
    const out = [];
    for (let i = 0; i < contour.length; i += every)
      out.push([Math.round(contour[i][0]), Math.round(contour[i][1])]);
    return out;
  }

  // img: {data (RGBA), width, height}
  function resized(cv, img, f) {
    if (f >= 0.999) return img;
    const src = cv.matFromImageData(img);
    const dst = new cv.Mat();
    const w = Math.round(img.width * f);
    const h = Math.round(img.height * f);
    cv.resize(src, dst, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const out = { data: new Uint8ClampedArray(dst.data), width: w, height: h };
    src.delete();
    dst.delete();
    return out;
  }

  // Alle Pixelgrößen der Erkennung (Glättung, Rauschen, Schwellen) sind auf
  // Teile mit rund 90 px Kantenlänge abgestimmt. Ein grober Vorlauf misst die
  // Teilgröße, danach wird das Foto passend verkleinert, nie vergrößert.
  const TARGET_SIDE = 90;
  function workScale(cv, img) {
    const f0 = Math.min(1, 1400 / Math.max(img.width, img.height));
    const small = resized(cv, img, f0);
    const seg = PH.segment.segmentScene(
      cv,
      small,
      PH.segment.rgbaToLab(small.data, small.width * small.height),
      {
        refine: false,
      },
    );
    seg.mask.delete();
    seg.bigMask.delete();
    if (!seg.pieceArea) return 1;
    // Fläche eines Teils ≈ Kernquadrat; Nasen und Löcher gleichen sich aus.
    const side = Math.sqrt(seg.pieceArea) / f0;
    return Math.min(1, TARGET_SIDE / side);
  }

  function analyzeScene(cv, input, ref, progress = () => {}) {
    progress('Teilgröße wird gemessen …');
    const scale = workScale(cv, input);
    const img = resized(cv, input, scale);
    const { width: w, height: h } = img;
    const lab = PH.segment.rgbaToLab(img.data, w * h);
    progress('Teile werden vom Tisch getrennt …');
    const seg = PH.segment.segmentScene(cv, img, lab);
    const src = cv.matFromImageData(img);
    let board = null;
    if (seg.big.length) {
      const gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      progress('Fertiger Teil wird auf die Vorlage gelegt …');
      board = PH.board.registerBoard(cv, ref, src, gray, seg.bigMask);
      gray.delete();
    }
    const pieces = [];
    const unclear = [];
    progress('Teile werden vermessen …');
    for (const p of seg.pieces) {
      let shape = p.touches ? null : PH.piece.analyzeContour(p.contour);
      let contour = p.contour;
      if (!p.touches && p.alt) {
        const s2 = PH.piece.analyzeContour(p.alt);
        if (s2 && (!shape || s2.quality > shape.quality)) {
          shape = s2;
          contour = p.alt;
          PH.segment.drawPoly(cv, seg.mask, contour);
        }
      }
      const outline = simplify(contour, 3);
      if (!shape || shape.quality < 0.08) {
        unclear.push({ outline, area: p.area, reason: p.touches ? 'edge' : 'shape' });
        continue;
      }
      const raw = PH.match.extractPatch(cv, src, seg.mask, shape.corners, ref.C, ref.G);
      pieces.push({ shape, raw, outline });
    }
    // Zu große Flecken ohne Vorlagenbezug sind meist aneinanderliegende Teile.
    if (!board)
      for (const b of seg.big)
        unclear.push({ outline: simplify(b.contour, 3), area: b.area, reason: 'merged' });
    src.delete();
    seg.mask.delete();
    seg.bigMask.delete();
    return { width: w, height: h, scale, pieces, unclear, board, pieceArea: seg.pieceArea };
  }

  // Farbangleich ohne fertiges Puzzle: die losen Teile sind eine Stichprobe
  // des Motivs, ihre Farbstatistik sollte der Vorlage ähneln.
  function statsColor(pieces, ref) {
    const acc = [0, 1, 2].map(() => [0, 0]);
    let n = 0;
    for (const p of pieces) {
      const lab = PH.segment.rgbaToLab(p.raw.rgba, p.raw.P * p.raw.P);
      for (let i = 0; i < p.raw.mask.length; i += 3) {
        if (!p.raw.mask[i]) continue;
        n++;
        for (let c = 0; c < 3; c++) {
          acc[c][0] += lab[i * 3 + c];
          acc[c][1] += lab[i * 3 + c] ** 2;
        }
      }
    }
    if (n < 100) return null;
    const rs = [0, 1, 2].map(() => [0, 0]);
    const N = ref.W * ref.H;
    for (let i = 0; i < N; i += 7) {
      for (let c = 0; c < 3; c++) {
        rs[c][0] += ref.lab[i * 3 + c];
        rs[c][1] += ref.lab[i * 3 + c] ** 2;
      }
    }
    const m = Math.ceil(N / 7);
    const wgt = Math.min(1, pieces.length / 25);
    // Nur die Mittelwerte angleichen: Die Streuung der Vorlage hängt an ihrer
    // Schärfe (ein unscharfes Schachtelfoto hat weniger Kontrast im Detail),
    // ein Kontrastabgleich würde die Teile dann fälschlich stauchen.
    return [0, 1, 2].map((c) => [1, (rs[c][0] / m - acc[c][0] / n) * wgt]);
  }

  // Neuer Farbangleich aus sicheren Zuordnungen (Blockmittel Teil ↔ Vorlage).
  function refitColor(items, ref, result) {
    const pairs = [];
    const { G, cols, blocks } = ref;
    items.forEach((it, idx) => {
      const ev = result.get(idx);
      if (!ev?.step) return;
      const raw = it.raw;
      const lab = PH.segment.rgbaToLab(raw.rgba, raw.P * raw.P);
      const k = ev.top.rot;
      const l = PH.match.rotate(lab, raw.P, 3, k);
      const m = PH.match.rotate(raw.mask, raw.P, 1, k);
      const pb = PH.match.patchBlocks(l, m, raw.P, ref.C / G);
      const r = Math.floor(ev.top.cell / cols);
      const c = ev.top.cell % cols;
      for (let j = 1; j <= G; j++) {
        for (let i = 1; i <= G; i++) {
          if (pb.cov[j * pb.n + i] < 0.95) continue;
          const o = ((r * G + j - 1) * blocks.w + c * G + i - 1) * 3;
          const p = (j * pb.n + i) * 3;
          pairs.push([Array.from(pb.mean.subarray(p, p + 3)), Array.from(blocks.data.subarray(o, o + 3))]);
        }
      }
    });
    return PH.board.fitColor(pairs);
  }

  function runAssign(items, ref, colors, ctx, progress) {
    for (const [n, it] of items.entries()) {
      if (n % 10 === 0) progress(`Vergleich mit der Vorlage: Teil ${n + 1} von ${items.length} …`);
      it.prep = PH.match.preparePiece(it.raw, ref.C, ref.G, colors[it.scene]);
      it.cands = PH.match.candidates(it.prep, it.sides, ref, ctx.free);
    }
    return PH.match.assign(items, ref, { filled: ctx.filled, holes: ctx.holes });
  }

  // Dasselbe Teil auf zwei Fotos (etwa Übersicht und Nahaufnahme): alle vier
  // Seitenprofile und die Farben stimmen bei einer der vier Drehungen überein.
  // Liefert Index des Doppels → Index des behaltenen Teils.
  function findDuplicates(items, ref) {
    const dup = new Map();
    if (new Set(items.map((it) => it.scene)).size < 2) return dup;
    const prep = items.map((it) => PH.match.preparePiece(it.raw, ref.C, ref.G, null));
    const N = PH.piece.PROFILE_N;
    // Gemessen an Fotos desselben Puzzles in zwei Größen: echte Doppel liegen
    // bei Form < 0,05 und Farbe < 9, fremde Teile ab etwa 0,04 und 15.
    const score = (i, j, k) => {
      let shape = 0;
      let mismatch = 0;
      for (let d = 0; d < 4; d++) {
        const sa = items[i].sides[d];
        const sb = PH.match.sideAt(items[j].sides, d, k);
        if (sa.type !== sb.type) mismatch++;
        let e = 0;
        for (let q = 0; q < N * 2; q++) e += (sa.profile[q] - sb.profile[q]) ** 2;
        shape += Math.sqrt(e / N) / 4;
      }
      const A = prep[i].rots[0].blocks;
      const B = prep[j].rots[k].blocks;
      let col = 0;
      let n = 0;
      for (let q = 0; q < A.cov.length; q++) {
        if (A.cov[q] < 0.6 || B.cov[q] < 0.6) continue;
        col += Math.hypot(
          A.mean[q * 3] - B.mean[q * 3],
          A.mean[q * 3 + 1] - B.mean[q * 3 + 1],
          A.mean[q * 3 + 2] - B.mean[q * 3 + 2],
        );
        n++;
      }
      return n < 4 ? Infinity : shape / 0.05 + col / n / 12 + mismatch;
    };
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].scene === items[j].scene) continue;
        let best = Infinity;
        for (let k = 0; k < 4; k++) best = Math.min(best, score(i, j, k));
        if (best < 2.2) pairs.push([best, i, j]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const used = new Set();
    for (const [, i, j] of pairs) {
      if (used.has(i) || used.has(j)) continue;
      used.add(i);
      used.add(j);
      const a = items[i].shape;
      const b = items[j].shape;
      if (a.quality * a.side >= b.quality * b.side) dup.set(j, i);
      else dup.set(i, j);
    }
    return dup;
  }

  // scenes: Ergebnisse von analyzeScene. Liefert Vorschläge je Teil.
  function solve(ref, scenes, opts = {}) {
    const progress = opts.progress ?? (() => {});
    const N = ref.cols * ref.rows;
    const free = new Uint8Array(N).fill(1);
    const filled = new Set();
    let holes = [];
    for (const s of scenes) {
      if (!s.board) continue;
      for (const f of s.board.filled) {
        free[f] = 0;
        filled.add(f);
      }
      holes = s.board.holes;
    }
    const items = [];
    scenes.forEach((s, si) => {
      s.pieces.forEach((p, pi) => {
        items.push({ scene: si, index: pi, raw: p.raw, sides: p.shape.sides, shape: p.shape });
      });
    });
    const dup = findDuplicates(items, ref);
    const active = items.filter((_, i) => !dup.has(i));
    const stats = statsColor(active, ref);
    const colors = scenes.map((s) => s.board?.color ?? stats);
    const ctx = { free, filled: [...filled], holes };
    let result = runAssign(active, ref, colors, ctx, progress);
    if (opts.refine !== false) {
      const col = refitColor(active, ref, result);
      if (col) {
        const colors2 = scenes.map((s) => s.board?.color ?? col);
        result = runAssign(active, ref, colors2, ctx, (t) => progress(`Feinabgleich – ${t}`));
      }
    }
    const evOf = new Map(active.map((it, k) => [it, result.get(k)]));
    return items.map((it, idx) => {
      const twin = dup.has(idx) ? items[dup.get(idx)] : null;
      const ev = evOf.get(twin ?? it);
      const scene = scenes[it.scene];
      const base = {
        scene: it.scene,
        index: it.index,
        center: it.shape.center,
        corners: it.shape.corners,
        sameAs: twin ? { scene: twin.scene, index: twin.index } : null,
      };
      if (!ev) return { ...base, cell: null };
      return {
        ...base,
        ...describe(ev.top, it, scene, ref),
        conf: ev.conf,
        step: ev.step ?? null,
        alts: ev.alts.map((a) => describe(a, it, scene, ref)),
      };
    });
  }

  // Platz, Drehung (Grad im Uhrzeigersinn, so wie das Teil im Foto liegt) und
  // Zielpunkt im Foto, falls dort das Puzzle zu sehen ist.
  function describe(cand, it, scene, ref) {
    const { cols, C } = ref;
    const row = Math.floor(cand.cell / cols);
    const col = cand.cell % cols;
    let psi = 0;
    let target = null;
    if (scene.board) {
      const H = scene.board.H;
      const cx = (col + 0.5) * C;
      const cy = (row + 0.5) * C;
      target = PH.geom.applyH(H, cx, cy);
      const t2 = PH.geom.applyH(H, cx + C, cy);
      psi = (Math.atan2(t2[1] - target[1], t2[0] - target[0]) * 180) / Math.PI;
    }
    const turn = PH.geom.wrapDeg(-it.shape.angle + cand.rot * 90 + psi);
    return { cell: cand.cell, row, col, rot: cand.rot, turn, target, e: cand.e };
  }

  PH.pipeline = { analyzeScene, solve, findDuplicates };
})();
