// Photo stitching: ORB homography between overlapping photos of the table.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { before, test } from 'node:test';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
require('../core/geom.js');
require('../core/stitch.js');
const { applyH } = globalThis.PH.geom;
const { describe, match } = globalThis.PH.stitch;

let cv;
before(async () => {
  const p = require(join(root, 'vendor/opencv.js'));
  cv = await new Promise((r) => p.then(r));
});

const W = 1200;
const H = 900;

// Random coloured rectangles: plenty of corners for ORB, reproducible.
function scene(seed) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let k = 0; k < 400; k++) {
    const x0 = Math.floor(rnd() * W);
    const y0 = Math.floor(rnd() * H);
    const w = 10 + Math.floor(rnd() * 80);
    const h = 10 + Math.floor(rnd() * 80);
    const c = [rnd() * 255, rnd() * 255, rnd() * 255];
    for (let y = y0; y < Math.min(H, y0 + h); y++)
      for (let x = x0; x < Math.min(W, x0 + w); x++) {
        const i = (y * W + x) * 4;
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
      }
  }
  return { width: W, height: H, data };
}

// Applies a 3×3 homography (row-major) to an image, like a second photo
// taken from a slightly different spot.
function warp(image, Hm) {
  const src = cv.matFromImageData(image);
  const dst = new cv.Mat();
  const M = cv.matFromArray(3, 3, cv.CV_64F, Hm);
  cv.warpPerspective(
    src,
    dst,
    M,
    new cv.Size(W, H),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255),
  );
  const out = { width: W, height: H, data: new Uint8ClampedArray(dst.data) };
  for (const m of [src, dst, M]) m.delete();
  return out;
}

test('finds the homography between two overlapping photos', () => {
  const a = scene(1);
  const t = (4 * Math.PI) / 180;
  const truth = [Math.cos(t), -Math.sin(t), -120, Math.sin(t), Math.cos(t), 60, 0, 0, 1];
  const b = warp(a, truth);
  const r = match(cv, describe(cv, a), describe(cv, b));
  assert.ok(r, 'photos should match');
  assert.ok(r.inliers >= 40, `inliers ${r.inliers}`);
  for (const [x, y] of [
    [400, 300],
    [800, 300],
    [600, 600],
  ]) {
    const [u, v] = applyH(r.H, x, y);
    const [eu, ev] = applyH(truth, x, y);
    assert.ok(Math.hypot(u - eu, v - ev) < 3, `(${x},${y}) -> (${u},${v}), expected (${eu},${ev})`);
  }
});

test('rejects photos that do not overlap', () => {
  assert.equal(match(cv, describe(cv, scene(1)), describe(cv, scene(2))), null);
});

test('rejects a mirrored photo', () => {
  const a = scene(3);
  const b = warp(a, [-1, 0, W - 1, 0, 1, 0, 0, 0, 1]);
  assert.equal(match(cv, describe(cv, a), describe(cv, b)), null);
});

test('a blank photo has too few points to match', () => {
  const blank = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
  const d = describe(cv, blank);
  assert.ok(d.n < 40);
  assert.equal(match(cv, d, describe(cv, scene(4))), null);
});
