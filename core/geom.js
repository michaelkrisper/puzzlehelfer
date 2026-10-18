// Geometry without OpenCV: homographies, grid, angles. Runs in the worker
// (importScripts) and in Node (require) alike.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  // Solves A·x = b by Gaussian elimination with column pivoting, A as an
  // array of rows.
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // Homography from 4 point pairs, result row by row as 9 numbers.
  function homography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = solve(A, b);
    return h ? [...h, 1] : null;
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  // Product A·B of two 3×3 matrices (B applied first).
  function mulH(A, B) {
    const out = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        out.push(A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]);
    return out;
  }

  function invertH(H) {
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) return null;
    return [
      A / det,
      -(b * i - c * h) / det,
      (b * f - c * e) / det,
      B / det,
      (a * i - c * g) / det,
      -(a * f - c * d) / det,
      C / det,
      -(a * h - b * g) / det,
      (a * e - b * d) / det,
    ];
  }

  // Columns × rows for a piece count: product close to n, aspect ratio close
  // to the picture. Manufacturers deviate slightly (1000 = 38×27 at
  // 70×50 cm), so the product is only penalised softly.
  function gridFor(n, aspect) {
    let best = null;
    for (let rows = 2; rows <= Math.ceil(Math.sqrt(n * 4)); rows++) {
      for (const cols of [Math.floor(n / rows), Math.ceil(n / rows)]) {
        if (cols < 2) continue;
        const cnt = Math.abs(cols * rows - n) / n;
        const asp = Math.abs(Math.log(cols / rows / aspect));
        const cost = cnt * 4 + asp;
        if (!best || cost < best.cost) best = { cols, rows, cost };
      }
    }
    return { cols: best.cols, rows: best.rows };
  }

  // Angle in degrees to (-180, 180].
  // How badly cols × rows fits the thickness of the finished part per side
  // (share of picture height for top/bottom, width for left/right, see
  // pipeline.js), the piece count n and the picture aspect (width/height).
  // A side that is k pieces thick (k = 1..3) measures k/rows or k/cols, the
  // product should be close to n, and pieces are rarely longer than 1.5:1.
  // About 0.01 fits, above 0.03 does not; null without usable sides.
  function borderCost(n, border, aspect, cols, rows) {
    const hs = [border?.top, border?.bottom].filter((t) => t > 0);
    const vs = [border?.left, border?.right].filter((t) => t > 0);
    const sides = hs.length + vs.length;
    if (!sides) return null;
    const fit = (ts, d) =>
      ts.reduce((e, t) => {
        const k = t * d;
        const kk = Math.max(1, Math.min(3, Math.round(k)));
        return e + ((k - kk) / kk) ** 2;
      }, 0);
    const piece = Math.abs(Math.log((aspect * rows) / cols));
    return (
      (fit(hs, rows) + fit(vs, cols)) / sides +
      2 * ((cols * rows - n) / n) ** 2 +
      5 * Math.max(0, piece - Math.log(1.5)) ** 2
    );
  }

  // The best grid for borderCost, or null if none fits.
  function gridFromBorder(n, border, aspect) {
    let best = null;
    for (let rows = 2; rows <= n / 2; rows++) {
      for (const cols of new Set([Math.floor(n / rows), Math.ceil(n / rows)])) {
        if (cols < 2) continue;
        const cost = borderCost(n, border, aspect, cols, rows);
        if (cost === null) return null;
        if (!best || cost < best.cost) best = { cols, rows, cost };
      }
    }
    return best && best.cost < 0.03 ? best : null;
  }

  function wrapDeg(a) {
    let r = a % 360;
    if (r <= -180) r += 360;
    if (r > 180) r -= 360;
    return r;
  }

  function polygonArea(pts) {
    let s = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    }
    return s / 2;
  }

  PH.geom = {
    solve,
    homography,
    applyH,
    mulH,
    invertH,
    gridFor,
    borderCost,
    gridFromBorder,
    wrapDeg,
    polygonArea,
  };
})();
