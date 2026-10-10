// Geometrie ohne OpenCV: Homographien, Raster, Winkel. Läuft im Worker
// (importScripts) und in Node (require) gleichermaßen.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  // Löst A·x = b per Gauß mit Spaltenpivot, A als Array von Zeilen.
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

  // Homographie aus 4 Punktpaaren, Ergebnis zeilenweise als 9 Zahlen.
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

  // Spalten × Reihen für eine Teilezahl: Produkt nahe n, Seitenverhältnis
  // nahe am Bild. Hersteller weichen leicht ab (1000 = 38×27 bei 70×50 cm),
  // daher wird das Produkt nur weich bestraft.
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

  // Winkel in Grad auf (-180, 180].
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

  PH.geom = { solve, homography, applyH, invertH, gridFor, wrapDeg, polygonArea };
})();
