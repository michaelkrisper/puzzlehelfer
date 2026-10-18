// Half-finished puzzle in the photo: map it onto the reference with feature
// points, read off occupied places and the shape of the gaps.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  function toGray(cv, rgba, w, h) {
    const src = new cv.Mat(h, w, cv.CV_8UC4);
    src.data.set(rgba);
    const g = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
    src.delete();
    return g;
  }

  // Point pairs reference (grid coordinates) ↔ photo in the finished part.
  // With the reference features (SIFT) if available, otherwise ORB.
  function boardPairs(cv, ref, sceneGray, bigMask, sf) {
    const m = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
    cv.dilate(bigMask, m, k);
    k.delete();
    const hi = ref.hi ?? { gray: null, w: ref.W, h: ref.H };
    const sx = hi.w / ref.W;
    const sy = hi.h / ref.H;
    let pairs = [];
    if (sf && ref.feat?.length) {
      pairs = PH.feature.matchToReference(cv, ref, sf, m).map(([[x, y], q]) => [[x / sx, y / sy], q]);
    } else {
      let refGray;
      if (hi.gray) {
        refGray = new cv.Mat(hi.h, hi.w, cv.CV_8UC1);
        refGray.data.set(hi.gray);
      } else refGray = toGray(cv, ref.rgba.data, ref.W, ref.H);
      const orb = new cv.ORB(5000);
      const kr = new cv.KeyPointVector();
      const ks = new cv.KeyPointVector();
      const dr = new cv.Mat();
      const ds = new cv.Mat();
      const none = new cv.Mat();
      orb.detectAndCompute(refGray, none, kr, dr);
      orb.detectAndCompute(sceneGray, m, ks, ds);
      if (dr.rows >= 10 && ds.rows >= 10) {
        const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
        const mm = new cv.DMatchVectorVector();
        bf.knnMatch(dr, ds, mm, 2);
        for (let i = 0; i < mm.size(); i++) {
          const pair = mm.get(i);
          if (pair.size() < 2) continue;
          const m0 = pair.get(0);
          if (m0.distance >= 0.8 * pair.get(1).distance) continue;
          const p = kr.get(m0.queryIdx).pt;
          const q = ks.get(m0.trainIdx).pt;
          pairs.push([
            [p.x / sx, p.y / sy],
            [q.x, q.y],
          ]);
        }
        bf.delete();
        mm.delete();
      }
      for (const x of [refGray, orb, kr, ks, dr, ds, none]) x.delete();
    }
    m.delete();
    return pairs;
  }

  // Cubic polynomial in (u, v) ∈ [0, 1]².
  const terms = (u, v) => [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];
  const poly = (c, u, v) => terms(u, v).reduce((s, t, i) => s + t * c[i], 0);

  // Shift of the grid at reference point x/y, bilinear between grid corners.
  function fieldAt(f, x, y) {
    const u = Math.min(f.cols - 1e-6, Math.max(0, x / f.C));
    const v = Math.min(f.rows - 1e-6, Math.max(0, y / f.C));
    const i = Math.floor(u);
    const j = Math.floor(v);
    const a = u - i;
    const b = v - j;
    const n = f.cols + 1;
    const at = (A) =>
      (A[j * n + i] * (1 - a) + A[j * n + i + 1] * a) * (1 - b) +
      (A[(j + 1) * n + i] * (1 - a) + A[(j + 1) * n + i + 1] * a) * b;
    return [at(f.dx), at(f.dy)];
  }

  // Reference → photo. A homography alone does not fit if the reference was
  // photographed wavy or bent; corr first shifts the reference coordinates
  // smoothly. It is measured on the finished part, which lies flat on the
  // table: this straightens the reference against it. field moves single grid
  // corners onto the seams (seamField).
  function toScene(board, x, y) {
    if (board.field) {
      const [dx, dy] = fieldAt(board.field, x, y);
      x += dx;
      y += dy;
    }
    const c = board.corr;
    if (!c) return PH.geom.applyH(board.H, x, y);
    const u = x / c.W;
    const v = y / c.H;
    return PH.geom.applyH(board.H, x + poly(c.dx, u, v), y + poly(c.dy, u, v));
  }

  // The table seen straight from above, about as many pixels per place as in
  // the photo (board.k per reference pixel): outlines of pieces and gaps
  // measured there are free of perspective. An oblique photo squashes far
  // pieces by up to a fifth, more than knob shapes differ.
  function toPlane(board, x, y) {
    const [u, v] = PH.geom.applyH(board.Hi, x, y);
    return [u * board.k, v * board.k];
  }
  function fromPlane(board, u, v) {
    return PH.geom.applyH(board.H, u / board.k, v / board.k);
  }

  // Returns H (reference pixel → photo pixel) with correction corr, or null.
  function homographyToScene(cv, ref, sceneGray, bigMask, sf) {
    const pairs = boardPairs(cv, ref, sceneGray, bigMask, sf);
    if (pairs.length < 12) return null;
    const am = cv.matFromArray(
      pairs.length,
      1,
      cv.CV_32FC2,
      pairs.flatMap(([p]) => p),
    );
    const bm = cv.matFromArray(
      pairs.length,
      1,
      cv.CV_32FC2,
      pairs.flatMap(([, q]) => q),
    );
    const inl = new cv.Mat();
    // Generous, so bent areas are not dropped as outliers; the correction pulls
    // them in afterwards. Many iterations and a high confidence: with the
    // defaults RANSAC stops early and one changed pair decides between the
    // best and a clearly worse fit.
    const Hm = cv.findHomography(am, bm, cv.RANSAC, 12, inl, 20000, 0.9999);
    let H = null;
    const use = [];
    for (let i = 0; i < inl.rows; i++) if (inl.data[i]) use.push(pairs[i]);
    if (!Hm.empty() && use.length >= 15) H = Array.from(Hm.data64F);
    for (const x of [am, bm, inl, Hm]) x.delete();
    if (!H) return null;
    const corr = fitCorrection(H, use, ref);
    return { H, corr, inliers: use.length };
  }

  // Residual of the homography in reference coordinates, smoothly
  // approximated. Only used with enough spread points and a measurable gain.
  function fitCorrection(H, pairs, ref) {
    if (pairs.length < 40) return null;
    const Hi = PH.geom.invertH(H);
    const pts = pairs.map(([p, q]) => {
      const [x, y] = PH.geom.applyH(Hi, q[0], q[1]);
      return { u: p[0] / ref.W, v: p[1] / ref.H, dx: x - p[0], dy: y - p[1] };
    });
    let use = pts;
    let cx = null;
    let cy = null;
    for (let it = 0; it < 3; it++) {
      const n = terms(0, 0).length;
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      const bx = new Array(n).fill(0);
      const by = new Array(n).fill(0);
      for (const p of use) {
        const t = terms(p.u, p.v);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) A[i][j] += t[i] * t[j];
          bx[i] += t[i] * p.dx;
          by[i] += t[i] * p.dy;
        }
      }
      // Some damping in case the points only cover part of the area.
      for (let i = 1; i < n; i++) A[i][i] += use.length * 1e-3;
      cx = PH.geom.solve(A, bx);
      cy = PH.geom.solve(A, by);
      if (!cx || !cy) return null;
      const res = use.map((p) => Math.hypot(p.dx - poly(cx, p.u, p.v), p.dy - poly(cy, p.u, p.v)));
      const med = [...res].sort((a, b) => a - b)[Math.floor(res.length / 2)];
      use = use.filter((_, i) => res[i] < Math.max(1.5, 3 * med));
    }
    const rms = (f) => Math.sqrt(use.reduce((s, p) => s + f(p), 0) / use.length);
    const before = rms((p) => p.dx * p.dx + p.dy * p.dy);
    const after = rms((p) => (p.dx - poly(cx, p.u, p.v)) ** 2 + (p.dy - poly(cy, p.u, p.v)) ** 2);
    if (after > before * 0.8 || before < ref.C * 0.03) return null;
    return { dx: cx, dy: cy, W: ref.W, H: ref.H };
  }

  // Photo (or mask) in grid coordinates of the reference.
  function warpToRef(cv, mat, board, ref, interp) {
    const out = new cv.Mat();
    if (!board.corr && !board.field) {
      const Hm = cv.matFromArray(3, 3, cv.CV_64F, board.H);
      cv.warpPerspective(
        mat,
        out,
        Hm,
        new cv.Size(ref.W, ref.H),
        interp | cv.WARP_INVERSE_MAP,
        cv.BORDER_CONSTANT,
      );
      Hm.delete();
      return out;
    }
    const mx = new Float32Array(ref.W * ref.H);
    const my = new Float32Array(ref.W * ref.H);
    for (let y = 0; y < ref.H; y++) {
      for (let x = 0; x < ref.W; x++) {
        const [sx, sy] = toScene(board, x, y);
        mx[y * ref.W + x] = sx;
        my[y * ref.W + x] = sy;
      }
    }
    const mapX = cv.matFromArray(ref.H, ref.W, cv.CV_32FC1, mx);
    const mapY = cv.matFromArray(ref.H, ref.W, cv.CV_32FC1, my);
    cv.remap(mat, out, mapX, mapY, interp, cv.BORDER_CONSTANT);
    mapX.delete();
    mapY.delete();
    return out;
  }

  function grayOf(rgba, n) {
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++)
      g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    return g;
  }

  // Normalised cross-correlation of two grey images inside a cell; 0 if the
  // reference has too little structure there.
  function cellNcc(a, b, W, c, r, C) {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let y = Math.round((r + 0.15) * C); y < (r + 0.85) * C; y++) {
      for (let x = Math.round((c + 0.15) * C); x < (c + 0.85) * C; x++) {
        const p = a[y * W + x];
        const q = b[y * W + x];
        n++;
        sa += p;
        sb += q;
        saa += p * p;
        sbb += q * q;
        sab += p * q;
      }
    }
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    if (vb / n < 36) return 0;
    return (sab - (sa * sb) / n) / Math.sqrt(Math.max(1e-6, va * vb));
  }

  function fraction(mask, W, x0, y0, x1, y1, want) {
    let hit = 0;
    let n = 0;
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        n++;
        if (!!mask[y * W + x] === want) hit++;
      }
    }
    return n ? hit / n : 0;
  }

  // Linear colour mapping photo → reference per channel from occupied blocks,
  // after a first estimate without the 20 % largest outliers.
  function fitColor(pairs) {
    const fit = (ps, c) => {
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (const [p, q] of ps) {
        sx += p[c];
        sy += q[c];
        sxx += p[c] * p[c];
        sxy += p[c] * q[c];
      }
      const n = ps.length;
      const den = n * sxx - sx * sx;
      const a = den > 1e-6 ? (n * sxy - sx * sy) / den : 1;
      return [a, (sy - a * sx) / n];
    };
    if (pairs.length < 30) return null;
    let col = [0, 1, 2].map((c) => fit(pairs, c));
    const err = (pq) => [0, 1, 2].reduce((s, c) => s + (pq[0][c] * col[c][0] + col[c][1] - pq[1][c]) ** 2, 0);
    const sorted = [...pairs].sort((x, y) => err(x) - err(y));
    col = [0, 1, 2].map((c) => fit(sorted.slice(0, Math.floor(sorted.length * 0.8)), c));
    return col.map(([a, b]) => [Math.min(2, Math.max(0.5, a)), b]);
  }

  // Outlines of the finished part in the plane, oriented so that the free
  // table lies to the right: a gap is then traversed clockwise, just like the
  // piece that belongs in it.
  function boardOutlines(cv, bigMask, board, C) {
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(bigMask, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE);
    const lines = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      if (c.data32S.length > 40) {
        const raw = [];
        for (let j = 0; j < c.data32S.length; j += 2)
          raw.push(toPlane(board, c.data32S[j], c.data32S[j + 1]));
        let pts = PH.piece.smoothClosed(PH.piece.arcResample(raw, 1), 2);
        const isHole = hier.data32S[i * 4 + 3] >= 0;
        const area = PH.geom.polygonArea(pts);
        if ((isHole && area < 0) || (!isHole && area > 0)) pts = pts.reverse();
        lines.push(pts);
      }
      c.delete();
    }
    contours.delete();
    hier.delete();
    const corner = (r, c) => toPlane(board, ...toScene(board, c * C, r * C));
    const nearest = (q, maxD) => {
      let best = null;
      for (let li = 0; li < lines.length; li++) {
        const pts = lines[li];
        for (let i = 0; i < pts.length; i++) {
          const d = Math.hypot(pts[i][0] - q[0], pts[i][1] - q[1]);
          if (d < maxD && (!best || d < best.d)) best = { li, i, d };
        }
      }
      return best;
    };
    return {
      // Side d (top, right, bottom, left) of the empty cell r/c.
      side(r, c, d) {
        const cs = [corner(r, c), corner(r, c + 1), corner(r + 1, c + 1), corner(r + 1, c)];
        const a = cs[d];
        const b = cs[(d + 1) % 4];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const na = nearest(a, 0.2 * L);
        const nb = nearest(b, 0.2 * L);
        if (!na || !nb || na.li !== nb.li) return null;
        const pts = lines[na.li];
        const n = pts.length;
        if ((nb.i - na.i + n) % n > 3 * L) return null;
        return PH.piece.sideShape(pts, na.i, nb.i, pts[na.i], pts[nb.i]);
      },
    };
  }

  // sf: feature points of the photo (PH.feature.sceneFeatures), or null.
  function registerBoard(cv, ref, sceneMat, sceneGray, bigMask, sf = null) {
    const hit = homographyToScene(cv, ref, sceneGray, bigMask, sf);
    if (!hit) return null;
    hit.field = seamField(cv, hit, ref, sceneGray, bigMask);
    const { H, corr, field } = hit;
    const { C, G, W, cols, rows } = ref;
    const mw = warpToRef(cv, bigMask, hit, ref, cv.INTER_NEAREST);
    const mask = new Uint8Array(mw.data);
    mw.delete();

    // Second evidence: the photo looks like the reference at this place. Helps
    // where dark pieces in the finished part leave gaps in the mask. The
    // picture content follows the feature points, not the seams.
    const sw = warpToRef(cv, sceneMat, { H, corr }, ref, cv.INTER_LINEAR);
    const sg = grayOf(sw.data, W * ref.H);
    const lab = PH.segment.rgbaToLab(sw.data, ref.W * ref.H);
    sw.delete();
    const rg = grayOf(ref.rgba.data, W * ref.H);
    const filled = [];
    const isFilled = new Uint8Array(cols * rows);
    // Places the photo does not show (a photo of part of the puzzle) are
    // neither filled nor free.
    const unseen = [];
    const inPhoto = (x, y) => {
      const [sx, sy] = toScene(hit, x * C, y * C);
      return sx >= 0 && sy >= 0 && sx < sceneMat.cols && sy < sceneMat.rows;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (![0.3, 0.7].every((u) => inPhoto(c + u, r + 0.3) && inPhoto(c + u, r + 0.7))) {
          unseen.push(r * cols + c);
          continue;
        }
        // Holes of the piece reach a third into the place; with the grid on
        // the seams a piece covers well over half of the middle, a gap with
        // knobs reaching in well under half.
        let f = fraction(mask, W, (c + 0.3) * C, (r + 0.3) * C, (c + 0.7) * C, (r + 0.7) * C, true);
        if (f > 0.1 && f <= 0.5 && cellNcc(sg, rg, W, c, r, C) > 0.6) f = 1;
        if (f > 0.5) {
          isFilled[r * cols + c] = 1;
          filled.push(r * cols + c);
        }
      }
    }
    if (filled.length < 2) return null;
    const isUnseen = new Uint8Array(cols * rows);
    for (const u of unseen) isUnseen[u] = 1;

    // Gaps: if the neighbour's knob reaches in, the piece needs a hole there;
    // if the neighbour misses a bit, it needs a knob.
    const holes = [];
    const sides = filled
      .filter((_, i) => i % Math.ceil(filled.length / 200) === 0)
      .map((cell) => {
        const r = Math.floor(cell / cols);
        const c = cell % cols;
        const q = [
          [c, r],
          [c + 1, r],
          [c + 1, r + 1],
          [c, r + 1],
        ].map(([x, y]) => toScene(hit, x * C, y * C));
        return Math.sqrt(Math.abs(PH.geom.polygonArea(q))) / C;
      })
      .sort((p, q) => p - q);
    hit.k = sides[sides.length >> 1];
    hit.Hi = PH.geom.invertH(H);
    const outlines = boardOutlines(cv, bigMask, hit, C);
    const a = 0.3 * C;
    const b = 0.7 * C;
    const d0 = 0.04 * C;
    const d1 = 0.22 * C;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (isFilled[r * cols + c] || isUnseen[r * cols + c]) continue;
        for (let d = 0; d < 4; d++) {
          const [dx, dy] = PH.match.DIRS[d];
          const nr = r + dy;
          const nc = c + dx;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || !isFilled[nr * cols + nc]) continue;
          const x = c * C;
          const y = r * C;
          let inE;
          let inN;
          if (d === 0) {
            inE = [x + a, y + d0, x + b, y + d1];
            inN = [x + a, y - d1, x + b, y - d0];
          } else if (d === 2) {
            inE = [x + a, y + C - d1, x + b, y + C - d0];
            inN = [x + a, y + C + d0, x + b, y + C + d1];
          } else if (d === 1) {
            inE = [x + C - d1, y + a, x + C - d0, y + b];
            inN = [x + C + d0, y + a, x + C + d1, y + b];
          } else {
            inE = [x + d0, y + a, x + d1, y + b];
            inN = [x - d1, y + a, x - d0, y + b];
          }
          const fA = fraction(mask, W, ...inE, true);
          const fB = fraction(mask, W, ...inN, false);
          let need = 0;
          if (fA > 0.2 && fA >= fB) need = -1;
          else if (fB > 0.2) need = 1;
          const shape = outlines.side(r, c, d);
          if (shape && shape.type !== 0 && (!need || shape.type === need)) {
            holes.push([`${r * cols + c},${d}`, { need: shape.type, hole: shape }]);
          } else if (need) holes.push([`${r * cols + c},${d}`, { need }]);
        }
      }
    }

    // Colour fit over the occupied places.

    const bs = C / G;
    const sb = PH.reference.blockMeans(lab, ref.W, ref.H, bs);
    const pairs = [];
    for (let by = 0; by < sb.h; by++) {
      for (let bx = 0; bx < sb.w; bx++) {
        const cell = Math.floor(by / G) * cols + Math.floor(bx / G);
        if (!isFilled[cell]) continue;
        if (fraction(mask, W, bx * bs, by * bs, (bx + 1) * bs, (by + 1) * bs, true) < 0.95) continue;
        const o = (by * sb.w + bx) * 3;
        pairs.push([Array.from(sb.data.subarray(o, o + 3)), Array.from(ref.blocks.data.subarray(o, o + 3))]);
      }
    }
    return {
      H,
      Hi: hit.Hi,
      k: hit.k,
      corr,
      field,
      inliers: hit.inliers,
      filled,
      unseen,
      holes,
      color: fitColor(pairs),
    };
  }

  // Photo and finished part in grid coordinates at F px per reference px;
  // d: seams as thin dark lines (black-hat), m: mask of the finished part.
  function seamImage(cv, board, ref, sceneGray, bigMask, F) {
    const W = ref.W * F;
    const H = ref.H * F;
    const mx = new Float32Array(W * H);
    const my = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [sx, sy] = toScene(board, x / F, y / F);
        mx[y * W + x] = sx;
        my[y * W + x] = sy;
      }
    }
    const mapX = cv.matFromArray(H, W, cv.CV_32FC1, mx);
    const mapY = cv.matFromArray(H, W, cv.CV_32FC1, my);
    const wg = new cv.Mat();
    const wm = new cv.Mat();
    cv.remap(sceneGray, wg, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.remap(bigMask, wm, mapX, mapY, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(wg, wg, cv.MORPH_BLACKHAT, k);
    const d = Uint8Array.from(wg.data);
    const m = Uint8Array.from(wm.data);
    for (const x of [mapX, mapY, wg, wm, k]) x.delete();
    return { d, m, W, H };
  }

  // Feature points leave plain areas (sky, water) to the smooth correction,
  // which misses the pieces there by up to half a place (Great Wave sky).
  // Seams and the outline of the finished part show where the grid lines
  // really run: per grid corner the shift in x and in y, at most half a
  // place, that puts the most of them onto the three nearest grid lines.
  // Median over the neighbouring corners; corners without lines around
  // (inside large gaps) take the mean of their neighbours.
  function seamField(cv, board, ref, sceneGray, bigMask) {
    const F = 2;
    const { C, cols, rows } = ref;
    const { d, m, W, H } = seamImage(cv, board, ref, sceneGray, bigMask, F);
    const E = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const v = m[i];
        const edge = v !== m[i - 1] || v !== m[i + 1] || v !== m[i - W] || v !== m[i + W];
        E[i] = (v ? Math.min(d[i], 60) : 0) + (edge ? 40 : 0);
      }
    }
    const L = C * F;
    const R = Math.round(L / 2);
    const span = Math.round(1.5 * L);
    // At least a weak line over a third of the comb.
    const minScore = 5 * 6 * span;
    const n1 = cols + 1;
    const N = n1 * (rows + 1);
    const raw = [new Float32Array(N).fill(Number.NaN), new Float32Array(N).fill(Number.NaN)];
    const sx = new Float64Array(2 * R + 1);
    const sy = new Float64Array(2 * R + 1);
    let found = 0;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        sx.fill(0);
        sy.fill(0);
        const x0 = i * L;
        const y0 = j * L;
        for (let o = -R; o <= R; o++) {
          for (let k = -1; k <= 1; k++) {
            const x = x0 + k * L + o;
            if (x >= 0 && x < W)
              for (let y = Math.max(0, y0 - span); y < Math.min(H, y0 + span); y++) sx[o + R] += E[y * W + x];
            const y = y0 + k * L + o;
            if (y >= 0 && y < H)
              for (let x2 = Math.max(0, x0 - span); x2 < Math.min(W, x0 + span); x2++)
                sy[o + R] += E[y * W + x2];
          }
        }
        [sx, sy].forEach((s, a) => {
          let best = 0;
          for (let q = 1; q < s.length; q++) if (s[q] > s[best]) best = q;
          const med = Float64Array.from(s).sort()[R];
          if (s[best] >= minScore && s[best] >= 1.6 * med) {
            raw[a][j * n1 + i] = (best - R) / F;
            found++;
          }
        });
      }
    }
    if (found < 0.1 * N) return null;
    const [dx, dy] = raw.map((A) => {
      let B = new Float32Array(N).fill(Number.NaN);
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
          const v = [];
          for (let jj = Math.max(0, j - 1); jj <= Math.min(rows, j + 1); jj++)
            for (let ii = Math.max(0, i - 1); ii <= Math.min(cols, i + 1); ii++)
              if (!Number.isNaN(A[jj * n1 + ii])) v.push(A[jj * n1 + ii]);
          if (v.length >= 3) B[j * n1 + i] = v.sort((p, q) => p - q)[v.length >> 1];
        }
      }
      for (let pass = 0; pass < 4; pass++) {
        const next = B.slice();
        for (let j = 0; j <= rows; j++) {
          for (let i = 0; i <= cols; i++) {
            if (!Number.isNaN(B[j * n1 + i])) continue;
            let s = 0;
            let c = 0;
            for (const [ii, jj] of [
              [i - 1, j],
              [i + 1, j],
              [i, j - 1],
              [i, j + 1],
            ]) {
              if (ii < 0 || jj < 0 || ii > cols || jj > rows || Number.isNaN(B[jj * n1 + ii])) continue;
              s += B[jj * n1 + ii];
              c++;
            }
            if (c) next[j * n1 + i] = s / c;
          }
        }
        B = next;
      }
      return B.map((v) => (Number.isNaN(v) ? 0 : v));
    });
    return { cols, rows, C, dx, dy };
  }

  // The real piece grid from the seams of the finished part: the box
  // picture often shows a little more or less than the puzzle, then the grid
  // laid over the box misses the pieces by a fraction of a place (measured:
  // rows 0.94 places high, shifted by a third). The scene is mapped into the
  // reference at F px per reference px; seams are thin dark lines (black-hat),
  // averaged per column and row over occupied places; per axis the period and
  // phase with the strongest comb, and the outer edges of the finished part.
  // Result in places of the current grid, or null if the seams are unclear.
  function seamGrid(cv, board, ref, sceneGray, bigMask) {
    const F = 2;
    const { C, cols, rows } = ref;
    // Without the local field: it already pulls the grid onto the seams.
    const { d, m, W, H } = seamImage(cv, { H: board.H, corr: board.corr }, ref, sceneGray, bigMask, F);
    const filled = new Set(board.filled);
    const px = new Float64Array(W);
    const py = new Float64Array(H);
    const nx = new Float64Array(W);
    const ny = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      const r = Math.floor(y / F / C);
      for (let x = 0; x < W; x++) {
        if (!filled.has(r * cols + Math.floor(x / F / C)) || !m[y * W + x]) continue;
        const v = d[y * W + x];
        px[x] += v;
        nx[x]++;
        py[y] += v;
        ny[y]++;
      }
    }
    const axis = (p, n, count) => {
      for (let i = 0; i < p.length; i++) p[i] = n[i] ? p[i] / n[i] : 0;
      let base = 0;
      let nb = 0;
      for (let i = 0; i < p.length; i++)
        if (n[i]) {
          base += p[i];
          nb++;
        }
      base /= Math.max(1, nb);
      const cF = C * F;
      let best = null;
      for (let per = 0.85 * cF; per <= 1.15 * cF; per += 0.002 * cF) {
        for (let ph = 0; ph < per; ph += 0.5) {
          let sc = 0;
          let hits = 0;
          for (let x = ph; x < p.length - 1; x += per) {
            const i = Math.round(x);
            if (!n[i]) continue;
            sc += p[i] + 0.5 * (p[i - 1] + p[i + 1]);
            hits++;
          }
          if (hits < count * 0.4) continue;
          sc /= hits;
          if (!best || sc > best.sc) best = { sc, per, ph };
        }
      }
      // Clear comb and a period inside the search range, else no claim.
      const period = best ? best.per / cF : 0;
      if (!best || best.sc < 1.2 * 2 * base || period < 0.87 || period > 1.13) return null;
      // Outer edges of the finished part, snapped to the nearest seams.
      let lo = -1;
      let hi = -1;
      for (let i = 0; i < p.length; i++)
        if (n[i] > 0.02 * (p.length === W ? H : W)) {
          if (lo < 0) lo = i;
          hi = i;
        }
      if (lo < 0) return null;
      const snap = (v) => best.ph + Math.round((v - best.ph) / best.per) * best.per;
      const a = snap(lo);
      const b = snap(hi + 1);
      return {
        from: a / cF,
        to: b / cF,
        n: Math.round((b - a) / best.per),
        period: best.per / cF,
        strength: best.sc / (2 * base),
      };
    };
    const gx = axis(px, nx, cols);
    const gy = axis(py, ny, rows);
    return gx && gy ? { x: gx, y: gy } : null;
  }

  PH.board = { registerBoard, toScene, toPlane, fromPlane, fitColor, toGray, seamGrid };
})();
