// Reference picture: find the picture area on the box, rectify it, split it
// into the grid.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;
  const G = 4; // blocks per cell side for the coarse search

  function orderQuad(pts) {
    const s = pts.map(([x, y]) => x + y);
    const d = pts.map(([x, y]) => x - y);
    const tl = pts[s.indexOf(Math.min(...s))];
    const br = pts[s.indexOf(Math.max(...s))];
    const tr = pts[d.indexOf(Math.max(...d))];
    const bl = pts[d.indexOf(Math.min(...d))];
    return [tl, tr, br, bl];
  }

  // Largest quadrilateral with clear edges, otherwise the whole image.
  function findPictureQuad(cv, img) {
    const { width: w, height: h } = img;
    const full = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ];
    const src = cv.matFromImageData(img);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const edges = new cv.Mat();
    cv.Canny(gray, edges, 40, 120);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.dilate(edges, edges, k);
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const cands = [];
    const consider = (approx) => {
      const area = cv.contourArea(approx);
      if (approx.rows !== 4 || area < w * h * 0.2 || area > w * h * 0.98) return;
      const q = [];
      for (let j = 0; j < 4; j++) q.push([approx.data32S[j * 2], approx.data32S[j * 2 + 1]]);
      // Corners at the photo border usually come from table edges or grain.
      const m = Math.min(w, h) * 0.01;
      const atEdge = q.some(([x, y]) => x < m || y < m || x > w - m || y > h - m);
      cands.push({ q, area, atEdge });
    };
    const scan = (bin) => {
      const cs = new cv.MatVector();
      const hh = new cv.Mat();
      cv.findContours(bin, cs, hh, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < cs.size(); i++) {
        const c = cs.get(i);
        const hull = new cv.Mat();
        cv.convexHull(c, hull);
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, cv.arcLength(hull, true) * 0.02, true);
        consider(approx);
        c.delete();
        hull.delete();
        approx.delete();
      }
      cs.delete();
      hh.delete();
    };
    scan(edges);
    // Second way: everything that stands out from the table by colour, as an
    // area.
    const lab = PH.segment.rgbaToLab(img.data, w * h);
    const { dist } = PH.segment.backgroundDistance(lab, w, h);
    const fg = new cv.Mat(h, w, cv.CV_8UC1);
    const fd = fg.data;
    for (let i = 0; i < dist.length; i++) fd[i] = dist[i] > 6 ? 255 : 0;
    const k9 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    cv.morphologyEx(fg, fg, cv.MORPH_OPEN, k9);
    cv.morphologyEx(fg, fg, cv.MORPH_CLOSE, k9);
    const fc = new cv.MatVector();
    const fh = new cv.Mat();
    cv.findContours(fg, fc, fh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < fc.size(); i++) {
      const c = fc.get(i);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, cv.arcLength(c, true) * 0.02, true);
      consider(approx);
      c.delete();
      approx.delete();
    }
    for (const m of [fg, k9, fc, fh]) m.delete();
    cands.sort((a, b) => a.atEdge - b.atEdge || b.area - a.area);
    const best = cands[0]?.q ?? null;
    for (const m of [src, gray, edges, k, contours, hier]) m.delete();
    return best ? innerPicture(cv, img, orderQuad(best)) : full;
  }

  // On a box the largest quadrilateral is the cardboard. If there is a
  // uniform margin inside it (lettering allowed), the picture starts at the
  // first continuous edge behind it.
  function innerPicture(cv, img, quad) {
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const asp = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / (d(quad[0], quad[3]) + d(quad[1], quad[2]));
    const W = 800;
    const H = Math.round(W / asp);
    const r = rectify(cv, img, quad, W, H);
    const g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++)
      g[i] = 0.3 * r.data[i * 4] + 0.59 * r.data[i * 4 + 1] + 0.11 * r.data[i * 4 + 2];
    // Share of strong edges per row (horizontal edges) and column.
    const rowF = new Float32Array(H);
    const colF = new Float32Array(W);
    // Difference over ±3 px: photographed lid pictures are often blurry, the
    // edge then spreads over several pixels.
    for (let y = 3; y < H - 3; y++) {
      for (let x = 3; x < W - 3; x++) {
        const i = y * W + x;
        if (Math.abs(g[i + 3 * W] - g[i - 3 * W]) > 24) rowF[y]++;
        if (Math.abs(g[i + 3] - g[i - 3]) > 24) colF[x]++;
      }
    }
    for (let y = 0; y < H; y++) rowF[y] /= W;
    for (let x = 0; x < W; x++) colF[x] /= H;
    const find = (f, n, fromEnd) => {
      const at = (i) => (fromEnd ? n - 1 - i : i);
      const start = Math.round(n * 0.015);
      let quiet = 0;
      let cnt = 0;
      for (let i = start; i < n * 0.3; i++) {
        const v = Math.max(f[at(i)], f[at(i + 1)] ?? 0);
        if (v > 0.35 && cnt > 3 && quiet / cnt < 0.12) {
          // The edge is at the strongest point of the next rows.
          let best = i;
          for (let k = i + 1; k <= i + 6; k++) if (f[at(k)] > f[at(best)]) best = k;
          return at(best);
        }
        quiet += f[at(i)];
        cnt++;
      }
      return fromEnd ? n : 0;
    };
    const top = find(rowF, H, false);
    const bot = find(rowF, H, true);
    const lef = find(colF, W, false);
    const rig = find(colF, W, true);
    if ((bot - top) * (rig - lef) < W * H * 0.3) return quad;
    const Hm = PH.geom.homography(
      [
        [0, 0],
        [W, 0],
        [W, H],
        [0, H],
      ],
      quad,
    );
    return [
      [lef, top],
      [rig, top],
      [rig, bot],
      [lef, bot],
    ].map(([x, y]) => PH.geom.applyH(Hm, x, y));
  }

  function cellSizeFor(cols, rows) {
    const m = Math.max(cols, rows);
    if (m * 32 <= 2560) return 32;
    if (m * 24 <= 2560) return 24;
    return 16;
  }

  // Rectifies to cols·C × rows·C pixels. Large photos are halved first so
  // that downscaling does not alias.
  function rectify(cv, img, quad, W, H) {
    let src = cv.matFromImageData(img);
    let q = quad;
    const qw = Math.max(
      Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]),
      Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]),
    );
    let f = qw / W;
    while (f > 2) {
      const d = new cv.Mat();
      cv.pyrDown(src, d);
      src.delete();
      src = d;
      q = q.map(([x, y]) => [x / 2, y / 2]);
      f /= 2;
    }
    const sm = cv.matFromArray(4, 1, cv.CV_32FC2, q.flat());
    const dm = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    const M = cv.getPerspectiveTransform(sm, dm);
    const out = new cv.Mat();
    cv.warpPerspective(src, out, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    const data = new Uint8ClampedArray(out.data);
    for (const m of [src, sm, dm, M, out]) m.delete();
    return { data, width: W, height: H };
  }

  // Means over blocks of size b (Lab, 3 channels).
  function blockMeans(lab, w, h, b) {
    const bw = Math.floor(w / b);
    const bh = Math.floor(h / b);
    const out = new Float32Array(bw * bh * 3);
    for (let y = 0; y < bh * b; y++) {
      const by = Math.floor(y / b);
      for (let x = 0; x < bw * b; x++) {
        const o = (by * bw + Math.floor(x / b)) * 3;
        const i = (y * w + x) * 3;
        out[o] += lab[i];
        out[o + 1] += lab[i + 1];
        out[o + 2] += lab[i + 2];
      }
    }
    const inv = 1 / (b * b);
    for (let i = 0; i < out.length; i++) out[i] *= inv;
    return { data: out, w: bw, h: bh };
  }

  function buildReference(cv, img, quad, cols, rows) {
    const C = cellSizeFor(cols, rows);
    const W = cols * C;
    const H = rows * C;
    const rgba = rectify(cv, img, quad, W, H);
    const lab = PH.segment.rgbaToLab(rgba.data, W * H);
    const blocks = blockMeans(lab, W, H, C / G);
    // Width : height of a cell in the reference photo.
    const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const qw = (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2;
    const qh = (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
    const cellAspect = qw / cols / (qh / rows);
    const hw = Math.round(Math.min(1200, qw));
    const hh = Math.round((hw * qh) / qw);
    const hr = rectify(cv, img, quad, hw, hh);
    const gray = new Uint8Array(hw * hh);
    for (let i = 0; i < gray.length; i++)
      gray[i] = Math.round(0.299 * hr.data[i * 4] + 0.587 * hr.data[i * 4 + 1] + 0.114 * hr.data[i * 4 + 2]);
    const hi = { gray, w: hw, h: hh };
    const feat = PH.feature ? PH.feature.describeReference(cv, hi) : [];
    return { cols, rows, C, G, W, H, rgba, lab, blocks, cellAspect, hi, feat };
  }

  PH.reference = { findPictureQuad, buildReference, rectify, blockMeans, cellSizeFor, orderQuad, G };
})();
