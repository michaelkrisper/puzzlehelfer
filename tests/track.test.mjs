import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('../core/track.js');
const { tracker, update, addShot, target, overlap, covered } = globalThis.PH.track;

// A table of smoothed noise, seen through a 96 × 72 window.
const TW = 700;
const TH = 500;
let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
let table = Float32Array.from({ length: TW * TH }, () => rnd() * 255);
for (let pass = 0; pass < 3; pass++) {
  const t = new Float32Array(TW * TH);
  for (let y = 1; y < TH - 1; y++)
    for (let x = 1; x < TW - 1; x++) {
      let s = 0;
      for (let k = -1; k <= 1; k++) for (let l = -1; l <= 1; l++) s += table[(y + k) * TW + x + l];
      t[y * TW + x] = s / 9;
    }
  table = t;
}
const W = 96;
const H = 72;
// View with its corner at (x, y), between pixels bilinear; brighter by gain.
function view(x, y, gain = 1) {
  const g = new Float32Array(W * H);
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const i = (iy + v) * TW + ix + u;
      const p =
        table[i] * (1 - fx) * (1 - fy) +
        table[i + 1] * fx * (1 - fy) +
        table[i + TW] * (1 - fx) * fy +
        table[i + TW + 1] * fx * fy;
      g[v * W + u] = p * gain + 4 * (rnd() - 0.5);
    }
  return g;
}

test('follows a sweep and knows where to hold', () => {
  const t = tracker(W, H);
  const start = [100, 100];
  // Right along a row, down, back left: 3 px per frame, exposure drifting.
  const path = [];
  for (let k = 0; k <= 120; k++) path.push([start[0] + 3 * k, start[1]]);
  for (let k = 1; k <= 15; k++) path.push([start[0] + 360, start[1] + 3 * k]);
  for (let k = 1; k <= 120; k++) path.push([start[0] + 360 - 3 * k, start[1] + 45]);
  let worst = 0;
  let shots = 0;
  path.forEach(([x, y], i) => {
    const g = view(x, y, 1 + 0.2 * Math.sin(i / 20));
    update(t, g);
    if (!t.shots.length || t.cover < 0.5) {
      addShot(t, g, null);
      shots++;
    }
    assert.ok(!t.lost, `lost at frame ${i}`);
    worst = Math.max(worst, Math.hypot(t.pos[0] - (x - start[0]), t.pos[1] - (y - start[1])));
  });
  assert.ok(worst < 1.5, `off by ${worst.toFixed(2)} px`);
  // Half a view new per photo: 9 along the first row; back along the second,
  // which the first covers by a third, fewer.
  assert.ok(shots >= 13 && shots <= 17, `${shots} photos`);
});

test('found again after a jump back onto a photo', () => {
  const t = tracker(W, H);
  update(t, view(200, 200));
  addShot(t, view(200, 200), null);
  update(t, view(300, 300));
  assert.ok(t.lost);
  update(t, view(230, 215));
  assert.ok(!t.lost);
  assert.ok(Math.hypot(t.pos[0] - 30, t.pos[1] - 15) < 1);
});

test('target: where half the view is new', () => {
  const t = tracker(W, H);
  addShot(t, view(0, 0), null);
  t.pos = [10, 0];
  let d = target(t, 0.5);
  assert.ok(Math.abs(d.dx - 48) < 0.5 && d.dy === 0);
  assert.ok(Math.abs(overlap(d.dx, d.dy, W, H) - 0.5) < 0.01);
  // A second row: the first one above counts.
  t.pos = [0, 36];
  addShot(t, view(0, 36), null);
  t.shots.push({ x: 96, y: 0 });
  t.pos = [5, 36];
  d = target(t, 0.5);
  assert.equal(d.s, t.shots[1]);
  assert.ok(Math.abs(covered(t, [d.s.x + d.dx, d.s.y + d.dy]) - 0.5) < 0.01);
  assert.ok(d.dx > 80, `${d.dx}`);
});
