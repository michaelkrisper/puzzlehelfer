// Whole-outline fit of a loose piece into a gap of the finished part, on the
// table seen from above (reference pixels). The corners of the same piece on
// two photos differ by about 5 % of a side, as much as plain pieces differ
// from each other; the outline itself is measured far more precisely. The
// piece is laid into the place (rotation and shift searched) and every point
// of the gap's rim must lie on its outline: a knob against a flat rim pushes
// the rim inside the piece, a missing knob leaves it outside.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;
  const STEP = 0.25; // grid of the signed distance, reference pixels
  const TAU = 0.15; // cap of a single rim point's distance, in places

  // 1-D squared distance transform (Felzenszwalb & Huttenlocher); cells
  // without a seed hold FAR.
  const FAR = 1e12;
  function edt1(f, n, d, v, z) {
    const meet = (q, p) => (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let s = meet(q, v[k]);
      while (s <= z[k]) {
        k--;
        s = meet(q, v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  }

  // Euclidean distance (grid cells) to the nearest cell with g = 0.
  function edt(g, w, h) {
    const n = Math.max(w, h);
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = g[y * w + x];
      edt1(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1(f, w, d, v, z);
      for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
    }
    return g;
  }

  // Signed distance to the outline (negative inside) on a grid around the
  // piece centre. plane: outline, corners: core square, both in reference
  // pixels; C: place size. Knob tips reach about 0.8 places from the centre.
  function preparePiece(plane, corners, C) {
    const cx = corners.reduce((a, q) => a + q[0], 0) / 4;
    const cy = corners.reduce((a, q) => a + q[1], 0) / 4;
    let R = 0;
    for (const [x, y] of plane) R = Math.max(R, Math.hypot(x - cx, y - cy));
    R = Math.min(R, 0.9 * C) + TAU * C;
    const n = Math.ceil((2 * R) / STEP) + 1;
    const g = new Float64Array(n * n).fill(FAR);
    const gx = (x) => (x - cx + R) / STEP;
    const gy = (y) => (y - cy + R) / STEP;
    for (const [x, y] of PH.piece.arcResample(plane, STEP * 0.7)) {
      const i = Math.round(gx(x));
      const j = Math.round(gy(y));
      if (i >= 0 && j >= 0 && i < n && j < n) g[j * n + i] = 0;
    }
    edt(g, n, n);
    // Inside by scanlines through the cell centres: each edge adds its
    // crossings to the rows it spans.
    const cross = Array.from({ length: n }, () => []);
    const m = plane.length;
    for (let i = 0; i < m; i++) {
      const [x0, y0] = plane[i];
      const [x1, y1] = plane[(i + 1) % m];
      const j0 = Math.ceil(gy(Math.min(y0, y1)));
      const j1 = Math.floor(gy(Math.max(y0, y1)));
      for (let j = Math.max(0, j0); j <= Math.min(n - 1, j1); j++) {
        const y = cy - R + j * STEP;
        if (y0 > y !== y1 > y) cross[j].push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    for (let j = 0; j < n; j++) {
      const xs = cross[j].sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(gx(xs[k])));
        const b = Math.min(n - 1, Math.floor(gx(xs[k + 1])));
        for (let i = a; i <= b; i++) g[j * n + i] = -g[j * n + i];
      }
    }
    const sdf = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) sdf[i] = g[i] * STEP;
    const rel = corners.map(([x, y]) => [x - cx, y - cy]);
    return { cx, cy, R, n, sdf, corners: rel };
  }

  // Signed distance at a point relative to the piece centre, and its
  // gradient (out[1], out[2]) if out is given.
  function sample(P, x, y, out = null) {
    const u = (x + P.R) / STEP;
    const v = (y + P.R) / STEP;
    if (u < 0 || v < 0 || u >= P.n - 1 || v >= P.n - 1) {
      if (out) out[1] = out[2] = 0;
      return P.R;
    }
    const i = Math.floor(u);
    const j = Math.floor(v);
    const a = u - i;
    const b = v - j;
    const s = P.sdf;
    const n = P.n;
    const s00 = s[j * n + i];
    const s10 = s[j * n + i + 1];
    const s01 = s[(j + 1) * n + i];
    const s11 = s[(j + 1) * n + i + 1];
    if (out) {
      out[1] = ((s10 - s00) * (1 - b) + (s11 - s01) * b) / STEP;
      out[2] = ((s01 - s00) * (1 - a) + (s11 - s10) * a) / STEP;
    }
    return (s00 * (1 - a) + s10 * a) * (1 - b) + (s01 * (1 - a) + s11 * a) * b;
  }

  // Rim points of the gap at place `cell` that a piece there must touch:
  // the rims (per side, from the board) of the sides with a filled
  // neighbour, one point per pixel. Null without any.
  function prepareGap(rims, cell, ref, filledSides) {
    const { cols } = ref;
    const xs = [];
    const ys = [];
    const of = [];
    const sides = [false, false, false, false];
    for (let d = 0; d < 4; d++) {
      const pts = rims[d];
      if (!pts || !filledSides[d]) continue;
      sides[d] = true;
      for (let i = 0; i < pts.length; i += 4) {
        xs.push(pts[i]);
        ys.push(pts[i + 1]);
        of.push(d);
      }
    }
    if (!sides.some(Boolean)) return null;
    // The rims run from corner to corner of the place: where the grid is off
    // locally (a fifth of a place at the far side of a photo), their ends
    // tell where the place really is.
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    const { C } = ref;
    let ox = 0;
    let oy = 0;
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const pts = rims[d];
      if (!pts || !sides[d]) continue;
      for (const i of [0, pts.length - 2]) {
        const x = pts[i];
        const y = pts[i + 1];
        const dx = x - Math.round(x / C) * C;
        const dy = y - Math.round(y / C) * C;
        if (Math.abs(Math.round(x / C) - c - 0.5) > 0.6 || Math.abs(Math.round(y / C) - r - 0.5) > 0.6)
          continue;
        ox += dx;
        oy += dy;
        n++;
      }
    }
    return {
      x: Float64Array.from(xs),
      y: Float64Array.from(ys),
      side: Uint8Array.from(of),
      sides,
      r,
      c,
      ox: n ? ox / n : 0,
      oy: n ? oy / n : 0,
    };
  }

  // Lay piece P into the gap G turned by rot (piece side s faces direction
  // (s + rot) % 4): start from the corners, then turn and shift by
  // Gauss-Newton on the rim points (those within TAU). The corners are often
  // off by a few degrees and the fit then stays in a wrong groove: it starts
  // turned a little either way as well, the best counts. Returns the mean
  // rim distance in places and the pose.
  const TURNS = [0, (-7 * Math.PI) / 180, (7 * Math.PI) / 180];
  function fitPiece(P, G, rot, C) {
    const cx = (G.c + 0.5) * C + (G.ox ?? 0);
    const cy = (G.r + 0.5) * C + (G.oy ?? 0);
    const h = C / 2;
    const cell = [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ];
    let dot = 0;
    let cross = 0;
    for (let i = 0; i < 4; i++) {
      const a = P.corners[i];
      const b = cell[(i + rot) % 4];
      dot += a[0] * b[0] + a[1] * b[1];
      cross += a[0] * b[1] - a[1] * b[0];
    }
    const start = [Math.atan2(cross, dot), cx, cy];
    let best = null;
    for (const t of TURNS) {
      const f = settle(P, G, start, [start[0] + t, cx, cy], C);
      if (!best || f.e < best.e) best = f;
    }
    return G.side ? sideShift(P, G, best, C) : best;
  }

  // Each side of a gap is the edge of another finished piece, and each of
  // them lies a little off (up to about 5 % of a place): after the piece is
  // laid in as a whole, every side may shift on its own by up to SHIFT.
  // Measured on the table: the right piece first at 17 of 21 gaps instead
  // of 13.
  const SHIFT = 0.08;
  function sideShift(P, G, f, C) {
    const { th, tx, ty } = f;
    const co = Math.cos(th);
    const si = Math.sin(th);
    const tau = TAU * C;
    const lim = SHIFT * C;
    const grad = [0, 0, 0];
    const r = new Float32Array(G.x.length);
    const shift = [];
    let sum = 0;
    for (let d = 0; d < 4; d++) {
      if (!G.sides[d]) continue;
      let ox = 0;
      let oy = 0;
      for (let it = 0; it < 6; it++) {
        let a = 1e-6;
        let b = 0;
        let c = 1e-6;
        let u = 0;
        let v = 0;
        for (let i = 0; i < G.x.length; i++) {
          if (G.side[i] !== d) continue;
          const dx = G.x[i] - tx - ox;
          const dy = G.y[i] - ty - oy;
          const q = sample(P, co * dx + si * dy, -si * dx + co * dy, grad);
          if (Math.abs(q) >= tau) continue;
          const jx = -grad[1] * co + grad[2] * si;
          const jy = -grad[1] * si - grad[2] * co;
          a += jx * jx;
          b += jx * jy;
          c += jy * jy;
          u += jx * q;
          v += jy * q;
        }
        const det = a * c - b * b;
        if (det <= 0) break;
        const sx = -(c * u - b * v) / det;
        const sy = -(a * v - b * u) / det;
        ox = Math.max(-lim, Math.min(lim, ox + sx));
        oy = Math.max(-lim, Math.min(lim, oy + sy));
        if (Math.abs(sx) < 0.02 && Math.abs(sy) < 0.02) break;
      }
      shift[d] = [ox, oy];
    }
    for (let i = 0; i < G.x.length; i++) {
      const [ox, oy] = shift[G.side[i]];
      const dx = G.x[i] - tx - ox;
      const dy = G.y[i] - ty - oy;
      const q = Math.max(-tau, Math.min(tau, sample(P, co * dx + si * dy, -si * dx + co * dy)));
      r[i] = q / C;
      sum += Math.abs(q);
    }
    return { e: sum / G.x.length / C, r, th, tx, ty, shift };
  }

  function settle(P, G, start, from, C) {
    const lim = [(16 * Math.PI) / 180, 0.2 * C, 0.2 * C];
    const tau = TAU * C;
    let pose = from;
    const grad = [0, 0, 0];
    for (let it = 0; it < 8; it++) {
      const [th, tx, ty] = pose;
      const co = Math.cos(th);
      const si = Math.sin(th);
      // Normal equations A·δ = −b.
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      const b = [0, 0, 0];
      for (let i = 0; i < G.x.length; i++) {
        const dx = G.x[i] - tx;
        const dy = G.y[i] - ty;
        const px = co * dx + si * dy;
        const py = -si * dx + co * dy;
        const r = sample(P, px, py, grad);
        if (Math.abs(r) >= tau) continue;
        const [, gx, gy] = grad;
        const J = [gx * py - gy * px, -gx * co + gy * si, -gx * si - gy * co];
        for (let p = 0; p < 3; p++) {
          b[p] += J[p] * r;
          for (let q = 0; q < 3; q++) A[p * 3 + q] += J[p] * J[q];
        }
      }
      for (let p = 0; p < 3; p++) A[p * 4] *= 1.01;
      A[0] += 1e-6;
      A[4] += 1e-6;
      A[8] += 1e-6;
      const d = PH.geom.solve(
        [
          [A[0], A[1], A[2]],
          [A[3], A[4], A[5]],
          [A[6], A[7], A[8]],
        ],
        b.map((x) => -x),
      );
      if (!d) break;
      pose = pose.map((v, k) => Math.max(start[k] - lim[k], Math.min(start[k] + lim[k], v + d[k])));
      if (Math.abs(d[0]) < 1e-4 && Math.abs(d[1]) < 0.02 && Math.abs(d[2]) < 0.02) break;
    }
    // Signed distance of each rim point to the outline at the final pose,
    // in places, capped at TAU.
    const [th, tx, ty] = pose;
    const co = Math.cos(th);
    const si = Math.sin(th);
    const r = new Float32Array(G.x.length);
    let sum = 0;
    for (let i = 0; i < G.x.length; i++) {
      const dx = G.x[i] - tx;
      const dy = G.y[i] - ty;
      const d = Math.max(-tau, Math.min(tau, sample(P, co * dx + si * dy, -si * dx + co * dy)));
      r[i] = d / C;
      sum += Math.abs(d);
    }
    return { e: sum / G.x.length / C, r, th, tx, ty };
  }

  // How much better than the other pieces a piece fits a gap, as a log
  // likelihood ratio: per rim point the piece's distance under measurement
  // noise SIGMA against the spread of all pieces there (median distance).
  // Where every piece fits (flat shoulders) a point says little; a knob that
  // only this piece matches says a lot. A single matching side is weak
  // evidence, two or three are strong. Neighbouring points are not
  // independent, and photos disagree by about as much as plain pieces
  // differ: one point in twelve counts. all: residuals (fitPiece r) of every
  // piece at its best turn. Returns a function of one piece's residuals.
  const SIGMA = 0.016; // places, about half a reference pixel
  function evidence(all) {
    const n = all[0]?.length ?? 0;
    const s = new Float64Array(n);
    const col = new Float64Array(all.length);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < all.length; k++) col[k] = Math.abs(all[k][i]);
      col.sort();
      s[i] = Math.max(1.25 * SIGMA, col[col.length >> 1]);
    }
    return (r) => {
      let L = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(r[i]);
        L += Math.max(-3, Math.log((0.8 * s[i]) / SIGMA) + a / s[i] - (a * a) / (2 * SIGMA * SIGMA));
      }
      return L / 12;
    };
  }

  PH.fit = { preparePiece, prepareGap, fitPiece, evidence, sample, edt };
})();
