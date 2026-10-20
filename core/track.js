// Where the camera is over the table while sweeping: small gray frames of the
// live picture compared with the frame before and with the photos taken, by
// shift (the phone is held flat and moved). Good enough to show the photos as
// a growing map and to say when to hold still; the photos themselves are laid
// onto each other later by their points (core/stitch.js).
// The phone's motion sensors help where the picture alone does not: the
// gyroscope tells how far the phone turned, so the frame is turned back
// before comparing; the accelerometer carries the position over a moment of
// blur (fast moves), for at most about half a second: integrated twice, its
// error grows with the square of the time.
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
  // insensitive to brightness and contrast. NaN in b: nothing there.
  function ncc(a, b, w, h, dx, dy, step) {
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y += step)
      for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x += step) {
        const q = b[y * w + x];
        if (Number.isNaN(q)) continue;
        const p = a[(y + dy) * w + x + dx];
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

  // Frame turned by deg about its centre: pixel p shows g at R(deg)(p - c) + c;
  // NaN where that is outside.
  function turned(g, w, h, deg) {
    const r = (deg * Math.PI) / 180;
    const co = Math.cos(r);
    const si = Math.sin(r);
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const u = co * (x - cx) - si * (y - cy) + cx;
        const v = si * (x - cx) + co * (y - cy) + cy;
        const i = Math.floor(u);
        const j = Math.floor(v);
        if (i < 0 || j < 0 || i >= w - 1 || j >= h - 1) {
          out[y * w + x] = Number.NaN;
          continue;
        }
        const fu = u - i;
        const fv = v - j;
        const k = j * w + i;
        out[y * w + x] =
          g[k] * (1 - fu) * (1 - fv) +
          g[k + 1] * fu * (1 - fv) +
          g[k + w] * (1 - fu) * fv +
          g[k + w + 1] * fu * fv;
      }
    return out;
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
      // Turn of the phone by the gyroscope, degrees, and at the frame before.
      yaw: 0,
      prevYaw: 0,
      // Which way a turn by the gyroscope turns the picture: +1, -1, or 0 while
      // not known; decided by the picture.
      spin: 0,
      votes: 0,
      // Speed of the view by the picture (frame px/s) and the change of speed
      // the accelerometer measured over the frame before (m/s).
      V: null,
      dv0: null,
      // How the phone's acceleration moves the view, learnt while the picture
      // is followed: least squares of change of speed (px/s) on change of
      // speed (m/s), slowly forgetting.
      fit: { aa: [0, 0, 0], va: [0, 0, 0, 0], vv: 0 },
      // Seconds carried by the accelerometer alone, and how far off the
      // position may be since (frame px) until a photo confirms it.
      coast: 0,
      doubt: 0,
    };
  }

  // Best shift of the current frame g against frame a, taken at turn ya:
  // g turned back by the turn since. While the sign is not known both ways,
  // and the clearly better one counts as a vote.
  function look(t, a, ya, g, cx, cy, r, step) {
    const d = t.yaw - ya;
    const signs = Math.abs(d) < 0.3 ? [0] : t.spin ? [t.spin] : [1, -1];
    const res = signs.map((s) => ({
      ...search(a, s ? turned(g, t.w, t.h, s * d) : g, t.w, t.h, cx, cy, r, step),
      s,
    }));
    if (res.length === 1) return res[0];
    const [p, q] = res;
    if (Math.abs(d) >= 2 && Math.max(p.c, q.c) >= SAME && Math.abs(p.c - q.c) > 0.05) {
      t.votes += p.c > q.c ? 1 : -1;
      if (Math.abs(t.votes) >= 3) t.spin = Math.sign(t.votes);
    }
    return p.c >= q.c ? p : q;
  }

  // Turn of a frame's picture against the map (the picture at the start), in
  // degrees: the turn by the gyroscope, with the sign the picture showed.
  const angle = (t, yaw, s) => -(t.spin || s || 0) * yaw;
  const rot = ([x, y], deg) => {
    const r = (deg * Math.PI) / 180;
    return [Math.cos(r) * x - Math.sin(r) * y, Math.sin(r) * x + Math.cos(r) * y];
  };

  // Learn from one more frame followed by the picture: speed V (px/s), the
  // phone's change of speed dv over the frame (m/s, null without sensor).
  function learn(t, V, dv) {
    if (t.V && dv && t.dv0) {
      const a = [(dv[0] + t.dv0[0]) / 2, (dv[1] + t.dv0[1]) / 2];
      const v = [V[0] - t.V[0], V[1] - t.V[1]];
      const f = t.fit;
      const k = 0.98;
      f.aa = [k * f.aa[0] + a[0] * a[0], k * f.aa[1] + a[0] * a[1], k * f.aa[2] + a[1] * a[1]];
      f.va = [
        k * f.va[0] + v[0] * a[0],
        k * f.va[1] + v[0] * a[1],
        k * f.va[2] + v[1] * a[0],
        k * f.va[3] + v[1] * a[1],
      ];
      f.vv = k * f.vv + v[0] * v[0] + v[1] * v[1];
    }
    t.V = V;
    t.dv0 = dv;
  }

  // Change of speed of the view (px/s) for the phone's dv (m/s), or null
  // while the fit is unsure: too little movement, or it explains less than
  // half of what the picture showed.
  function carry(t, dv) {
    const { aa, va, vv } = t.fit;
    // A little ridge: moved only along a row, nothing is known across it.
    const a0 = aa[0] + 0.002;
    const a2 = aa[2] + 0.002;
    const det = a0 * a2 - aa[1] * aa[1];
    if (aa[0] + aa[2] < 0.02 || !vv) return null;
    const i = [a2 / det, -aa[1] / det, a0 / det];
    const M = [
      va[0] * i[0] + va[1] * i[1],
      va[0] * i[1] + va[1] * i[2],
      va[2] * i[0] + va[3] * i[1],
      va[2] * i[1] + va[3] * i[2],
    ];
    const explained = M[0] * va[0] + M[1] * va[1] + M[2] * va[2] + M[3] * va[3];
    if (explained < 0.5 * vv) return null;
    return [M[0] * dv[0] + M[1] * dv[1], M[2] * dv[0] + M[3] * dv[1]];
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
  // mo: the phone's motion since the frame before, null without sensors:
  // dt (s), turn (degrees about the axis of view, by the gyroscope), dv
  // (change of speed by the accelerometer, m/s, in the phone's x and y).
  function update(t, g, mo = null) {
    const { w, h } = t;
    const dt = mo?.dt ?? 0.1;
    t.yaw += mo?.turn ?? 0;
    let pred = t.pos;
    let moved = false;
    let carried = false;
    // Shifts are found in the picture of the frame compared with, and turned
    // onto the map by its turn.
    let sign = t.spin;
    if (t.prev) {
      let m = look(t, t.prev, t.prevYaw, g, t.vel[0], t.vel[1], 5, 1);
      if (m.c < SAME) m = look(t, t.prev, t.prevYaw, g, 0, 0, Math.round(0.3 * w), 3);
      moved = m.c >= SAME;
      if (moved) sign ||= m.s;
      let step = moved ? [m.dx, m.dy] : [0, 0];
      if (moved) {
        learn(t, [m.dx / dt, m.dy / dt], mo?.dv ?? null);
        t.coast = 0;
      } else {
        // The picture blurred: on with the speed before, changed as the
        // accelerometer says. t.V is the mean over the frame before; at its
        // end the speed had changed by half of that frame's dv more.
        const half = t.V && mo?.dv && t.dv0 && t.coast + dt <= 0.6 ? carry(t, t.dv0) : null;
        const dV = half && carry(t, mo.dv);
        if (dV) {
          const v0 = [t.V[0] + half[0] / 2, t.V[1] + half[1] / 2];
          t.V = [v0[0] + dV[0] / 2, v0[1] + dV[1] / 2];
          step = [t.V[0] * dt, t.V[1] * dt];
          t.coast += dt;
          // Room to search the photos around where it should be.
          t.doubt += 1 + 0.25 * Math.hypot(...step);
          carried = true;
          t.dv0 = mo.dv;
        } else {
          t.V = null;
          t.dv0 = null;
        }
      }
      t.vel = step;
      t.still = moved && Math.hypot(m.dx, m.dy) < 0.35 ? t.still + 1 : 0;
      const d = rot(step, angle(t, t.prevYaw, sign));
      if ((moved || carried) && !t.lost) pred = [t.pos[0] + d[0], t.pos[1] + d[1]];
    }
    t.prev = g;
    t.prevYaw = t.yaw;
    if (!t.shots.length) return t;
    // Against the photos: no drift while the view still overlaps one; found
    // again by a wide search after a jump.
    let found = null;
    for (const { i, o } of near(t, pred).slice(0, 2)) {
      if (o < 0.2) break;
      const sh = t.shots[i];
      const [cx, cy] = rot([pred[0] - sh.x, pred[1] - sh.y], -angle(t, sh.yaw, sign));
      const r = Math.min(24, 4 + Math.round(t.doubt));
      const m = look(t, sh.g, sh.yaw, g, cx, cy, r, r > 8 ? 2 : 1);
      if (m.c >= SAME && (!found || m.c > found.c)) found = { ...m, sh };
    }
    if (!found && (t.lost || !moved))
      for (const i of new Set([t.best, t.shots.length - 1])) {
        if (i < 0) continue;
        const sh = t.shots[i];
        const m = look(t, sh.g, sh.yaw, g, 0, 0, Math.round(0.8 * Math.max(w, h)), 3);
        if (m.c >= SAME + 0.1 && (!found || m.c > found.c)) found = { ...m, sh };
      }
    if (found) {
      const d = rot([found.dx, found.dy], angle(t, found.sh.yaw, found.s || sign));
      t.pos = [found.sh.x + d[0], found.sh.y + d[1]];
    } else t.pos = pred;
    if (found) {
      t.coast = 0;
      t.doubt = 0;
    }
    t.lost = !found && (t.lost || (!moved && !carried) || !near(t, pred).length);
    const n = near(t, t.pos)[0];
    t.best = n?.i ?? -1;
    t.over = n?.o ?? 0;
    t.cover = covered(t, t.pos);
    return t;
  }

  // The current view becomes a photo; thumb is anything drawable.
  function addShot(t, g, thumb) {
    t.shots.push({ x: t.pos[0], y: t.pos[1], yaw: t.yaw, g, thumb });
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

  // Turn of a photo's picture taken at yaw against the map, degrees (0 while
  // the sign is not known).
  const turnOf = (t, yaw) => angle(t, yaw, 0);

  PH.track = { gray, overlap, covered, search, turned, tracker, update, addShot, target, turnOf, rot };
})();
