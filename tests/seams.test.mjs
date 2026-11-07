// Grid from the seams of a finished part: comb over the photo, then the
// columns × rows that fit the piece count.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { before, test } from 'node:test';

const require = createRequire(import.meta.url);
const root = join(import.meta.dirname, '..');
require('../core/geom.js');
require('../core/board.js');
const { gridFromSeams } = globalThis.PH.geom;
const { seamGrid } = globalThis.PH.board;

let cv;
before(async () => {
  const p = require(join(root, 'vendor/opencv.js'));
  cv = await new Promise((r) => p.then(r));
});

// Comb curve over periods 0.72..1.38 as seamGrid returns it: background 1,
// bumps [period, strength, phase]; edges lo..hi of the finished part.
function curve(lo, hi, bumps) {
  const sc = [];
  const ph = [];
  for (let i = 0; i < 331; i++) {
    const q = 0.72 + i * 0.002;
    let s = 1;
    let p = 0.37 * q;
    for (const [at, h, phase] of bumps) {
      const v = h * Math.exp(-(((q - at) / 0.004) ** 2));
      if (v > s - 1) p = phase;
      s = Math.max(s, 1 + v);
    }
    sc.push(s);
    ph.push(p);
  }
  return { lo, hi, p0: 0.72, dp: 0.002, sc, ph };
}

test('seams of a finished 12 × 20 puzzle correct a 14 × 17 grid', () => {
  // The photo straight on, in reference pixels; seams are dark lines.
  const C = 20;
  const cols = 14;
  const rows = 17;
  const W = cols * C;
  const H = rows * C;
  const gray = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(170));
  const dark = new cv.Scalar(60);
  for (let k = 1; k < 12; k++) {
    const x = Math.round((k * W) / 12);
    cv.line(gray, new cv.Point(x, 0), new cv.Point(x, H - 1), dark, 1);
  }
  for (let k = 1; k < 20; k++) {
    const y = Math.round((k * H) / 20);
    cv.line(gray, new cv.Point(0, y), new cv.Point(W - 1, y), dark, 1);
  }
  const mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
  const board = { H: [1, 0, 0, 0, 1, 0, 0, 0, 1], corr: null, filled: [...Array(cols * rows).keys()] };
  const seams = seamGrid(cv, board, { C, cols, rows, W, H }, gray, mask);
  gray.delete();
  mask.delete();
  // The comb meets the seams at the edge of the photo too (phase 0).
  const at = (a, q) => a.sc[Math.round((q - a.p0) / a.dp)];
  assert.ok(at(seams.x, 14 / 12) > 2, `x comb ${at(seams.x, 14 / 12)}`);
  assert.ok(at(seams.y, 17 / 20) > 2, `y comb ${at(seams.y, 17 / 20)}`);
  const g = gridFromSeams(seams, 240, 988 / 1267, cols, rows);
  assert.deepEqual([g.cols, g.rows], [12, 20]);
  assert.ok(Math.abs(g.x.from) < 0.1 && Math.abs(g.x.to - cols) < 0.1, `x ${g.x.from}..${g.x.to}`);
  assert.ok(Math.abs(g.y.from) < 0.1 && Math.abs(g.y.to - rows) < 0.1, `y ${g.y.from}..${g.y.to}`);
});

test('a frame keeps only grids whose comb meets its edges', () => {
  // As measured on Cats photos: a comb at the current period, but half a
  // place off the frame; the 12 × 20 comb on it is only a little stronger.
  const seams = {
    x: curve(0, 14, [
      [1.0, 0.3, 0.5],
      [14 / 12, 0.4, 0],
    ]),
    y: curve(0.05, 17, [
      [1.0, 0.5, 0.5],
      [17 / 20, 0.5, 0.05],
    ]),
  };
  const g = gridFromSeams(seams, 240, 988 / 1267, 14, 17);
  assert.deepEqual([g.cols, g.rows], [12, 20]);
});

test('square pieces: a neighbouring grid does not take over', () => {
  // Part of a 36 × 28 puzzle (Great Wave): clear rows, weak columns with a
  // stronger bump at 35 columns.
  const seams = {
    x: curve(22, 36, [
      [0.98, 0.22, 0.3],
      [1.032, 0.3, 0.6],
    ]),
    y: curve(2, 22, [[1.0, 0.8, 0.2]]),
  };
  for (const n of [1000, 1008]) {
    const g = gridFromSeams(seams, n, 1.4, 36, 28);
    assert.deepEqual([g.cols, g.rows, g.x.from, g.x.to], [36, 28, 0, 36]);
  }
});

test('unclear seams, no grid', () => {
  assert.equal(gridFromSeams(null, 240, 0.78, 14, 17), null);
  const flat = { x: curve(0, 14, []), y: curve(0, 17, []) };
  assert.equal(gridFromSeams(flat, 240, 0.78, 14, 17), null);
});
