// Halbfertiges Puzzle im Foto: per Merkmalspunkten (ORB) auf die Vorlage
// legen, belegte Plätze und die Form der Lücken ablesen.
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

  // Liefert H (Vorlage-Pixel → Foto-Pixel) oder null.
  function homographyToScene(cv, ref, sceneGray, bigMask) {
    const refGray = toGray(cv, ref.rgba.data, ref.W, ref.H);
    const orb = new cv.ORB(5000);
    const kr = new cv.KeyPointVector();
    const ks = new cv.KeyPointVector();
    const dr = new cv.Mat();
    const ds = new cv.Mat();
    const none = new cv.Mat();
    const m = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
    cv.dilate(bigMask, m, k);
    orb.detectAndCompute(refGray, none, kr, dr);
    orb.detectAndCompute(sceneGray, m, ks, ds);
    let H = null;
    let inliers = 0;
    if (dr.rows >= 10 && ds.rows >= 10) {
      const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
      const mm = new cv.DMatchVectorVector();
      bf.knnMatch(dr, ds, mm, 2);
      const a = [];
      const b = [];
      for (let i = 0; i < mm.size(); i++) {
        const pair = mm.get(i);
        if (pair.size() < 2) continue;
        const m0 = pair.get(0);
        const m1 = pair.get(1);
        if (m0.distance < 0.8 * m1.distance) {
          const p = kr.get(m0.queryIdx).pt;
          const q = ks.get(m0.trainIdx).pt;
          a.push(p.x, p.y);
          b.push(q.x, q.y);
        }
      }
      if (a.length >= 24) {
        const am = cv.matFromArray(a.length / 2, 1, cv.CV_32FC2, a);
        const bm = cv.matFromArray(b.length / 2, 1, cv.CV_32FC2, b);
        const inl = new cv.Mat();
        const Hm = cv.findHomography(am, bm, cv.RANSAC, 5, inl);
        for (let i = 0; i < inl.rows; i++) inliers += inl.data[i];
        if (!Hm.empty() && inliers >= 15) H = Array.from(Hm.data64F);
        am.delete();
        bm.delete();
        inl.delete();
        Hm.delete();
      }
      bf.delete();
      mm.delete();
    }
    for (const x of [refGray, orb, kr, ks, dr, ds, none, m, k]) x.delete();
    return H ? { H, inliers } : null;
  }

  function warpToRef(cv, mat, H, ref, interp) {
    const Hm = cv.matFromArray(3, 3, cv.CV_64F, H);
    const out = new cv.Mat();
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

  // Lineare Farbanpassung Foto → Vorlage je Kanal aus belegten Blöcken,
  // nach einer ersten Schätzung ohne die 20 % größten Ausreißer.
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

  // Umrisse des fertigen Bereichs im Foto, so ausgerichtet, dass die freie
  // Tischfläche rechts liegt: Eine Lücke wird dann im Uhrzeigersinn umlaufen,
  // genau wie das Teil, das hineingehört.
  function boardOutlines(cv, bigMask, H, C) {
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
    const corner = (r, c) => PH.geom.applyH(H, c * C, r * C);
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
      // Seite d (oben, rechts, unten, links) der leeren Zelle r/c.
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

  function registerBoard(cv, ref, sceneMat, sceneGray, bigMask) {
    const hit = homographyToScene(cv, ref, sceneGray, bigMask);
    if (!hit) return null;
    const { H } = hit;
    const { C, G, W, cols, rows } = ref;
    const mw = warpToRef(cv, bigMask, H, ref, cv.INTER_NEAREST);
    const mask = new Uint8Array(mw.data);
    mw.delete();

    const filled = [];
    const isFilled = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const f = fraction(mask, W, (c + 0.3) * C, (r + 0.3) * C, (c + 0.7) * C, (r + 0.7) * C, true);
        if (f > 0.75) {
          isFilled[r * cols + c] = 1;
          filled.push(r * cols + c);
        }
      }
    }
    if (filled.length < 2) return null;

    // Lücken: ragt die Nase des Nachbarn herein, braucht das Teil dort ein
    // Loch; fehlt beim Nachbarn ein Stück, braucht es eine Nase.
    const holes = [];
    const outlines = boardOutlines(cv, bigMask, H, C);
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

    // Farbabgleich über die belegten Plätze.
    const sw = warpToRef(cv, sceneMat, H, ref, cv.INTER_LINEAR);
    const lab = PH.segment.rgbaToLab(sw.data, ref.W * ref.H);
    sw.delete();
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
    return { H, inliers: hit.inliers, filled, holes, color: fitColor(pairs) };
  }

  PH.board = { registerBoard, fitColor, toGray };
})();
