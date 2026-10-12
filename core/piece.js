// Shape of a single puzzle piece from its outer contour: the four corners of
// the core square, the position in the photo and per side knob (out), hole
// (in) or flat.
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

  // Line through points (principal axis), as point + direction.
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

  // Dominant edge direction modulo 90°: the straight parts of all four sides
  // share it, the round knobs spread over all angles.
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

  // Strongest weighted cluster of coordinates in [lo, hi].
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

  function analyzeContour(raw, prior) {
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
    // Pixel chains are jagged: smooth over ~2 px, tangent over ±4 px.
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
    // Straightness: the tangent barely changes over ±5 % of the side length.
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
    // Weights for horizontal and vertical straight parts in the rotated image.
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

    // Per side a line through the straight parts near the extreme; real
    // pieces are not exact squares, the sides may be slightly skewed.
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
    // Second way if the lines are not convincing: look for sharp 90° corners
    // with straight legs and take the best combination of four.
    if (!best || best.quality < 0.6) {
      const alt = cornerCombos(pts, step, s0, area);
      if (alt && (!best || alt.quality > best.quality)) best = alt;
    }
    // Third way for pieces with big knobs and wavy cuts, where hardly anything
    // straight is left. Only with a known core size: with an estimated size
    // the edges often land on a knob or hole instead of the core.
    if (prior && (!best || best.quality < 0.1)) {
      const pq = projectionQuad(pts, prior);
      const fill = pq ? PH.geom.polygonArea(pq) / area : 0;
      if (fill > 0.5 && fill < 1.8) {
        const alt = finish(pts, pq, area, 0.59);
        if (alt && (!best || alt.quality > best.quality)) best = alt;
      }
    }
    return best;
  }

  // Pixel centres inside the polygon, as [x0, y0, x1, y1, …].
  function fillPoly(poly) {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [, y] of poly) {
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const px = [];
    for (let y = Math.ceil(y0); y <= y1; y++) {
      const xs = [];
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        if (ay <= y === by <= y) continue;
        xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.ceil(xs[k]); x <= xs[k + 1]; x++) px.push(x, y);
    }
    return px;
  }

  // Core rectangle from projection profiles: at the right angle the row and
  // column sums of the piece area jump at every core edge, whether there is
  // a knob, a hole or nothing. prior: [long, short] side of the core.
  function projectionQuad(poly, prior) {
    const px = fillPoly(poly);
    const np = px.length / 2;
    if (np < 50) return null;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < px.length; i += 2) {
      cx += px[i];
      cy += px[i + 1];
    }
    cx /= np;
    cy /= np;
    let R = 0;
    for (const [x, y] of poly) R = Math.max(R, Math.abs(x - cx), Math.abs(y - cy));
    R = Math.ceil(R * 1.5) + 4;
    const pu = new Float64Array(2 * R);
    const pv = new Float64Array(2 * R);
    const du = new Float64Array(2 * R);
    const dv = new Float64Array(2 * R);
    const project = (deg) => {
      const c = Math.cos(deg * DEG);
      const s = Math.sin(deg * DEG);
      pu.fill(0);
      pv.fill(0);
      for (let i = 0; i < px.length; i += 2) {
        const dx = px[i] - cx;
        const dy = px[i + 1] - cy;
        // Split linearly over two bins so the score is smooth in the angle.
        const fu = dx * c + dy * s + R;
        const fv = -dx * s + dy * c + R;
        const iu = Math.floor(fu);
        const iv = Math.floor(fv);
        pu[iu] += 1 - (fu - iu);
        pu[iu + 1] += fu - iu;
        pv[iv] += 1 - (fv - iv);
        pv[iv + 1] += fv - iv;
      }
      for (let i = 2; i < 2 * R - 2; i++) {
        du[i] = pu[i + 1] + pu[i] - pu[i - 1] - pu[i - 2];
        dv[i] = pv[i + 1] + pv[i] - pv[i - 1] - pv[i - 2];
      }
    };
    // Edge pair at distance L0 (± 8 %).
    const paired = (d, L0) => {
      let best = { lo: R, hi: R, score: -Infinity };
      for (let L = Math.round(L0 * 0.92); L <= Math.round(L0 * 1.08); L++) {
        for (let i = 2; i + L < 2 * R - 2; i++) {
          const sc = d[i] - d[i + L];
          if (sc > best.score) best = { lo: i, hi: i + L, score: sc };
        }
      }
      return best;
    };
    const fit = (deg) => {
      project(deg);
      let best = null;
      for (const [a, b] of [prior, [prior[1], prior[0]]]) {
        const eu = paired(du, a);
        const ev = paired(dv, b);
        if (!best || eu.score + ev.score > best.score) best = { deg, eu, ev, score: eu.score + ev.score };
      }
      return best;
    };
    let best = null;
    for (let d = 0; d < 90; d++) {
      const r = fit(d);
      if (!best || r.score > best.score) best = r;
    }
    const d0 = best.deg;
    for (let d = d0 - 0.75; d <= d0 + 0.75; d += 0.25) {
      const r = fit(d);
      if (r.score > best.score) best = r;
    }
    const c = Math.cos(best.deg * DEG);
    const s = Math.sin(best.deg * DEG);
    // Bin i stands for u = i - R; the jump lies between bins i - 1 and i.
    const at = (u, v) => [
      cx + (u - R - 0.5) * c - (v - R - 0.5) * s,
      cy + (u - R - 0.5) * s + (v - R - 0.5) * c,
    ];
    const { eu, ev } = best;
    if (eu.hi - eu.lo < 4 || ev.hi - ev.lo < 4) return null;
    return [at(eu.lo, ev.lo), at(eu.hi, ev.lo), at(eu.hi, ev.hi), at(eu.lo, ev.hi)];
  }

  // shapeQ: shape quality given from outside (projection way); otherwise from
  // the quadrilateral and the corner fit.
  function finish(pts, corners, area, shapeQ) {
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
    const q = shapeQ ?? quadQuality(corners, area) * cornerFit(pts, idx, corners, side);
    // A knob is never flatter than 0.1 and never deeper than 0.5 sides.
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
      quality: q * plaus,
    };
  }

  // Does the contour near every corner lie on both edges of the quadrilateral?
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
            // Start corner as in the line way: top left in its own frame.
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

  // 0 … 1: how much the core quadrilateral resembles a square and fits the area.
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

  // Side shape in the chord frame: u along the chord (0 … 1), v outwards,
  // both in side lengths. From that the type (knob/hole/flat) and a profile
  // for comparing two sides.
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

  // Do two sides fit together? Side b runs the opposite way, its knob is the
  // hole of a: point k of a against point N-1-k of b with u → 1-u, v → -v.
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

  // Side of a piece against the outline of a gap: same direction, the curves
  // must coincide.
  function holeDistance(a, h) {
    if (a.type !== h.type) return Infinity;
    let s = 0;
    for (let k = 0; k < PROFILE_N * 2; k++) s += (a.profile[k] - h.profile[k]) ** 2;
    return Math.sqrt(s / PROFILE_N);
  }

  PH.piece = {
    analyzeContour,
    projectionQuad,
    sideDistance,
    holeDistance,
    sideShape,
    PROFILE_N,
    arcResample,
    smoothClosed,
  };
})();
