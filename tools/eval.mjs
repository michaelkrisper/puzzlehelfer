// Measures recognition on one scene from tools/synth.py.
// node tools/eval.mjs DIR [--max 2000] [--clean] [--json]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export async function loadCore() {
  const p = require(join(root, 'vendor/opencv.js'));
  const cv = await new Promise((r) => p.then(r));
  for (const f of [
    'geom',
    'piece',
    'segment',
    'reference',
    'match',
    'fit',
    'board',
    'knn',
    'feature',
    'stitch',
    'pipeline',
  ])
    require(join(root, `core/${f}.js`));
  return { cv, PH: globalThis.PH };
}

// Load an image as RGBA via PIL, longest side at most max pixels.
export function loadImage(path, max = 0) {
  const py = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
m = int(sys.argv[2])
if m and max(im.size) > m:
    f = m / max(im.size)
    im = im.resize((round(im.width * f), round(im.height * f)), Image.LANCZOS)
sys.stdout.buffer.write(im.width.to_bytes(4, 'little') + im.height.to_bytes(4, 'little') + im.tobytes())
`;
  const buf = execFileSync('python3', ['-P', '-c', py, path, String(max)], { maxBuffer: 1 << 30 });
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  return { width, height, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, width * height * 4) };
}

// A bad box photo: small, blurry, colour cast, glare, heavy JPEG compression.
// That is what a photographed lid picture looks like.
export function loadBadReference(path) {
  const py = `
import io, os, sys
import numpy as np
from PIL import Image, ImageFilter
on = os.environ.get('DEGRADE', 'small,blur,cast,glare,noise,jpeg').split(',')
im = Image.open(sys.argv[1]).convert('RGB')
if 'small' in on:
    f = 900 / max(im.size)
    im = im.resize((round(im.width * f), round(im.height * f)), Image.BILINEAR)
if 'blur' in on:
    im = im.filter(ImageFilter.GaussianBlur(1.6))
a = np.asarray(im).astype(np.float32) / 255
if 'cast' in on:
    a = a ** 0.85 * np.array([1.08, 1.0, 0.86])
h, w = a.shape[:2]
if 'glare' in on:
    yy, xx = np.mgrid[0:h, 0:w]
    glare = np.exp(-(((xx - 0.7 * w) / (0.25 * w)) ** 2 + ((yy - 0.3 * h) / (0.2 * h)) ** 2))
    a = a * (1 - 0.45 * glare[..., None]) + 0.45 * glare[..., None]
if 'noise' in on:
    a = a + np.random.default_rng(3).normal(0, 0.02, a.shape)
im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
buf = io.BytesIO()
im.save(buf, 'JPEG', quality=35 if 'jpeg' in on else 95)
im = Image.open(buf).convert('RGBA')
sys.stdout.buffer.write(im.width.to_bytes(4, 'little') + im.height.to_bytes(4, 'little') + im.tobytes())
`;
  const buf = execFileSync('python3', ['-c', py, path], { maxBuffer: 1 << 30 });
  const width = buf.readUInt32LE(0);
  const height = buf.readUInt32LE(4);
  return { width, height, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + 8, width * height * 4) };
}

const wrap = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export async function evaluate(dir, opts = {}) {
  const { cv, PH } = await loadCore();
  const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
  const t0 = performance.now();
  let refImg;
  let quad;
  if (opts.clean) {
    refImg = loadImage(join(dir, 'reference_clean.png'), 2400);
    quad = [
      [0, 0],
      [refImg.width, 0],
      [refImg.width, refImg.height],
      [0, refImg.height],
    ];
  } else if (opts.badref) {
    refImg = loadBadReference(join(dir, 'reference.jpg'));
    quad = PH.reference.findPictureQuad(cv, refImg);
    if (opts.truthQuad) {
      const w0 = loadImage(join(dir, 'reference.jpg'), 0).width;
      quad = truth.referenceQuad.map(([x, y]) => [(x * refImg.width) / w0, (y * refImg.width) / w0]);
    }
  } else {
    refImg = loadImage(join(dir, 'reference.jpg'), 2400);
    quad = PH.reference.findPictureQuad(cv, refImg);
  }
  const ref = PH.reference.buildReference(cv, refImg, quad, truth.cols, truth.rows);
  const t1 = performance.now();
  const img = loadImage(join(dir, 'scene.jpg'), opts.max ?? 4000);
  const scene = PH.pipeline.analyzeScene(cv, img, ref);
  const f = scene.width / truth.scene.width;
  const t2 = performance.now();
  const sugg = PH.pipeline.solve(ref, [scene]);
  const t3 = performance.now();

  const side = Math.sqrt(scene.pieceArea || 1);
  const rows = [];
  let found = 0;
  let cellOk = 0;
  let rotOk = 0;
  let accepted = 0;
  let acceptedOk = 0;
  let cornerOk = 0;
  for (const t of truth.loose) {
    const tx = t.cx * f;
    const ty = t.cy * f;
    let best = null;
    let bd = Infinity;
    for (const s of sugg) {
      const d = Math.hypot(s.center[0] - tx, s.center[1] - ty);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best || bd > side * 0.25) {
      rows.push({ t, status: 'missed' });
      continue;
    }
    found++;
    const needed = -t.angle;
    const angErr = Math.abs(wrap(best.corners ? angleOf(best.corners) - t.angle : 999));
    const cornersGood = Math.min(angErr % 90, 90 - (angErr % 90)) < 6;
    if (cornersGood) cornerOk++;
    const cellGood = best.row === t.row && best.col === t.col;
    const rotGood = best.cell !== null && Math.abs(wrap(best.turn - needed)) < 20;
    if (cellGood) cellOk++;
    if (cellGood && rotGood) rotOk++;
    if (best.sure ?? best.step) {
      accepted++;
      if (cellGood && rotGood) acceptedOk++;
    }
    rows.push({ t, best, cellGood, rotGood, cornersGood });
  }
  const res = {
    dir,
    grid: `${truth.cols}x${truth.rows}`,
    loose: truth.loose.length,
    detected: scene.pieces.length,
    unclear: scene.unclear.length,
    board: scene.board
      ? {
          inliers: scene.board.inliers,
          filled: scene.board.filled.length,
          truthFilled: truth.filled?.length ?? 0,
        }
      : null,
    found,
    cornerOk,
    cellOk,
    cellRotOk: rotOk,
    accepted,
    acceptedOk,
    ms: { ref: Math.round(t1 - t0), scene: Math.round(t2 - t1), solve: Math.round(t3 - t2) },
  };
  if (scene.board && truth.filled) {
    const tf = new Set(truth.filled.map(([r, c]) => r * truth.cols + c));
    const bf = new Set(scene.board.filled);
    res.board.filledWrong = [...bf].filter((x) => !tf.has(x)).length;
    res.board.filledMissed = [...tf].filter((x) => !bf.has(x)).length;
  }
  return { res, rows };
}

function angleOf(c) {
  return (Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]) * 180) / Math.PI;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const max = args.includes('--max') ? Number(args[args.indexOf('--max') + 1]) : 4000;
  const { res, rows } = await evaluate(dir, {
    max,
    clean: args.includes('--clean'),
    badref: args.includes('--badref'),
    truthQuad: args.includes('--truth-quad'),
  });
  if (args.includes('--verbose')) {
    for (const r of rows) {
      if (r.status) console.log('missed', r.t.row, r.t.col);
      else
        console.log(
          `${r.t.row},${r.t.col} a=${r.t.angle.toFixed(0)} -> ${r.best.row},${r.best.col} turn=${r.best.turn?.toFixed(0)} conf=${r.best.conf?.toFixed(2)} step=${r.best.step} ${r.cellGood ? 'CELL' : '----'} ${r.rotGood ? 'ROT' : '---'} ${r.cornersGood ? '' : 'CORNERS?'}`,
        );
    }
  }
  console.log(JSON.stringify(res));
  process.exit(0);
}
