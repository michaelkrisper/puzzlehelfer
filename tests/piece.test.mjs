import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('../core/geom.js');
require('../core/piece.js');
const { geom, piece } = globalThis.PH;

// Outline of a piece: side types t (1 tab, -1 hole, 0 flat) for top, right,
// bottom, left; edge length S, rotated by deg clockwise.
function outline(t, S, deg, cx = 300, cy = 300) {
  const sq = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const local = [];
  for (let k = 0; k < 4; k++) {
    const path = [[0, 0]];
    if (t[k]) {
      const s = t[k];
      path.push([0.44, 0], [0.44, 0.1 * s]);
      const c = [0.5, 0.2 * s];
      const a0 = Math.atan2(0.1 * s - c[1], 0.44 - c[0]);
      const a1 = Math.atan2(0.1 * s - c[1], 0.56 - c[0]);
      // around the outside, i.e. over the apex
      let da = a1 - a0;
      if (s > 0 && da > 0) da -= 2 * Math.PI;
      if (s < 0 && da < 0) da += 2 * Math.PI;
      for (let i = 1; i < 40; i++) {
        const a = a0 + (da * i) / 40;
        path.push([c[0] + 0.12 * Math.cos(a), c[1] + 0.12 * Math.sin(a)]);
      }
      path.push([0.56, 0.1 * s], [0.56, 0]);
    }
    const a = sq[k];
    const b = sq[(k + 1) % 4];
    const d = [b[0] - a[0], b[1] - a[1]];
    const n = [d[1], -d[0]];
    for (const [u, v] of path) local.push([a[0] + u * d[0] + v * n[0], a[1] + u * d[1] + v * n[1]]);
  }
  const r = (deg * Math.PI) / 180;
  const pts = local.map(([x, y]) => {
    const X = (x - 0.5) * S;
    const Y = (y - 0.5) * S;
    return [cx + X * Math.cos(r) - Y * Math.sin(r), cy + X * Math.sin(r) + Y * Math.cos(r)];
  });
  return piece.arcResample(pts, 1);
}

for (const deg of [0, 17, 45, 133, 260]) {
  test(`corners and sides at ${deg}°`, () => {
    const t = [1, -1, 0, 1];
    const res = piece.analyzeContour(outline(t, 120, deg));
    assert.ok(res, 'piece detected');
    assert.ok(res.quality > 0.6, `quality ${res.quality}`);
    assert.ok(Math.abs(res.side - 120) < 4, `side ${res.side}`);
    // Sides in contour order, any start corner: compare cyclically.
    const types = res.sides.map((s) => s.type);
    const shift = [0, 1, 2, 3].find((k) => t.every((v, i) => types[(i + k) % 4] === v));
    assert.notEqual(shift, undefined, `sides ${types}`);
    const angle = geom.wrapDeg(res.angle - deg + shift * 90);
    assert.ok(Math.abs(angle) < 2, `angle ${res.angle}`);
  });
}

test('counterparts match, equal sides do not', () => {
  const a = piece.analyzeContour(outline([1, 0, 0, 0], 100, 0));
  const b = piece.analyzeContour(outline([0, 0, -1, 0], 100, 0));
  const c = piece.analyzeContour(outline([1, 0, 0, 0], 100, 0));
  const top = (r) => r.sides.find((s) => s.type !== 0);
  assert.ok(piece.sideDistance(top(a), top(b)) < 0.05);
  assert.equal(piece.sideDistance(top(a), top(c)), Infinity);
});

test('grid from piece count', () => {
  for (const [n, asp] of [
    [1000, 70 / 50],
    [500, 49 / 36],
    [2000, 98 / 75],
  ]) {
    const { cols, rows } = geom.gridFor(n, asp);
    assert.ok(Math.abs(cols * rows - n) / n < 0.03, `${n}: ${cols}×${rows}`);
    assert.ok(Math.abs(Math.log(cols / rows / asp)) < 0.1, `${n}: ${cols}×${rows}`);
  }
  const g = geom.gridFor(100, 1);
  assert.equal(g.cols * g.rows, 100);
});

test('homography maps corners', () => {
  const src = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const dst = [
    [10, 20],
    [110, 30],
    [100, 140],
    [5, 120],
  ];
  const H = geom.homography(src, dst);
  for (let i = 0; i < 4; i++) {
    const p = geom.applyH(H, ...src[i]);
    assert.ok(Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < 1e-6);
  }
  const Hi = geom.invertH(H);
  const q = geom.applyH(Hi, ...geom.applyH(H, 0.3, 0.7));
  assert.ok(Math.hypot(q[0] - 0.3, q[1] - 0.7) < 1e-9);
});
