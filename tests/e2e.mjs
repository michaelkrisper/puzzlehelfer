/**
 * End-to-end in headless Chrome at phone size: load reference, accept
 * corners, set piece count, load pieces photo, check suggestions.
 * Photos come from tools/synth.py (needs python3 with numpy and Pillow).
 *
 *   node tests/e2e.mjs [URL] [output dir]
 * Without a URL, starts its own server on port 8794. E2E_PARTIAL=1 tests
 * a half-finished puzzle in the photo (arrows to the places).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 8794;
const cdpPort = 9337;
let base = process.argv[2];
const out = process.argv[3] ?? join(tmpdir(), 'puzzlehelfer-shots');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'puzzlehelfer-e2e-'));
const profile = mkdtempSync(join(tmpdir(), 'puzzlehelfer-chrome-'));
const fx = join(work, 'fx');
// E2E_PARTIAL=1: half-finished puzzle in the photo, arrows point to the places.
const partial = !!process.env.E2E_PARTIAL;
const count = partial ? 60 : 24;
const gen = spawnSync('python3', [
  join(root, 'tools/synth.py'),
  '--image',
  join(root, 'tests/fixtures/picture.jpg'),
  '--pieces',
  String(count),
  '--seed',
  '7',
  ...(partial ? ['--mode', 'partial', '--filled', '0.6', '--piece-px', '90'] : []),
  '--out',
  fx,
]);
if (gen.status !== 0) throw new Error(String(gen.stderr));
const truth = JSON.parse(readFileSync(join(fx, 'truth.json'), 'utf8'));

let server = null;
if (!base) {
  server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
  });
  base = `http://127.0.0.1:${port}/`;
}
const chrome = spawn(
  process.env.CHROME ?? 'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let msgId = 0;
const pending = new Map();
const errors = [];
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expr, ms = 60000) {
  for (let t = 0; t < ms; t += 250) {
    if (await evaluate(expr)) return true;
    await wait(250);
  }
  return false;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'));
}
async function setFile(selector, file) {
  const { root: doc } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
}

let ok = true;
const check = (cond, what) => {
  console.log(cond ? 'ok  ' : 'FAIL', what);
  if (!cond) ok = false;
};

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await wait(200);
    target = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })
      .then((r) => r.json())
      .catch(() => null);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send('Page.navigate', { url: base });
  check(
    await until(`document.getElementById('engine')?.classList.contains('ready')`, 90000),
    'image recognition loaded',
  );
  await shot('1-start');

  // 1. Reference
  await setFile('input[data-ref]:not([capture])', join(fx, 'reference.jpg'));
  check(await until(`!document.getElementById('ref-crop').hidden`), 'crop view appears');
  check(
    await until(`crop.quad && crop.quad[0][0] > state.refImg.image.width * 0.06`, 30000),
    'picture border found automatically',
  );
  const quad = await evaluate('JSON.stringify(crop.quad)');
  // referenceQuad refers to reference.jpg; the app may downscale.
  const jpgW = Number(
    spawnSync('python3', [
      '-c',
      'import sys; from PIL import Image; print(Image.open(sys.argv[1]).width)',
      join(fx, 'reference.jpg'),
    ]).stdout,
  );
  const f = (await evaluate('state.refImg.image.width')) / jpgW;
  const err = Math.max(
    ...JSON.parse(quad).map((p, i) =>
      Math.hypot(p[0] - truth.referenceQuad[i][0] * f, p[1] - truth.referenceQuad[i][1] * f),
    ),
  );
  check(err < 15, `reference corners accurate to ${err.toFixed(1)} px`);
  await shot('2-crop');
  await evaluate(`document.getElementById('crop-ok').click()`);
  await evaluate(`setCount(${count})`);
  check(await until(`!document.getElementById('tab-scene').disabled && state.refView`), 'reference prepared');
  check(
    (await evaluate('[state.cols, state.rows].join("x")')) === `${truth.cols}x${truth.rows}`,
    `grid ${truth.cols}×${truth.rows}`,
  );
  await shot('3-reference');

  // 2. Pieces photo, in the second tab
  await evaluate(`document.getElementById('tab-scene').click()`);
  check(await evaluate(`!document.getElementById('step-scene').hidden`), 'tab "Teile" opens');
  await setFile('input[data-scene]:not([capture])', join(fx, 'scene.jpg'));
  check(await until('state.result !== null', 120000), 'pieces photo analysed');
  await wait(300);
  const res = await evaluate(`(() => {
    const info = state.result.scenes[0];
    return { width: info.width, sugg: state.result.suggestions.map((s) => ({ c: s.center, row: s.row, col: s.col, turn: s.turn, sure: s.sure })) };
  })()`);
  const k = res.width / truth.scene.width;
  let right = 0;
  let wrongSure = 0;
  for (const t of truth.loose) {
    const s = res.sugg.find((x) => Math.hypot(x.c[0] - t.cx * k, x.c[1] - t.cy * k) < 30 * k + 10);
    if (!s) continue;
    const dt = ((((s.turn + t.angle + 180) % 360) + 360) % 360) - 180;
    const good = s.row === t.row && s.col === t.col && Math.abs(dt) < 20;
    if (good) right++;
    else if (s.sure) wrongSure++;
  }
  check(
    right >= truth.loose.length * 0.8,
    `${right}/${truth.loose.length} pieces with right place and rotation`,
  );
  if (partial) {
    check(await evaluate('!!state.result.scenes[0].board'), 'half-finished puzzle in photo detected');
    check(
      await evaluate(`state.result.suggestions.filter((s) => s.sure && s.target).length > 0`),
      'arrows to the places',
    );
  }
  check(wrongSure === 0, `no wrong sure suggestions (${wrongSure})`);
  await evaluate(`document.getElementById('result').scrollIntoView()`);
  await shot('4-result');
  // Frame first: only pieces with a place on the border.
  await evaluate(`document.getElementById('edge-only').click()`);
  check(
    await evaluate(`state.edgeOnly && document.getElementById('edge-only').textContent === 'Alle Teile'`),
    'border-only view switches on',
  );
  await shot('4-border');
  await evaluate(`document.getElementById('edge-only').click()`);
  // Zoom in: degree labels and arrows must become readable.
  const clip = await evaluate(`(() => {
    zoomAt(view.cssW / 2, view.cssH / 2, 2.6);
    clampView();
    drawViewer();
    const r = document.getElementById('viewer').getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 };
  })()`);
  const z = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  writeFileSync(join(out, '4-zoom.png'), Buffer.from(z.data, 'base64'));

  // Step by step: the surest piece first, its candidate places, skip moves on.
  check(
    await evaluate(
      `!document.getElementById('step').hidden && document.querySelectorAll('#step-cands .cand').length > 0 && document.querySelectorAll('#piece-list .piece-row').length > 0`,
    ),
    'step card with candidate places and piece list',
  );
  await shot('4-step');
  const before = await evaluate(`JSON.stringify(state.focus)`);
  await evaluate(`document.getElementById('step-skip').click()`);
  check((await evaluate(`JSON.stringify(state.focus)`)) !== before, 'skip goes to the next piece');

  // Details of one piece
  await evaluate(`(() => {
    const s = state.result.suggestions.find((x) => x.sure);
    openDetail(s, state.result.scenes[0]);
  })()`);
  check(await evaluate(`document.getElementById('detail').open`), 'detail view opens');
  await shot('5-detail');
  check(errors.length === 0, `no errors in the console ${errors.join(' | ')}`);
} catch (err) {
  console.log('FAIL', err.message);
  ok = false;
} finally {
  chrome.kill();
  server?.kill();
  await wait(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? 'All good' : 'Failed', `– images in ${out}`);
process.exit(ok ? 0 : 1);
