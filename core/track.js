// Where the camera is over the table while sweeping: small gray frames of the
// live picture compared with the frame before and with the photos taken, by
// shift only (the phone is held flat and moved, not turned). Good enough to
// show the photos as a growing map and to say when to hold still; the photos
// themselves are laid onto each other later by their points (core/stitch.js).
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;
  // Correlation of a frame with a shifted one that counts as the same view:
  // the camera blurs while moving and changes its exposure.
  const SAME = 0.6;

  function gray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++)
      g[i] = 0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2];
    return g;
  }

  // Part of a frame still in view after a shift of (dx, dy) frame pixels.
  const overlap = (dx, dy, w, h) => Math.max(0, 1 - Math.abs(dx) / w) * Math.max(0, 1 - Math.abs(dy) / h);

  // Correlation of b against a where b's pixel (x, y) shows a's (x + dx, y + dy);
  // insensitive to brightness and contrast.
  function ncc(a, b, w, h, dx, dy, step) {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y += step)
      for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x += step) {
        const p = a[(y + dy) * w + x + dx];
        const q = b[y * w + x];
        sa += p;
        sb += q;
        saa += p * p;
        sbb += q * q;
        sab += p * q;
        n++;
      }
    if (n < 150 / step / step) return -1;
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    // Plain table or mat: nothing to follow.
    if (va < n * 16 || vb < n * 16) return -1;
    return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
  }

  // Best shift within r of (cx, cy), every step-th shift and pixel, then
  // refined to the pixel and a parabola between pixels.
  function search(a, b, w, h, cx, cy, r, step = 1) {
    const at = (dx, dy, s) => (overlap(dx, dy, w, h) < 0.15 ? -1 : ncc(a, b, w, h, dx, dy, s));
    let best = { c: -2, dx: 0, dy: 0 };
    const x0 = Math.round(cx);
    const y0 = Math.round(cy);
    for (let dy = y0 - r; dy <= y0 + r; dy += step)
      for (let dx = x0 - r; dx <= x0 + r; dx += step) {
        const c = at(dx, dy, step > 1 ? 2 : 1);
        if (c > best.c) best = { c, dx, dy };
      }
    if (step > 1) {
      const coarse = best;
      best = { c: -2, dx: 0, dy: 0 };
      for (let dy = coarse.dy - step + 1; dy < coarse.dy + step; dy++)
        for (let dx = coarse.dx - step + 1; dx < coarse.dx + step; dx++) {
          const c = at(dx, dy, 1);
          if (c > best.c) best = { c, dx, dy };
        }
    }
    const sub = (m, c0, p) => {
      const d = m + p - 2 * c0;
      return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / d)) : 0;
    };
    const { c, dx, dy } = best;
    return {
      c,
      dx: dx + sub(at(dx - 1, dy, 1), c, at(dx + 1, dy, 1)),
      dy: dy + sub(at(dx, dy - 1, 1), c, at(dx, dy + 1, 1)),
    };
  }

  // A tracker for frames of w × h pixels; positions are those of the frame's
  // top left corner on the table, in frame pixels, the first photo at 0, 0.
  function tracker(w, h) {
    return {
      w,
      h,
      shots: [],
      pos: [0, 0],
      vel: [0, 0],
      prev: null,
      lost: false,
      still: 0,
      best: -1,
      over: 0,
      cover: 0,
    };
  }

  // The photos the view at pos overlaps, most first.
  function near(t, pos) {
    return t.shots
      .map((s, i) => ({ i, o: overlap(pos[0] - s.x, pos[1] - s.y, t.w, t.h) }))
      .filter((s) => s.o > 0)
      .sort((a, b) => b.o - a.o);
  }

  // Part of the view at pos that the photos show together.
  function covered(t, pos) {
    const [px, py] = pos;
    const { w, h } = t;
    const rs = [];
    for (const s of t.shots) {
      const r = [Math.max(px, s.x), Math.max(py, s.y), Math.min(px + w, s.x + w), Math.min(py + h, s.y + h)];
      if (r[2] > r[0] && r[3] > r[1]) rs.push(r);
    }
    const xs = [...new Set(rs.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
    const ys = [...new Set(rs.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
    let a = 0;
    for (let i = 0; i + 1 < xs.length; i++)
      for (let j = 0; j + 1 < ys.length; j++) {
        const x = (xs[i] + xs[i + 1]) / 2;
        const y = (ys[j] + ys[j + 1]) / 2;
        if (rs.some((r) => x > r[0] && x < r[2] && y > r[1] && y < r[3]))
          a += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      }
    return a / (w * h);
  }

  // Follows the camera by one frame: t.pos, t.still (frames without moving),
  // t.lost, t.best (photo with most overlap), t.over (its overlap) and
  // t.cover (part of the view photographed).
  function update(t, g) {
    const { w, h } = t;
    let pred = t.pos;
    let moved = false;
    if (t.prev) {
      let m = search(t.prev, g, w, h, t.vel[0], t.vel[1], 5);
      if (m.c < SAME) m = search(t.prev, g, w, h, 0, 0, Math.round(0.3 * w), 3);
      moved = m.c >= SAME;
      t.vel = moved ? [m.dx, m.dy] : [0, 0];
      t.still = moved && Math.hypot(m.dx, m.dy) < 0.35 ? t.still + 1 : 0;
      if (moved && !t.lost) pred = [t.pos[0] + m.dx, t.pos[1] + m.dy];
    }
    t.prev = g;
    if (!t.shots.length) return t;
    // Against the photos: no drift while the view still overlaps one; found
    // again by a wide search after a jump.
    let found = null;
    for (const { i, o } of near(t, pred).slice(0, 2)) {
      if (o < 0.2) break;
      const s = t.shots[i];
      const m = search(s.g, g, w, h, pred[0] - s.x, pred[1] - s.y, 4);
      if (m.c >= SAME && (!found || m.c > found.c)) found = { ...m, s };
    }
    if (!found && (t.lost || !moved))
      for (const i of new Set([t.best, t.shots.length - 1])) {
        if (i < 0) continue;
        const s = t.shots[i];
        const m = search(s.g, g, w, h, 0, 0, Math.round(0.8 * Math.max(w, h)), 3);
        if (m.c >= SAME + 0.1 && (!found || m.c > found.c)) found = { ...m, s };
      }
    if (found) t.pos = [found.s.x + found.dx, found.s.y + found.dy];
    else t.pos = pred;
    t.lost = !found && (t.lost || !moved || !near(t, pred).length);
    const n = near(t, t.pos)[0];
    t.best = n?.i ?? -1;
    t.over = n?.o ?? 0;
    t.cover = covered(t, t.pos);
    return t;
  }

  // The current view becomes a photo; thumb is anything drawable.
  function addShot(t, g, thumb) {
    t.shots.push({ x: t.pos[0], y: t.pos[1], g, thumb });
    t.best = t.shots.length - 1;
    t.over = 1;
    t.cover = 1;
    t.lost = false;
  }

  // Spot along the way the camera moves from the photo with most overlap
  // where only `want` of the view is photographed, as shift from that photo;
  // null without a way.
  function target(t, want) {
    const s = t.shots[t.best];
    if (!s) return null;
    const dx = t.pos[0] - s.x;
    const dy = t.pos[1] - s.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.03 * t.w) return null;
    for (let m = 0; m < 2 * Math.max(t.w, t.h); m += 0.5) {
      const p = [s.x + (m * dx) / d, s.y + (m * dy) / d];
      if (covered(t, p) <= want) return { s, dx: p[0] - s.x, dy: p[1] - s.y };
    }
    return null;
  }

  PH.track = { gray, overlap, covered, search, tracker, update, addShot, target };
})();
