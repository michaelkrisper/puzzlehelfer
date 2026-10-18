// UI: capture and crop the reference, add pieces photos,
// draw suggestions with arrows and rotation.
const { gridFor, gridFromBorder, borderCost, applyH, invertH } = PH.geom;
const REF_MAX = 2400;
const SCENE_MAX = 4000;
const COUNTS = [100, 200, 300, 500, 1000, 1500, 2000];
// Same as VERSION in sw.js; bump both together.
const APP_VERSION = 'v33';
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
  // All photos with the puzzle as one picture from above, instead of one
  // photo: {canvas, width, height, x0, y0, f, M (sceneId → matrix), corners}.
  table: false,
  tableChosen: false, // the user switched between table and single photo
  tableImg: null,
  // Part of the table that counts, [u0, v0, u1, v1] in reference pixels.
  crop: null,
  edit: false, // table view: drag the crop corners, tap places to toggle
  dirty: false, // corrected while editing: search again when done
  // Marks by the user, in order (for undo): {kind: 'placed' with cell, rot |
  // 'removed' (no piece, or a wrong find), sceneId, index} or {kind: 'cell',
  // cell, free} (a place the recognition got wrong).
  marks: [],
  // Step by step: the piece shown and the chosen candidate place; skipped
  // pieces move to the end of the queue.
  focus: null, // {sceneId, index, alt}
  skipped: new Set(),
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
  state.marks = [];
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
    // Several photos: one search for places at the end.
    for (const [i, f] of files.entries()) {
      try {
        await addScene(f, i === files.length - 1);
      } catch (err) {
        console.error(err);
        setStatus(`${f.name}: ${err.message}`);
      }
    }
  });
}

async function addScene(file, thenSolve = true) {
  const { canvas, image } = await decode(file, SCENE_MAX);
  const s = { id: sceneSeq++, canvas, image, url: URL.createObjectURL(file), busy: true };
  state.scenes.push(s);
  state.current = s.id;
  renderThumbs();
  await analyze(s, thenSolve);
}

async function analyze(s, thenSolve) {
  setStatus('Teile werden gesucht …');
  state.tableImg = null;
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
      state.table = false;
      state.tableChosen = true;
      state.edit = false;
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
  state.marks = state.marks.filter((p) => p.sceneId !== id);
  state.tableImg = null;
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
  state.marks.push({ kind: 'placed', sceneId: x.sceneId, index: x.index, cell: x.cell, rot: x.rot });
  state.selected = null;
  await solve();
});
// Remove: not a piece, or a piece the app got wrong; it takes no place.
$('detail-removed').addEventListener('click', async () => {
  const x = state.selected;
  $('detail').close();
  if (!x) return;
  state.marks.push({ kind: 'removed', sceneId: x.sceneId, index: x.index });
  state.selected = null;
  await solve();
});
$('undo-placed').addEventListener('click', async () => {
  state.marks.pop();
  await solve();
});

$('new-round').addEventListener('click', async () => {
  state.marks = [];
  state.skipped.clear();
  state.focus = null;
  for (const s of state.scenes) URL.revokeObjectURL(s.url);
  state.scenes = [];
  state.current = null;
  state.result = null;
  state.tableImg = null;
  state.crop = null;
  state.edit = false;
  await call('clearScenes');
  renderThumbs();
  show('result', false);
  setStatus('Setze die vorgeschlagenen Teile ein und fotografiere Puzzle und restliche Teile erneut.');
});

// All photos with the finished part as one picture of the table from above,
// the puzzle upright as in the reference.
async function tableImage() {
  if (state.tableImg) return state.tableImg;
  setStatus('Fotos werden zusammengesetzt …');
  const r = await call('table');
  const c = document.createElement('canvas');
  c.width = r.w;
  c.height = r.h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0);
  const M = new Map(r.views.map((v) => [v.sceneId, { M: v.M, Mi: invertH(v.M) }]));
  state.tableImg = { canvas: c, width: r.w, height: r.h, x0: r.x0, y0: r.y0, f: r.f, M, corners: r.corners };
  setStatus('');
  return state.tableImg;
}

$('table').addEventListener('click', () => {
  state.table = !state.table;
  state.tableChosen = true;
  state.edit = false;
  view.scene = null;
  renderResult();
});

// Correct the table: crop corners and places, then search again.
$('table-edit').addEventListener('click', async () => {
  state.edit = !state.edit;
  view.scene = null;
  renderResult();
  if (!state.edit && state.dirty) {
    state.dirty = false;
    await solve();
  }
});

function setStatus(t) {
  $('status').textContent = t;
}

async function solve() {
  setStatus('Plätze werden gesucht …');
  const r = await call('solve', {
    placed: state.marks.filter((m) => m.kind === 'placed'),
    removed: state.marks.filter((m) => m.kind === 'removed'),
    cells: state.marks.filter((m) => m.kind === 'cell').map(({ cell, free }) => ({ cell, free })),
    crop: state.crop,
  });
  // Pieces put in are hidden; the next arrows move up.
  r.suggestions = r.suggestions.filter((s) => !s.placed);
  $('undo-placed').hidden = !state.marks.length;
  // Numbered by probability: 1 is the likeliest.
  const order = r.suggestions.filter((s) => s.cell !== null && !s.sameAs).sort((a, b) => b.conf - a.conf);
  order.forEach((s, i) => {
    s.label = i + 1;
    s.level = 'ok';
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
  const unclear = r.scenes.reduce((a, s) => a + s.unclear.length, 0);
  const total = r.suggestions.filter((s) => !s.sameAs).length;
  let msg = `${state.gridNote ? `${state.gridNote} ` : ''}${total} Teile erkannt, ${order.length} mit Platz, nummeriert nach Wahrscheinlichkeit.`;
  const groups = r.scenes.reduce((a, s) => a + (s.groups?.length ?? 0), 0);
  if (groups) msg += ` ${groups} zusammengesteckte ${groups === 1 ? 'Gruppe' : 'Gruppen'} zugeordnet.`;
  if (unclear) msg += ` ${unclear} Flecken unklar (berühren sich Teile?).`;
  if (r.scenes.some((s) => s.board)) msg += ' Puzzle im Foto gefunden – Pfeile zeigen auf den Platz.';
  setStatus(msg);
  show('result', true);
  state.queue = order;
  renderResult();
  renderSteps();
}

// ---------- Step by step ----------
const keyOf = (x) => `${x.sceneId}:${x.index}`;

function queue() {
  const q = state.queue ?? [];
  return [...q.filter((x) => !state.skipped.has(keyOf(x))), ...q.filter((x) => state.skipped.has(keyOf(x)))];
}

function focused() {
  const f = state.focus;
  return f ? (state.queue ?? []).find((x) => x.sceneId === f.sceneId && x.index === f.index) : null;
}

// Candidate places of a piece: its place and the alternatives.
function candsOf(x) {
  return [{ ...x, p: x.conf }, ...(x.alts ?? []).map((a) => ({ ...a, level: x.level }))];
}

// The piece turned as it goes in (patch rotated by the candidate's rot).
function drawPieceTile(cv, x, rot) {
  const info = state.result.scenes.find((s) => s.id === x.sceneId);
  const p = info?.pieces[x.index];
  const g = cv.getContext('2d');
  g.fillStyle = '#0b1016';
  g.fillRect(0, 0, cv.width, cv.height);
  if (!p) return;
  const tile = document.createElement('canvas');
  tile.width = tile.height = p.P;
  tile.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.rgba), p.P, p.P), 0, 0);
  g.save();
  g.translate(cv.width / 2, cv.height / 2);
  g.rotate(((rot ?? 0) * Math.PI) / 2);
  g.drawImage(tile, -cv.width / 2, -cv.height / 2, cv.width, cv.height);
  g.restore();
}

function drawCellTile(cv, row, col) {
  const { canvas, C } = state.refView;
  const m = C / 4;
  const g = cv.getContext('2d');
  g.drawImage(canvas, col * C - m, row * C - m, C + 2 * m, C + 2 * m, 0, 0, cv.width, cv.height);
  const k = cv.width / (C + 2 * m);
  g.strokeStyle = '#4fb3ff';
  g.lineWidth = 2;
  g.strokeRect(m * k, m * k, C * k, C * k);
}

function renderSteps() {
  const q = queue();
  let x = focused();
  if (!x) {
    x = q[0] ?? null;
    state.focus = x ? { sceneId: x.sceneId, index: x.index, alt: 0 } : null;
  }
  show('step', !!x);
  if (x) {
    if (x.sceneId !== state.current) {
      state.current = x.sceneId;
      renderThumbs();
      renderResult();
    }
    const cands = candsOf(x);
    const alt = Math.min(state.focus.alt, cands.length - 1);
    const c = cands[alt];
    const n = q.indexOf(x) + 1;
    $('step-title').textContent = `Teil ${x.label}`;
    $('step-sub').textContent =
      `${n} von ${q.length}${state.skipped.has(keyOf(x)) ? ' · übersprungen' : ''} · ${Math.round(x.conf * 100)} %`;
    drawPieceTile($('step-piece'), x, c.rot);
    const box = $('step-cands');
    box.replaceChildren();
    cands.forEach((a, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cand${i === alt ? ' on' : ''}`;
      const cv = document.createElement('canvas');
      cv.width = cv.height = 144;
      drawCellTile(cv, a.row, a.col);
      const t = document.createElement('span');
      t.textContent = `R${a.row + 1} S${a.col + 1} · ${Math.round((a.p ?? 0) * 100)} %`;
      b.append(cv, t);
      b.addEventListener('click', () => {
        state.focus.alt = i;
        renderSteps();
        drawViewer();
      });
      box.append(b);
    });
    $('step-text').textContent = `Reihe ${c.row + 1}, Spalte ${c.col + 1}. ${turnText(c.turn)}`;
  }
  renderPieceList(q, x);
  drawViewer();
}

function renderPieceList(q, cur) {
  const box = $('piece-list');
  box.replaceChildren();
  for (const x of q) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `piece-row${x === cur ? ' on' : ''}`;
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = x.label;
    no.title = `${Math.round(x.conf * 100)} %`;
    no.style.color = COLORS[x.level];
    const pc = document.createElement('canvas');
    pc.width = pc.height = 104;
    drawPieceTile(pc, x, x.rot);
    b.append(no, pc);
    for (const a of candsOf(x).slice(0, 3)) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 104;
      drawCellTile(cv, a.row, a.col);
      cv.title = `R${a.row + 1} S${a.col + 1} · ${Math.round((a.p ?? 0) * 100)} %`;
      b.append(cv);
    }
    b.addEventListener('click', () => {
      state.focus = { sceneId: x.sceneId, index: x.index, alt: 0 };
      renderSteps();
      $('step').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    box.append(b);
  }
}

$('step-placed').addEventListener('click', async () => {
  const x = focused();
  if (!x) return;
  const c = candsOf(x)[state.focus.alt] ?? x;
  state.marks.push({ kind: 'placed', sceneId: x.sceneId, index: x.index, cell: c.cell, rot: c.rot });
  state.skipped.delete(keyOf(x));
  state.focus = null;
  await solve();
});
$('step-skip').addEventListener('click', () => {
  const x = focused();
  if (!x) return;
  state.skipped.add(keyOf(x));
  state.focus = null;
  renderSteps();
});
$('step-removed').addEventListener('click', async () => {
  const x = focused();
  if (!x) return;
  state.marks.push({ kind: 'removed', sceneId: x.sceneId, index: x.index });
  state.focus = null;
  await solve();
});

// ---------- Draw result ----------
// ok: has a place (numbered by probability), bad: no place.
const COLORS = { ok: '#f5f5f5', bad: '#7d8996' };

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

// What the viewer shows: the photo, or the table from above. full: size the
// whole picture is drawn at; the part shown starts at ox, oy (crop).
function viewImage(cur) {
  const t = state.table ? state.tableImg : null;
  if (!t) {
    const { width, height } = cur.info;
    return { canvas: cur.s.canvas, full: [width, height], width, height, ox: 0, oy: 0 };
  }
  const c = !state.edit && cropRect(t);
  const [x0, y0, x1, y1] = c || [0, 0, t.width, t.height];
  return { canvas: t.canvas, full: [t.width, t.height], width: x1 - x0, height: y1 - y0, ox: x0, oy: y0 };
}

// The crop in table pixels, inside the picture.
function cropRect(t) {
  const c = state.crop;
  if (!c) return null;
  const X = (u) => Math.max(0, Math.min(t.width, (u - t.x0) * t.f));
  const Y = (v) => Math.max(0, Math.min(t.height, (v - t.y0) * t.f));
  return [X(c[0]), Y(c[1]), X(c[2]), Y(c[3])];
}

// Recognition coordinates of the scene drawn → view (null: the photo itself).
let viewH = null;
const vp = (p) => (viewH ? applyH(viewH, p[0], p[1]) : p);

function renderResult() {
  const cur = currentScene();
  if (!cur) return;
  const cv = $('viewer');
  // Several photos with the puzzle: the table from above unless the user
  // chose otherwise.
  const boards = state.result.scenes.filter((x) => x.board).length;
  if (!state.tableChosen && boards >= 2) state.table = true;
  if (!boards) state.table = false;
  if (state.table && !state.tableImg) {
    tableImage()
      .then(() => {
        view.scene = null;
        renderResult();
      })
      .catch((err) => {
        state.table = false;
        state.tableChosen = true;
        setStatus(`Zusammensetzen ging nicht: ${err.message}`);
      });
  }
  const table = state.table && !!state.tableImg;
  $('table').hidden = !boards;
  $('table').textContent = state.table ? 'Einzelnes Foto' : 'Tisch von oben';
  $('table-edit').hidden = !table;
  $('table-edit').textContent = state.edit ? 'Fertig' : 'Korrigieren';
  show('edit-hint', table && state.edit);
  // Recognition coordinates refer to the possibly downscaled working image.
  const { width: w, height: h } = viewImage(cur);
  view.cssW = cv.parentElement.clientWidth;
  view.cssH = Math.min(window.innerHeight * 0.7, (view.cssW * h) / w);
  touchMode();
  const key = table ? `table${state.edit ? '-edit' : ''}` : cur.s.id;
  if (view.scene !== key) {
    view.fit = Math.min(view.cssW / w, view.cssH / h);
    view.s = view.fit;
    view.tx = (view.cssW - w * view.s) / 2;
    view.ty = (view.cssH - h * view.s) / 2;
    view.scene = key;
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
  const im = viewImage(cur);
  g.beginPath();
  g.rect(0, 0, im.width, im.height);
  g.clip();
  g.translate(-im.ox, -im.oy);
  g.drawImage(im.canvas, 0, 0, ...im.full);
  try {
    if (state.table && state.tableImg) drawTable(g, state.tableImg);
    else drawOverlay(g, cur);
  } finally {
    viewH = null;
    g.restore();
  }
}

// Places shown as free: the search result with the user's corrections since.
function freeCells() {
  const free = new Set(state.result.free ?? []);
  for (const m of state.marks) {
    if (m.kind === 'cell' && m.free) free.add(m.cell);
    else if (m.kind === 'cell' || m.kind === 'placed') free.delete(m.cell);
  }
  return free;
}

// Places of the finished part, with the user's corrections and pieces put in.
function filledCells() {
  const filled = new Set(state.result.scenes.flatMap((s) => s.board?.filled ?? []));
  for (const m of state.marks) {
    if (m.kind === 'cell' && m.free) filled.delete(m.cell);
    else if (m.kind === 'cell' || m.kind === 'placed') filled.add(m.cell);
  }
  return filled;
}

// Corners of a place in table pixels, null where no photo shows it.
function cellQuad(t, cell) {
  const n = state.cols + 1;
  const r = Math.floor(cell / state.cols);
  const c = cell % state.cols;
  const q = [
    t.corners[r * n + c],
    t.corners[r * n + c + 1],
    t.corners[(r + 1) * n + c + 1],
    t.corners[(r + 1) * n + c],
  ];
  return q.every(Boolean) ? q : null;
}

function drawTable(g, t) {
  const px = 1 / view.s;
  // Free places: thin frames; while correcting, filled blue.
  g.strokeStyle = '#4fb3ffcc';
  g.fillStyle = '#4fb3ff55';
  g.lineWidth = (state.edit ? 2 : 1.5) * px;
  for (const cell of freeCells()) {
    const q = cellQuad(t, cell);
    if (!q) continue;
    poly(g, q);
    if (state.edit) g.fill();
    g.stroke();
  }
  for (const info of state.result.scenes) {
    const m = t.M.get(info.id);
    if (!m) continue;
    viewH = m.M;
    drawOverlay(g, { s: { id: info.id }, info }, true);
  }
  viewH = null;
  if (state.edit) drawCropFrame(g, t, px);
}

// Crop while correcting: outside dimmed, corners to drag.
function drawCropFrame(g, t, px) {
  const [x0, y0, x1, y1] = cropRect(t) ?? [0, 0, t.width, t.height];
  g.fillStyle = '#000b';
  g.fillRect(0, 0, t.width, y0);
  g.fillRect(0, y1, t.width, t.height - y1);
  g.fillRect(0, y0, x0, y1 - y0);
  g.fillRect(x1, y0, t.width - x1, y1 - y0);
  g.strokeStyle = '#fff';
  g.lineWidth = 2 * px;
  g.strokeRect(x0, y0, x1 - x0, y1 - y0);
  for (const [x, y] of cropCorners(t)) {
    g.beginPath();
    g.arc(x, y, 12 * px, 0, Math.PI * 2);
    g.fillStyle = '#4fb3ff';
    g.fill();
    g.strokeStyle = '#000';
    g.stroke();
  }
}

function cropCorners(t) {
  const [x0, y0, x1, y1] = cropRect(t) ?? [0, 0, t.width, t.height];
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

// table: drawn into the table view (duplicates on a second photo left out,
// the frame comes from the places).
function drawOverlay(g, cur, table = false) {
  const px = 1 / view.s; // one screen unit in image pixels
  const sugg = state.result.suggestions.filter(
    (x) => x.sceneId === cur.s.id && (!state.edgeOnly || onEdge(x)) && !(table && x.sameAs),
  );

  if (!state.edgeOnly) drawUnclearAndGroups(g, cur.info, px);
  if (cur.info.board && !table) drawFilled(g, cur.info.board, px);
  for (const x of sugg) {
    const p = cur.info.pieces[x.index];
    const col = x.cell === null ? COLORS.bad : COLORS[x.level];
    poly(g, p.outline);
    g.strokeStyle = `${col}cc`;
    g.lineWidth = 2 * px;
    g.stroke();
  }
  if (table && state.edit) return;
  const f = !state.allArrows && focused();
  if (f && (f.sceneId === cur.s.id || table)) {
    if (f.sceneId === cur.s.id) drawFocus(g, cur.info, f, px);
    return;
  }
  drawArrows(g, sugg, cur.info.board, px);
}

function drawArrows(g, sugg, board, px) {
  for (const x of sugg) {
    if (x.cell === null || x.level === 'bad' || !x.target) continue;
    // Many arrows cross: by default only the next steps.
    if (!state.allArrows && x.label > ARROWS && x !== state.selected) continue;
    arrow(g, x.center, x.target, COLORS[x.level], px);
    targetMarker(g, x, board, px);
  }
  for (const x of sugg) {
    if (x.cell === null) continue;
    badge(g, x.center, x, px);
  }
}

// Step by step: only the piece in hand, its place and turn.
function drawFocus(g, info, f, px) {
  const c = { ...f, ...candsOf(f)[state.focus.alt] };
  poly(g, info.pieces[f.index].outline);
  g.strokeStyle = '#4fb3ff';
  g.lineWidth = 5 * px;
  g.stroke();
  if (c.target && info.board) {
    arrow(g, f.center, c.target, '#4fb3ff', px);
    targetMarker(g, { ...c, level: 'ok' }, info.board, px);
  }
  badge(g, f.center, c, px);
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
  const q = pts.map(vp);
  g.beginPath();
  g.moveTo(q[0][0], q[0][1]);
  for (const p of q.slice(1)) g.lineTo(p[0], p[1]);
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

function arrow(g, a0, b0, color, px) {
  const a = vp(a0);
  const b = vp(b0);
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
  const pts =
    x.quad ??
    [
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
function badge(g, c0, x, px0) {
  // In the overview pieces are often only a few millimetres: shrink the label
  // along, show degrees only when zoomed in.
  const c = vp(c0);
  const [k0, k1] = [vp(x.corners[0]), vp(x.corners[1])];
  const side = Math.hypot(k1[0] - k0[0], k1[1] - k0[1]);
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
  const filled = filledCells();
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
  gesture = { moved: false, start: snapshot(), corner: view.pointers.size === 1 ? cropCornerAt(e) : -1 };
});
vc.addEventListener('pointermove', (e) => {
  if (!view.pointers.has(e.pointerId) || !gesture) return;
  const prev = snapshot();
  view.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const now = snapshot();
  if (Math.hypot(now.cx - gesture.start.cx, now.cy - gesture.start.cy) > 6 || now.n > 1) gesture.moved = true;
  if (!gesture.moved || prev.n !== now.n) return;
  const r = vc.getBoundingClientRect();
  if (gesture.corner >= 0 && now.n === 1) {
    dragCorner(gesture.corner, now.cx - r.left, now.cy - r.top);
    return;
  }
  if (now.n === 1 && view.s <= view.fit * 1.01) return;
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
  if (!gesture.moved && view.pointers.size === 0 && gesture.corner < 0) {
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
  touchMode();
};

// Zoomed in or correcting, one finger moves the picture or a corner instead
// of scrolling the page.
function touchMode() {
  vc.style.touchAction = state.edit || view.s > view.fit * 1.01 ? 'none' : 'pan-y';
}

// Crop corner under the pointer (table view, correcting), else −1.
function cropCornerAt(e) {
  const t = state.tableImg;
  if (!state.edit || !state.table || !t) return -1;
  const r = vc.getBoundingClientRect();
  return cropCorners(t).findIndex(
    ([x, y]) =>
      Math.hypot(view.tx + x * view.s - (e.clientX - r.left), view.ty + y * view.s - (e.clientY - r.top)) <
      28,
  );
}

function dragCorner(i, sx, sy) {
  const t = state.tableImg;
  const X = Math.max(0, Math.min(t.width, (sx - view.tx) / view.s));
  const Y = Math.max(0, Math.min(t.height, (sy - view.ty) / view.s));
  let [x0, y0, x1, y1] = cropRect(t) ?? [0, 0, t.width, t.height];
  // At least two places wide and high.
  const m = 2 * state.refView.C * t.f;
  if (i === 0 || i === 3) x0 = Math.min(X, x1 - m);
  else x1 = Math.max(X, x0 + m);
  if (i < 2) y0 = Math.min(Y, y1 - m);
  else y1 = Math.max(Y, y0 + m);
  state.crop = [x0 / t.f + t.x0, y0 / t.f + t.y0, x1 / t.f + t.x0, y1 / t.f + t.y0];
  state.dirty = true;
  drawViewer();
}
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
  const im = viewImage(cur);
  const w = im.width * view.s;
  const h = im.height * view.s;
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
  const im = viewImage(cur);
  const v = [(sx - view.tx) / view.s + im.ox, (sy - view.ty) / view.s + im.oy];
  const t = state.table ? state.tableImg : null;
  // In the table view each photo has its own mapping; duplicates are hidden.
  const where = t
    ? state.result.scenes.filter((i) => t.M.has(i.id)).map((i) => [i, applyH(t.M.get(i.id).Mi, ...v)])
    : [[cur.info, v]];
  for (const [info, [x, y]] of where) {
    const hit = state.result.suggestions.find(
      (u) => u.sceneId === info.id && !(t && u.sameAs) && inside(info.pieces[u.index].outline, x, y),
    );
    if (!hit) continue;
    if (hit.cell !== null && !state.edit) {
      state.focus = { sceneId: hit.sceneId, index: hit.index, alt: 0 };
      renderSteps();
    } else openDetail(hit, info);
    return;
  }
  if (t && state.edit) toggleCell(t, v);
}

// A place the recognition got wrong: free ↔ filled.
function toggleCell(t, v) {
  for (let cell = 0; cell < state.cols * state.rows; cell++) {
    const q = cellQuad(t, cell);
    if (!q || !inside(q, v[0], v[1])) continue;
    state.marks.push({ kind: 'cell', cell, free: !freeCells().has(cell) });
    state.dirty = true;
    $('undo-placed').hidden = false;
    drawViewer();
    return;
  }
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
