// Teile vom Tisch trennen. Der Tisch füllt den Bildrand, daraus entsteht ein
// Farbmodell (bis zu vier Farbcluster, etwa Holzmaserung); alles, was davon
// deutlich abweicht, ist Puzzle.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  // sRGB → CIELab (L 0…100, a/b ca. -100…100), D65.
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

  // Abstand jedes Pixels zum Tischmodell, in Streuungen gemessen. Helligkeit
  // zählt halb, damit Schlagschatten der Teile nicht als Teil gelten.
  function backgroundDistance(lab, w, h) {
    const band = Math.max(4, Math.round(Math.min(w, h) * 0.04));
    const s = [];
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        const i = (y * w + x) * 3;
        s.push(lab[i], lab[i + 1], lab[i + 2]);
      }
    }
    // Der häufigste Randton ist der Tisch; weitere Töne nur, wenn sie ihm
    // ähneln (Maserung). Teile am Bildrand dürfen nicht zum Tisch werden.
    const all = kmeans(Float32Array.from(s), 6, 10).sort((a, b) => b.weight - a.weight);
    const near = (c) =>
      Math.hypot(c.mean[0] - all[0].mean[0], c.mean[1] - all[0].mean[1], c.mean[2] - all[0].mean[2]);
    const clusters = all.filter((c, i) => i === 0 || (c.weight > 0.05 && near(c) < 20));
    const model = clusters.map((c) => ({
      mean: c.mean,
      // Streuung nach unten und oben begrenzt: Ein zu breiter Cluster würde
      // sonst auch Teile als Tisch durchwinken.
      inv: [
        1 / (2 * Math.min(8, Math.max(3, c.std[0]))),
        1 / Math.min(6, Math.max(2.5, c.std[1])),
        1 / Math.min(6, Math.max(2.5, c.std[2])),
      ],
    }));
    const n = w * h;
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const m of model) {
        const d =
          ((lab[i * 3] - m.mean[0]) * m.inv[0]) ** 2 +
          ((lab[i * 3 + 1] - m.mean[1]) * m.inv[1]) ** 2 +
          ((lab[i * 3 + 2] - m.mean[2]) * m.inv[2]) ** 2;
        if (d < best) best = d;
      }
      dist[i] = Math.sqrt(best);
    }
    return { dist, model };
  }

  // Typische Teilfläche: Größe, die zahlreich vorkommt und zusammen viel
  // Fläche ausmacht (Fläche × Anzahl ähnlich großer Flecken).
  // Viele Krümel (Maserung) sind klein, ein fertiger Puzzlebereich ist
  // einzeln; die losen Teile sind zahlreich und gleich groß.
  function typicalArea(areas) {
    let best = 0;
    let bestScore = 0;
    for (const a of areas) {
      let sc = 0;
      let n = 0;
      for (const b of areas) {
        if (b > a / 1.5 && b < a * 1.5) {
          sc += b;
          n++;
        }
      }
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

  // Umriss eines Teils mit GrabCut nachschärfen: Farbmodelle aus dem Teil
  // selbst und seiner nächsten Umgebung statt aus dem ganzen Tisch. Schließt
  // tischfarbene Stellen im Motiv, die sonst als Kerben im Umriss landen.
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

  // Ergebnis: Teile (Kontur, Fläche), große Flächen (fertige Puzzlebereiche
  // oder aneinanderliegende Teile) und die Vordergrundmaske.
  function drawPoly(cv, mat, contour) {
    const poly = cv.matFromArray(contour.length, 1, cv.CV_32SC2, contour.flat());
    const pv = new cv.MatVector();
    pv.push_back(poly);
    cv.drawContours(mat, pv, 0, new cv.Scalar(255), -1);
    poly.delete();
    pv.delete();
  }

  function segmentScene(cv, img, lab, opts = {}) {
    const { width: w, height: h } = img;
    const { dist } = backgroundDistance(lab, w, h);
    const sample = [];
    for (let i = 0; i < dist.length; i += 7) sample.push(Math.min(dist[i], 30));
    // Streuung des Tischs selbst am Bildrand: Maserung und Rauschen dürfen
    // nicht über der Schwelle liegen, egal was Otsu meint.
    const band = [];
    const bw = Math.max(4, Math.round(Math.min(w, h) * 0.04));
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        if (x >= bw && x < w - bw && y >= bw && y < h - bw) continue;
        band.push(dist[y * w + x]);
      }
    }
    band.sort((a, b) => a - b);
    // Median statt höherer Quantile: Bei dicht gelegten Teilen liegen auch
    // Teile im Randstreifen.
    const p50 = band[Math.floor(band.length * 0.5)] ?? 1;
    // Hysterese: Teile müssen irgendwo deutlich vom Tisch abweichen (hoch),
    // ihr Umriss reicht aber bis zur niedrigen Schwelle. Tischrauschen ohne
    // deutlichen Kern fällt weg, Teilränder franzen nicht aus.
    const tLow = Math.max(3, 2 * p50);
    const thr = Math.max(tLow * 1.6, 5, Math.min(12, otsu(sample, 30, 120)));

    // Leicht geglättet statt morphologisch geschlossen: Ein großes Schließen
    // würde bei kleinen Teilen die schmalen Hälse der Löcher zukleben.
    const dm = cv.matFromArray(h, w, cv.CV_32FC1, dist);
    cv.GaussianBlur(dm, dm, new cv.Size(5, 5), 1.2);
    const raw = new cv.Mat(h, w, cv.CV_8UC1);
    // Speicheransichten erst nach allen Allokationen holen: wächst der
    // WASM-Speicher, zeigen ältere Ansichten ins Leere.
    const ds = Float32Array.from(dm.data32F);
    dm.delete();
    const md = raw.data;
    for (let i = 0; i < ds.length; i++) md[i] = ds[i] > tLow ? 255 : 0;
    const k3 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    const k7 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(raw, raw, cv.MORPH_OPEN, k3);
    cv.morphologyEx(raw, raw, cv.MORPH_CLOSE, k7);
    const labels = new cv.Mat();
    const nl = cv.connectedComponents(raw, labels, 8, cv.CV_32S);
    const strong = new Uint8Array(nl);
    const ld = labels.data32S;
    for (let i = 0; i < ds.length; i++) if (ds[i] > thr) strong[ld[i]] = 1;
    const rd = raw.data;
    for (let i = 0; i < ds.length; i++) if (!strong[ld[i]]) rd[i] = 0;
    labels.delete();

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
      // Zweiter Umriss per GrabCut, nur wenn der erste keine saubere Form
      // ergibt (GrabCut kostet die meiste Rechenzeit); welcher besser ist,
      // entscheidet die Form.
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
    // Löcher in großen Flächen (leere Plätze im fertigen Teil) bleiben frei,
    // kleine Löcher (Spiegelungen, tischfarbene Stellen im Motiv) nicht.
    const bigIds = new Set(outer.filter((o) => o.area > pieceArea * 2.4).map((o) => o.i));
    for (const hole of holes) {
      if (bigIds.has(hole.parent) && hole.area > pieceArea * 0.12) {
        cv.drawContours(mask, contours, hole.i, new cv.Scalar(0), -1);
        cv.drawContours(bigMask, contours, hole.i, new cv.Scalar(0), -1);
      }
    }
    raw.delete();
    rgb.delete();
    k3.delete();
    k7.delete();
    contours.delete();
    hier.delete();
    return { pieces, big, mask, bigMask, pieceArea, threshold: thr };
  }

  PH.segment = { rgbaToLab, segmentScene, backgroundDistance, kmeans, otsu, drawPoly };
})();
