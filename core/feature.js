// Feature points (SIFT, BRISK): find a piece directly in the reference,
// regardless of its shape. Strong on fur, lettering and faces; plain areas
// have no points, there the image comparison decides.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  // Fewer but stronger points for the reference: matching costs points in
  // the photo times points in the reference.
  const DETECTORS = [
    {
      name: 'SIFT',
      make: (cv, forRef) => new cv.SIFT(forRef ? 8000 : 0, 3, 0.02),
      norm: (cv) => cv.NORM_L2,
    },
    {
      name: 'BRISK',
      make: (cv, forRef) => new cv.BRISK(forRef ? 35 : 20, 3, 1.0),
      norm: (cv) => cv.NORM_HAMMING,
    },
  ];

  // only: detector names (default all), cap: at most this many SIFT points.
  function detect(cv, gray, mask, forRef = false, only = null, cap = 0) {
    const out = [];
    for (const d of DETECTORS) {
      if (typeof cv[d.name] !== 'function' || (only && !only.includes(d.name))) continue;
      const det = cap && d.name === 'SIFT' ? new cv.SIFT(cap, 3, 0.02) : d.make(cv, forRef);
      const kp = new cv.KeyPointVector();
      const desc = new cv.Mat();
      const m = mask ?? new cv.Mat();
      det.detectAndCompute(gray, m, kp, desc);
      const n = kp.size();
      const pts = new Float32Array(n * 2);
      const resp = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const k = kp.get(i);
        pts[i * 2] = k.pt.x;
        pts[i * 2 + 1] = k.pt.y;
        resp[i] = k.response;
      }
      out.push({ name: d.name, norm: d.norm(cv), pts, resp, desc });
      if (!mask) m.delete();
      kp.delete();
      det.delete();
    }
    return out;
  }

  // Reference features: grey image in the true aspect ratio (ref.hi).
  function describeReference(cv, hi) {
    const g = new cv.Mat(hi.h, hi.w, cv.CV_8UC1);
    g.data.set(hi.gray);
    const sets = detect(cv, g, null, true);
    g.delete();
    // Descriptors as typed arrays: Mats do not survive being passed around.
    return sets.map((s) => {
      const r = {
        name: s.name,
        norm: s.norm,
        pts: s.pts,
        rows: s.desc.rows,
        cols: s.desc.cols,
        type: s.desc.type(),
        data: s.desc.type() === cv.CV_32F ? Float32Array.from(s.desc.data32F) : Uint8Array.from(s.desc.data),
      };
      s.desc.delete();
      return r;
    });
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Similarity transform a → b (rotation, scale, shift) by RANSAC over point
  // pairs. scale: allowed range [lo, hi].
  function ransacSimilarity(a, b, tol, scale, iters = 1500) {
    const n = a.length;
    if (n < 3) return null;
    let best = null;
    let bestN = 0;
    // Fixed random sequence: same input, same result.
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let it = 0; it < iters; it++) {
      const i = Math.floor(rnd() * n);
      const j = Math.floor(rnd() * n);
      if (i === j) continue;
      const dax = a[j][0] - a[i][0];
      const day = a[j][1] - a[i][1];
      const la = dax * dax + day * day;
      if (la < 25) continue;
      const dbx = b[j][0] - b[i][0];
      const dby = b[j][1] - b[i][1];
      const c = (dbx * dax + dby * day) / la;
      const s = (dby * dax - dbx * day) / la;
      const sc = Math.hypot(c, s);
      if (sc < scale[0] || sc > scale[1]) continue;
      const tx = b[i][0] - (c * a[i][0] - s * a[i][1]);
      const ty = b[i][1] - (s * a[i][0] + c * a[i][1]);
      let cnt = 0;
      for (let k = 0; k < n; k++) {
        const x = c * a[k][0] - s * a[k][1] + tx - b[k][0];
        const y = s * a[k][0] + c * a[k][1] + ty - b[k][1];
        if (x * x + y * y < tol * tol) cnt++;
      }
      if (cnt > bestN) {
        bestN = cnt;
        best = { c, s, tx, ty };
      }
    }
    if (!best) return null;
    return {
      ...best,
      inliers: bestN,
      scale: Math.hypot(best.c, best.s),
      angle: (Math.atan2(best.s, best.c) * 180) / Math.PI,
    };
  }

  // All feature points of a photo, detected once and shared by the finished
  // part, the loose pieces and the groups. Each point is matched against the
  // reference only when someone asks for it, and only once.
  function sceneFeatures(cv, gray, mask) {
    const sets = detect(cv, gray, mask).map((s) => ({
      ...s,
      best: new Int32Array(s.pts.length / 2).fill(-2),
    }));
    return {
      sets,
      delete() {
        for (const s of sets) s.desc.delete();
      },
    };
  }

  // Nearest reference point for the points idx of set s (ratio test), stored
  // in s.best: index in the reference or -1.
  function matchPoints(cv, ref, s, idx) {
    const r = ref.feat?.find((f) => f.name === s.name);
    const todo = idx.filter((i) => s.best[i] === -2);
    if (!todo.length) return;
    if (!r?.rows) {
      for (const i of todo) s.best[i] = -1;
      return;
    }
    const hamming = s.norm === cv.NORM_HAMMING;
    // BRISK: 64 bytes; SIFT: 128 floats that are integers 0..255, as bytes.
    const bytes = s.desc.cols;
    if (PH.knn?.available() && bytes % 16 === 0 && bytes <= 256) {
      r.u8 ??= hamming ? r.data : Uint8Array.from(r.data);
      const src = hamming ? s.desc.data : s.desc.data32F;
      const q = new Uint8Array(todo.length * bytes);
      todo.forEach((i, k) => {
        q.set(src.subarray(i * bytes, (i + 1) * bytes), k * bytes);
      });
      const res = PH.knn.knn2(hamming ? 'hamming' : 'l2', q, todo.length, r.u8, r.rows, bytes);
      // Ratio test 0.8 on the distance, for L2 on its square.
      const ratio = hamming ? 0.8 : 0.64;
      todo.forEach((i, k) => {
        const d2 = res[k * 3 + 2];
        s.best[i] = d2 !== 0xffffffff && res[k * 3 + 1] < ratio * d2 ? res[k * 3] : -1;
      });
      return;
    }
    const q = new cv.Mat(todo.length, s.desc.cols, s.desc.type());
    // Views into WASM memory only after the last allocation.
    const row = s.desc.data.length / s.desc.rows;
    const src = s.desc.data;
    const dst = q.data;
    todo.forEach((i, k) => {
      dst.set(src.subarray(i * row, (i + 1) * row), k * row);
    });
    const rd = cv.matFromArray(r.rows, r.cols, r.type, r.data);
    const bf = new cv.BFMatcher(s.norm, false);
    const mm = new cv.DMatchVectorVector();
    bf.knnMatch(q, rd, mm, 2);
    for (const i of todo) s.best[i] = -1;
    for (let k = 0; k < mm.size(); k++) {
      const pr = mm.get(k);
      if (pr.size() < 2) continue;
      const m0 = pr.get(0);
      if (m0.distance < 0.8 * pr.get(1).distance) s.best[todo[m0.queryIdx]] = m0.trainIdx;
    }
    for (const m of [q, rd, bf, mm]) m.delete();
  }

  // For every piece (outline in the photo) its position in the reference, if
  // feature points show it clearly. Result per piece null or
  // {cell, rot, inliers, angle, at, toRef}. shapes[i]: corners and angle of
  // the piece, or null (then no grid rotation, only place and angle).
  // sf: sceneFeatures of the photo.
  function locatePieces(cv, ref, sf, contours, shapes) {
    if (!ref.feat?.length) return contours.map(() => null);
    const bbox = contours.map((c) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of c) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      return [x0 - 3, y0 - 3, x1 + 3, y1 + 3];
    });
    // Point pairs per piece, collected over both detectors.
    const pairs = contours.map(() => ({ a: [], b: [] }));
    for (const s of sf.sets) {
      const r = ref.feat.find((f) => f.name === s.name);
      const n = s.pts.length / 2;
      if (!r?.rows || !n) continue;
      const owner = new Int32Array(n).fill(-1);
      const idx = [];
      for (let i = 0; i < n; i++) {
        const x = s.pts[i * 2];
        const y = s.pts[i * 2 + 1];
        for (let p = 0; p < contours.length; p++) {
          const b = bbox[p];
          if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) continue;
          if (pointInPoly(x, y, contours[p])) {
            owner[i] = p;
            idx.push(i);
            break;
          }
        }
      }
      matchPoints(cv, ref, s, idx);
      for (const i of idx) {
        const j = s.best[i];
        if (j < 0) continue;
        pairs[owner[i]].a.push([s.pts[i * 2], s.pts[i * 2 + 1]]);
        pairs[owner[i]].b.push([r.pts[j * 2], r.pts[j * 2 + 1]]);
      }
    }
    const { hi, W, H, C, cols, rows } = ref;
    const tol = Math.max(3, (hi.w / cols) * 0.06);
    // First unconstrained, then with the scale the confident pieces share.
    let fits = pairs.map((p) => ransacSimilarity(p.a, p.b, tol, [0.25, 4]));
    const scales = fits.filter((f) => f && f.inliers >= 8).map((f) => f.scale);
    if (scales.length >= 3) {
      scales.sort((x, y) => x - y);
      const m = scales[Math.floor(scales.length / 2)];
      fits = pairs.map((p) => ransacSimilarity(p.a, p.b, tol, [m * 0.8, m * 1.25]));
    }
    return fits.map((f, i) => {
      if (!f || f.inliers < 4) return null;
      const sh = shapes[i];
      let cx;
      let cy;
      if (sh) [cx, cy] = sh.center;
      else {
        cx = (bbox[i][0] + bbox[i][2]) / 2;
        cy = (bbox[i][1] + bbox[i][3]) / 2;
      }
      const hx = f.c * cx - f.s * cy + f.tx;
      const hy = f.s * cx + f.c * cy + f.ty;
      const u = (hx * W) / hi.w;
      const v = (hy * H) / hi.h;
      const col = Math.floor(u / C);
      const row = Math.floor(v / C);
      if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
      const rot = sh ? ((Math.round((sh.angle + f.angle) / 90) % 4) + 4) % 4 : null;
      // Photo → grid reference (via the high-resolution reference).
      const toRef = (x, y) => [
        ((f.c * x - f.s * y + f.tx) * W) / hi.w,
        ((f.s * x + f.c * y + f.ty) * H) / hi.h,
      ];
      return { cell: row * cols + col, rot, inliers: f.inliers, angle: f.angle, at: [u, v], toRef };
    });
  }

  // Point pairs reference (ref.hi coordinates) ↔ photo inside a mask, after
  // the ratio test. For large areas (finished part) the strongest points per
  // detector are enough; BRISK adds pairs where SIFT alone leaves the fit
  // shaky.
  function matchToReference(cv, ref, sf, mask, caps = { SIFT: 5000, BRISK: 3000 }) {
    const pairs = [];
    const md = mask.data;
    const w = mask.cols;
    for (const s of sf.sets) {
      const r = ref.feat?.find((f) => f.name === s.name);
      const cap = caps[s.name] ?? 0;
      if (!r?.rows || !cap) continue;
      const idx = [];
      for (let i = 0; i < s.pts.length / 2; i++) {
        const x = Math.round(s.pts[i * 2]);
        const y = Math.round(s.pts[i * 2 + 1]);
        if (x >= 0 && y >= 0 && x < w && y < mask.rows && md[y * w + x]) idx.push(i);
      }
      idx.sort((a, b) => s.resp[b] - s.resp[a]);
      idx.length = Math.min(idx.length, cap);
      matchPoints(cv, ref, s, idx);
      for (const i of idx) {
        const j = s.best[i];
        if (j >= 0)
          pairs.push([
            [r.pts[j * 2], r.pts[j * 2 + 1]],
            [s.pts[i * 2], s.pts[i * 2 + 1]],
          ]);
      }
    }
    return pairs;
  }

  PH.feature = {
    describeReference,
    sceneFeatures,
    locatePieces,
    matchToReference,
    ransacSimilarity,
    pointInPoly,
  };
})();
