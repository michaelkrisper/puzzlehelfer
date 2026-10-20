import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('../core/track.js');
const { tracker, update, addShot, target, overlap, covered, turned } = globalThis.PH.track;

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

// The view turned by deg about its centre.
function turnedView(x, y, deg) {
  const big = new Float32Array((W + 40) * (H + 40));
  const ix = Math.floor(x) - 20;
  const iy = Math.floor(y) - 20;
  for (let v = 0; v < H + 40; v++)
    for (let u = 0; u < W + 40; u++) big[v * (W + 40) + u] = table[(iy + v) * TW + ix + u];
  const r = (deg * Math.PI) / 180;
  const g = new Float32Array(W * H);
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const a = Math.cos(r) * (u - cx) - Math.sin(r) * (v - cy) + cx + 20;
      const b = Math.sin(r) * (u - cx) + Math.cos(r) * (v - cy) + cy + 20;
      const i = Math.floor(a);
      const j = Math.floor(b);
      const fa = a - i;
      const fb = b - j;
      const k = j * (W + 40) + i;
      g[v * W + u] =
        big[k] * (1 - fa) * (1 - fb) +
        big[k + 1] * fa * (1 - fb) +
        big[k + W + 40] * (1 - fa) * fb +
        big[k + W + 41] * fa * fb +
        4 * (rnd() - 0.5);
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

for (const sign of [1, -1])
  test(`turned phone, gyroscope turning ${sign > 0 ? 'with' : 'against'} the picture`, () => {
    const t = tracker(W, H);
    const start = [150, 150];
    let last = 0;
    let worst = 0;
    for (let k = 0; k <= 100; k++) {
      const x = start[0] + 3 * k;
      const y = start[1] + 0.3 * k;
      const deg = 15 * Math.sin(k / 25);
      const g = turnedView(x, y, deg);
      update(t, g, { dt: 0.1, turn: sign * (deg - last), dv: null });
      last = deg;
      if (!t.shots.length || t.cover < 0.5) addShot(t, g, null);
      assert.ok(!t.lost, `lost at frame ${k}`);
      worst = Math.max(worst, Math.hypot(t.pos[0] - (x - start[0]), t.pos[1] - (y - start[1])));
    }
    assert.ok(worst < 2, `off by ${worst.toFixed(2)} px`);
    assert.equal(t.spin, -sign);
  });

test('a moment of blur carried by the accelerometer', () => {
  // The phone's x and y against the picture: turned and mirrored, 250 px/m.
  const K = 250;
  const toPhone = ([vx, vy]) => [-vy / K, -vx / K];
  // Moves of 60 px in 1 s, slowing down at both ends, a pause after each.
  const moves = [
    [60, 0],
    [0, 60],
    [60, 10],
    [-20, 60],
    [60, -30],
    [50, 40],
  ];
  const run = (sensors) => {
    seed = 11;
    const t = tracker(W, H);
    let p = [120, 120];
    let lostInBlur = false;
    let off = 0;
    moves.forEach((d, n) => {
      const blur = n === moves.length - 1;
      let vBefore = [0, 0];
      for (let k = 1; k <= 13; k++) {
        const tau = Math.min(1, k / 10);
        const e = (1 - Math.cos(Math.PI * tau)) / 2;
        const s = (Math.PI / 2) * Math.sin(Math.PI * tau);
        const x = p[0] + d[0] * e;
        const y = p[1] + d[1] * e;
        const v = [d[0] * s, d[1] * s];
        const dv = toPhone([v[0] - vBefore[0], v[1] - vBefore[1]]).map(
          (a) => a + 0.002 + 0.003 * (rnd() - 0.5),
        );
        vBefore = v;
        const dark = blur && k >= 4 && k <= 7;
        const g = dark ? Float32Array.from({ length: W * H }, () => rnd() * 255) : view(x, y);
        update(t, g, { dt: 0.1, turn: 0, dv: sensors ? dv : null });
        if (!t.shots.length || (!t.lost && t.cover < 0.5)) addShot(t, g, null);
        if (dark && t.lost) lostInBlur = true;
        if (blur && k === 8) off = Math.hypot(t.pos[0] - (x - 120), t.pos[1] - (y - 120));
      }
      p = [p[0] + d[0], p[1] + d[1]];
    });
    return { lostInBlur, off };
  };
  const without = run(false);
  assert.ok(without.lostInBlur);
  const carried = run(true);
  assert.ok(!carried.lostInBlur);
  assert.ok(carried.off < 2, `off by ${carried.off.toFixed(2)} px after the blur`);
});
