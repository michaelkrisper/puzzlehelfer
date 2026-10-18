// Separate pieces from the table. The table fills the image border; it gives a
// colour model (several colour clusters, e.g. wood grain); everything that
// differs clearly is puzzle.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  // sRGB → CIELab (L 0…100, a/b about -100…100), D65.
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function rgbaToLab(data, n) {
    const lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = LIN[data[i * 4]];
      const g = LIN[data[i * 4 + 1]];
      const b = LIN[data[i * 4 + 2]];
      const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
      const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
      lab[i * 3] = 116 * fy - 16;
      lab[i * 3 + 1] = 500 * (fx - fy);
      lab[i * 3 + 2] = 200 * (fy - fz);
    }
    return lab;
  }

  function kmeans(samples, k, iters) {
    const n = samples.length / 3;
    const cent = [];
    for (let j = 0; j < k; j++) {
      const i = Math.floor(((j + 0.5) * n) / k);
      cent.push([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]]);
    }
    const lab = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      const sum = cent.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        let best = 0;
        let bd = Infinity;
        for (let j = 0; j < k; j++) {
          const d =
            (samples[i * 3] - cent[j][0]) ** 2 +
            (samples[i * 3 + 1] - cent[j][1]) ** 2 +
            (samples[i * 3 + 2] - cent[j][2]) ** 2;
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
        lab[i] = best;
        const s = sum[best];
        s[0] += samples[i * 3];
        s[1] += samples[i * 3 + 1];
        s[2] += samples[i * 3 + 2];
        s[3]++;
      }
      for (let j = 0; j < k; j++)
        if (sum[j][3]) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
    }
    return cent.map((c, j) => {
      const v = [0, 0, 0];
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        if (lab[i] !== j) continue;
        cnt++;
        for (let ch = 0; ch < 3; ch++) v[ch] += (samples[i * 3 + ch] - c[ch]) ** 2;
      }
      return { mean: c, std: v.map((x) => Math.sqrt(x / Math.max(1, cnt))), weight: cnt / n };
    });
  }

  function otsu(vals, maxV, bins) {
    const hist = new Float64Array(bins);
    for (const v of vals) hist[Math.min(bins - 1, Math.floor((v / maxV) * bins))]++;
    const total = vals.length;
    let sumAll = 0;
    for (let i = 0; i < bins; i++) sumAll += i * hist[i];
    let wB = 0;
    let sumB = 0;
    let best = 0;
    let bestVar = -1;
    for (let i = 0; i < bins; i++) {
      wB += hist[i];
      if (!wB || wB === total) continue;
      sumB += i * hist[i];
      const mB = sumB / wB;
      const mF = (sumAll - sumB) / (total - wB);
      const v = wB * (total - wB) * (mB - mF) ** 2;
      if (v > bestVar) {
        bestVar = v;
        best = i;
      }
    }
    return ((best + 1) / bins) * maxV;
  }

  // Distance of every pixel to the table colours (model of
  // backgroundDistance), in standard deviations.
  function tableDistance(lab, n, model) {
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const m of model) {
        const dl = (lab[i * 3] - m.mean[0]) * m.inv[0];
        const da = (lab[i * 3 + 1] - m.mean[1]) * m.inv[1];
        const db = (lab[i * 3 + 2] - m.mean[2]) * m.inv[2];
        const d = dl * dl + da * da + db * db;
        if (d < best) best = d;
      }
      dist[i] = Math.sqrt(best);
    }
    return dist;
  }

  // Distance of every pixel to the table model, in standard deviations.
  // Lightness counts half so that cast shadows of pieces do not count as
  // pieces.
  function backgroundDistance(lab, w, h, sd = null) {
    const band = Math.max(4, Math.round(Math.min(w, h) * 0.04));
    const s = [];
    const ss = [];
    const px = [];
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        const i = (y * w + x) * 3;
        s.push(lab[i], lab[i + 1], lab[i + 2]);
        px.push(y * w + x);
        if (sd) ss.push(sd[y * w + x]);
      }
    }
    // The most frequent border colour is the table; further colours only with
    // the same hue (grain, light falloff across the image: any brighter).
    // Clearly darker colours only if they make up a large part of the border
    // (darker planks); rare dark colours are rather brown pieces at the image
    // border.
    const all = kmeans(Float32Array.from(s), 6, 10).sort((a, b) => b.weight - a.weight);
    // Table or mat is plain, a finished puzzle at the image border (close-up)
    // has seams and print: the base colour is the frequent and smooth one
    // (local spread 1–6 on tables and mats, 9–19 on puzzle areas), not simply
    // the most frequent.
    if (sd) {
      const acc = all.map(() => [0, 0]);
      for (let i = 0; i < ss.length; i++) {
        let best = 0;
        let bd = Infinity;
        for (let j = 0; j < all.length; j++) {
          const m = all[j].mean;
          const d = (s[i * 3] - m[0]) ** 2 + (s[i * 3 + 1] - m[1]) ** 2 + (s[i * 3 + 2] - m[2]) ** 2;
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
        acc[best][0]++;
        acc[best][1] += ss[i];
      }
      for (let j = 0; j < all.length; j++) all[j].spread = acc[j][1] / Math.max(1, acc[j][0]);
      const score = (c) => c.weight / (1 + (c.spread / 5) ** 2);
      // A table often comes in several shades of one hue (mat and sorting
      // trays, light falloff): they count together against a plain puzzle
      // area at the border, e.g. sky in the last plain pieces (cream sky
      // 0.46 of the border against mat and trays 0.18 + 0.16 + 0.12).
      const kin = (a, b) =>
        Math.hypot(a.mean[1] - b.mean[1], a.mean[2] - b.mean[2]) < 6 &&
        Math.abs(a.mean[0] - b.mean[0]) <= 30 &&
        b.spread < 10;
      const family = (c) => all.reduce((t, o) => t + (o === c || kin(c, o) ? score(o) : 0), 0);
      let base = 0;
      for (let j = 1; j < all.length; j++) {
        const d = family(all[j]) - family(all[base]);
        if (d > 1e-9 || (d > -1e-9 && score(all[j]) > score(all[base]))) base = j;
      }
      all.unshift(...all.splice(base, 1));
    }
    const sameHue = (c) => Math.hypot(c.mean[1] - all[0].mean[1], c.mean[2] - all[0].mean[2]) < 6;
    // With the spread known, a further colour far off in lightness must be
    // plain too: on a black mat, white puzzle areas would otherwise pass as
    // brighter table (unevenly lit mat and wood grain stay).
    // Clearly brighter colours must be as plain as the table itself: the
    // sheen on leather trays is, cream pieces in its light are not (spread
    // 10.3 and 18.6 against 7.9).
    const plain = (c) =>
      c.spread === undefined ||
      c.spread < 7 ||
      (Math.abs(c.mean[0] - all[0].mean[0]) <= 30 &&
        (c.mean[0] - all[0].mean[0] <= 12 || c.spread <= 1.2 * all[0].spread));
    const clusters = all.filter(
      (c, i) =>
        i === 0 ||
        (c.weight > 0.05 && sameHue(c) && plain(c) && (c.mean[0] - all[0].mean[0] > -12 || c.weight >= 0.15)),
    );
    const model = clusters.map((c) => ({
      mean: c.mean,
      // Spread limited both ways: a too wide cluster would otherwise let
      // pieces pass as table.
      inv: [
        1 / (2 * Math.min(8, Math.max(3, c.std[0]))),
        1 / Math.min(6, Math.max(2.5, c.std[1])),
        1 / Math.min(6, Math.max(2.5, c.std[2])),
      ],
    }));
    const n = w * h;
    const dist = tableDistance(lab, n, model);
    // Second distance for the dark rims of the pieces: darker than the table,
    // compared with the table colour in shadow, whose chroma falls with the
    // lightness. Only used right at the outline (brown fur has the same hue).
    const shade = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let bestS = Infinity;
      for (const m of model) {
        const dl = (lab[i * 3] - m.mean[0]) * m.inv[0];
        const f = dl < 0 ? Math.max(0, lab[i * 3] / m.mean[0]) : 1;
        const ds =
          dl * dl +
          ((lab[i * 3 + 1] - f * m.mean[1]) * m.inv[1]) ** 2 +
          ((lab[i * 3 + 2] - f * m.mean[2]) * m.inv[2]) ** 2;
        if (ds < bestS) bestS = ds;
      }
      shade[i] = Math.sqrt(bestS);
    }
    // Noise of the table itself: distances of the border samples whose
    // colour belongs to a table cluster (the border may show a finished
    // puzzle in a close-up, whose distances say nothing about the table).
    const tableSet = new Set(clusters);
    const nd = [];
    for (let i = 0; i < px.length; i++) {
      let best = null;
      let bd = Infinity;
      for (const c of all) {
        const d =
          (s[i * 3] - c.mean[0]) ** 2 + (s[i * 3 + 1] - c.mean[1]) ** 2 + (s[i * 3 + 2] - c.mean[2]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (tableSet.has(best)) nd.push(dist[px[i]]);
    }
    nd.sort((a, b) => a - b);
    const noise = nd.length ? nd[Math.floor(nd.length / 2)] : null;
    return { dist, shade, model, noise };
  }

  // Local spread of lightness (7×7): cardboard edges, fur and lettering have a
  // lot of it, wood and soft shadows little.
  function localStd(cv, img) {
    const rgba = cv.matFromImageData(img);
    const g = new cv.Mat();
    cv.cvtColor(rgba, g, cv.COLOR_RGBA2GRAY);
    rgba.delete();
    g.convertTo(g, cv.CV_32F);
    cv.GaussianBlur(g, g, new cv.Size(3, 3), 0.8);
    const g2 = new cv.Mat();
    cv.multiply(g, g, g2);
    const ksz = new cv.Size(7, 7);
    cv.boxFilter(g, g, -1, ksz);
    cv.boxFilter(g2, g2, -1, ksz);
    const mean = Float32Array.from(g.data32F);
    const sq = Float32Array.from(g2.data32F);
    g.delete();
    g2.delete();
    const sd = new Float32Array(mean.length);
    for (let i = 0; i < sd.length; i++) sd[i] = Math.sqrt(Math.max(0, sq[i] - mean[i] * mean[i]));
    return sd;
  }

  // Value at the table border (quantile q), e.g. for noise and grain.
  function borderQuantile(arr, w, h, q) {
    const band = [];
    const bw = Math.max(4, Math.round(Math.min(w, h) * 0.04));
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2)
        if (x < bw || x >= w - bw || y < bw || y >= h - bw) band.push(arr[y * w + x]);
    band.sort((a, b) => a - b);
    return band[Math.floor(band.length * q)] ?? 0;
  }

  // Typical piece area: a size that occurs often and adds up to a lot of area
  // (area × number of similar-sized blobs). Crumbs (grain) are small, a
  // finished puzzle area is single; the loose pieces are many and alike.
  function typicalArea(areas) {
    let best = 0;
    let bestScore = 0;
    const count = (a) => areas.filter((b) => b > a / 1.5 && b < a * 1.5).length;
    // A single large blob (finished border including its inner area) is never
    // the typical size as long as there are several of equal size.
    const minN = areas.some((a) => count(a) >= 3) ? 3 : 1;
    for (const a of areas) {
      let sc = 0;
      let n = 0;
      for (const b of areas) {
        if (b > a / 1.5 && b < a * 1.5) {
          sc += b;
          n++;
        }
      }
      if (n < minN) continue;
      sc *= n;
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    const near = areas.filter((b) => b > best / 1.5 && b < best * 1.5).sort((x, y) => x - y);
    return near.length ? near[Math.floor(near.length / 2)] : 0;
  }

  function contourPoints(c) {
    const pts = [];
    for (let i = 0; i < c.data32S.length; i += 2) pts.push([c.data32S[i], c.data32S[i + 1]]);
    return pts;
  }

  // Sharpen a piece outline with GrabCut: colour models from the piece itself
  // and its immediate surroundings instead of the whole table. Closes
  // table-coloured spots in the motif that would otherwise end up as notches
  // in the outline.
  function refinePiece(cv, rgb, contour, bbox, side) {
    const W = rgb.cols;
    const H = rgb.rows;
    const pad = Math.max(6, Math.round(side * 0.3));
    const x0 = Math.max(0, bbox[0] - pad);
    const y0 = Math.max(0, bbox[1] - pad);
    const x1 = Math.min(W, bbox[0] + bbox[2] + pad);
    const y1 = Math.min(H, bbox[1] + bbox[3] + pad);
    const rect = new cv.Rect(x0, y0, x1 - x0, y1 - y0);
    const roi = rgb.roi(rect);
    const blob = cv.Mat.zeros(rect.height, rect.width, cv.CV_8UC1);
    const flat = [];
    for (const [x, y] of contour) flat.push(x - x0, y - y0);
    const poly = cv.matFromArray(contour.length, 1, cv.CV_32SC2, flat);
    const pv = new cv.MatVector();
    pv.push_back(poly);
    cv.drawContours(blob, pv, 0, new cv.Scalar(255), -1);
    const r = Math.max(2, Math.round(side * 0.1));
    const ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1));
    const dil = new cv.Mat();
    const ero = new cv.Mat();
    cv.dilate(blob, dil, ker);
    cv.erode(blob, ero, ker);
    const gm = new cv.Mat(rect.height, rect.width, cv.CV_8UC1);
    const g = gm.data;
    const ed = ero.data;
    const bd = blob.data;
    const dd = dil.data;
    for (let i = 0; i < g.length; i++) {
      g[i] = ed[i] ? cv.GC_FGD : bd[i] ? cv.GC_PR_FGD : dd[i] ? cv.GC_PR_BGD : cv.GC_BGD;
    }
    const bgd = new cv.Mat();
    const fgd = new cv.Mat();
    let out = null;
    try {
      cv.grabCut(roi, gm, rect, bgd, fgd, 3, cv.GC_INIT_WITH_MASK);
      const g = gm.data;
      for (let i = 0; i < g.length; i++) g[i] = g[i] === cv.GC_FGD || g[i] === cv.GC_PR_FGD ? 255 : 0;
      const k3 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
      cv.morphologyEx(gm, gm, cv.MORPH_OPEN, k3);
      k3.delete();
      const cs = new cv.MatVector();
      const hh = new cv.Mat();
      cv.findContours(gm, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      let best = -1;
      let bestA = 0;
      for (let i = 0; i < cs.size(); i++) {
        const c = cs.get(i);
        const a = cv.contourArea(c);
        if (a > bestA) {
          bestA = a;
          best = i;
        }
        c.delete();
      }
      if (best >= 0) {
        const c = cs.get(best);
        out = { contour: contourPoints(c).map(([x, y]) => [x + x0, y + y0]), area: bestA };
        c.delete();
      }
      cs.delete();
      hh.delete();
    } catch (err) {
      console.warn('grabCut', err);
    }
    for (const m of [roi, blob, poly, pv, ker, dil, ero, gm, bgd, fgd]) m.delete();
    return out;
  }

  // Brown pieces on wood: colour alone hardly separates fur from grain, but the
  // cardboard edge draws a closed outline with a lot of structure, wood and
  // soft shadows have little. Strong structure near pieces already found
  // counts as well (also weak ones without a clear core: weak), a piece is
  // filled within its outline, thin edge remnants vanish when opening.
  function addOutlines(cv, img, raw, weak, sd) {
    const { width: w, height: h } = img;
    const n = w * h;
    // Threshold from the table border: grain and noise stay below it.
    const T = Math.max(18, 2 * (borderQuantile(sd, w, h, 0.9) || 9));

    // Blob by blob, so that plank joints and grain between two pieces do not
    // build a bridge: edge pixels only count if they are closer to this blob
    // than to any other. Large blobs (finished part) stay as they are.
    const components = (m) => {
      const labels = new cv.Mat();
      const stats = new cv.Mat();
      const cents = new cv.Mat();
      const nl = cv.connectedComponentsWithStats(m, labels, stats, cents, 8, cv.CV_32S);
      const r = { nl, st: Int32Array.from(stats.data32S), lab: Int32Array.from(labels.data32S) };
      labels.delete();
      stats.delete();
      cents.delete();
      return r;
    };
    const base = components(weak);
    const areas = [];
    for (let k = 1; k < base.nl; k++) if (base.st[k * 5 + 4] > n * 0.00004) areas.push(base.st[k * 5 + 4]);
    const pieceArea = typicalArea(areas);
    if (!pieceArea) return;
    // Fragments (clearly smaller than a piece, e.g. a fur piece that fell
    // apart) form a group with neighbours a few pixels away. Whole pieces stay
    // separate even when they lie close together.
    const grouped = cv.Mat.zeros(h, w, cv.CV_8UC1);
    const gd = grouped.data;
    for (let i = 0; i < n; i++) {
      const l = base.lab[i];
      if (l && base.st[l * 5 + 4] < pieceArea * 0.6) gd[i] = 255;
    }
    const kg = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.dilate(grouped, grouped, kg);
    kg.delete();
    cv.bitwise_or(grouped, weak, grouped);
    const grp = components(grouped);
    grouped.delete();
    const st = grp.st;
    const lab = grp.lab;
    const nl = grp.nl;
    // Use memory views only fresh (see segmentScene): from here on work with
    // JS copies and write raw back at the end.
    const wd = Uint8Array.from(weak.data);
    // How many blobs per group: only join fragments there.
    const groupOf = new Int32Array(base.nl).fill(-1);
    const parts = new Int32Array(nl);
    for (let i = 0; i < n; i++) {
      const l = base.lab[i];
      if (l && groupOf[l] < 0) {
        groupOf[l] = lab[i];
        parts[lab[i]]++;
      }
    }
    const R = Math.max(4, Math.round(Math.sqrt(pieceArea) * 0.15));
    const rd = Uint8Array.from(raw.data);
    for (let k = 1; k < nl; k++) {
      const area = st[k * 5 + 4];
      if (area < pieceArea * 0.1 || area > pieceArea * 2.4) continue;
      const x0 = Math.max(0, st[k * 5] - R);
      const y0 = Math.max(0, st[k * 5 + 1] - R);
      const x1 = Math.min(w, st[k * 5] + st[k * 5 + 2] + R);
      const y1 = Math.min(h, st[k * 5 + 1] + st[k * 5 + 3] + R);
      const rw = x1 - x0;
      const rh = y1 - y0;
      const od = new Uint8Array(rw * rh);
      const ot = new Uint8Array(rw * rh);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const j = (y + y0) * w + x + x0;
          if (!wd[j]) continue;
          if (lab[j] === k) od[y * rw + x] = 255;
          else if (lab[j]) ot[y * rw + x] = 255;
        }
      }
      const own = cv.matFromArray(rh, rw, cv.CV_8UC1, od);
      const other = cv.matFromArray(rh, rw, cv.CV_8UC1, ot);
      const kn = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * R + 1, 2 * R + 1));
      const near = new cv.Mat();
      cv.dilate(own, near, kn);
      const kh = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(R + 1, R + 1));
      cv.dilate(other, other, kh);
      const nd = Uint8Array.from(near.data);
      const oh = Uint8Array.from(other.data);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const i = y * rw + x;
          if (nd[i] && !oh[i] && sd[(y + y0) * w + x + x0] > T) od[i] = 255;
        }
      }
      own.data.set(od);
      // Fill the blob within its outline: close fragments, largest outer
      // outline. No closing for a single blob, that would seal narrow hole
      // necks.
      if (parts[k] > 1) {
        const kc = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
        cv.morphologyEx(own, own, cv.MORPH_CLOSE, kc);
        kc.delete();
      }
      const cs = new cv.MatVector();
      const hh = new cv.Mat();
      cv.findContours(own, cs, hh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = -1;
      let bestA = 0;
      for (let i = 0; i < cs.size(); i++) {
        const c = cs.get(i);
        const a = cv.contourArea(c);
        if (a > bestA) {
          bestA = a;
          best = i;
        }
        c.delete();
      }
      const fill = cv.Mat.zeros(rh, rw, cv.CV_8UC1);
      if (best >= 0 && bestA < pieceArea * 2.4) cv.drawContours(fill, cs, best, new cv.Scalar(255), -1);
      const ko = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
      cv.morphologyEx(fill, fill, cv.MORPH_OPEN, ko);
      const fd = Uint8Array.from(fill.data);
      for (let y = 0; y < rh; y++)
        for (let x = 0; x < rw; x++) if (fd[y * rw + x]) rd[(y + y0) * w + x + x0] = 255;
      for (const m of [own, other, kn, near, kh, cs, hh, fill, ko]) m.delete();
    }
    raw.data.set(rd);
  }

  // Pieces lying against each other touch only at narrow spots. Each piece
  // body is a maximum of the distance to the blob edge (knobs are too thin
  // for one); from these markers the blob is flooded from high to low
  // distance, so the borders fall on the narrow contacts. Result: outlines
  // of the parts, or null if the blob holds only one body.
  function splitBlob(cv, contour, pieceArea) {
    const side = Math.sqrt(pieceArea);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of contour) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    x0 -= 3;
    y0 -= 3;
    const w = x1 - x0 + 4;
    const h = y1 - y0 + 4;
    const mask = cv.Mat.zeros(h, w, cv.CV_8UC1);
    drawPoly(
      cv,
      mask,
      contour.map(([x, y]) => [x - x0, y - y0]),
    );
    const dist = new cv.Mat();
    cv.distanceTransform(mask, dist, cv.DIST_L2, 5);
    // Maxima: no higher distance within 0.3 piece sides, at least 0.22 deep.
    const r = Math.max(2, Math.round(0.3 * side));
    const ker = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1));
    const dil = new cv.Mat();
    cv.dilate(dist, dil, ker);
    const peaks = cv.Mat.zeros(h, w, cv.CV_8UC1);
    const lab = new cv.Mat();
    const D = Float32Array.from(dist.data32F);
    const inside = Uint8Array.from(mask.data);
    const dl = dil.data32F;
    const pd = peaks.data;
    for (let i = 0; i < D.length; i++) if (D[i] >= 0.22 * side && D[i] >= dl[i] - 0.01) pd[i] = 255;
    const n = cv.connectedComponents(peaks, lab, 8, cv.CV_32S) - 1;
    const L = Int32Array.from(lab.data32S);
    for (const m of [mask, dist, ker, dil, peaks, lab]) m.delete();
    if (n < 2) return null;
    // Each pixel, by decreasing distance, joins its deepest labelled
    // neighbour; pixels without one wait for the next sweep.
    let todo = [];
    for (let i = 0; i < D.length; i++) if (inside[i] && !L[i]) todo.push(i);
    todo.sort((a, b) => D[b] - D[a]);
    for (let pass = 0; pass < 50 && todo.length; pass++) {
      const next = [];
      for (const i of todo) {
        const x = i % w;
        let best = 0;
        let bd = -1;
        for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) {
          if (j < 0 || j >= L.length || Math.abs((j % w) - x) > 1) continue;
          if (L[j] > 0 && D[j] > bd) {
            bd = D[j];
            best = L[j];
          }
        }
        if (best) L[i] = best;
        else next.push(i);
      }
      todo = next;
    }
    // A piece with two opposite holes has a waist and two maxima: parts below
    // 0.7 piece areas join the neighbour they share the longest border with
    // (two halves of a piece share the waist, two pieces only a contact).
    const area = new Float64Array(n + 1);
    for (let i = 0; i < L.length; i++) area[L[i]]++;
    for (;;) {
      let k = 0;
      for (let j = 1; j <= n; j++)
        if (area[j] > 0 && area[j] < 0.7 * pieceArea && (!k || area[j] < area[k])) k = j;
      if (!k) break;
      const shared = new Map();
      for (let i = 0; i < L.length; i++) {
        if (L[i] !== k) continue;
        for (const j of [i + 1, i - 1, i + w, i - w]) {
          const o = L[j];
          if (o > 0 && o !== k) shared.set(o, (shared.get(o) ?? 0) + 1);
        }
      }
      let into = 0;
      for (const [o, c] of shared) if (!into || c > shared.get(into)) into = o;
      if (!into) {
        area[k] = 0;
        continue;
      }
      for (let i = 0; i < L.length; i++) if (L[i] === k) L[i] = into;
      area[into] += area[k];
      area[k] = 0;
    }
    const parts = [];
    const rm = new cv.Mat(h, w, cv.CV_8UC1);
    for (let k = 1; k <= n; k++) {
      if (!area[k]) continue;
      const d = rm.data;
      for (let i = 0; i < L.length; i++) d[i] = L[i] === k ? 255 : 0;
      const cs = new cv.MatVector();
      const hi = new cv.Mat();
      cv.findContours(rm, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      let bi = -1;
      let ba = 0;
      for (let i = 0; i < cs.size(); i++) {
        const ci = cs.get(i);
        const a = cv.contourArea(ci);
        ci.delete();
        if (a > ba) {
          ba = a;
          bi = i;
        }
      }
      if (bi >= 0) {
        const c = cs.get(bi);
        const pts = [];
        for (let i = 0; i < c.rows; i++) pts.push([c.data32S[i * 2] + x0, c.data32S[i * 2 + 1] + y0]);
        parts.push({ contour: pts, area: ba });
        c.delete();
      }
      cs.delete();
      hi.delete();
    }
    rm.delete();
    return parts;
  }

  // Result: pieces (contour, area), large areas (finished puzzle areas or
  // pieces lying against each other) and the foreground mask.
  // Dashes and lines printed on a puzzle mat: elongated and filling their
  // rectangle (measured 1.4–2 : 1 and 82–95 % in a photo, longer ones more),
  // and small (a finished puzzle is a filled rectangle too).
  // Pieces fill 55–80 % of it because of knobs; a piece with four holes and
  // no knob fills more but is nearly square (cells up to about 1.3 : 1).
  function isLine(cv, c, area) {
    const { width, height } = cv.minAreaRect(c).size;
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    return short > 0 && long / short >= 1.4 && area / (long * short) >= 0.8;
  }

  function drawPoly(cv, mat, contour, value = 255) {
    const poly = cv.matFromArray(contour.length, 1, cv.CV_32SC2, contour.flat());
    const pv = new cv.MatVector();
    pv.push_back(poly);
    cv.drawContours(mat, pv, 0, new cv.Scalar(value), -1);
    poly.delete();
    pv.delete();
  }

  function segmentScene(cv, img, lab, opts = {}) {
    const { width: w, height: h } = img;
    const sd = localStd(cv, img);
    const { dist, shade, noise, model } = backgroundDistance(lab, w, h, sd);
    const sample = [];
    for (let i = 0; i < dist.length; i += 7) sample.push(Math.min(dist[i], 30));
    // Spread of the table itself at the image border: grain and noise must not
    // exceed the threshold, whatever Otsu says.
    const band = [];
    const bw = Math.max(4, Math.round(Math.min(w, h) * 0.04));
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (x >= bw && x < w - bw && y >= bw && y < h - bw) continue;
        band.push(dist[y * w + x]);
      }
    }
    band.sort((a, b) => a - b);
    // Median instead of higher quantiles: with densely laid pieces there are
    // pieces in the border band too.
    const p50 = noise ?? band[Math.floor(band.length * 0.5)] ?? 1;
    // Hysteresis: pieces must differ clearly from the table somewhere (high),
    // but their outline extends to the low threshold. Table noise without a
    // clear core is dropped, piece edges do not fray.
    const tLow = Math.max(3, 2 * p50);
    const thr = Math.max(tLow * 1.6, 5, Math.min(12, otsu(sample, 30, 120)));

    // Lightly smoothed instead of morphologically closed: a big closing would
    // seal the narrow necks of holes on small pieces.
    const dm = cv.matFromArray(h, w, cv.CV_32FC1, dist);
    cv.GaussianBlur(dm, dm, new cv.Size(5, 5), 1.2);
    const raw = new cv.Mat(h, w, cv.CV_8UC1);
    // Fetch memory views only after all allocations: if WASM memory grows,
    // older views point to nothing.
    const ds = Float32Array.from(dm.data32F);
    dm.delete();
    const md = raw.data;
    for (let i = 0; i < ds.length; i++) md[i] = ds[i] > tLow ? 255 : 0;
    const k3 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    const k7 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(raw, raw, cv.MORPH_OPEN, k3);
    cv.morphologyEx(raw, raw, cv.MORPH_CLOSE, k7);
    // Clone before fetching the views: allocations move memory.
    const weak = opts.outlines !== false ? raw.clone() : null;
    const labels = new cv.Mat();
    const nl = cv.connectedComponents(raw, labels, 8, cv.CV_32S);
    const strong = new Uint8Array(nl);
    const ld = labels.data32S;
    for (let i = 0; i < ds.length; i++) if (ds[i] > thr) strong[ld[i]] = 1;
    const rd = raw.data;
    for (let i = 0; i < ds.length; i++) if (!strong[ld[i]]) rd[i] = 0;
    labels.delete();
    if (weak) {
      addOutlines(cv, img, raw, weak, sd);
      weak.delete();
    }

    // Dark rim at the outline that is only table in shadow (cardboard edge
    // and contact shadow): off, within a band of about 3 % of a piece side.
    const RIM_DL = 25; // lightness steps (0–255) darker than inside
    let RIM = 0;
    if (opts.rim !== false) {
      const cl = new cv.Mat();
      const st = new cv.Mat();
      const ce = new cv.Mat();
      const nc = cv.connectedComponentsWithStats(raw, cl, st, ce, 8, cv.CV_32S);
      const areas = [];
      for (let i = 1; i < nc; i++) {
        const a = st.data32S[i * 5 + 4];
        if (a > w * h * 0.00004) areas.push(a);
      }
      for (const m of [cl, st, ce]) m.delete();
      areas.sort((a, b) => a - b);
      const a0 = typicalArea(areas);
      RIM = a0 ? Math.max(1, Math.min(4, Math.round(0.03 * Math.sqrt(a0)))) : 0;
    }
    if (RIM > 0) {
      const ero = new cv.Mat();
      const kr = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * RIM + 1, 2 * RIM + 1));
      cv.erode(raw, ero, kr);
      // Only where the rim is clearly darker than the piece just inside it
      // (dark fur at the outline stays).
      const inner = new cv.Mat(h, w, cv.CV_8UC1);
      const id = inner.data;
      const ed0 = ero.data;
      for (let i = 0; i < id.length; i++) id[i] = ed0[i] ? Math.min(255, lab[i * 3] * 2.55) : 0;
      const kb = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(4 * RIM + 1, 4 * RIM + 1));
      cv.dilate(inner, inner, kb);
      const rd2 = raw.data;
      const ed = ero.data;
      const nd = inner.data;
      for (let i = 0; i < rd2.length; i++)
        if (rd2[i] && !ed[i] && shade[i] <= tLow && lab[i * 3] * 2.55 < nd[i] - RIM_DL) rd2[i] = 0;
      inner.delete();
      kb.delete();
      cv.morphologyEx(raw, raw, cv.MORPH_OPEN, k3);
      ero.delete();
      kr.delete();
    }

    const minArea = w * h * 0.00004;
    const rgba = cv.matFromImageData(img);
    const rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    rgba.delete();
    const scan = () => {
      const contours = new cv.MatVector();
      const hier = new cv.Mat();
      cv.findContours(raw, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE);
      const outer = [];
      const holes = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c);
        const parent = hier.data32S[i * 4 + 3];
        if (parent < 0 && area > minArea && area < 0.01 * w * h && isLine(cv, c, area)) {
          c.delete();
          continue;
        }
        (parent < 0 ? outer : holes).push({ i, area, parent });
        c.delete();
      }
      const areas = outer
        .filter((o) => o.area > minArea)
        .map((o) => o.area)
        .sort((a, b) => a - b);
      const pieceArea = typicalArea(areas);
      return { contours, hier, outer, holes, pieceArea };
    };
    const sc = scan();
    const { contours, hier, outer, holes, pieceArea } = sc;

    const pieces = [];
    const big = [];
    const mask = cv.Mat.zeros(h, w, cv.CV_8UC1);
    const bigMask = cv.Mat.zeros(h, w, cv.CV_8UC1);
    for (const o of outer) {
      if (o.area < Math.max(minArea, pieceArea * 0.3)) continue;
      const c = contours.get(o.i);
      const rect = cv.boundingRect(c);
      const touches =
        rect.x <= 1 || rect.y <= 1 || rect.x + rect.width >= w - 1 || rect.y + rect.height >= h - 1;
      const isBig = o.area > pieceArea * 2.4;
      cv.drawContours(mask, contours, o.i, new cv.Scalar(255), -1);
      if (isBig) cv.drawContours(bigMask, contours, o.i, new cv.Scalar(255), -1);
      const contour = contourPoints(c);
      // Second outline by GrabCut, only if the first gives no clean shape
      // (GrabCut costs most of the time); the shape decides which is better.
      let alt = null;
      const firstQ = isBig || touches ? 1 : (PH.piece.analyzeContour(contour)?.quality ?? 0);
      if (!isBig && opts.refine !== false && firstQ < 0.5) {
        const bb = [rect.x, rect.y, rect.width, rect.height];
        const ref = refinePiece(cv, rgb, contour, bb, Math.sqrt(pieceArea));
        if (ref && ref.area > o.area * 0.7 && ref.area < o.area * 1.6) alt = ref.contour;
      }
      const item = {
        contour,
        alt,
        area: o.area,
        bbox: [rect.x, rect.y, rect.width, rect.height],
        touches,
      };
      (isBig ? big : pieces).push(item);
      c.delete();
    }
    // Holes in large areas (empty places in the finished part) stay free,
    // small holes (reflections, table-coloured spots in the motif) do not.
    const bigIds = new Set(outer.filter((o) => o.area > pieceArea * 2.4).map((o) => o.i));
    for (const hole of holes) {
      if (bigIds.has(hole.parent) && hole.area > pieceArea * 0.12) {
        cv.drawContours(mask, contours, hole.i, new cv.Scalar(0), -1);
        cv.drawContours(bigMask, contours, hole.i, new cv.Scalar(0), -1);
      }
    }
    // Loose pieces can lie in such a hole, e.g. inside the finished border.
    for (const o of outer)
      if (!bigIds.has(o.i) && o.area >= Math.max(minArea, pieceArea * 0.3))
        cv.drawContours(mask, contours, o.i, new cv.Scalar(255), -1);
    raw.delete();
    rgb.delete();
    k3.delete();
    k7.delete();
    contours.delete();
    hier.delete();
    return { pieces, big, mask, bigMask, pieceArea, threshold: thr, model, low: tLow };
  }

  PH.segment = {
    rgbaToLab,
    segmentScene,
    splitBlob,
    backgroundDistance,
    tableDistance,
    kmeans,
    otsu,
    drawPoly,
  };
})();
