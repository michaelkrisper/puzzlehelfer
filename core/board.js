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

  // Reference → photo. A homography alone does not fit if the reference was
  // photographed wavy or bent; corr first shifts the reference coordinates
  // smoothly. It is measured on the finished part, which lies flat on the
  // table: this straightens the reference against it.
  function toScene(board, x, y) {
    const c = board.corr;
    if (!c) return PH.geom.applyH(board.H, x, y);
    const u = x / c.W;
    const v = y / c.H;
    return PH.geom.applyH(board.H, x + poly(c.dx, u, v), y + poly(c.dy, u, v));
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
    // them in afterwards.
    const Hm = cv.findHomography(am, bm, cv.RANSAC, 12, inl);
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
    if (!board.corr) {
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

  // Outlines of the finished part in the photo, oriented so that the free
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
        for (let j = 0; j < c.data32S.length; j += 2) raw.push([c.data32S[j], c.data32S[j + 1]]);
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
    const corner = (r, c) => toScene(board, c * C, r * C);
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
    const { H, corr } = hit;
    const { C, G, W, cols, rows } = ref;
    const mw = warpToRef(cv, bigMask, hit, ref, cv.INTER_NEAREST);
    const mask = new Uint8Array(mw.data);
    mw.delete();

    // Second evidence: the photo looks like the reference at this place. Helps
    // where dark pieces in the finished part leave gaps in the mask.
    const sw = warpToRef(cv, sceneMat, hit, ref, cv.INTER_LINEAR);
    const sg = grayOf(sw.data, W * ref.H);
    const lab = PH.segment.rgbaToLab(sw.data, ref.W * ref.H);
    sw.delete();
    const rg = grayOf(ref.rgba.data, W * ref.H);
    const filled = [];
    const isFilled = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let f = fraction(mask, W, (c + 0.3) * C, (r + 0.3) * C, (c + 0.7) * C, (r + 0.7) * C, true);
        if (f > 0.25 && f <= 0.75 && cellNcc(sg, rg, W, c, r, C) > 0.6) f = 1;
        if (f > 0.75) {
          isFilled[r * cols + c] = 1;
          filled.push(r * cols + c);
        }
      }
    }
    if (filled.length < 2) return null;

    // Gaps: if the neighbour's knob reaches in, the piece needs a hole there;
    // if the neighbour misses a bit, it needs a knob.
    const holes = [];
    const outlines = boardOutlines(cv, bigMask, hit, C);
    const a = 0.3 * C;
    const b = 0.7 * C;
    const d0 = 0.04 * C;
    const d1 = 0.22 * C;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (isFilled[r * cols + c]) continue;
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
    return { H, corr, inliers: hit.inliers, filled, holes, color: fitColor(pairs) };
  }

  PH.board = { registerBoard, toScene, fitColor, toGray };
})();
