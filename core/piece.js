// Form eines einzelnen Puzzleteils aus seiner Außenkontur: die vier Ecken des
// Kernquadrats, die Lage im Foto und je Seite Nase (out), Loch (in) oder glatt.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;
  const DEG = Math.PI / 180;

  function arcResample(pts, step) {
    const n = pts.length;
    const out = [];
    let carry = 0;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      const len = Math.hypot(x1 - x0, y1 - y0);
      let t = carry;
      while (t < len) {
        const f = t / len;
        out.push([x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
        t += step;
      }
      carry = t - len;
    }
    return out;
  }

  function smoothClosed(pts, sigma) {
    const n = pts.length;
    const r = Math.ceil(sigma * 2.5);
    const w = [];
    for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
    const ws = w.reduce((a, b) => a + b, 0);
    return pts.map((_, i) => {
      let x = 0;
      let y = 0;
      for (let k = -r; k <= r; k++) {
        const p = pts[(i + k + n) % n];
        x += p[0] * w[k + r];
        y += p[1] * w[k + r];
      }
      return [x / ws, y / ws];
    });
  }

  // Gerade durch Punkte (Hauptachse), als Punkt + Richtung.
  function fitLine(pts) {
    let mx = 0;
    let my = 0;
    for (const [x, y] of pts) {
      mx += x;
      my += y;
    }
    mx /= pts.length;
    my /= pts.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const [x, y] of pts) {
      sxx += (x - mx) ** 2;
      sxy += (x - mx) * (y - my);
      syy += (y - my) ** 2;
    }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: [mx, my], d: [Math.cos(a), Math.sin(a)] };
  }

  function intersect(l1, l2) {
    const [x1, y1] = l1.p;
    const [dx1, dy1] = l1.d;
    const [x2, y2] = l2.p;
    const [dx2, dy2] = l2.d;
    const den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((x2 - x1) * dy2 - (y2 - y1) * dx2) / den;
    return [x1 + dx1 * t, y1 + dy1 * t];
  }

  // Vorherrschende Kantenrichtung modulo 90°: die geraden Stücke aller vier
  // Seiten teilen sie, die runden Nasen verteilen sich über alle Winkel.
  function dominantAngle(tan, straight) {
    const hist = new Float64Array(90);
    for (let i = 0; i < tan.length; i++) {
      const a = (((tan[i] / DEG) % 90) + 90) % 90;
      hist[Math.floor(a) % 90] += straight[i];
    }
    const sm = new Float64Array(90);
    for (let i = 0; i < 90; i++) {
      for (let k = -3; k <= 3; k++) sm[i] += hist[(i + k + 90) % 90] * Math.exp(-(k * k) / 4);
    }
    let best = 0;
    for (let i = 1; i < 90; i++) if (sm[i] > sm[best]) best = i;
    const l = sm[(best + 89) % 90];
    const r = sm[(best + 1) % 90];
    const den = l - 2 * sm[best] + r;
    const off = den < 0 ? (0.5 * (l - r)) / den : 0;
    return (best + 0.5 + off) * DEG;
  }

  // Stärkste Häufung von Koordinaten in [lo, hi], gewichtet.
  function peak(vals, weights, lo, hi) {
    const n = Math.max(1, Math.ceil(hi - lo));
    const hist = new Float64Array(n + 1);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v < lo || v > hi) continue;
      hist[Math.round(v - lo)] += weights[i];
    }
    let best = 0;
    let bestV = -1;
    for (let i = 0; i <= n; i++) {
      const s = (hist[i - 1] ?? 0) * 0.6 + hist[i] + (hist[i + 1] ?? 0) * 0.6;
      if (s > bestV) {
        bestV = s;
        best = i;
      }
    }
    return { at: lo + best, weight: bestV };
  }

  function analyzeContour(raw) {
    if (raw.length < 20) return null;
    let pts = raw;
    if (PH.geom.polygonArea(pts) < 0) pts = [...pts].reverse();
    let per = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      per += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const step = Math.max(0.75, per / 900);
    // Pixelketten sind treppig: über ~2 px glätten, Tangente über ±4 px.
    pts = smoothClosed(arcResample(pts, step), 2 / step);
    const n = pts.length;
    const area = PH.geom.polygonArea(pts);
    const s0 = Math.sqrt(area);

    const k = Math.max(2, Math.round(4 / step));
    const tan = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[(i - k + n) % n];
      const b = pts[(i + k) % n];
      tan[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
    // Geradheit: Tangente ändert sich über ±5 % der Seitenlänge kaum.
    const kk = Math.max(2, Math.round((0.05 * s0) / step));
    const straight = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let d = tan[(i + kk) % n] - tan[(i - kk + n) % n];
      d = Math.atan2(Math.sin(d), Math.cos(d));
      straight[i] = Math.exp(-((d / (12 * DEG)) ** 2));
    }
    const theta = dominantAngle(tan, straight);
    const c = Math.cos(-theta);
    const s = Math.sin(-theta);
    const rx = new Float64Array(n);
    const ry = new Float64Array(n);
    let minx = Infinity;
    let maxx = -Infinity;
    let miny = Infinity;
    let maxy = -Infinity;
    for (let i = 0; i < n; i++) {
      rx[i] = pts[i][0] * c - pts[i][1] * s;
      ry[i] = pts[i][0] * s + pts[i][1] * c;
      minx = Math.min(minx, rx[i]);
      maxx = Math.max(maxx, rx[i]);
      miny = Math.min(miny, ry[i]);
      maxy = Math.max(maxy, ry[i]);
    }
    // Gewichte für waagrechte bzw. senkrechte gerade Stücke im gedrehten Bild.
    const wh = new Float64Array(n);
    const wv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = tan[i] - theta;
      const sa = Math.abs(Math.sin(a));
      const ca = Math.abs(Math.cos(a));
      wh[i] = sa < 0.2 ? straight[i] : 0;
      wv[i] = ca < 0.2 ? straight[i] : 0;
    }
    const h = maxy - miny;
    const w = maxx - minx;
    const top = peak(ry, wh, miny, miny + 0.42 * h);
    const bot = peak(ry, wh, maxy - 0.42 * h, maxy);
    const lef = peak(rx, wv, minx, minx + 0.42 * w);
    const rig = peak(rx, wv, maxx - 0.42 * w, maxx);

    // Je Seite eine Gerade durch die geraden Stücke nahe der Spitze; echte
    // Teile sind keine exakten Quadrate, die Seiten dürfen etwas schief sein.
    const band = Math.max(2, s0 * 0.05);
    const sideLine = (pk, vals, ws) => {
      const sel = [];
      for (let i = 0; i < n; i++) if (ws[i] > 0.3 && Math.abs(vals[i] - pk.at) < band) sel.push(pts[i]);
      return sel.length >= 4 ? fitLine(sel) : null;
    };
    const lines = [
      sideLine(top, ry, wh),
      sideLine(rig, rx, wv),
      sideLine(bot, ry, wh),
      sideLine(lef, rx, wv),
    ];
    let best = null;
    if (!lines.some((l) => !l)) {
      const corners = [];
      for (let i = 0; i < 4; i++) corners.push(intersect(lines[(i + 3) % 4], lines[i]));
      if (corners.every(Boolean)) best = finish(pts, corners, area);
    }
    // Zweiter Weg, wenn die Geraden nicht überzeugen: scharfe 90°-Ecken mit
    // geraden Schenkeln suchen und die beste Vierer-Kombination nehmen.
    if (!best || best.quality < 0.6) {
      const alt = cornerCombos(pts, step, s0, area);
      if (alt && (!best || alt.quality > best.quality)) best = alt;
    }
    return best;
  }

  function finish(pts, corners, area) {
    const idx = corners.map((q) => nearestIndex(pts, q));
    const sides = [];
    for (let i = 0; i < 4; i++)
      sides.push(sideShape(pts, idx[i], idx[(i + 1) % 4], corners[i], corners[(i + 1) % 4]));
    if (sides.some((x) => !x)) return null;
    const side =
      (dist(corners[0], corners[1]) +
        dist(corners[1], corners[2]) +
        dist(corners[2], corners[3]) +
        dist(corners[3], corners[0])) /
      4;
    const fit = cornerFit(pts, idx, corners, side);
    // Eine Nase ist nie flacher als 0,1 und nie tiefer als 0,5 Seiten.
    const plaus = sides.every((x) => x.depth < 0.1 || (x.depth > 0.12 && x.depth < 0.55)) ? 1 : 0.5;
    return {
      corners,
      sides,
      side,
      area,
      angle: Math.atan2(corners[1][1] - corners[0][1], corners[1][0] - corners[0][0]) / DEG,
      center: [
        (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4,
        (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4,
      ],
      quality: quadQuality(corners, area) * fit * plaus,
    };
  }

  // Liegt die Kontur nahe jeder Ecke auf beiden Kanten des Vierecks?
  function cornerFit(pts, idx, corners, side) {
    const n = pts.length;
    const span = Math.max(3, Math.round(n * 0.04));
    let sum = 0;
    let cnt = 0;
    for (let c = 0; c < 4; c++) {
      const a = corners[c];
      const next = corners[(c + 1) % 4];
      const prev = corners[(c + 3) % 4];
      for (let k = 1; k <= span; k++) {
        sum += lineDist(pts[(idx[c] + k) % n], a, next);
        sum += lineDist(pts[(idx[c] - k + n) % n], a, prev);
        cnt += 2;
      }
    }
    const m = sum / cnt / side;
    return Math.exp(-((m / 0.03) ** 2));
  }

  function lineDist(p, a, b) {
    const L = dist(a, b) || 1;
    return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L;
  }

  function cornerCombos(pts, step, s0, area) {
    const n = pts.length;
    const w = Math.max(3, Math.round((0.1 * s0) / step));
    const score = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[(i - w + n) % n];
      const b = pts[(i + w) % n];
      const v1 = [a[0] - p[0], a[1] - p[1]];
      const v2 = [b[0] - p[0], b[1] - p[1]];
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      if (cross <= 0) continue;
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
      const ang = Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
      let dev = 0;
      for (let k = 1; k < w; k++) {
        dev += lineDist(pts[(i - k + n) % n], p, a) + lineDist(pts[(i + k) % n], p, b);
      }
      dev /= 2 * (w - 1) * w * step;
      score[i] = Math.exp(-(((ang - 90) / 22) ** 2)) * Math.exp(-((dev / 0.06) ** 2));
    }
    const cand = [];
    for (let i = 0; i < n; i++) {
      if (score[i] < 0.15) continue;
      let isMax = true;
      for (let k = -w; k <= w && isMax; k++) if (k && score[(i + k + n) % n] > score[i]) isMax = false;
      if (isMax) cand.push(i);
    }
    cand.sort((x, y) => score[y] - score[x]);
    const top = cand.slice(0, 10).sort((x, y) => x - y);
    let best = null;
    const m = top.length;
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        for (let c = b + 1; c < m; c++) {
          for (let d = c + 1; d < m; d++) {
            const q = [top[a], top[b], top[c], top[d]].map((i) => pts[i]);
            if (quadQuality(q, area) < 0.3) continue;
            // Startecke wie beim Geradenweg: die links oben im eigenen Rahmen.
            const r = finish(pts, q, area);
            if (!r) continue;
            const cs = (score[top[a]] + score[top[b]] + score[top[c]] + score[top[d]]) / 4;
            r.quality *= Math.sqrt(cs);
            if (!best || r.quality > best.quality) best = r;
          }
        }
      }
    }
    return best;
  }

  function dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function nearestIndex(pts, q) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = (pts[i][0] - q[0]) ** 2 + (pts[i][1] - q[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // 0 … 1: wie sehr das Kernviereck einem Quadrat gleicht und zur Fläche passt.
  function quadQuality(q, area) {
    const L = [0, 1, 2, 3].map((i) => dist(q[i], q[(i + 1) % 4]));
    const ratio = Math.min(...L) / Math.max(...L);
    let angPen = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[(i + 3) % 4];
      const b = q[i];
      const c = q[(i + 1) % 4];
      const v1 = [a[0] - b[0], a[1] - b[1]];
      const v2 = [c[0] - b[0], c[1] - b[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
      angPen = Math.max(angPen, Math.abs(cos));
    }
    const qa = PH.geom.polygonArea(q);
    const fill = qa / area;
    const fillOk = fill > 0.55 && fill < 1.6 ? 1 : 0;
    return fillOk * Math.max(0, (ratio - 0.6) / 0.4) * Math.max(0, 1 - angPen / 0.35);
  }

  const PROFILE_N = 24;

  // Seitenform im Sehnenrahmen: u entlang der Sehne (0 … 1), v nach außen,
  // beides in Seitenlängen. Daraus Art (Nase/Loch/glatt) und ein Profil zum
  // Vergleichen zweier Seiten.
  function sideShape(pts, i0, i1, a, b) {
    const n = pts.length;
    const seg = [];
    for (let i = i0; ; i = (i + 1) % n) {
      seg.push(pts[i]);
      if (i === i1 || seg.length > n) break;
    }
    const L = dist(a, b);
    if (seg.length < 4 || !(L >= 1)) return null;
    const ux = (b[0] - a[0]) / L;
    const uy = (b[1] - a[1]) / L;
    const nx = uy;
    const ny = -ux;
    let out = 0;
    let inn = 0;
    let atU = 0.5;
    const uv = seg.map(([x, y]) => {
      const u = ((x - a[0]) * ux + (y - a[1]) * uy) / L;
      const v = ((x - a[0]) * nx + (y - a[1]) * ny) / L;
      if (v > out) {
        out = v;
        if (out > inn) atU = u;
      }
      if (-v > inn) {
        inn = -v;
        if (inn > out) atU = u;
      }
      return [u, v];
    });
    const depth = Math.max(out, inn);
    const type = depth < 0.1 ? 0 : out > inn ? 1 : -1;
    const profile = new Float32Array(PROFILE_N * 2);
    let total = 0;
    const cum = [0];
    for (let i = 1; i < uv.length; i++) {
      total += Math.hypot(uv[i][0] - uv[i - 1][0], uv[i][1] - uv[i - 1][1]);
      cum.push(total);
    }
    let j = 0;
    for (let k = 0; k < PROFILE_N; k++) {
      const t = (total * k) / (PROFILE_N - 1);
      while (j < cum.length - 2 && cum[j + 1] < t) j++;
      const f = cum[j + 1] > cum[j] ? (t - cum[j]) / (cum[j + 1] - cum[j]) : 0;
      profile[k * 2] = uv[j][0] + (uv[j + 1][0] - uv[j][0]) * f;
      profile[k * 2 + 1] = uv[j][1] + (uv[j + 1][1] - uv[j][1]) * f;
    }
    return { type, depth, atU, len: L, profile };
  }

  // Passen zwei Seiten zusammen? Seite b läuft gegengleich, ihre Nase ist
  // das Loch von a: Punkt k von a gegen Punkt N-1-k von b mit u → 1-u, v → -v.
  function sideDistance(a, b) {
    if (a.type === 0 || b.type === 0 || a.type === b.type) return Infinity;
    let s = 0;
    for (let k = 0; k < PROFILE_N; k++) {
      const m = PROFILE_N - 1 - k;
      const du = a.profile[k * 2] - (1 - b.profile[m * 2]);
      const dv = a.profile[k * 2 + 1] + b.profile[m * 2 + 1];
      s += du * du + dv * dv;
    }
    return Math.sqrt(s / PROFILE_N) + Math.abs(Math.log(a.len / b.len)) * 0.5;
  }

  // Seite eines Teils gegen den Umriss einer Lücke: gleiche Laufrichtung,
  // die Kurven müssen sich decken.
  function holeDistance(a, h) {
    if (a.type !== h.type) return Infinity;
    let s = 0;
    for (let k = 0; k < PROFILE_N * 2; k++) s += (a.profile[k] - h.profile[k]) ** 2;
    return Math.sqrt(s / PROFILE_N);
  }

  PH.piece = { analyzeContour, sideDistance, holeDistance, sideShape, PROFILE_N, arcResample, smoothClosed };
})();
