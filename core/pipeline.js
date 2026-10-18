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
      { refine: false, outlines: false, rim: false },
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
  // Without a finished part: from the typical piece area in the photo (a
  // piece covers about one cell, knobs and holes cancel out; measured 0.98 to
  // 1.15) and the cell shape of the grid.
  function bodyPrior(board, ref, contour, pieceArea) {
    if (!board) {
      if (!pieceArea) return null;
      const ka = Math.max(ref.cellAspect ?? 1, 1 / (ref.cellAspect ?? 1));
      const a = pieceArea / 1.07;
      return [Math.sqrt(a * ka), Math.sqrt(a / ka)];
    }
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

  // Loose pieces lying against each other also form large areas, and their
  // feature points give some homography. On a real finished part a loose
  // piece is about one cell large (measured 0.98–1.15), on such a cluster
  // the scale is far off (6–10).
  // The finished part also explains most of the large areas (measured 85 to
  // 93 % of their area in occupied places, such clusters 5–6 %).
  function plausibleBoard(board, ref, seg) {
    // A few occupied places are rather loose pieces lying together; as a
    // group they are still located, and the other blobs get split.
    if (board.filled.length < 8) return false;
    const cell = cellArea(board, ref);
    const d = seg.bigMask.data;
    let big = 0;
    for (let i = 0; i < d.length; i++) if (d[i]) big++;
    if (board.filled.length < 0.25 * (big / cell)) return false;
    // A large finished part is clear by itself; its photo may have little
    // else to measure the piece size on (crumbs, mat print).
    if (seg.pieces.length < 3 || board.filled.length >= 40) return true;
    // Loose pieces often lie in pairs or threes in an overview photo, so the
    // typical blob may be several cells; clusters gave a scale 6–10 off.
    const k = seg.pieceArea / cell;
    return k > 0.35 && k < 4;
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
  // Does an outline lie mostly on occupied places of the finished part? The
  // outline of the finished part itself runs along place borders (a point
  // counts if a place next to it is occupied) and, where the photo cuts it
  // off, over places the photo does not show.
  function onBoardTest(board, ref) {
    const { C, cols, rows } = ref;
    const Hi = board && PH.geom.invertH(board.H);
    const filled = new Set([...(board?.filled ?? []), ...(board?.unseen ?? [])]);
    const at = (u, v) => {
      const c = Math.floor(u / C);
      const r = Math.floor(v / C);
      return c >= 0 && r >= 0 && c < cols && r < rows && filled.has(r * cols + c);
    };
    const e = 0.25 * C;
    return (out) => {
      if (!Hi) return false;
      let n = 0;
      for (const [x, y] of out) {
        const [u, v] = PH.geom.applyH(Hi, x, y);
        if (at(u - e, v - e) || at(u + e, v - e) || at(u - e, v + e) || at(u + e, v + e)) n++;
      }
      return n > out.length * 0.5;
    };
  }

  // Places not occupied by the finished part (1 = free).
  function freeCells(board, ref) {
    const free = new Uint8Array(ref.cols * ref.rows).fill(1);
    for (const c of board.filled) free[c] = 0;
    return free;
  }

  // Area of one place in the photo, at the middle of the reference.
  function cellArea(board, ref) {
    const { W, H, C } = ref;
    const [x0, y0] = PH.board.toScene(board, W / 2, H / 2);
    const [x1, y1] = PH.board.toScene(board, W / 2 + C, H / 2);
    const [x2, y2] = PH.board.toScene(board, W / 2, H / 2 + C);
    return Math.abs((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0));
  }

  function locateGroups(cv, ref, sf, big, board) {
    const { C, cols, rows } = ref;
    const Hi = board && PH.geom.invertH(board.H);
    // Blobs that the board maps onto occupied places are the board itself and
    // need no (expensive) search of their own.
    const onBoard = onBoardTest(board, ref);
    // A joined group is a few places; a huge area is (part of) the finished
    // part even where its outline runs along gaps.
    const cand = big
      .filter((b) => !board || b.area < 25 * cellArea(board, ref))
      .map((b) => ({ b, out: simplify(b.contour, 3) }))
      .filter((x) => !onBoard(x.out));
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
      if (board && !plausibleBoard(board, ref, seg)) board = null;
      if (board) board.border = borderThickness(board, ref, seg.bigMask);
      if (board && board.filled.length >= 40)
        board.seams = PH.board.seamGrid(cv, board, ref, gray, seg.bigMask);
    }
    // With a finished part the piece size is known from its places; the
    // blob statistics may have been ruled by crumbs or mat print. Blobs off
    // the finished part of about one place are loose pieces then.
    let A = seg.pieceArea;
    let segPieces = seg.pieces;
    let segBig = seg.big;
    if (board) {
      A = cellArea(board, ref) * 1.05;
      const onBoard = onBoardTest(board, ref);
      segPieces = seg.pieces.filter((p) => p.area > 0.3 * A);
      segBig = [];
      for (const b of seg.big) {
        if (b.area < 2.4 * A && !onBoard(simplify(b.contour, 3))) {
          const touches = b.contour.some(([x, y]) => x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2);
          segPieces.push({ ...b, alt: null, touches });
        } else segBig.push(b);
      }
    }
    const groups = sf ? locateGroups(cv, ref, sf, segBig, board) : [];
    const pieces = [];
    const unclear = [];
    // Without a finished part, large areas that are no assembled group are
    // pieces lying against each other: split at their narrow contacts. The
    // parts get a mask of their own, the shared one holds the neighbours.
    const quality = (c) => PH.piece.analyzeContour(c, bodyPrior(board, ref, c, A))?.quality ?? 0;
    const loose = [];
    // Two pieces touching are still below the size of a large area: split
    // too large outlines if every part has a better piece shape.
    for (const p of segPieces) {
      const parts = !p.touches && p.area > 1.3 * A ? PH.segment.splitBlob(cv, p.contour, A) : null;
      if (parts?.length > 1 && parts.every((q) => q.area > 0.4 * A)) {
        const whole = Math.max(quality(p.contour), p.alt ? quality(p.alt) : 0);
        if (parts.every((q) => quality(q.contour) >= whole)) {
          for (const q of parts)
            loose.push({ contour: q.contour, area: q.area, touches: false, alt: null, own: true });
          continue;
        }
      }
      loose.push(p);
    }
    const onBoard = onBoardTest(board, ref);
    for (const b of segBig) {
      if (groups.some((g) => g.big === b) || onBoard(simplify(b.contour, 3))) continue;
      // A huge area is a finished part that could not be placed, not a
      // cluster of loose pieces: splitting it gives only fake pieces.
      const parts = b.area < 25 * A ? (PH.segment.splitBlob(cv, b.contour, A) ?? [b]) : [b];
      for (const q of parts) {
        if (q.area > 0.4 * A && q.area < 2.2 * A) {
          const touches = q.contour.some(([x, y]) => x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2);
          loose.push({ contour: q.contour, area: q.area, touches, alt: null, own: true });
        } else unclear.push({ outline: simplify(q.contour, 3), area: q.area, reason: 'merged' });
      }
    }
    let own = null;
    progress('Teile werden vermessen …');
    const measure = (contour, prior) => {
      if (!board) return PH.piece.analyzeContour(contour, prior);
      // In the plane seen from above; corners back into the photo.
      const k = board.k * ref.C;
      const s = PH.piece.analyzeContour(
        contour.map(([x, y]) => PH.board.toPlane(board, x, y)),
        [k, k],
      );
      if (!s) return null;
      const corners = s.corners.map(([u, v]) => PH.board.fromPlane(board, u, v));
      const d = (i) =>
        Math.hypot(corners[(i + 1) % 4][0] - corners[i][0], corners[(i + 1) % 4][1] - corners[i][1]);
      return {
        ...s,
        corners,
        center: [0, 1].map((a) => corners.reduce((t, q) => t + q[a], 0) / 4),
        angle: (Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0]) * 180) / Math.PI,
        side: (d(0) + d(1) + d(2) + d(3)) / 4,
      };
    };
    for (const p of loose) {
      const prior = p.touches ? null : bodyPrior(board, ref, p.contour, A);
      let shape = p.touches ? null : measure(p.contour, prior);
      let contour = p.contour;
      if (!p.touches && p.alt) {
        const s2 = measure(p.alt, prior);
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
      let mask = seg.mask;
      if (p.own) {
        own ??= cv.Mat.zeros(h, w, cv.CV_8UC1);
        PH.segment.drawPoly(cv, own, contour);
        mask = own;
      }
      const raw = PH.match.extractPatch(cv, src, mask, shape.corners, ref.C, ref.G);
      if (p.own) PH.segment.drawPoly(cv, own, contour, 0);
      pieces.push({ shape, raw, outline, split: !!p.own });
    }
    if (sf && pieces.length) {
      progress('Merkmalspunkte werden verglichen …');
      const loc = PH.feature.locatePieces(
        cv,
        ref,
        sf,
        pieces.map((p) => p.outline),
        pieces.map((p) => p.shape),
        board ? freeCells(board, ref) : null,
      );
      pieces.forEach((p, i) => {
        p.feat = loc[i];
      });
    }
    own?.delete();
    sf?.delete();
    gray.delete();
    for (const g of groups) delete g.big;
    src.delete();
    seg.mask.delete();
    seg.bigMask.delete();
    return { width: w, height: h, scale, pieces, unclear, groups, board, pieceArea: A };
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

  // Every side clearly straight or clearly a knob or hole, corners found
  // well: then straight sides decide strictly between border, corner and
  // inner places (60 of 240 places at 12 × 20), and the rotation with them.
  // Not for parts split off a blob: the cut at the contact looks straight.
  function clearSides(shape) {
    if (shape.quality < 0.5) return false;
    const s = shape.sides;
    if (!s.every((x) => x.depth < 0.025 || x.depth > 0.15)) return false;
    return !((s[0].type === 0 && s[2].type === 0) || (s[1].type === 0 && s[3].type === 0));
  }

  function runAssign(items, ref, colors, ctx, progress) {
    for (const [n, it] of items.entries()) {
      if (n % 10 === 0) progress(`Vergleich mit der Vorlage: Teil ${n + 1} von ${items.length} …`);
      it.prep = PH.match.preparePiece(it.raw, ref.C, ref.G, colors[it.scene]);
      it.prep.allowRot = allowedRots(it.shape, ref);
      it.prep.strictBorder = !it.split && clearSides(it.shape);
      const must = it.feat && it.feat.rot !== null ? [it.feat] : [];
      // Plain-coloured pieces: the colour alone puts the right place far
      // down, so only places where knobs and holes fit are compared.
      const fits = ctx.gaps ? (cell, rot) => !gapFit(it.sides, { cell, rot }, ctx.gaps).bad : null;
      it.cands = PH.match.candidates(it.prep, it.sides, ref, ctx.free, must, fits);
    }
    return PH.match.assign(items, ref, { filled: ctx.filled, holes: ctx.holes, unknown: ctx.unknown });
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
    // Gap sides from every photo with the finished part, with outline first.
    const gapOf = new Map();
    // A place counts as free only if some photo shows it (photos of part of
    // the puzzle).
    const seen = new Uint8Array(N);
    let boards = 0;
    for (const s of scenes) {
      if (!s.board) continue;
      boards++;
      for (const f of s.board.filled) {
        free[f] = 0;
        filled.add(f);
      }
      const unseen = new Set(s.board.unseen ?? []);
      for (let c = 0; c < N; c++) if (!unseen.has(c)) seen[c] = 1;
      for (const [key, g] of s.board.holes) if (!gapOf.get(key)?.hole) gapOf.set(key, g);
    }
    if (boards) for (let c = 0; c < N; c++) if (!seen[c]) free[c] = 0;
    let holes = [...gapOf];
    // Places of joined groups are taken for loose pieces.
    for (const s of scenes)
      for (const g of s.groups ?? [])
        for (const c of g.cells) {
          free[c] = 0;
          filled.add(c);
        }
    // Pieces the user has put in (opts.placed: scene, index, cell, rot): their
    // places are taken, and their sides are gap sides for the neighbours.
    const placed = new Map((opts.placed ?? []).map((p) => [`${p.scene}:${p.index}`, p]));
    // Removed by the user (no piece, or a wrong find): left out entirely.
    const removed = new Set((opts.removed ?? []).map((p) => `${p.scene}:${p.index}`));
    holes = [...holes];
    for (const p of placed.values()) {
      const piece = scenes[p.scene]?.pieces[p.index];
      if (!piece) continue;
      free[p.cell] = 0;
      filled.add(p.cell);
      const r = Math.floor(p.cell / ref.cols);
      const c = p.cell % ref.cols;
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = PH.match.DIRS[d];
        if (r + dy < 0 || c + dx < 0 || r + dy >= ref.rows || c + dx >= ref.cols) continue;
        const side = PH.match.sideAt(piece.shape.sides, d, p.rot);
        if (side.type)
          holes.push([`${(r + dy) * ref.cols + c + dx},${(d + 2) % 4}`, { need: -side.type, side }]);
      }
    }
    // With a large finished part, only places right next to it: that is where
    // one builds on, and the gap outlines there check every suggestion
    // (plain-coloured pieces are told apart by shape alone).
    const atEdge = filled.size >= 40;
    if (atEdge) {
      const { cols, rows } = ref;
      const next = (c) => {
        const r = Math.floor(c / cols);
        const k = c % cols;
        return (
          (r > 0 && filled.has(c - cols)) ||
          (r < rows - 1 && filled.has(c + cols)) ||
          (k > 0 && filled.has(c - 1)) ||
          (k < cols - 1 && filled.has(c + 1))
        );
      };
      for (let c = 0; c < N; c++) if (free[c] && !next(c)) free[c] = 0;
    }
    const gaps = new Map(holes);
    const items = [];
    scenes.forEach((s, si) => {
      s.pieces.forEach((p, pi) => {
        if (placed.has(`${si}:${pi}`) || removed.has(`${si}:${pi}`)) return;
        items.push({
          scene: si,
          index: pi,
          raw: p.raw,
          sides: p.shape.sides,
          shape: p.shape,
          feat: p.feat,
          split: p.split,
        });
      });
    });
    const dup = findDuplicates(items, ref);
    const active = items.filter((_, i) => !dup.has(i));
    const stats = statsColor(active, ref);
    const colors = scenes.map((s) => s.board?.color ?? stats);
    const ctx = {
      free,
      filled: [...filled],
      holes,
      gaps: atEdge ? gaps : null,
      // Places not filled and not next to the finished part (or not in the photo).
      unknown: atEdge ? N - filled.size - free.reduce((a, b) => a + b, 0) : 0,
    };
    let result = runAssign(active, ref, colors, ctx, progress);
    if (opts.refine !== false) {
      const col = refitColor(active, ref, result);
      if (col) {
        const colors2 = scenes.map((s) => s.board?.color ?? col);
        result = runAssign(active, ref, colors2, ctx, (t) => progress(`Feinabgleich – ${t}`));
      }
    }
    const evOf = new Map(active.map((it, k) => [it, result.get(k)]));
    const done = [...placed.values()]
      .filter((p) => scenes[p.scene]?.pieces[p.index])
      .map((p) => ({
        scene: p.scene,
        index: p.index,
        center: scenes[p.scene].pieces[p.index].shape.center,
        cell: p.cell,
        row: Math.floor(p.cell / ref.cols),
        col: p.cell % ref.cols,
        rot: p.rot,
        placed: true,
      }));
    return [
      ...done,
      ...items.map((it, idx) => {
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
        // At the edge of a finished part: knobs and holes must fit every
        // neighbouring gap side, else the piece has no place there.
        let fit = null;
        if (atEdge) {
          fit = gapFit(it.sides, ev.top, gaps);
          if (fit.bad || !fit.n) return { ...base, cell: null };
        }
        // Shown as sure (green) only with independent support: feature points
        // on the same place, or an image comparison without any rival; and a
        // cleanly measured outline. Measured on 1054 labelled real pieces:
        // 99 % of sure suggestions right instead of 86 %.
        const featOk = !!(it.feat?.inliers && it.feat.cell === ev.top.cell);
        const sure =
          !!ev.step &&
          ev.conf >= 0.6 &&
          (featOk || ev.conf >= 0.99) &&
          it.shape.quality >= 0.35 &&
          (!fit || fit.worst < 0.07);
        return {
          ...base,
          ...describe(ev.top, it, scene, ref),
          conf: ev.conf,
          step: ev.step ?? null,
          sure,
          alts: ev.alts.map((a) => ({ ...describe(a, it, scene, ref), p: a.p })),
        };
      }),
    ];
  }

  // How a piece at cand (cell, rot) fits the gap sides of the finished part:
  // number of gap sides, knob/hole mismatches, worst outline distance.
  function gapFit(sides, cand, gaps) {
    let n = 0;
    let bad = 0;
    let worst = 0;
    for (let d = 0; d < 4; d++) {
      const g = gaps.get(`${cand.cell},${d}`);
      if (!g) continue;
      n++;
      const mine = PH.match.sideAt(sides, d, cand.rot);
      if (mine.type !== g.need) bad++;
      else if (g.hole) worst = Math.max(worst, PH.piece.holeDistance(mine, g.hole));
    }
    return { n, bad, worst };
  }

  // Place, rotation (degrees clockwise, as the piece lies in the photo) and
  // target point in the photo if the puzzle is visible there.
  function describe(cand, it, scene, ref) {
    const { cols, C } = ref;
    const row = Math.floor(cand.cell / cols);
    const col = cand.cell % cols;
    let psi = 0;
    let target = null;
    let quad = null;
    if (scene.board) {
      const cx = (col + 0.5) * C;
      const cy = (row + 0.5) * C;
      target = PH.board.toScene(scene.board, cx, cy);
      quad = [
        [col, row],
        [col + 1, row],
        [col + 1, row + 1],
        [col, row + 1],
      ].map(([x, y]) => PH.board.toScene(scene.board, x * C, y * C));
      const t2 = PH.board.toScene(scene.board, cx + C, cy);
      psi = (Math.atan2(t2[1] - target[1], t2[0] - target[0]) * 180) / Math.PI;
    }
    const turn = PH.geom.wrapDeg(-it.shape.angle + cand.rot * 90 + psi);
    return { cell: cand.cell, row, col, rot: cand.rot, turn, target, quad, e: cand.e };
  }

  // The photo seen straight from above, the puzzle upright as in the
  // reference (a photo of part of the puzzle from the side). image: the photo
  // at the size given to analyzeScene. M: working-image pixel → view pixel.
  function straightView(cv, image, scene, ref) {
    const { board, width: w, height: h, scale } = scene;
    const toView = (x, y) => PH.board.toPlane(board, x, y);
    const pts = [];
    for (let i = 0; i <= 8; i++)
      for (const [x, y] of [
        [(w * i) / 8, 0],
        [(w * i) / 8, h],
        [0, (h * i) / 8],
        [w, (h * i) / 8],
      ])
        pts.push(toView(x, y));
    // Far off in an oblique photo the table stretches without end: at most
    // half a puzzle around it.
    const rw = board.k * ref.W;
    const rh = board.k * ref.H;
    const x0 = Math.max(-0.5 * rw, Math.min(...pts.map((p) => p[0])));
    const x1 = Math.min(1.5 * rw, Math.max(...pts.map((p) => p[0])));
    const y0 = Math.max(-0.5 * rh, Math.min(...pts.map((p) => p[1])));
    const y1 = Math.min(1.5 * rh, Math.max(...pts.map((p) => p[1])));
    // About as many pixels as the photo.
    const f = Math.min(1 / scale, Math.sqrt((image.width * image.height) / ((x1 - x0) * (y1 - y0))));
    const W = Math.round((x1 - x0) * f);
    const H = Math.round((y1 - y0) * f);
    const k = board.k * f;
    const Hi = board.Hi;
    // Working pixel → plane → view.
    const M = [
      k * Hi[0] - f * x0 * Hi[6],
      k * Hi[1] - f * x0 * Hi[7],
      k * Hi[2] - f * x0 * Hi[8],
      k * Hi[3] - f * y0 * Hi[6],
      k * Hi[4] - f * y0 * Hi[7],
      k * Hi[5] - f * y0 * Hi[8],
      Hi[6],
      Hi[7],
      Hi[8],
    ];
    // The photo is larger than the working image by 1 / scale.
    const Mf = M.map((v, i) => (i % 3 < 2 ? v * scale : v));
    const src = cv.matFromImageData(image);
    const dst = new cv.Mat();
    const m = cv.matFromArray(3, 3, cv.CV_64F, Mf);
    cv.warpPerspective(
      src,
      dst,
      m,
      new cv.Size(W, H),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 255),
    );
    const rgba = new Uint8ClampedArray(dst.data);
    for (const x of [src, dst, m]) x.delete();
    return { rgba, w: W, h: H, M };
  }

  PH.pipeline = { analyzeScene, solve, findDuplicates, straightView };
})();
