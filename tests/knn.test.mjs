import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
require('../core/knn.js');
const { knn } = globalThis.PH;

// Deterministic pseudo-random bytes (xorshift32).
function bytesOf(n, seed) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 255;
  }
  return out;
}

const popcount = (v) => {
  let c = 0;
  for (; v; v &= v - 1) c++;
  return c;
};
const dist = {
  hamming: (a, b) => popcount(a ^ b),
  l2: (a, b) => (a - b) * (a - b),
};

// Reference: two smallest distances by brute force in plain JS.
function reference(kind, q, nq, r, nr, bytes) {
  const out = [];
  for (let i = 0; i < nq; i++) {
    const d = [];
    for (let j = 0; j < nr; j++) {
      let s = 0;
      for (let k = 0; k < bytes; k++) s += dist[kind](q[i * bytes + k], r[j * bytes + k]);
      d.push(s);
    }
    const sorted = [...d].sort((a, b) => a - b);
    out.push([d.indexOf(sorted[0]), sorted[0], sorted[1] ?? 0xffffffff]);
  }
  return out;
}

for (const [kind, bytes] of [
  ['hamming', 32],
  ['hamming', 64],
  ['l2', 128],
]) {
  test(`knn2 ${kind} (${bytes} bytes) matches brute force`, { skip: !knn.available() }, () => {
    const nq = 150; // more than one call batch of 64
    const nr = 90;
    const q = bytesOf(nq * bytes, 7);
    const r = bytesOf(nr * bytes, 11);
    const got = knn.knn2(kind, q, nq, r, nr, bytes);
    const want = reference(kind, q, nq, r, nr, bytes);
    for (let i = 0; i < nq; i++) {
      // Ties may pick either index; the distances must agree exactly.
      assert.equal(got[i * 3 + 1], want[i][1], `query ${i}: nearest distance`);
      assert.equal(got[i * 3 + 2], want[i][2], `query ${i}: second distance`);
      assert.equal(
        reference(kind, q.subarray(i * bytes), 1, r.subarray(got[i * 3] * bytes), 1, bytes)[0][1],
        want[i][1],
      );
    }
  });
}

test('knn2 finds an exact copy at distance 0', { skip: !knn.available() }, () => {
  const bytes = 32;
  const r = bytesOf(40 * bytes, 3);
  const q = r.slice(17 * bytes, 18 * bytes);
  const got = knn.knn2('hamming', q, 1, r, 40, bytes);
  assert.equal(got[0], 17);
  assert.equal(got[1], 0);
  assert.ok(got[2] > 0);
});

test('knn2 with a single reference row reports no second neighbour', { skip: !knn.available() }, () => {
  const bytes = 16;
  const r = bytesOf(bytes, 5);
  const q = bytesOf(2 * bytes, 9);
  const got = knn.knn2('l2', q, 2, r, 1, bytes);
  assert.equal(got[0], 0);
  assert.equal(got[2], 0xffffffff);
  assert.equal(got[5], 0xffffffff);
});

// Near rows early make most later rows stop after part of the distance
// (wasm/knn.c knn_l2u8); the result must be the same, ties included.
test('knn2 l2 with near and equal rows matches brute force', { skip: !knn.available() }, () => {
  const bytes = 128;
  const nq = 20;
  const nr = 130;
  const q = bytesOf(nq * bytes, 13);
  const r = bytesOf(nr * bytes, 17);
  const noise = bytesOf(nq * bytes, 19);
  for (let i = 0; i < nq; i++)
    for (let k = 0; k < bytes; k++) {
      const v = q[i * bytes + k];
      r[i * bytes + k] = Math.min(255, v + (noise[i * bytes + k] & 1));
      r[(60 + i) * bytes + k] = v;
      r[(100 + i) * bytes + k] = v;
    }
  const got = knn.knn2('l2', q, nq, r, nr, bytes);
  const want = reference('l2', q, nq, r, nr, bytes);
  for (let i = 0; i < nq; i++) assert.deepEqual([...got.subarray(i * 3, i * 3 + 3)], want[i], `query ${i}`);
});
