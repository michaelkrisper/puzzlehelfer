import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('../core/geom.js');
const { gridFor, gridFromBorder, borderCost } = globalThis.PH.geom;

// Thickness of the finished part as measured on real photos of a 12 × 20
// puzzle with rectangular pieces (two rows done at the bottom and right).
const aspect = 988 / 1267;
const photos = [
  { top: 1 / 21.2, bottom: 1 / 9.6, left: 1 / 11.4, right: 1 / 5.6 },
  { top: 1 / 23.9, bottom: 1 / 9.6 },
  { top: 1 / 19.9, bottom: 1 / 9.6, left: 1 / 11.7, right: 1 / 12.9 },
];

test('rectangular pieces: grid from the finished border', () => {
  const square = gridFor(240, aspect);
  assert.notDeepEqual([square.cols, square.rows], [12, 20]);
  for (const b of photos) {
    const g = gridFromBorder(240, b, aspect);
    assert.deepEqual([g.cols, g.rows], [12, 20]);
    assert.ok(g.cost < borderCost(240, b, aspect, square.cols, square.rows) / 3);
  }
});

test('square pieces: the border does not overrule a fitting grid', () => {
  const b = { top: 1 / 27, bottom: 1 / 27, left: 1 / 38, right: 1 / 38 };
  assert.ok(borderCost(1000, b, 38 / 27, 38, 26) < 0.01);
  assert.ok(borderCost(1000, b, 38 / 27, 37, 27) < 0.01);
});

test('no border, no grid', () => {
  assert.equal(gridFromBorder(240, {}, aspect), null);
  assert.equal(gridFromBorder(240, null, aspect), null);
});
