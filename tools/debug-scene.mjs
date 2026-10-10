// Zwischenergebnisse einer Szene als Bilder: Maske und erkannte Ecken.
// node tools/debug-scene.mjs DIR OUTDIR
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCore, loadImage } from './eval.mjs';

const [dir, out] = process.argv.slice(2);
const { cv, PH } = await loadCore();
const img = loadImage(join(dir, 'scene.jpg'), Number(process.env.MAX ?? 4000));
const lab = PH.segment.rgbaToLab(img.data, img.width * img.height);
const seg = PH.segment.segmentScene(cv, img, lab, { refine: process.env.REFINE !== '0' });
console.log(
  'threshold',
  seg.threshold.toFixed(2),
  'pieceArea',
  Math.round(seg.pieceArea),
  'pieces',
  seg.pieces.length,
  'big',
  seg.big.length,
);
const reasons = {};
const lines = [];
for (const p of seg.pieces) {
  const s = p.touches ? null : PH.piece.analyzeContour(p.contour);
  const r = p.touches ? 'touches' : !s ? 'null' : s.quality < 0.25 ? 'quality' : 'ok';
  reasons[r] = (reasons[r] ?? 0) + 1;
  if (s) lines.push({ c: s.corners, q: s.quality, sides: s.sides.map((x) => x.type) });
}
console.log(reasons);
const qs = lines.map((l) => l.q.toFixed(2));
console.log('qualities', qs.join(' '));
const raw = Buffer.from(seg.mask.data);
writeFileSync(join(out, 'mask.raw'), raw);
writeFileSync(join(out, 'corners.json'), JSON.stringify(lines));
execFileSync('python3', [
  '-I',
  '-c',
  `
import sys, json
from PIL import Image, ImageDraw
w, h = int(sys.argv[2]), int(sys.argv[3])
m = Image.frombytes('L', (w, h), open(sys.argv[1] + '/mask.raw', 'rb').read()).convert('RGB')
d = ImageDraw.Draw(m)
for l in json.load(open(sys.argv[1] + '/corners.json')):
    c = [tuple(p) for p in l['c']]
    d.line(c + [c[0]], fill=(255, 0, 0) if l['q'] < 0.25 else (0, 200, 0), width=2)
    d.ellipse([c[0][0]-4, c[0][1]-4, c[0][0]+4, c[0][1]+4], fill=(0, 0, 255))
m.save(sys.argv[1] + '/mask.png')
`,
  out,
  String(img.width),
  String(img.height),
]);
process.exit(0);
