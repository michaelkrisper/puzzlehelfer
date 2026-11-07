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

  // Homography reference → photo over point pairs, or null.
  function fitH(cv, pairs) {
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
    const Hm = cv.findHomography(am, bm, cv.RANSAC, RANSAC_TOL, inl, 20000, 0.9999);
    let n = 0;
    for (let i = 0; i < inl.rows; i++) if (inl.data[i]) n++;
    const H = !Hm.empty() && n >= 15 ? Array.from(Hm.data64F) : null;
    for (const x of [am, bm, inl, Hm]) x.delete();
    return H;
  }
  const RANSAC_TOL = 12;

  const fits = (H, [p, q]) => {
    const [x, y] = PH.geom.applyH(H, p[0], p[1]);
    return Math.hypot(x - q[0], y - q[1]) < RANSAC_TOL;
  };

  // Pairs per blob of the finished part (blobs: outlines in the photo):
  // index of the blob under the photo point, or within the margin the mask
  // was widened by for the points; -1 for none.
  function blobOfPairs(cv, pairs, blobs, bigMask) {
    if (!blobs.length) return pairs.map(() => -1);
    const w = bigMask.cols;
    const h = bigMask.rows;
    const lab = cv.Mat.zeros(h, w, cv.CV_8UC1);
    // Largest first: an island inside the finished border's hole is drawn
    // over the border's filled outline.
    const order = blobs.map((_, i) => i).sort((a, b) => blobs[b].area - blobs[a].area);
    for (const i of order) PH.segment.drawPoly(cv, lab, blobs[i].contour, Math.min(254, i + 1));
    const L = lab.data;
    const M = bigMask.data;
    const out = pairs.map(([, [qx, qy]]) => {
      const x0 = Math.round(qx);
      const y0 = Math.round(qy);
      for (let r = 0; r <= 9; r += 3)
        for (let dy = -r; dy <= r; dy += 3)
          for (let dx = -r; dx <= r; dx += 3) {
            const x = x0 + dx;
            const y = y0 + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const o = y * w + x;
            if (M[o] && L[o]) return L[o] - 1;
          }
      return -1;
    });
    lab.delete();
    return out;
  }

  // The main part (finished border and what lies at its place) and the
  // homography that puts it onto the reference. Islands laid only roughly
  // where they belong, and groups elsewhere, each follow a homography of
  // their own: tried are all pairs and each blob alone, kept the one whose
  // consistent blobs cover the largest area of the photo (the border
  // encloses all others).
  // Returns {H, corr, inliers, members: blob indices}, or null.
  // k: expected photo pixels per reference pixel (from the loose pieces), or
  // null.
  function homographyToScene(cv, ref, sceneGray, bigMask, sf, blobs = [], k = null) {
    // The same match comes back from overlapping tiles and both detectors:
    // repeated, one wrong match would count as several agreeing points.
    const seen = new Set();
    const pairs = boardPairs(cv, ref, sceneGray, bigMask, sf).filter(([p, q]) => {
      const key = [p, q].flat().map(Math.round).join();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (pairs.length < 12) return null;
    const of = blobOfPairs(cv, pairs, blobs, bigMask);
    const per = blobs.map(() => []);
    of.forEach((b, i) => {
      if (b >= 0) per[b].push(pairs[i]);
    });
    // Per blob the pairs a similarity explains: on plain sky most matches
    // are wrong, the right ones agree with each other.
    const good = per.map((p) => {
      const m = PH.feature.ransacSimilarity(
        p.map(([a]) => a),
        p.map(([, b]) => b),
        RANSAC_TOL,
        k ? [0.6 * k, 1.6 * k] : [0.05, 20],
      );
      if (!m || m.inliers < 6) return [];
      return p.filter(
        ([a, b]) =>
          Math.hypot(m.c * a[0] - m.s * a[1] + m.tx - b[0], m.s * a[0] + m.c * a[1] + m.ty - b[1]) <
          RANSAC_TOL,
      );
    });
    // Candidates for the main mapping: all pairs, and each blob alone (by a
    // similarity where its points are few: a photo from above).
    const cands = [fitH(cv, pairs)];
    const own = good.map((p, i) => [p.length, i]).filter(([n]) => n >= 6);
    if (own.length > 1)
      for (const [n, i] of own.sort((a, b) => b[0] - a[0]).slice(0, 5))
        cands.push(n >= 15 ? fitH(cv, good[i]) : simH(good[i]));
    // The main part is the one with the finished border: the user moves
    // islands, not the border. Border places its outline runs over, then the
    // area of its blobs, decide.
    const { C, cols, rows } = ref;
    const borderOf = (H, i) => {
      const Hi = PH.geom.invertH(H);
      const out = new Set();
      const c = blobs[i].contour;
      for (let j = 0; j < c.length; j += 5) {
        const [u, v] = PH.geom.applyH(Hi, c[j][0], c[j][1]);
        const col = Math.floor(u / C);
        const row = Math.floor(v / C);
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        if (row === 0 || col === 0 || row === rows - 1 || col === cols - 1) out.add(row * cols + col);
      }
      return out.size;
    };
    let best = null;
    for (const H of cands) {
      if (!H || !saneH(H, ref)) continue;
      const members = [];
      let area = 0;
      let border = 0;
      good.forEach((p, i) => {
        const n = p.filter((pq) => fits(H, pq)).length;
        if (n >= 4 && n >= 0.5 * p.length) {
          members.push(i);
          area += blobs[i].area;
          border += borderOf(H, i);
        }
      });
      const use = pairs.filter((pq, i) => fits(H, pq) && (of[i] < 0 || members.includes(of[i])));
      if (use.length < 8) continue;
      const key = [border >= 3 ? border : 0, area, use.length];
      const better = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      if (!best || better(key, best.key) > 0) best = { H, members, key, use };
    }
    if (!best) return null;
    let hit = { H: best.H, corr: null };
    let moves = [];
    // Islands move by S on the table; their points, moved back, show the
    // table plane too: with them the main mapping is fitted again, which
    // helps when the main part alone has few points (a border of plain sky).
    for (let round = 0; round < 2; round++) {
      moves = [];
      good.forEach((_, i) => {
        if (best.members.includes(i)) return;
        const mv = islandMove(ref, hit, good[i]);
        if (mv) moves.push({ ...mv, blob: i });
      });
      if (!moves.length || round) break;
      const all = [...best.use];
      for (const mv of moves)
        for (const [p, q] of good[mv.blob]) {
          const [x, y] = PH.geom.applyH(mv.S, p[0], p[1]);
          all.push([[x, y], q]);
        }
      const H1 = fitH(cv, all);
      if (!H1 || !saneH(H1, ref) || all.filter((pq) => fits(H1, pq)).length < 0.8 * all.length) break;
      hit = { H: H1, corr: null };
      best.use = best.use.filter((pq) => fits(H1, pq));
    }
    globalThis.PH_DEBUG?.(
      'scales',
      k,
      ref.C,
      per.map((p) => {
        const m = PH.feature.ransacSimilarity(
          p.map(([a]) => a),
          p.map(([, b]) => b),
          RANSAC_TOL,
          [0.05, 20],
        );
        return m && [m.inliers, +m.scale.toFixed(3), Math.round(m.angle)];
      }),
    );
    globalThis.PH_DEBUG?.('homography', {
      pairs: pairs.length,
      per: per.map((p, i) => [p.length, good[i].length, Math.round(blobs[i].area), blobs[i].bbox]),
      best: { members: best.members, use: best.use.length },
      moves: moves.map((m) => [m.blob, m.inliers, m.S.map((v) => +v.toFixed(3))]),
    });
    const corr = fitCorrection(hit.H, best.use, ref);
    // Parts whose points put them elsewhere: loose pieces, or an island too
    // plain for a move of its own.
    const away = new Set();
    good.forEach((p, i) => {
      if (best.members.includes(i) || moves.some((m) => m.blob === i)) return;
      if (p.length >= 4 && p.filter((pq) => fits(hit.H, pq)).length < 0.5 * p.length) away.add(i);
    });
    return { H: hit.H, corr, inliers: best.use.length, members: new Set(best.members), moves, away };
  }

  // Similarity over point pairs as a homography (no perspective).
  function simH(pairs) {
    const [a, b, tx, ty] = lsqSimilarity(
      pairs.map(([p]) => p),
      pairs.map(([, q]) => q),
    );
    return [a, -b, tx, b, a, ty, 0, 0, 1];
  }

  // A homography a photo of a table can have: the reference stays on one
  // side of the horizon, and the scale over it varies at most threefold.
  function saneH(H, ref) {
    const pts = [
      [0, 0],
      [ref.W, 0],
      [ref.W, ref.H],
      [0, ref.H],
      [ref.W / 2, ref.H / 2],
    ];
    const w = pts.map(([x, y]) => H[6] * x + H[7] * y + H[8]);
    if (!w.every((v) => Math.sign(v) === Math.sign(w[4]) && Math.abs(v) > 1e-9)) return false;
    const sc = pts.map(([x, y]) => {
      const a = PH.geom.applyH(H, x, y);
      const b = PH.geom.applyH(H, x + 1, y);
      const c = PH.geom.applyH(H, x, y + 1);
      return Math.sqrt(Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])));
    });
    return Math.max(...sc) < 3 * Math.min(...sc);
  }

  // Similarity [a, b, tx, ty] (x' = a·x − b·y + tx, y' = b·x + a·y + ty)
  // taking points src closest onto dst (least squares).
  function lsqSimilarity(src, dst) {
    const n = src.length;
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
      sx += src[i][0] / n;
      sy += src[i][1] / n;
      dx += dst[i][0] / n;
      dy += dst[i][1] / n;
    }
    let ss = 0;
    let dot = 0;
    let cross = 0;
    for (let i = 0; i < n; i++) {
      const px = src[i][0] - sx;
      const py = src[i][1] - sy;
      const qx = dst[i][0] - dx;
      const qy = dst[i][1] - dy;
      ss += px * px + py * py;
      dot += px * qx + py * qy;
      cross += px * qy - py * qx;
    }
    const a = dot / ss;
    const b = cross / ss;
    return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
  }

  // Island or group: the move S on the table (reference pixels, where a
  // place belongs → where it lies, in the main part's frame) from its pairs
  // (those a similarity explains already).
  // Null with too few consistent points or a scale off the table plane's.
  function islandMove(ref, hit, pairs) {
    if (pairs.length < 6) return null;
    const Hi = PH.geom.invertH(hit.H);
    const src = pairs.map(([p]) => corrected(hit, p[0], p[1]));
    const dst = pairs.map(([, q]) => PH.geom.applyH(Hi, q[0], q[1]));
    const tol = 0.1 * ref.C;
    const m = PH.feature.ransacSimilarity(src, dst, tol, [0.85, 1.18]);
    globalThis.PH_DEBUG?.(
      'move',
      pairs.length,
      m && [
        m.inliers,
        +m.scale.toFixed(3),
        +m.angle.toFixed(1),
        +(m.tx / ref.C).toFixed(2),
        +(m.ty / ref.C).toFixed(2),
      ],
    );
    if (!m || m.inliers < 6 || m.inliers < 0.6 * pairs.length) return null;
    const near = (i) =>
      Math.hypot(
        m.c * src[i][0] - m.s * src[i][1] + m.tx - dst[i][0],
        m.s * src[i][0] + m.c * src[i][1] + m.ty - dst[i][1],
      ) < tol;
    const keep = src.map((_, i) => i).filter(near);
    const [a, b, tx, ty] = lsqSimilarity(
      keep.map((i) => src[i]),
      keep.map((i) => dst[i]),
    );
    return { S: [a, -b, tx, b, a, ty, 0, 0, 1], inliers: keep.length };
  }

  // Reference point with the smooth correction of a bent reference.
  function corrected(board, x, y) {
    const c = board.corr;
    if (!c) return [x, y];
    const u = x / c.W;
    const v = y / c.H;
    return [x + poly(c.dx, u, v), y + poly(c.dy, u, v)];
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

  // Normalised cross-correlation of two grey images inside a cell (margin m
  // off each side, photo shifted by dx, dy); 0 if the reference, or with
  // m > 0.15 the photo, has too little structure there.
  function cellNcc(a, b, W, c, r, C, m = 0.15, dx = 0, dy = 0) {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let y = Math.round((r + m) * C); y < (r + 1 - m) * C; y++) {
      for (let x = Math.round((c + m) * C); x < (c + 1 - m) * C; x++) {
        const p = a[(y + dy) * W + x + dx];
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
    if (vb / n < 36 || (m > 0.15 && va / n < 9)) return 0;
    return (sab - (sa * sb) / n) / Math.sqrt(Math.max(1e-6, va * vb));
  }

  function nccNear(a, b, W, c, r, C) {
    let best = -1;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) best = Math.max(best, cellNcc(a, b, W, c, r, C, 0.3, dx, dy));
    return best;
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
  // tol: how far (share of a side) a corner of the grid may lie off the
  // outline.
  function boardOutlines(cv, bigMask, board, C, tol = 0.2) {
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
    // The sharpest turn (over 50°) within 15 % of a side around index i: the
    // corner of the gap at the seam. Otherwise i (the outline runs straight
    // on along the next piece).
    const turnNear = (pts, i, L) => {
      const n = pts.length;
      const w = Math.max(2, Math.round(0.08 * L));
      let best = i;
      let bestA = (50 * Math.PI) / 180;
      for (let j = -Math.round(0.15 * L); j <= Math.round(0.15 * L); j++) {
        const p = pts[(i + j + n) % n];
        const q0 = pts[(i + j - w + n) % n];
        const q1 = pts[(i + j + w + n) % n];
        const t0 = Math.atan2(p[1] - q0[1], p[0] - q0[0]);
        const t1 = Math.atan2(q1[1] - p[1], q1[0] - p[0]);
        const turn = Math.abs(Math.atan2(Math.sin(t1 - t0), Math.cos(t1 - t0)));
        if (turn > bestA) {
          bestA = turn;
          best = (i + j + n) % n;
        }
      }
      return best;
    };
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
      // Rim of the gap along side d of the empty cell r/c: the outline of
      // the finished part from corner to corner (where it turns at the seam,
      // the grid may be a little off), in reference pixels every half pixel.
      rim(r, c, d) {
        const cs = [corner(r, c), corner(r, c + 1), corner(r + 1, c + 1), corner(r + 1, c)];
        const a = cs[d];
        const b = cs[(d + 1) % 4];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const na = nearest(a, tol * L);
        const nb = nearest(b, tol * L);
        if (!na || !nb || na.li !== nb.li) return null;
        const pts = lines[na.li];
        const n = pts.length;
        const ia = turnNear(pts, na.i, L);
        const ib = turnNear(pts, nb.i, L);
        const len = (ib - ia + n) % n;
        if (len < 0.5 * L || len > 3 * L) return null;
        const step = Math.max(1, Math.round(0.5 * board.k));
        const out = [];
        for (let j = 0; j <= len; j += step) {
          const [x, y] = pts[(ia + j) % n];
          out.push(x / board.k, y / board.k);
        }
        return Float32Array.from(out);
      },
      // Side d (top, right, bottom, left) of the empty cell r/c.
      side(r, c, d) {
        const cs = [corner(r, c), corner(r, c + 1), corner(r + 1, c + 1), corner(r + 1, c)];
        const a = cs[d];
        const b = cs[(d + 1) % 4];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const na = nearest(a, tol * L);
        const nb = nearest(b, tol * L);
        if (!na || !nb || na.li !== nb.li) return null;
        const pts = lines[na.li];
        const n = pts.length;
        if ((nb.i - na.i + n) % n > 3 * L) return null;
        return PH.piece.sideShape(pts, na.i, nb.i, pts[na.i], pts[nb.i]);
      },
    };
  }

  // Gap rims and knob/hole needs of the free places next to filled ones
  // (isFilled), in rows/cols range [r0, r1) × [c0, c1). frac(x0, y0, x1, y1,
  // want): share of the rectangle (reference pixels) that is (want) or is
  // not (!want) finished part.
  function gapsAround(ref, isFilled, isUnseen, outlines, frac, [r0, r1, c0, c1]) {
    const { C, cols, rows } = ref;
    const gaps = new Map();
    const holes = [];
    const a = 0.3 * C;
    const b = 0.7 * C;
    const d0 = 0.04 * C;
    const d1 = 0.22 * C;
    const filledAt = (r, c) => r >= 0 && c >= 0 && r < rows && c < cols && isFilled[r * cols + c];
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        if (isFilled[r * cols + c] || isUnseen?.[r * cols + c]) continue;
        const sides = PH.match.DIRS.map(([dx, dy]) => filledAt(r + dy, c + dx));
        if (!sides.some(Boolean)) continue;
        gaps.set(
          r * cols + c,
          sides.map((f, d) => (f ? outlines.rim(r, c, d) : null)),
        );
        for (let d = 0; d < 4; d++) {
          if (!sides[d]) continue;
          // If the neighbour's knob reaches in, the piece needs a hole there;
          // if the neighbour misses a bit, it needs a knob.
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
          const fA = frac(...inE, true);
          const fB = frac(...inN, false);
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
    return { gaps, holes };
  }

  // An island (or a joined group) on its own mapping: the main one after
  // its move S. Places and gaps are sampled in the photo along that mapping,
  // so no warp of the whole photo is needed per island.
  function measureIsland(cv, ref, hit, move, blob, bigMask, sceneGray) {
    const { C, cols, rows } = ref;
    const w = bigMask.cols;
    const h = bigMask.rows;
    const view = { H: PH.geom.mulH(hit.H, move.S), corr: hit.corr, k: hit.k };
    view.Hi = PH.geom.invertH(view.H);
    // Its outline filled, without the empty places inside it.
    const m = cv.Mat.zeros(h, w, cv.CV_8UC1);
    PH.segment.drawPoly(cv, m, blob.contour);
    const md = m.data;
    const bm = bigMask.data;
    for (let i = 0; i < md.length; i++) if (!bm[i]) md[i] = 0;
    const inside = (x, y) => {
      const [sx, sy] = toScene(view, x, y);
      const xi = Math.round(sx);
      const yi = Math.round(sy);
      return xi >= 0 && yi >= 0 && xi < w && yi < h && md[yi * w + xi] > 0;
    };
    const frac = (x0, y0, x1, y1, want) => {
      let n = 0;
      for (let j = 0; j < 6; j++)
        for (let i = 0; i < 6; i++)
          if (inside(x0 + ((i + 0.5) * (x1 - x0)) / 6, y0 + ((j + 0.5) * (y1 - y0)) / 6) === want) n++;
      return n / 36;
    };
    let c0 = cols;
    let r0 = rows;
    let c1 = 0;
    let r1 = 0;
    for (let i = 0; i < blob.contour.length; i += 4) {
      const [u, v] = PH.geom.applyH(view.Hi, ...blob.contour[i]);
      c0 = Math.min(c0, Math.floor(u / C));
      c1 = Math.max(c1, Math.ceil(u / C));
      r0 = Math.min(r0, Math.floor(v / C));
      r1 = Math.max(r1, Math.ceil(v / C));
    }
    const range = [Math.max(0, r0 - 1), Math.min(rows, r1 + 1), Math.max(0, c0 - 1), Math.min(cols, c1 + 1)];
    // Its grid onto its seams and outline, as the main part's.
    view.field = seamField(cv, view, ref, sceneGray, m, range);
    const isFilled = new Uint8Array(cols * rows);
    const filled = [];
    for (let r = range[0]; r < range[1]; r++)
      for (let c = range[2]; c < range[3]; c++)
        if (frac((c + 0.3) * C, (r + 0.3) * C, (c + 0.7) * C, (r + 0.7) * C, true) > 0.5) {
          isFilled[r * cols + c] = 1;
          filled.push(r * cols + c);
        }
    let out = null;
    if (filled.length) {
      // Its grid follows fewer seams than the main part's.
      const outlines = boardOutlines(cv, m, view, C, 0.35);
      const { gaps, holes } = gapsAround(ref, isFilled, null, outlines, frac, range);
      out = { view, filled, gaps, holes };
    }
    m.delete();
    return out;
  }

  // The large areas split where they only touch (narrow contacts): an
  // island laid against the border is a blob of its own, with a mapping of
  // its own. side: piece side in photo pixels. Returns parts {contour, area
  // (pixels), bbox} and their label image (part i + 1, 0 none), or null.
  function splitAtNecks(cv, bigMask, side) {
    const w = bigMask.cols;
    const h = bigMask.rows;
    const r = Math.max(2, Math.round(0.12 * side));
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1));
    const er = new cv.Mat();
    cv.erode(bigMask, er, k);
    k.delete();
    const markers = new cv.Mat();
    const n = cv.connectedComponents(er, markers, 8, cv.CV_32S);
    er.delete();
    if (n > 250) {
      markers.delete();
      return null;
    }
    // Outside the areas: a label of its own; the rest grows from the cores.
    const md = markers.data32S;
    const bm = bigMask.data;
    for (let i = 0; i < w * h; i++) if (!bm[i]) md[i] = n;
    const flat = new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(0, 0, 0));
    cv.watershed(flat, markers);
    flat.delete();
    const lab = new Uint8Array(w * h);
    const count = new Int32Array(n + 1);
    for (let i = 0; i < w * h; i++) {
      const v = md[i];
      if (v > 0 && v < n && bm[i]) {
        lab[i] = v;
        count[v]++;
      }
    }
    markers.delete();
    const parts = [];
    const keep = new Uint8Array(n + 1);
    const one = cv.Mat.zeros(h, w, cv.CV_8UC1);
    for (let v = 1; v < n; v++) {
      if (count[v] < 0.5 * side * side) continue;
      const d = one.data;
      for (let i = 0; i < w * h; i++) d[i] = lab[i] === v ? 255 : 0;
      const cs = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(one, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      let best = null;
      for (let j = 0; j < cs.size(); j++) {
        const c = cs.get(j);
        const a = cv.contourArea(c);
        if (!best || a > best.a) {
          const rect = cv.boundingRect(c);
          const pts = [];
          for (let q = 0; q < c.data32S.length; q += 2) pts.push([c.data32S[q], c.data32S[q + 1]]);
          best = { a, pts, bbox: [rect.x, rect.y, rect.width, rect.height] };
        }
        c.delete();
      }
      cs.delete();
      hier.delete();
      if (!best) continue;
      keep[v] = parts.length + 1;
      parts.push({ contour: best.pts, area: count[v], bbox: best.bbox });
    }
    one.delete();
    for (let i = 0; i < w * h; i++) lab[i] = keep[lab[i]];
    return { parts, lab };
  }

  // Parts that part v (split.lab) touches, as part indices: it was split off
  // a larger area there.
  function touching(split, v, contour, bigMask) {
    const w = bigMask.cols;
    const h = bigMask.rows;
    const bm = bigMask.data;
    const out = new Set();
    for (const [x, y] of contour)
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const o = yy * w + xx;
          if (bm[o] && split.lab[o] && split.lab[o] !== v) out.add(split.lab[o] - 1);
        }
    return out;
  }

  // sf: feature points of the photo (PH.feature.sceneFeatures), or null.
  // big: the large areas of the photo (PH.segment.segmentScene big).
  // k: expected photo pixels per reference pixel, or null.
  // Islands come with the indices of the large areas they make up (more
  // than half of it).
  function registerBoard(cv, ref, sceneMat, sceneGray, bigMask, sf = null, big = [], k = null) {
    const split = k ? splitAtNecks(cv, bigMask, k * ref.C) : null;
    const blobs = split?.parts ?? big;
    const hit = homographyToScene(cv, ref, sceneGray, bigMask, sf, blobs, k);
    if (!hit) return null;
    const { C, G, W, cols, rows } = ref;
    hit.Hi = PH.geom.invertH(hit.H);
    // Blobs off the main mapping with points enough for a move of their
    // own: islands. They leave the main part's mask.
    const { moves } = hit;
    // copyTo: clone() of this OpenCV.js build shares the pixels.
    const mainMask = new cv.Mat();
    bigMask.copyTo(mainMask);
    for (const mv of moves) PH.segment.drawPoly(cv, mainMask, blobs[mv.blob].contour, 0);
    // Not part of the main part either: parts elsewhere by their points, and
    // small parts without points on the main mapping that do not hang on it
    // or on an island (loose pieces lying together), which stay loose pieces.
    const cell = (k * ref.C) ** 2;
    const placed = (i) => hit.members.has(i) || moves.some((m) => m.blob === i);
    blobs.forEach((b, i) => {
      if (placed(i)) return;
      const alone =
        split && b.area < 2.6 * cell && ![...touching(split, i + 1, b.contour, bigMask)].some(placed);
      if (hit.away.has(i) || alone) PH.segment.drawPoly(cv, mainMask, b.contour, 0);
    });
    hit.field = seamField(cv, hit, ref, sceneGray, mainMask);
    const { H, corr, field } = hit;
    const mw = warpToRef(cv, mainMask, hit, ref, cv.INTER_NEAREST);
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
    const looks = [];
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
        const f = fraction(mask, W, (c + 0.3) * C, (r + 0.3) * C, (c + 0.7) * C, (r + 0.7) * C, true);
        if (f > 0.5) {
          isFilled[r * cols + c] = 1;
          filled.push(r * cols + c);
        } else if (
          (f > 0.25 && cellNcc(sg, rg, W, c, r, C) > 0.6) ||
          // Dark blue pieces pass as black mat in the mask. Their print still
          // matches in the middle of the place, where the knobs of neighbours
          // around a free place do not reach; small shifts allowed, the photo
          // follows the feature points only roughly at its far end (measured
          // on dark pieces 0.58–0.88, on free places at most 0.46).
          (f <= 0.25 && nccNear(sg, rg, W, c, r, C) > 0.55)
        )
          looks.push(r * cols + c);
      }
    }
    // By the print alone only within the finished part (two filled sides,
    // growing inward): on a wooden table loose pieces match some place by
    // chance.
    for (let grown = true; grown; ) {
      grown = false;
      for (const cell of looks) {
        if (isFilled[cell]) continue;
        const r = Math.floor(cell / cols);
        const c = cell % cols;
        const n = PH.match.DIRS.filter(([dx, dy]) => {
          const rr = r + dy;
          const cc = c + dx;
          return rr >= 0 && cc >= 0 && rr < rows && cc < cols && isFilled[rr * cols + cc];
        }).length;
        if (n >= 2) {
          isFilled[cell] = 1;
          filled.push(cell);
          grown = true;
        }
      }
    }
    if (filled.length < 2 && !moves.length) {
      mainMask.delete();
      return null;
    }
    const isUnseen = new Uint8Array(cols * rows);
    for (const u of unseen) isUnseen[u] = 1;

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
    hit.k = sides.length
      ? sides[sides.length >> 1]
      : Math.sqrt(
          Math.abs(
            PH.geom.polygonArea(
              [
                [W / 2, ref.H / 2],
                [W / 2 + C, ref.H / 2],
                [W / 2 + C, ref.H / 2 + C],
                [W / 2, ref.H / 2 + C],
              ].map(([x, y]) => toScene(hit, x, y)),
            ),
          ),
        ) / C;
    // Gap outlines of the empty places next to the finished part.
    const outlines = boardOutlines(cv, mainMask, hit, C);
    const frac = (x0, y0, x1, y1, want) => fraction(mask, W, x0, y0, x1, y1, want);
    const { gaps, holes } = gapsAround(ref, isFilled, isUnseen, outlines, frac, [0, rows, 0, cols]);

    // Islands: their places count as filled, their gap rims join the main
    // part's (side by side where a place lies between both). owner: place →
    // island whose mapping shows it (filled or a gap next to it).
    const islands = [];
    const owner = new Map();
    for (const mv of moves) {
      const it = measureIsland(cv, ref, hit, mv, blobs[mv.blob], bigMask, sceneGray);
      if (!it) continue;
      // A single piece counts only near its place: else it is a loose piece
      // whose points happen to agree.
      const turn = (Math.atan2(mv.S[3], mv.S[0]) * 180) / Math.PI;
      if (it.filled.length < 2 && Math.abs(turn) > 15) continue;
      const n = islands.length;
      const S = mv.S;
      // How far it lies from its place: shift of its middle in places, turn
      // in degrees.
      const mid = [0, 1].map(
        (a) =>
          it.filled.reduce((t, c) => t + (a ? Math.floor(c / cols) : c % cols) + 0.5, 0) / it.filled.length,
      );
      const [mx, my] = PH.geom.applyH(S, mid[0] * C, mid[1] * C);
      const shift = [mx / C - mid[0], my / C - mid[1]];
      if (it.filled.length < 2 && Math.hypot(...shift) > 1.5) continue;
      islands.push({
        blob: mv.blob,
        contour: blobs[mv.blob].contour,
        S,
        H: it.view.H,
        Hi: it.view.Hi,
        field: it.view.field,
        cells: it.filled,
        inliers: mv.inliers,
        shift,
        turn,
      });
      for (const c of it.filled) {
        if (isFilled[c]) continue;
        isFilled[c] = 1;
        filled.push(c);
        owner.set(c, n);
      }
      for (const [cell, g] of it.gaps) {
        if (isFilled[cell]) continue;
        const prev = gaps.get(cell);
        gaps.set(cell, prev ? prev.map((x, d) => x ?? g[d]) : g);
        if (!prev?.some(Boolean)) owner.set(cell, n);
      }
      holes.push(...it.holes);
    }
    mainMask.delete();
    if (filled.length < 2) return null;
    // Large areas that are mostly island.
    const islandBig = new Set();
    if (islands.length) {
      const of = new Set(islands.map((i) => i.blob));
      const one = cv.Mat.zeros(bigMask.rows, bigMask.cols, cv.CV_8UC1);
      big.forEach((b, j) => {
        if (!split) {
          if (of.has(j)) islandBig.add(j);
          return;
        }
        one.data.fill(0);
        PH.segment.drawPoly(cv, one, b.contour);
        let n = 0;
        let t = 0;
        const d = one.data;
        for (let i = 0; i < d.length; i++) {
          if (!d[i] || !bigMask.data[i]) continue;
          t++;
          if (split.lab[i] && of.has(split.lab[i] - 1)) n++;
        }
        if (n > 0.5 * t) islandBig.add(j);
      });
      one.delete();
    }

    // Colour fit over the occupied places.

    const bs = C / G;
    const sb = PH.reference.blockMeans(lab, ref.W, ref.H, bs);
    const pairs = [];
    for (let by = 0; by < sb.h; by++) {
      for (let bx = 0; bx < sb.w; bx++) {
        const cell = Math.floor(by / G) * cols + Math.floor(bx / G);
        if (!isFilled[cell] || owner.has(cell)) continue;
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
      unseen: unseen.filter((c) => !isFilled[c]),
      holes,
      gaps: [...gaps],
      color: fitColor(pairs),
      islands,
      islandBig: [...islandBig],
      owner: [...owner],
    };
  }

  // Photo and finished part in grid coordinates at F px per reference px;
  // d: seams as thin dark lines (black-hat), m: mask of the finished part.
  // rect: part of the reference [x0, y0, x1, y1], at ox, oy in the image.
  function seamImage(cv, board, ref, sceneGray, bigMask, F, rect = [0, 0, ref.W, ref.H]) {
    const [rx0, ry0, rx1, ry1] = rect;
    const W = Math.round((rx1 - rx0) * F);
    const H = Math.round((ry1 - ry0) * F);
    const mx = new Float32Array(W * H);
    const my = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const [sx, sy] = toScene(board, rx0 + x / F, ry0 + y / F);
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
    return { d, m, W, H, ox: Math.round(rx0 * F), oy: Math.round(ry0 * F) };
  }

  // Feature points leave plain areas (sky, water) to the smooth correction,
  // which misses the pieces there by up to half a place (Great Wave sky).
  // Seams and the outline of the finished part show where the grid lines
  // really run: per grid corner the shift in x and in y, at most half a
  // place, that puts the most of them onto the three nearest grid lines.
  // Median over the neighbouring corners; corners without lines around
  // (inside large gaps) take the mean of their neighbours.
  // range: grid corners [r0, r1] × [c0, c1] to measure (an island), else
  // all.
  function seamField(cv, board, ref, sceneGray, bigMask, range = null) {
    const F = 2;
    const { C, cols, rows } = ref;
    const [r0, r1, c0, c1] = range ?? [0, rows, 0, cols];
    const rect = [
      Math.max(0, (c0 - 1.6) * C),
      Math.max(0, (r0 - 1.6) * C),
      Math.min(ref.W, (c1 + 1.6) * C),
      Math.min(ref.H, (r1 + 1.6) * C),
    ];
    const { d, m, W, H, ox, oy } = seamImage(cv, board, ref, sceneGray, bigMask, F, rect);
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
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        sx.fill(0);
        sy.fill(0);
        const x0 = i * L - ox;
        const y0 = j * L - oy;
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
    if (found < 0.1 * (r1 - r0 + 1) * (c1 - c0 + 1)) return null;
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
  // rows 0.94 places high, shifted by a third), and the piece count alone
  // does not fix columns and rows (240 = 12 × 20, not 14 × 17). The scene is
  // mapped into the reference at F px per reference px; seams are thin dark
  // lines (black-hat), averaged per column and row over occupied places. Per
  // axis the comb strength (relative to twice the mean) and best phase for
  // periods 0.72..1.38 of the current place, and the outer edges of the
  // finished part, all in places of the current grid; PH.geom.gridFromSeams
  // picks the grid. Null without a finished part.
  function seamGrid(cv, board, ref, sceneGray, bigMask) {
    const F = 2;
    const P0 = 0.72;
    const DP = 0.002;
    const NP = 331;
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
    const axis = (p, n, count, across) => {
      for (let i = 0; i < p.length; i++) p[i] = n[i] ? p[i] / n[i] : 0;
      let base = 0;
      let nb = 0;
      for (let i = 0; i < p.length; i++)
        if (n[i]) {
          base += p[i];
          nb++;
        }
      base /= Math.max(1, nb);
      // Outer edges of the finished part.
      let lo = -1;
      let hi = -1;
      for (let i = 0; i < p.length; i++)
        if (n[i] > 0.02 * across) {
          if (lo < 0) lo = i;
          hi = i;
        }
      if (lo < 0 || !base) return null;
      const cF = C * F;
      const sc = new Array(NP).fill(0);
      const ph = new Array(NP).fill(0);
      for (let k = 0; k < NP; k++) {
        const q = P0 + k * DP;
        const per = q * cF;
        for (let o = 0; o < per; o += 0.5) {
          let s = 0;
          let hits = 0;
          for (let x = o; x < p.length - 1; x += per) {
            const i = Math.round(x);
            if (!n[i]) continue;
            s += p[i] + 0.5 * ((p[i - 1] ?? 0) + (p[i + 1] ?? 0));
            hits++;
          }
          // The comb must meet at least 40 % of the seams at this period.
          if (hits < (0.4 * count) / q) continue;
          s /= hits * 2 * base;
          if (s > sc[k]) {
            sc[k] = s;
            ph[k] = o / cF;
          }
        }
      }
      return { lo: lo / cF, hi: (hi + 1) / cF, p0: P0, dp: DP, sc, ph };
    };
    const gx = axis(px, nx, cols, H);
    const gy = axis(py, ny, rows, W);
    return gx && gy ? { x: gx, y: gy } : null;
  }

  PH.board = { registerBoard, toScene, toPlane, fromPlane, fitColor, toGray, seamGrid };
})();
