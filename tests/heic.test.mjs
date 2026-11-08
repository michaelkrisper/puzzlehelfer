import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
require('../core/heic.js');
const { PH } = globalThis;

const file = readFileSync(new URL('fixtures/quarters.heic', import.meta.url));

test('HEIF container: one HEVC image with its clean aperture', () => {
  assert.ok(PH.heic.isHeif(file));
  const h = PH.heic.parse(file);
  assert.equal(h.cols * h.rows, 1);
  assert.deepEqual([h.width, h.height], [64, 64]);
  assert.deepEqual(h.crop, { x: 0, y: 0, width: 64, height: 48 });
  assert.equal(h.rot, 0);
  assert.equal(h.mirror, null);
  // The coded picture: length-prefixed NAL units, the first a slice.
  const d = h.tiles[0].data;
  const len = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  assert.ok(len > 0 && len + 4 <= d.length);
  assert.equal(h.tile.config[0], 1);
});

test('HEVC codec strings: stated profile, then Main', () => {
  // iPhone: Main Still Picture, compatible with Main and Main 10, level 3.
  const c = Uint8Array.from([1, 3, 0x70, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 90]);
  assert.deepEqual(PH.heic.codecs(c), ['hvc1.3.E.L90.B0', 'hvc1.1.6.L90.B0']);
});

test('Not HEIF: JPEG', () => {
  const jpeg = readFileSync(new URL('fixtures/picture.jpg', import.meta.url));
  assert.equal(PH.heic.isHeif(jpeg), false);
  assert.throws(() => PH.heic.parse(jpeg));
});
