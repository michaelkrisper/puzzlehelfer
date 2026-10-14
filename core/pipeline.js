// Flow: split the photo → measure pieces → compare with the reference →
// assign. Shared by the worker and the Node tools. Progress messages are
// shown to users and therefore German.
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

  // All pixel sizes of the recognition (smoothing, noise, thresholds) are
  // tuned to pieces of about 90 px side length. A coarse pre-pass measures
  // the piece size, then the photo is scaled down to fit, never up.
  const TARGET_SIDE = 90;
  function workScale(cv, img) {
    const f0 = Math.min(1, 1400 / Math.max(img.width, img.height));
    const small = resized(cv, img, f0);
    const seg = PH.segment.segmentScene(
      cv,
      small,
      PH.segment.rgbaToLab(small.data, small.width * small.height),
      { refine: false, outlines: false },
    );
    seg.mask.delete();
    seg.bigMask.delete();
    if (!seg.pieceArea) return 1;
    // Area of a piece ≈ core square; knobs and holes balance out.
    const side = Math.sqrt(seg.pieceArea) / f0;
    return Math.min(1, TARGET_SIDE / side);
  }

  // Core size [long, short] of a piece at its position in the photo: table and
  // finished part lie in one plane, so the board mapping knows the cell size
  // there, perspective included. Null without a board.
  function bodyPrior(board, ref, contour) {
    if (!board) return null;
    let x = 0;
    let y = 0;
    for (const [px, py] of contour) {
      x += px;
      y += py;
    }
    const [u, v] = PH.geom.applyH(PH.geom.invertH(board.H), x / contour.length, y / contour.length);
    const h = ref.C / 2;
    const d = (a, b) => {
      const p = PH.board.toScene(board, ...a);
      const q = PH.board.toScene(board, ...b);
      return Math.hypot(q[0] - p[0], q[1] - p[1]);
    };
    const w = d([u - h, v], [u + h, v]);
    const t = d([u, v - h], [u, v + h]);
    return [Math.max(w, t), Math.min(w, t)];
  }

  // Thickness of the finished part at each side of the picture, as a share
  // of the picture width (left, right) or height (top, bottom): from the
  // picture edge inwards as long as the photo shows finished puzzle. The
  // border is one piece thick, so this gives the grid without assuming
  // square pieces (PH.geom.gridFromBorder). Per side the most frequent run
  // length, null if it is not frequent enough or the side is missing.
  function borderThickness(board, ref, bigMask) {
    const N = 400;
    const w = bigMask.cols;
    const h = bigMask.rows;
    const md = bigMask.data;
    const inside = (u, v) => {
      const [x, y] = PH.board.toScene(board, u * ref.W, v * ref.H);
      const xi = Math.round(x);
      const yi = Math.round(y);
      return xi >= 0 && yi >= 0 && xi < w && yi < h && md[yi * w + xi] > 0;
    };
    const run = (f) => {
      let n = 0;
      while (n < N / 2 && f((n + 0.5) / N)) n++;
      return n;
    };
    const sides = { top: [], bottom: [], left: [], right: [] };
    for (let k = 4; k < N - 4; k++) {
      const t = k / N;
      sides.top.push(run((d) => inside(t, d)));
      sides.bottom.push(run((d) => inside(t, 1 - d)));
      sides.left.push(run((d) => inside(d, t)));
      sides.right.push(run((d) => inside(1 - d, t)));
    }
    const out = {};
    for (const [k, v] of Object.entries(sides)) {
      const runs = v.filter((x) => x > 0 && x < N / 2);
      const near = (a, b) => Math.abs(b - a) <= Math.max(1, a * 0.04);
      let best = 0;
      let bn = 0;
      for (const a of runs) {
        const n = runs.filter((b) => near(a, b)).length;
        if (n > bn) {
          bn = n;
          best = a;
        }
      }
      const sel = runs.filter((b) => near(best, b));
      // Enough of the side is finished part, and one thickness dominates.
      out[k] =
        runs.length >= v.length * 0.3 && bn >= runs.length * 0.25
          ? sel.reduce((a, b) => a + b, 0) / sel.length / N
          : null;
    }
    return out;
  }

  // Joined groups: large blobs that are not part of the recognised board are
  // searched as a whole in the reference with feature points. Returns per
  // group outline, occupied places, anchor place, rotation and target in the
  // photo.
  function locateGroups(cv, ref, sf, big, board) {
    const { C, cols, rows } = ref;
    const Hi = board && PH.geom.invertH(board.H);
    // Blobs that the board maps onto occupied places are the board itself and
    // need no (expensive) search of their own.
    const filled = new Set(board?.filled ?? []);
    const onBoard = (out) => {
      if (!Hi) return false;
      let n = 0;
      for (const [x, y] of out) {
        const [u, v] = PH.geom.applyH(Hi, x, y);
        const c = Math.floor(u / C);
        const r = Math.floor(v / C);
        if (c >= 0 && r >= 0 && c < cols && r < rows && filled.has(r * cols + c)) n++;
      }
      return n > out.length * 0.5;
    };
    const cand = big.map((b) => ({ b, out: simplify(b.contour, 3) })).filter((x) => !onBoard(x.out));
    if (!cand.length) return [];
    const loc = PH.feature.locatePieces(
      cv,
      ref,
      sf,
      cand.map((x) => x.out),
      cand.map(() => null),
    );
    const outs = cand.map((x) => x.out);
    const groups = [];
    cand.forEach(({ b }, i) => {
      const f = loc[i];
      if (!f || f.inliers < 10) return;
      if (Hi) {
        // If the blob lies where the board puts it, it belongs to the board.
        let x = 0;
        let y = 0;
        for (const [px, py] of outs[i]) {
          x += px;
          y += py;
        }
        const [u, v] = PH.geom.applyH(Hi, x / outs[i].length, y / outs[i].length);
        if (Math.hypot(u - f.at[0], v - f.at[1]) < C) return;
      }
      const poly = outs[i].map(([x, y]) => f.toRef(x, y));
      const cells = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          if (PH.feature.pointInPoly((c + 0.5) * C, (r + 0.5) * C, poly)) cells.push(r * cols + c);
      if (!cells.length) return;
      const row = Math.floor(f.cell / cols);
      const col = f.cell % cols;
      let psi = 0;
      let target = null;
      if (board) {
        target = PH.board.toScene(board, (col + 0.5) * C, (row + 0.5) * C);
        const t2 = PH.board.toScene(board, (col + 1.5) * C, (row + 0.5) * C);
        psi = (Math.atan2(t2[1] - target[1], t2[0] - target[0]) * 180) / Math.PI;
      }
      groups.push({
        big: b,
        outline: outs[i],
        cells,
        row,
        col,
        turn: PH.geom.wrapDeg(f.angle + psi),
        target,
        inliers: f.inliers,
      });
    });
    return groups;
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
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Feature points once for everything that is not table.
    let sf = null;
    if (PH.feature && ref.feat?.length && (seg.pieces.length || seg.big.length)) {
      progress('Merkmalspunkte werden gesucht …');
      const m = new cv.Mat();
      cv.bitwise_or(seg.mask, seg.bigMask, m);
      // Groups inside the finished border are cleared from both masks.
      for (const b of seg.big) PH.segment.drawPoly(cv, m, b.contour);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
      cv.dilate(m, m, k);
      k.delete();
      sf = PH.feature.sceneFeatures(cv, gray, m);
      m.delete();
    }
    let board = null;
    if (seg.big.length) {
      progress('Fertiger Teil wird auf die Vorlage gelegt …');
      board = PH.board.registerBoard(cv, ref, src, gray, seg.bigMask, sf);
      if (board) board.border = borderThickness(board, ref, seg.bigMask);
    }
    const pieces = [];
    const unclear = [];
    progress('Teile werden vermessen …');
    for (const p of seg.pieces) {
      const prior = p.touches ? null : bodyPrior(board, ref, p.contour);
      let shape = p.touches ? null : PH.piece.analyzeContour(p.contour, prior);
      let contour = p.contour;
      if (!p.touches && p.alt) {
        const s2 = PH.piece.analyzeContour(p.alt, prior);
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
    if (sf && pieces.length) {
      progress('Merkmalspunkte werden verglichen …');
      const loc = PH.feature.locatePieces(
        cv,
        ref,
        sf,
        pieces.map((p) => p.outline),
        pieces.map((p) => p.shape),
      );
      pieces.forEach((p, i) => {
        p.feat = loc[i];
      });
    }
    const groups = sf ? locateGroups(cv, ref, sf, seg.big, board) : [];
    sf?.delete();
    gray.delete();
    // Too large blobs without a link to the reference are usually pieces lying
    // against each other.
    if (!board)
      for (const b of seg.big)
        if (!groups.some((g) => g.big === b))
          unclear.push({ outline: simplify(b.contour, 3), area: b.area, reason: 'merged' });
    for (const g of groups) delete g.big;
    src.delete();
    seg.mask.delete();
    seg.bigMask.delete();
    return { width: w, height: h, scale, pieces, unclear, groups, board, pieceArea: seg.pieceArea };
  }

  // Colour fit without a finished puzzle: the loose pieces are a sample of the
  // motif, their colour statistics should resemble the reference.
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
    // Only fit the means: the spread of the reference depends on its sharpness
    // (a blurry box photo has less detail contrast), a contrast fit would then
    // wrongly compress the pieces.
    return [0, 1, 2].map((c) => [1, (rs[c][0] / m - acc[c][0] / n) * wgt]);
  }

  // New colour fit from sure assignments (block means piece ↔ reference).
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

  // Rectangular pieces only fit with the long side along the long cell side;
  // the other two rotations get a penalty in the comparison (match.js).
  function allowedRots(shape, ref) {
    const ka = ref.cellAspect ?? 1;
    if (Math.abs(Math.log(ka)) < 0.12) return null;
    const [a, b, c] = shape.corners;
    const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const h = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (Math.abs(Math.log(w / h)) < 0.1) return null;
    const flat = w > h === ka > 1;
    return [flat, !flat, flat, !flat];
  }

  function runAssign(items, ref, colors, ctx, progress) {
    for (const [n, it] of items.entries()) {
      if (n % 10 === 0) progress(`Vergleich mit der Vorlage: Teil ${n + 1} von ${items.length} …`);
      it.prep = PH.match.preparePiece(it.raw, ref.C, ref.G, colors[it.scene]);
      it.prep.allowRot = allowedRots(it.shape, ref);
      const must = it.feat && it.feat.rot !== null ? [it.feat] : [];
      it.cands = PH.match.candidates(it.prep, it.sides, ref, ctx.free, must);
    }
    return PH.match.assign(items, ref, { filled: ctx.filled, holes: ctx.holes });
  }

  // The same piece in two photos (e.g. overview and close-up): all four side
  // profiles and the colours agree at one of the four rotations. Returns
  // index of the duplicate → index of the kept piece.
  function findDuplicates(items, ref) {
    const dup = new Map();
    if (new Set(items.map((it) => it.scene)).size < 2) return dup;
    const prep = items.map((it) => PH.match.preparePiece(it.raw, ref.C, ref.G, null));
    const N = PH.piece.PROFILE_N;
    // Measured on photos of the same puzzle at two sizes: true duplicates are
    // at shape < 0.05 and colour < 9, other pieces from about 0.04 and 15.
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

  // scenes: results of analyzeScene. Returns suggestions per piece.
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
    // Places of joined groups are taken for loose pieces.
    for (const s of scenes)
      for (const g of s.groups ?? [])
        for (const c of g.cells) {
          free[c] = 0;
          filled.add(c);
        }
    const items = [];
    scenes.forEach((s, si) => {
      s.pieces.forEach((p, pi) => {
        items.push({ scene: si, index: pi, raw: p.raw, sides: p.shape.sides, shape: p.shape, feat: p.feat });
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

  // Place, rotation (degrees clockwise, as the piece lies in the photo) and
  // target point in the photo if the puzzle is visible there.
  function describe(cand, it, scene, ref) {
    const { cols, C } = ref;
    const row = Math.floor(cand.cell / cols);
    const col = cand.cell % cols;
    let psi = 0;
    let target = null;
    if (scene.board) {
      const cx = (col + 0.5) * C;
      const cy = (row + 0.5) * C;
      target = PH.board.toScene(scene.board, cx, cy);
      const t2 = PH.board.toScene(scene.board, cx + C, cy);
      psi = (Math.atan2(t2[1] - target[1], t2[0] - target[0]) * 180) / Math.PI;
    }
    const turn = PH.geom.wrapDeg(-it.shape.angle + cand.rot * 90 + psi);
    return { cell: cand.cell, row, col, rot: cand.rot, turn, target, e: cand.e };
  }

  PH.pipeline = { analyzeScene, solve, findDuplicates };
})();
