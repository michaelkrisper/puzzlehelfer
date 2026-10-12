// Full recognition in Node on a synthetic photo with 24 pieces.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluate } from '../tools/eval.mjs';

const root = join(import.meta.dirname, '..');

test('24 loose pieces: place and rotation', { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlehelfer-test-'));
  try {
    const gen = spawnSync('python3', [
      join(root, 'tools/synth.py'),
      '--image',
      join(root, 'tests/fixtures/picture.jpg'),
      '--pieces',
      '24',
      '--seed',
      '3',
      '--out',
      dir,
    ]);
    assert.equal(gen.status, 0, String(gen.stderr));
    const { res } = await evaluate(dir);
    const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
    assert.ok(res.detected >= truth.loose.length - 2, `detected ${res.detected}`);
    assert.ok(res.cellRotOk >= truth.loose.length * 0.8, `right ${res.cellRotOk}`);
    assert.equal(res.accepted, res.acceptedOk, 'all sure suggestions are right');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('half-finished puzzle in photo: board and gaps', { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlehelfer-test-'));
  try {
    const gen = spawnSync('python3', [
      join(root, 'tools/synth.py'),
      '--image',
      join(root, 'tests/fixtures/picture.jpg'),
      '--pieces',
      '60',
      '--mode',
      'partial',
      '--filled',
      '0.6',
      '--piece-px',
      '90',
      '--seed',
      '4',
      '--out',
      dir,
    ]);
    assert.equal(gen.status, 0, String(gen.stderr));
    const { res } = await evaluate(dir);
    assert.ok(res.board, 'board found');
    assert.equal(res.board.filledWrong, 0, 'no wrongly filled places');
    assert.ok(res.cellRotOk >= res.loose * 0.75, `right ${res.cellRotOk}/${res.loose}`);
    assert.equal(res.accepted, res.acceptedOk, 'all sure suggestions are right');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
