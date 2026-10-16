// UI: capture and crop the reference, add pieces photos,
// draw suggestions with arrows and rotation.
const { gridFor, gridFromBorder, borderCost, applyH } = PH.geom;
const REF_MAX = 2400;
const SCENE_MAX = 4000;
const COUNTS = [100, 200, 300, 500, 1000, 1500, 2000];
// Same as VERSION in sw.js; bump both together.
const APP_VERSION = 'v27';
const ARROWS = 6;
const $ = (id) => document.getElementById(id);

// ---------- Worker ----------
const worker = new Worker('worker.js');
const pending = new Map();
let nextId = 1;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ready') {
    $('engine').textContent = 'bereit';
    $('engine').classList.add('ready');
    return;
  }
  const p = pending.get(m.id);
  if (!p) return;
  if (m.type === 'progress') {
    setStatus(m.text);
    return;
  }
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message));
  else p.resolve(m.data);
};
worker.onerror = (e) => {
  $('engine').textContent = `Fehler: ${e.message ?? 'Bilderkennung lädt nicht'}`;
};
function call(type, payload = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload });
  });
}

// ---------- Storage (IndexedDB) ----------
const db = new Promise((resolve, reject) => {
  const r = indexedDB.open('puzzlehelfer', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function store(key, value) {
  const d = await db;
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    if (value === undefined) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function load(key) {
  const d = await db;
  return new Promise((resolve, reject) => {
    const r = d.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ---------- Images ----------
// Some browsers cannot read every image through createImageBitmap; the
// <img> element is the second way. Formats the browser cannot open at all
// (HEIC in Chrome) end in an error with a readable message.
async function bitmapOf(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } catch {
      const kind = blob.type || blob.name?.split('.').pop() || 'unbekannt';
      const heic = /hei[cf]/i.test(kind) || /\.hei[cf]$/i.test(blob.name ?? '');
      throw new Error(
        heic
          ? 'HEIC-Fotos (vom iPhone) kann dieser Browser nicht öffnen. Als JPEG speichern oder direkt mit der App fotografieren.'
          : `Der Browser kann dieses Bild nicht öffnen (${kind}).`,
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function decode(blob, max) {
  const bmp = await bitmapOf(blob);
  const f = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * f);
  const h = Math.round(bmp.height * f);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { canvas: c, image: g.getImageData(0, 0, w, h) };
}

// density: canvas pixels per CSS pixel, by default the device's; more for
// pictures that can be zoomed.
function sizeCanvas(cv, cssW, cssH, density = 0) {
  const dpr = Math.max(density, window.devicePixelRatio || 1);
  cv.style.height = `${cssH}px`;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

// ---------- State ----------
const state = {
  refBlob: null,
  refImg: null, // {canvas, image}
  quad: null,
  count: 0, // piece count from the box; required
  cols: 0,
  rows: 0,
  refView: null, // {canvas, view (finer, for zooming), W, H, C}
  featCache: null, // feature points of the reference, see worker.js
  gridManual: false, // columns/rows set with −/+
  gridAuto: false, // grid already taken from a photo
  gridNote: '',
  scenes: [], // {id, canvas, image, url, busy}
  current: null,
  result: null,
  allArrows: false,
  edgeOnly: false,
  placed: [], // pieces put in by the user: {sceneId, index, cell, rot}
  selected: null,
};

function show(id, on) {
  $(id).hidden = !on;
}

// ---------- Step 1: reference ----------
for (const input of document.querySelectorAll('input[data-ref]')) {
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    show('ref-error', false);
    try {
      await setReferenceFile(file);
    } catch (err) {
      console.error(err);
      $('ref-error').textContent = err.message;
      show('ref-error', true);
    }
  });
}

async function setReferenceFile(blob) {
  state.refBlob = blob;
  // Another puzzle: its piece count is asked for anew.
  state.count = 0;
  state.refImg = await decode(blob, REF_MAX);
  show('ref-empty', false);
  show('ref-done', false);
  show('ref-crop', true);
  const w = state.refImg.image.width;
  const h = state.refImg.image.height;
  crop.quad = [
    [w * 0.05, h * 0.05],
    [w * 0.95, h * 0.05],
    [w * 0.95, h * 0.95],
    [w * 0.05, h * 0.95],
  ];
  crop.draw();
  try {
    const { quad } = await call('quad', { image: state.refImg.image });
    crop.quad = quad;
    crop.draw();
  } catch (err) {
    console.warn(err);
  }
}

const crop = {
  quad: null,
  scale: 1,
  // null, {corner, off} or {edge, start, orig}: what the finger moves.
  drag: null,
  draw() {
    const cv = $('crop-canvas');
    const { canvas: img } = state.refImg;
    const cssW = cv.parentElement.clientWidth;
    const cssH = Math.min(window.innerHeight * 0.65, (cssW * img.height) / img.width);
    this.scale = Math.min(cssW / img.width, cssH / img.height);
    this.ox = (cssW - img.width * this.scale) / 2;
    const g = sizeCanvas(cv, cssW, cssH);
    g.fillStyle = '#0b1016';
    g.fillRect(0, 0, cssW, cssH);
    g.drawImage(img, this.ox, 0, img.width * this.scale, img.height * this.scale);
    const pts = this.quad.map(([x, y]) => this.toCss(x, y));
    g.fillStyle = '#0008';
    g.beginPath();
    g.rect(0, 0, cssW, cssH);
    g.moveTo(...pts[0]);
    for (const p of pts.slice(1).reverse()) g.lineTo(...p);
    g.closePath();
    g.fill('evenodd');
    g.strokeStyle = '#4fb3ff';
    g.lineWidth = 2;
    poly(g, pts);
    g.stroke();
    for (const p of pts) {
      g.beginPath();
      g.arc(p[0], p[1], 11, 0, Math.PI * 2);
      g.fillStyle = '#4fb3ffcc';
      g.fill();
      g.strokeStyle = '#fff';
      g.stroke();
    }
    // Edge handles move a whole side.
    for (let i = 0; i < 4; i++) {
      const [x, y] = this.edgeMid(i);
      const [cx, cy] = this.toCss(x, y);
      g.beginPath();
      g.arc(cx, cy, 7, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.strokeStyle = '#4fb3ff';
      g.lineWidth = 3;
      g.stroke();
    }
    if (this.drag) this.loupe(g, cssW);
  },
  // Magnified view of the dragged point above the finger, which covers it.
  loupe(g, cssW) {
    const { canvas: img } = state.refImg;
    const [fx, fy] =
      this.drag.corner !== undefined ? this.quad[this.drag.corner] : this.edgeMid(this.drag.edge);
    const D = 130;
    const k = this.scale * 4; // CSS pixels per image pixel in the loupe
    const [px, py] = this.toCss(fx, fy);
    // Above the finger; near the top beside it, towards the middle (below
    // would be under the hand).
    const above = py - D * 0.95 > D / 2;
    const lx = Math.max(D / 2 + 4, Math.min(cssW - D / 2 - 4, above ? px : px < cssW / 2 ? px + D : px - D));
    const ly = above ? py - D * 0.95 : Math.max(D / 2 + 4, py);
    const map = ([x, y]) => [lx + (x - fx) * k, ly + (y - fy) * k];
    g.save();
    g.beginPath();
    g.arc(lx, ly, D / 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#0b1016';
    g.fillRect(lx - D / 2, ly - D / 2, D, D);
    g.drawImage(img, fx - D / 2 / k, fy - D / 2 / k, D / k, D / k, lx - D / 2, ly - D / 2, D, D);
    g.strokeStyle = '#4fb3ff';
    g.lineWidth = 1.5;
    poly(g, this.quad.map(map));
    g.stroke();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(lx - 10, ly);
    g.lineTo(lx + 10, ly);
    g.moveTo(lx, ly - 10);
    g.lineTo(lx, ly + 10);
    g.stroke();
    g.restore();
    g.beginPath();
    g.arc(lx, ly, D / 2, 0, Math.PI * 2);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.stroke();
  },
  edgeMid(i) {
    const a = this.quad[i];
    const b = this.quad[(i + 1) % 4];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  },
  toCss(x, y) {
    return [this.ox + x * this.scale, y * this.scale];
  },
  toImg(e) {
    const r = $('crop-canvas').getBoundingClientRect();
    return [(e.clientX - r.left - this.ox) / this.scale, (e.clientY - r.top) / this.scale];
  },
};
$('crop-canvas').addEventListener('pointerdown', (e) => {
  const p = crop.toImg(e);
  const near = (q, r) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < (r / crop.scale) ** 2;
  let drag = null;
  let bd = Infinity;
  crop.quad.forEach((q, i) => {
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (near(q, 40) && d < bd) {
      bd = d;
      // Keep the offset to the finger: the corner does not jump under it.
      drag = { corner: i, off: [q[0] - p[0], q[1] - p[1]] };
    }
  });
  if (!drag)
    for (let i = 0; i < 4; i++)
      if (near(crop.edgeMid(i), 32))
        drag = { edge: i, start: p, orig: [[...crop.quad[i]], [...crop.quad[(i + 1) % 4]]] };
  crop.drag = drag;
  if (drag) {
    e.target.setPointerCapture(e.pointerId);
    crop.draw();
  }
});
$('crop-canvas').addEventListener('pointermove', (e) => {
  const d = crop.drag;
  if (!d) return;
  const { width: w, height: h } = state.refImg.image;
  const clamp = ([x, y]) => [Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y))];
  const [x, y] = crop.toImg(e);
  if (d.corner !== undefined) crop.quad[d.corner] = clamp([x + d.off[0], y + d.off[1]]);
  else {
    const dx = x - d.start[0];
    const dy = y - d.start[1];
    crop.quad[d.edge] = clamp([d.orig[0][0] + dx, d.orig[0][1] + dy]);
    crop.quad[(d.edge + 1) % 4] = clamp([d.orig[1][0] + dx, d.orig[1][1] + dy]);
  }
  crop.draw();
});
const cropUp = () => {
  if (!crop.drag) return;
  crop.drag = null;
  crop.draw();
};
$('crop-canvas').addEventListener('pointerup', cropUp);
$('crop-canvas').addEventListener('pointercancel', cropUp);
$('crop-full').addEventListener('click', () => {
  const { width: w, height: h } = state.refImg.image;
  crop.quad = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  crop.draw();
});
$('crop-ok').addEventListener('click', async () => {
  state.quad = crop.quad.map((p) => [...p]);
  if (!state.count) {
    askCount();
    return;
  }
  const { cols, rows } = gridFor(state.count, quadAspect(state.quad));
  state.cols = cols;
  state.rows = rows;
  resetGridChoice();
  await saveRef();
  await applyReference();
});

function quadAspect(q) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return (d(q[0], q[1]) + d(q[3], q[2])) / (d(q[0], q[3]) + d(q[1], q[2]));
}

async function saveRef() {
  await store('ref', {
    blob: state.refBlob,
    quad: state.quad,
    count: state.count,
    cols: state.cols,
    rows: state.rows,
    gridManual: state.gridManual,
  });
}

// The grid is always based on the piece count (columns × rows follow from it
// and from the finished border), so it is asked for before anything else.
function askCount() {
  show('ref-crop', false);
  show('ref-empty', false);
  show('ref-done', true);
  show('ref-preview', false);
  show('grid-adjust', false);
  $('tab-scene').disabled = true;
  show('count-hint', true);
  $('count').closest('.count').classList.add('need');
  updateGridLabels();
  $('count').focus();
}

async function applyReference() {
  show('ref-crop', false);
  show('ref-empty', false);
  show('ref-done', true);
  show('ref-preview', true);
  show('grid-adjust', true);
  show('count-hint', false);
  $('count').closest('.count').classList.remove('need');
  $('tab-scene').disabled = false;
  updateGridLabels();
  setStatus('Vorlage wird aufbereitet …');
  const r = await call('reference', {
    image: state.refImg.image,
    quad: state.quad,
    cols: state.cols,
    rows: state.rows,
    cache: state.featCache,
  });
  if (r.cache) {
    state.featCache = r.cache;
    store('feat', r.cache).catch((err) => console.warn(err));
  }
  const c = document.createElement('canvas');
  c.width = r.W;
  c.height = r.H;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.W, r.H), 0, 0);
  const v = document.createElement('canvas');
  v.width = r.view.width;
  v.height = r.view.height;
  v.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.view.data), v.width, v.height), 0, 0);
  state.refView = { canvas: c, view: v, W: r.W, H: r.H, C: r.C };
  drawRefPreview();
  setStatus('');
  // New grid: re-analyse existing photos (piece numbers change, so pieces
  // marked as put in are forgotten).
  state.placed = [];
  for (const s of state.scenes) s.busy = true;
  renderThumbs();
  for (const s of state.scenes) await analyze(s, false);
  if (state.scenes.length) await solve();
}

function drawRefPreview() {
  const cv = $('ref-canvas');
  const { view, W, H, C } = state.refView;
  const cssW = cv.parentElement.clientWidth;
  if (!cssW) return;
  const k = cssW / W;
  const g = sizeCanvas(cv, cssW, H * k, Math.min(4, view.width / cssW));
  g.drawImage(view, 0, 0, W * k, H * k);
  g.strokeStyle = '#ffffff66';
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 1; c < state.cols; c++) {
    g.moveTo(c * C * k, 0);
    g.lineTo(c * C * k, H * k);
  }
  for (let r = 1; r < state.rows; r++) {
    g.moveTo(0, r * C * k);
    g.lineTo(W * k, r * C * k);
  }
  g.stroke();
}

function updateGridLabels() {
  $('count').value = state.count || '';
  $('cols').textContent = state.cols;
  $('rows').textContent = state.rows;
  $('grid-total').textContent = `= ${state.cols * state.rows} Plätze`;
  for (const b of $('chips').children) b.classList.toggle('on', Number(b.dataset.n) === state.count);
}

for (const n of COUNTS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = n;
  b.dataset.n = n;
  b.addEventListener('click', () => setCount(n));
  $('chips').append(b);
}
$('count').addEventListener('change', () => {
  const n = Math.round(Number($('count').value));
  if (n >= 4 && n <= 5000) setCount(n);
});
function resetGridChoice() {
  state.gridManual = false;
  state.gridAuto = false;
  state.seamsDone = false;
  state.gridNote = '';
}

async function setCount(n) {
  state.count = n;
  const g = gridFor(n, quadAspect(state.quad));
  state.cols = g.cols;
  state.rows = g.rows;
  resetGridChoice();
  await saveRef();
  await applyReference();
}
for (const b of document.querySelectorAll('[data-adj]')) {
  b.addEventListener('click', async () => {
    const key = b.dataset.adj;
    state[key] = Math.max(2, state[key] + Number(b.dataset.d));
    state.gridManual = true;
    state.gridNote = '';
    await saveRef();
    await applyReference();
  });
}
$('ref-redo').addEventListener('click', () => {
  show('ref-done', false);
  show('ref-empty', true);
});
$('ref-recrop').addEventListener('click', () => {
  crop.quad = state.quad.map((p) => [...p]);
  show('ref-done', false);
  show('ref-crop', true);
  crop.draw();
});

// ---------- Step 2: pieces photos ----------
let sceneSeq = 1;
for (const input of document.querySelectorAll('input[data-scene]')) {
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    for (const f of files) {
      try {
        await addScene(f);
      } catch (err) {
        console.error(err);
        setStatus(`${f.name}: ${err.message}`);
      }
    }
  });
}

async function addScene(file) {
  const { canvas, image } = await decode(file, SCENE_MAX);
  const s = { id: sceneSeq++, canvas, image, url: URL.createObjectURL(file), busy: true };
  state.scenes.push(s);
  state.current = s.id;
  renderThumbs();
  await analyze(s, true);
}

async function analyze(s, thenSolve) {
  setStatus('Teile werden gesucht …');
  let r = null;
  try {
    r = await call('scene', { sceneId: s.id, image: s.image });
    s.busy = false;
    s.error = null;
  } catch (err) {
    s.busy = false;
    s.error = err.message;
    setStatus(`Foto konnte nicht ausgewertet werden: ${err.message}`);
  }
  renderThumbs();
  if (await gridFromSeams(r)) return;
  if (await gridFromPhoto(r)) return;
  if (thenSolve) await solve();
}

// The seams of a finished part show where the pieces really are: the box
// picture often shows a little more or less than the puzzle, and the count
// alone does not fix columns and rows. Adopt corners and grid once, if they
// fit the piece count and the grid was not set by hand.
async function gridFromSeams(r) {
  const g = r?.seams;
  if (!g || state.gridManual || state.seamsDone || g.shift < 0.15) return false;
  if (state.count && Math.abs(g.cols * g.rows - state.count) > 0.06 * state.count) return false;
  state.seamsDone = true;
  state.gridAuto = true;
  state.quad = g.quad;
  state.cols = g.cols;
  state.rows = g.rows;
  state.gridNote = `Raster an den Fugen des fertigen Teils ausgerichtet: ${g.cols} × ${g.rows}.`;
  await saveRef();
  await applyReference();
  return true;
}

// The grid from the piece count assumes square pieces. The finished border
// in a photo is one piece thick and tells the real grid: switch once (all
// photos are analysed again), unless the grid was set by hand or already
// fits.
async function gridFromPhoto(r) {
  if (state.gridManual || state.gridAuto || !r?.border) return false;
  const g = gridFromBorder(state.count, r.border, r.aspect);
  const now = borderCost(state.count, r.border, r.aspect, state.cols, state.rows);
  if (!g || now === null || now < 0.01 || g.cost > now / 3) return false;
  if (g.cols === state.cols && g.rows === state.rows) return false;
  state.gridAuto = true;
  state.cols = g.cols;
  state.rows = g.rows;
  state.gridNote = `Raster aus dem fertigen Rand bestimmt: ${g.cols} × ${g.rows}.`;
  await saveRef();
  await applyReference();
  return true;
}

function renderThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  for (const s of state.scenes) {
    const b = document.createElement('div');
    b.className = `thumb${s.id === state.current ? ' on' : ''}`;
    b.role = 'button';
    b.tabIndex = 0;
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = `Foto ${s.id}`;
    b.append(img);
    if (s.busy) {
      const o = document.createElement('div');
      o.className = 'busy';
      o.textContent = '…';
      b.append(o);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.textContent = '✕';
    x.ariaLabel = 'Foto entfernen';
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeScene(s.id);
    });
    b.append(x);
    b.addEventListener('click', () => {
      state.current = s.id;
      renderThumbs();
      renderResult();
    });
    box.append(b);
  }
}

async function removeScene(id) {
  const s = state.scenes.find((x) => x.id === id);
  URL.revokeObjectURL(s.url);
  state.scenes = state.scenes.filter((x) => x.id !== id);
  state.placed = state.placed.filter((p) => p.sceneId !== id);
  await call('removeScene', { sceneId: id });
  if (state.current === id) state.current = state.scenes.at(-1)?.id ?? null;
  renderThumbs();
  if (state.scenes.length) await solve();
  else {
    state.result = null;
    show('result', false);
    setStatus('');
  }
}

$('all-arrows').addEventListener('click', () => {
  state.allArrows = !state.allArrows;
  $('all-arrows').textContent = state.allArrows ? `Nur die nächsten ${ARROWS} Pfeile` : 'Alle Pfeile zeigen';
  drawViewer();
});

// Build the frame first: only pieces whose place is on the border.
$('edge-only').addEventListener('click', () => {
  state.edgeOnly = !state.edgeOnly;
  $('edge-only').textContent = state.edgeOnly ? 'Alle Teile' : 'Nur Rand';
  renderResult();
});

function onEdge(x) {
  return (
    x.cell !== null && (x.row === 0 || x.col === 0 || x.row === state.rows - 1 || x.col === state.cols - 1)
  );
}

// Put in: the piece is hidden, its place counts as taken and its sides
// check the neighbouring places; the next arrow is shown.
$('detail-placed').addEventListener('click', async () => {
  const x = state.selected;
  $('detail').close();
  if (!x || x.cell === null) return;
  state.placed.push({ sceneId: x.sceneId, index: x.index, cell: x.cell, rot: x.rot });
  state.selected = null;
  await solve();
});
$('undo-placed').addEventListener('click', async () => {
  state.placed.pop();
  await solve();
});

$('new-round').addEventListener('click', async () => {
  state.placed = [];
  for (const s of state.scenes) URL.revokeObjectURL(s.url);
  state.scenes = [];
  state.current = null;
  state.result = null;
  await call('clearScenes');
  renderThumbs();
  show('result', false);
  setStatus('Setze die vorgeschlagenen Teile ein und fotografiere Puzzle und restliche Teile erneut.');
});

function setStatus(t) {
  $('status').textContent = t;
}

async function solve() {
  setStatus('Plätze werden gesucht …');
  const r = await call('solve', { placed: state.placed });
  // Pieces put in are hidden; the next arrows move up.
  r.suggestions = r.suggestions.filter((s) => !s.placed);
  $('undo-placed').hidden = !state.placed.length;
  // Order: sure pieces in the order they are resolved,
  // then the rest by confidence.
  const order = r.suggestions
    .filter((s) => s.cell !== null && !s.sameAs)
    .sort((a, b) => (a.step ?? 1e9) - (b.step ?? 1e9) || b.conf - a.conf);
  order.forEach((s, i) => {
    s.label = i + 1;
    s.level = s.sure ? 'ok' : s.conf >= 0.2 ? 'maybe' : 'bad';
  });
  // The same piece on a second photo gets the same number.
  const sceneIds = r.scenes.map((x) => x.id);
  for (const s of r.suggestions) {
    if (!s.sameAs || s.cell === null) continue;
    const twin = r.suggestions.find(
      (x) => x.sceneId === sceneIds[s.sameAs.scene] && x.index === s.sameAs.index,
    );
    s.label = twin?.label;
    s.level = twin?.level ?? 'bad';
  }
  // Joined groups: letters instead of numbers.
  for (const sc of r.scenes) {
    (sc.groups ?? []).forEach((g, i) => {
      g.label = String.fromCharCode(65 + i);
      g.level = 'ok';
      let x = 0;
      let y = 0;
      for (const [px, py] of g.outline) {
        x += px;
        y += py;
      }
      g.center = [x / g.outline.length, y / g.outline.length];
      // badge() sizes label and arc by one piece side.
      const side = Math.sqrt(polyArea(g.outline) / g.cells.length);
      g.corners = [g.center, [g.center[0] + side, g.center[1]]];
    });
  }
  state.result = r;
  const sure = order.filter((s) => s.level === 'ok').length;
  const maybe = order.filter((s) => s.level === 'maybe').length;
  const unclear = r.scenes.reduce((a, s) => a + s.unclear.length, 0);
  const total = r.suggestions.filter((s) => !s.sameAs).length;
  let msg = `${state.gridNote ? `${state.gridNote} ` : ''}${total} Teile erkannt: ${sure} sicher, ${maybe} vermutlich zugeordnet.`;
  const groups = r.scenes.reduce((a, s) => a + (s.groups?.length ?? 0), 0);
  if (groups) msg += ` ${groups} zusammengesteckte ${groups === 1 ? 'Gruppe' : 'Gruppen'} zugeordnet.`;
  if (unclear) msg += ` ${unclear} Flecken unklar (berühren sich Teile?).`;
  if (r.scenes.some((s) => s.board)) msg += ' Puzzle im Foto gefunden – Pfeile zeigen auf den Platz.';
  setStatus(msg);
  show('result', true);
  renderResult();
}

// ---------- Draw result ----------
const COLORS = { ok: '#3ddc84', maybe: '#ffc94d', bad: '#ff6b6b' };

const view = {
  s: 1,
  tx: 0,
  ty: 0,
  fit: 1,
  cssW: 0,
  cssH: 0,
  scene: null,
  pointers: new Map(),
};

function currentScene() {
  const s = state.scenes.find((x) => x.id === state.current);
  const info = state.result?.scenes.find((x) => x.id === state.current);
  return s && info ? { s, info } : null;
}

function renderResult() {
  const cur = currentScene();
  if (!cur) return;
  const cv = $('viewer');
  // Recognition coordinates refer to the possibly downscaled working image.
  const { width: w, height: h } = cur.info;
  view.cssW = cv.parentElement.clientWidth;
  view.cssH = Math.min(window.innerHeight * 0.7, (view.cssW * h) / w);
  if (view.scene !== cur.s.id) {
    view.fit = Math.min(view.cssW / w, view.cssH / h);
    view.s = view.fit;
    view.tx = (view.cssW - w * view.s) / 2;
    view.ty = (view.cssH - h * view.s) / 2;
    view.scene = cur.s.id;
  }
  drawViewer();
  drawMap();
}

function drawViewer() {
  const cur = currentScene();
  if (!cur) return;
  const cv = $('viewer');
  const g = sizeCanvas(cv, view.cssW, view.cssH);
  g.fillStyle = '#0b1016';
  g.fillRect(0, 0, view.cssW, view.cssH);
  g.save();
  g.translate(view.tx, view.ty);
  g.scale(view.s, view.s);
  g.drawImage(cur.s.canvas, 0, 0, cur.info.width, cur.info.height);
  const px = 1 / view.s; // one screen unit in image pixels
  const sugg = state.result.suggestions.filter(
    (x) => x.sceneId === cur.s.id && (!state.edgeOnly || onEdge(x)),
  );

  if (!state.edgeOnly) drawUnclearAndGroups(g, cur.info, px);
  if (cur.info.board) drawFilled(g, cur.info.board, px);
  for (const x of sugg) {
    const p = cur.info.pieces[x.index];
    const col = x.cell === null ? COLORS.bad : COLORS[x.level];
    poly(g, p.outline);
    g.strokeStyle = `${col}cc`;
    g.lineWidth = 2 * px;
    g.stroke();
  }
  for (const x of sugg) {
    if (x.cell === null || x.level === 'bad' || !x.target) continue;
    // Many arrows cross: by default only the next steps.
    if (!state.allArrows && x.label > ARROWS && x !== state.selected) continue;
    arrow(g, x.center, x.target, COLORS[x.level], px);
    targetMarker(g, x, cur.info.board, px);
  }
  for (const x of sugg) {
    if (x.cell === null) continue;
    badge(g, x.center, x, px);
  }
  g.restore();
}

function drawUnclearAndGroups(g, info, px) {
  for (const u of info.unclear) {
    g.setLineDash([6 * px, 5 * px]);
    poly(g, u.outline);
    g.strokeStyle = COLORS.bad;
    g.lineWidth = 2 * px;
    g.stroke();
    g.setLineDash([]);
  }
  for (const gr of info.groups ?? []) {
    poly(g, gr.outline);
    g.strokeStyle = `${COLORS.ok}cc`;
    g.lineWidth = 2 * px;
    g.stroke();
    if (gr.target) arrow(g, gr.center, gr.target, COLORS.ok, px);
    badge(g, gr.center, gr, px);
  }
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function poly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
  g.closePath();
}

function drawFilled(g, board, px) {
  // Frame around the detected puzzle.
  const { W, H } = state.refView;
  const pts = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ].map(([x, y]) => applyH(board.H, x, y));
  poly(g, pts);
  g.strokeStyle = '#4fb3ffaa';
  g.lineWidth = 2 * px;
  g.setLineDash([10 * px, 6 * px]);
  g.stroke();
  g.setLineDash([]);
}

function arrow(g, a, b, color, px) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 20 * px) return;
  const head = 14 * px;
  g.strokeStyle = '#000a';
  g.lineWidth = 6 * px;
  g.beginPath();
  g.moveTo(...a);
  g.lineTo(...b);
  g.stroke();
  g.strokeStyle = color;
  g.lineWidth = 3 * px;
  g.beginPath();
  g.moveTo(...a);
  g.lineTo(b[0] - Math.cos(ang) * head * 0.6, b[1] - Math.sin(ang) * head * 0.6);
  g.stroke();
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(...b);
  g.lineTo(b[0] - Math.cos(ang - 0.4) * head, b[1] - Math.sin(ang - 0.4) * head);
  g.lineTo(b[0] - Math.cos(ang + 0.4) * head, b[1] - Math.sin(ang + 0.4) * head);
  g.closePath();
  g.fill();
}

function targetMarker(g, x, board, px) {
  const C = state.refView.C;
  const pts = [
    [x.col * C, x.row * C],
    [(x.col + 1) * C, x.row * C],
    [(x.col + 1) * C, (x.row + 1) * C],
    [x.col * C, (x.row + 1) * C],
  ].map(([a, b]) => applyH(board.H, a, b));
  poly(g, pts);
  g.fillStyle = `${COLORS[x.level]}55`;
  g.fill();
  g.strokeStyle = COLORS[x.level];
  g.lineWidth = 2 * px;
  g.stroke();
}

// Number with rotation arrow: arc in the turn direction, degrees beside it.
function badge(g, c, x, px0) {
  // In the overview pieces are often only a few millimetres: shrink the label
  // along, show degrees only when zoomed in.
  const side = Math.hypot(x.corners[1][0] - x.corners[0][0], x.corners[1][1] - x.corners[0][1]);
  const sideScreen = side / px0;
  const px = px0 * Math.max(0.5, Math.min(1, sideScreen / 70));
  const r = 13 * px;
  const color = COLORS[x.level];
  const turn = Math.round(x.turn / 5) * 5;
  if (Math.abs(turn) >= 10 && x.level !== 'bad') {
    // Arc around the piece, as large as the piece itself: shows direction
    // and rough angle at a glance.
    const R = Math.max(r + 8 * px, side * 0.42);
    const a0 = -Math.PI / 2;
    const a1 = a0 + (turn * Math.PI) / 180;
    for (const [col, lw] of [
      ['#000c', 7],
      ['#fff', 3.5],
    ]) {
      g.strokeStyle = col;
      g.lineWidth = lw * px;
      g.beginPath();
      g.arc(c[0], c[1], R, Math.min(a0, a1), Math.max(a0, a1));
      g.stroke();
    }
    // Arrowhead tangent at the end of the arc
    const ex = c[0] + Math.cos(a1) * R;
    const ey = c[1] + Math.sin(a1) * R;
    const dir = a1 + (turn > 0 ? Math.PI / 2 : -Math.PI / 2);
    const hd = 12 * px;
    g.beginPath();
    g.moveTo(ex + Math.cos(dir) * hd, ey + Math.sin(dir) * hd);
    g.lineTo(ex + Math.cos(dir + 2.3) * hd * 0.8, ey + Math.sin(dir + 2.3) * hd * 0.8);
    g.lineTo(ex + Math.cos(dir - 2.3) * hd * 0.8, ey + Math.sin(dir - 2.3) * hd * 0.8);
    g.closePath();
    g.fillStyle = '#fff';
    g.strokeStyle = '#000c';
    g.lineWidth = 2 * px;
    g.fill();
    g.stroke();
    if (sideScreen > 32) {
      const am = a0 + (turn * Math.PI) / 360;
      const lx = c[0] + Math.cos(am) * (R + 14 * px);
      const ly = c[1] + Math.sin(am) * (R + 14 * px);
      label(g, `${Math.abs(turn)}°`, lx, ly, px, '#fff', 'center');
    }
  }
  g.beginPath();
  g.arc(c[0], c[1], r, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 2 * px;
  g.strokeStyle = '#000';
  g.stroke();
  g.fillStyle = '#000';
  g.font = `bold ${13 * px}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(x.label), c[0], c[1] + 0.5 * px);
}

function label(g, text, x, y, px, color, align) {
  g.font = `bold ${13 * px}px system-ui, sans-serif`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.lineWidth = 4 * px;
  g.strokeStyle = '#000c';
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

function drawMap() {
  const cv = $('map');
  const { view, W, H, C } = state.refView;
  const cssW = cv.parentElement.clientWidth;
  if (!cssW) return;
  const k = cssW / W;
  const g = sizeCanvas(cv, cssW, H * k, Math.min(4, view.width / cssW));
  g.drawImage(view, 0, 0, W * k, H * k);
  const filled = new Set([
    ...state.result.scenes.flatMap((s) => s.board?.filled ?? []),
    ...state.placed.map((p) => p.cell),
  ]);
  if (filled.size) {
    g.fillStyle = '#000a';
    for (let cell = 0; cell < state.cols * state.rows; cell++) {
      if (filled.has(cell)) continue;
      const r = Math.floor(cell / state.cols);
      const c = cell % state.cols;
      g.fillRect(c * C * k, r * C * k, C * k, C * k);
    }
  }
  const sugg = state.result.suggestions.filter(
    (x) =>
      x.sceneId === state.current && x.cell !== null && x.level !== 'bad' && (!state.edgeOnly || onEdge(x)),
  );
  if (state.edgeOnly) {
    // The frame stays bright, the inside is dimmed.
    g.fillStyle = '#000a';
    g.fillRect(C * k, C * k, (state.cols - 2) * C * k, (state.rows - 2) * C * k);
  }
  const fs = Math.max(9, Math.min(14, C * k * 0.55));
  const info = state.result.scenes.find((s) => s.id === state.current);
  for (const gr of state.edgeOnly ? [] : (info?.groups ?? [])) {
    g.fillStyle = `${COLORS.ok}55`;
    for (const cell of gr.cells) {
      const r = Math.floor(cell / state.cols);
      const c = cell % state.cols;
      g.fillRect(c * C * k, r * C * k, C * k, C * k);
    }
    const cx = (gr.col + 0.5) * C * k;
    const cy = (gr.row + 0.5) * C * k;
    g.beginPath();
    g.arc(cx, cy, fs * 0.75, 0, Math.PI * 2);
    g.fillStyle = COLORS.ok;
    g.fill();
    g.fillStyle = '#000';
    g.font = `bold ${fs}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(gr.label, cx, cy + 0.5);
  }
  for (const x of sugg) {
    const cx = (x.col + 0.5) * C * k;
    const cy = (x.row + 0.5) * C * k;
    g.strokeStyle = COLORS[x.level];
    g.lineWidth = 2;
    g.strokeRect(x.col * C * k, x.row * C * k, C * k, C * k);
    g.beginPath();
    g.arc(cx, cy, fs * 0.75, 0, Math.PI * 2);
    g.fillStyle = COLORS[x.level];
    g.fill();
    g.fillStyle = '#000';
    g.font = `bold ${fs}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(x.label), cx, cy + 0.5);
  }
}

// ---------- Zoom, pan, tap ----------
const vc = $('viewer');
let gesture = null;
let lastTap = 0;
vc.addEventListener('pointerdown', (e) => {
  vc.setPointerCapture(e.pointerId);
  view.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  gesture = { moved: false, start: snapshot() };
});
vc.addEventListener('pointermove', (e) => {
  if (!view.pointers.has(e.pointerId) || !gesture) return;
  const prev = snapshot();
  view.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const now = snapshot();
  if (Math.hypot(now.cx - gesture.start.cx, now.cy - gesture.start.cy) > 6 || now.n > 1) gesture.moved = true;
  if (!gesture.moved || prev.n !== now.n) return;
  if (now.n === 1 && view.s <= view.fit * 1.01) return;
  const r = vc.getBoundingClientRect();
  const k = now.n > 1 && prev.d > 0 ? now.d / prev.d : 1;
  zoomAt(prev.cx - r.left, prev.cy - r.top, k);
  view.tx += now.cx - prev.cx;
  view.ty += now.cy - prev.cy;
  clampView();
  drawViewer();
});
const up = (e) => {
  view.pointers.delete(e.pointerId);
  if (!gesture) return;
  if (!gesture.moved && view.pointers.size === 0) {
    const t = performance.now();
    const r = vc.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (t - lastTap < 300) {
      zoomAt(sx, sy, view.s > view.fit * 1.5 ? view.fit / view.s : 2.5);
      clampView();
      drawViewer();
      lastTap = 0;
    } else {
      lastTap = t;
      tapAt(sx, sy);
    }
  }
  if (view.pointers.size === 0) gesture = null;
  else gesture.start = snapshot();
  vc.style.touchAction = view.s > view.fit * 1.01 ? 'none' : 'pan-y';
};
vc.addEventListener('pointerup', up);
vc.addEventListener('pointercancel', up);
vc.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = vc.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.002));
    clampView();
    drawViewer();
  },
  { passive: false },
);
vc.style.touchAction = 'pan-y';

// No page zoom: Safari ignores user-scalable=no and touch-action for pinch,
// desktop browsers zoom on ctrl+wheel (trackpad pinch).
for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault());
document.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false },
);

function snapshot() {
  const ps = [...view.pointers.values()];
  const n = ps.length;
  const cx = ps.reduce((a, p) => a + p[0], 0) / (n || 1);
  const cy = ps.reduce((a, p) => a + p[1], 0) / (n || 1);
  const d = n > 1 ? Math.hypot(ps[0][0] - ps[1][0], ps[0][1] - ps[1][1]) : 0;
  return { n, cx, cy, d };
}

function zoomAt(sx, sy, k) {
  const ns = Math.max(view.fit, Math.min(view.fit * 8, view.s * k));
  const f = ns / view.s;
  view.tx = sx - (sx - view.tx) * f;
  view.ty = sy - (sy - view.ty) * f;
  view.s = ns;
}

function clampView() {
  const cur = currentScene();
  if (!cur) return;
  const w = cur.info.width * view.s;
  const h = cur.info.height * view.s;
  view.tx = w <= view.cssW ? (view.cssW - w) / 2 : Math.min(0, Math.max(view.cssW - w, view.tx));
  view.ty = h <= view.cssH ? (view.cssH - h) / 2 : Math.min(0, Math.max(view.cssH - h, view.ty));
}

function inside(pts, x, y) {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}

function tapAt(sx, sy) {
  const cur = currentScene();
  if (!cur) return;
  const x = (sx - view.tx) / view.s;
  const y = (sy - view.ty) / view.s;
  const hit = state.result.suggestions.find(
    (u) => u.sceneId === cur.s.id && inside(cur.info.pieces[u.index].outline, x, y),
  );
  if (hit) openDetail(hit, cur.info);
}

// ---------- Details ----------
function turnText(t) {
  const a = Math.round(Math.abs(t) / 5) * 5;
  if (a < 10) return 'Nicht drehen, liegt schon richtig.';
  return `Um ${a}° ${t > 0 ? 'im Uhrzeigersinn' : 'gegen den Uhrzeigersinn'} drehen.`;
}

function openDetail(x, info) {
  state.selected = x;
  drawViewer();
  const p = info.pieces[x.index];
  $('detail-title').textContent = x.cell === null ? 'Kein Platz gefunden' : `Teil ${x.label}`;
  $('detail-placed').hidden = x.cell === null;
  const pc = $('detail-piece');
  const rc = $('detail-ref');
  pc.width = rc.width = 260;
  pc.height = rc.height = 260;
  const g = pc.getContext('2d');
  g.clearRect(0, 0, 260, 260);
  const tile = document.createElement('canvas');
  tile.width = tile.height = p.P;
  const td = new ImageData(new Uint8ClampedArray(p.rgba), p.P, p.P);
  tile.getContext('2d').putImageData(td, 0, 0);
  g.save();
  g.translate(130, 130);
  g.rotate(((x.rot ?? 0) * Math.PI) / 2);
  g.drawImage(tile, -130, -130, 260, 260);
  g.restore();
  const h = rc.getContext('2d');
  h.fillStyle = '#0b1016';
  h.fillRect(0, 0, 260, 260);
  if (x.cell !== null) {
    const { canvas, C } = state.refView;
    const m = C / 4;
    h.drawImage(canvas, x.col * C - m, x.row * C - m, C + 2 * m, C + 2 * m, 0, 0, 260, 260);
    h.strokeStyle = '#4fb3ff';
    h.lineWidth = 2;
    const k = 260 / (C + 2 * m);
    h.strokeRect(m * k, m * k, C * k, C * k);
    $('detail-text').textContent =
      `Reihe ${x.row + 1}, Spalte ${x.col + 1} (von links oben). ${turnText(x.turn)} Sicherheit ${Math.round(x.conf * 100)} %.`;
  } else {
    $('detail-text').textContent = 'Für dieses Teil passt kein freier Platz gut genug.';
  }
  const alts = $('detail-alts');
  alts.replaceChildren();
  for (const a of x.alts ?? []) {
    const s = document.createElement('span');
    s.textContent = `oder R${a.row + 1}/S${a.col + 1}`;
    alts.append(s);
  }
  $('detail').showModal();
}

window.addEventListener('resize', () => {
  if (!$('ref-crop').hidden && state.refImg) crop.draw();
  if (state.refView && !$('ref-done').hidden) drawRefPreview();
  if (state.result) renderResult();
});

// ---------- Tabs ----------
function showTab(id) {
  for (const b of document.querySelectorAll('.tabbar [data-tab]')) {
    const on = b.dataset.tab === id;
    b.setAttribute('aria-selected', String(on));
    show(b.dataset.tab, on);
  }
  window.scrollTo(0, 0);
  // Canvas sizes follow the visible width, hidden tabs have none.
  if (id === 'step-ref' && state.refView && !$('ref-done').hidden) drawRefPreview();
  if (id === 'step-ref' && !$('ref-crop').hidden && state.refImg) crop.draw();
  if (id === 'step-scene' && state.result) renderResult();
}
for (const b of document.querySelectorAll('.tabbar [data-tab]'))
  b.addEventListener('click', () => {
    if (!b.disabled) showTab(b.dataset.tab);
  });

// ---------- Zoom in pictures ----------
// Two fingers zoom, one finger pans once zoomed (before that it scrolls the
// page), double tap toggles; the mouse wheel zooms on a desktop. CSS
// transform of the canvas inside its clipping frame.
function zoomable(cv) {
  const z = { s: 1, x: 0, y: 0, pts: new Map(), moved: false, tap: 0 };
  const frame = cv.parentElement;
  const apply = () => {
    const w = frame.clientWidth;
    const h = cv.clientHeight;
    z.s = Math.min(6, Math.max(1, z.s));
    z.x = Math.min(0, Math.max(w - w * z.s, z.x));
    z.y = Math.min(0, Math.max(h - h * z.s, z.y));
    cv.style.transformOrigin = '0 0';
    cv.style.transform = z.s > 1 ? `translate(${z.x}px, ${z.y}px) scale(${z.s})` : '';
    cv.style.touchAction = z.s > 1.01 ? 'none' : 'pan-y';
  };
  const at = (k, px, py) => {
    z.x = px - (px - z.x) * k;
    z.y = py - (py - z.y) * k;
    z.s *= k;
  };
  const snap = () => {
    const ps = [...z.pts.values()];
    const n = ps.length;
    return {
      n,
      cx: ps.reduce((a, p) => a + p[0], 0) / (n || 1),
      cy: ps.reduce((a, p) => a + p[1], 0) / (n || 1),
      d: n > 1 ? Math.hypot(ps[0][0] - ps[1][0], ps[0][1] - ps[1][1]) : 0,
    };
  };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    z.pts.set(e.pointerId, [e.clientX, e.clientY]);
    z.moved = z.pts.size > 1;
  });
  cv.addEventListener('pointermove', (e) => {
    if (!z.pts.has(e.pointerId)) return;
    const prev = snap();
    z.pts.set(e.pointerId, [e.clientX, e.clientY]);
    const now = snap();
    if (prev.n !== now.n || (now.n === 1 && z.s <= 1.01)) return;
    z.moved = true;
    const r = frame.getBoundingClientRect();
    at(now.n > 1 && prev.d > 0 ? now.d / prev.d : 1, prev.cx - r.left, prev.cy - r.top);
    z.x += now.cx - prev.cx;
    z.y += now.cy - prev.cy;
    apply();
  });
  const up = (e) => {
    if (!z.pts.delete(e.pointerId) || z.pts.size || z.moved) return;
    const t = performance.now();
    if (t - z.tap < 300) {
      const r = frame.getBoundingClientRect();
      at(z.s > 1.5 ? 1 / z.s : 2.5, e.clientX - r.left, e.clientY - r.top);
      apply();
      z.tap = 0;
    } else z.tap = t;
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      at(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
      apply();
    },
    { passive: false },
  );
  apply();
}
zoomable($('ref-canvas'));
zoomable($('map'));

// ---------- Start ----------
(async () => {
  try {
    const saved = await load('ref');
    if (saved?.blob) {
      state.refBlob = saved.blob;
      state.refImg = await decode(saved.blob, REF_MAX);
      state.quad = saved.quad;
      state.count = saved.count;
      state.cols = saved.cols;
      state.rows = saved.rows;
      state.gridManual = saved.gridManual ?? false;
      state.featCache = await load('feat');
      await applyReference();
      showTab('step-scene');
    }
  } catch (err) {
    console.warn(err);
  }
})();

// Version of the code running now; a newer one installed in the background
// takes effect after reloading.
$('version').textContent = APP_VERSION;
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    const v = $('version');
    v.textContent = `${APP_VERSION} · neu laden`;
    v.classList.add('update');
    v.onclick = () => location.reload();
  });
  navigator.serviceWorker.register('sw.js');
}
