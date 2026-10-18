import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
require('../core/geom.js');
require('../core/piece.js');
require('../core/fit.js');
const { PH } = globalThis;

// Unit square piece of side C with a knob of radius C/6 on its right side.
function piece(C, x0, y0, knob) {
  const pts = [];
  for (let s = 0; s < C; s += 0.25) pts.push([x0 + s, y0]);
  for (let s = 0; s < C; s += 0.25) {
    const dy = s - C / 2;
    const out = knob && Math.abs(dy) < C / 6 ? Math.sqrt((C / 6) ** 2 - dy * dy) : 0;
    pts.push([x0 + C + out, y0 + s]);
  }
  for (let s = 0; s < C; s += 0.25) pts.push([x0 + C - s, y0 + C]);
  for (let s = 0; s < C; s += 0.25) pts.push([x0, y0 + C - s]);
  return {
    pts,
    corners: [
      [x0, y0],
      [x0 + C, y0],
      [x0 + C, y0 + C],
      [x0, y0 + C],
    ],
  };
}

test('signed distance of a square piece', () => {
  const { pts, corners } = piece(32, 100, 50, false);
  const P = PH.fit.preparePiece(pts, corners, 32);
  assert.ok(Math.abs(PH.fit.sample(P, 0, 0) + 16) < 0.3);
  assert.ok(Math.abs(PH.fit.sample(P, 20, 0) - 4) < 0.3);
});

test('a piece fits its own gap better than a wrong one, in the right turn', () => {
  const C = 32;
  // Gap at row 2, column 3 whose right neighbour has a hole for a knob: the
  // rim along the right side bulges out.
  const knobbed = piece(C, 3 * C, 2 * C, true);
  const rimRight = knobbed.pts.filter(([x]) => x >= 4 * C - 0.01).flat();
  const rimTop = knobbed.pts.filter(([, y]) => y === 2 * C).flat();
  const G = PH.fit.prepareGap(
    [Float32Array.from(rimTop), Float32Array.from(rimRight), null, null],
    2 * 36 + 3,
    { C, cols: 36 },
    [true, true, false, false],
  );
  // The same piece elsewhere on the table, and a plain square.
  const mine = piece(C, 300, 200, true);
  const plain = piece(C, 300, 200, false);
  const P = PH.fit.preparePiece(mine.pts, mine.corners, C);
  const Q = PH.fit.preparePiece(plain.pts, plain.corners, C);
  const right = PH.fit.fitPiece(P, G, 0, C).e;
  assert.ok(right < 0.01, `own gap ${right}`);
  assert.ok(PH.fit.fitPiece(P, G, 1, C).e > 3 * right + 0.01, 'turned');
  assert.ok(PH.fit.fitPiece(Q, G, 0, C).e > 3 * right + 0.01, 'no knob');
});
