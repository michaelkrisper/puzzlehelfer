// Image recognition runs in the background so the 6.6 MB OpenCV blocks the UI
// neither while loading nor while computing. Reference and scenes live here.
importScripts(
  'vendor/opencv.js',
  'core/geom.js',
  'core/piece.js',
  'core/segment.js',
  'core/reference.js',
  'core/match.js',
  'core/fit.js',
  'core/board.js',
  'core/knn.js',
  'core/gpu.js',
  'core/feature.js',
  'core/stitch.js',
  'core/pipeline.js',
);

// opencv.js sets cv to a Promise of the module.
const ready = new Promise((resolve) => self.cv.then(resolve)).then((m) => {
  self.cv = m;
  postMessage({ type: 'ready' });
  setTimeout(() => PH.gpu.warm(), 0);
});

let ref = null;
let refQuad = null;
let refCount = 0; // piece count from the box
const scenes = new Map(); // id → result of analyzeScene
// id → stamp of its analysis, new each time a photo is analysed: a stored
// search result fits only the very same analyses.
const analyses = new Map();
const points = new Map(); // id → ORB points, to lay photos onto each other
const near = new Map(); // id → photos of the sweep next to it, nearest first
const tried = new Set(); // pairs of photos compared, `${id}:${other}`
let table = null; // table colours of the last photo that clearly showed them

// A placed photo the photo overlaps (most common points), or null. The
// sweep's neighbours first: one comparison takes a second or more on a
// phone.
function overlapOf(id) {
  const order = [...new Set([...(near.get(id) ?? []), ...scenes.keys()])];
  let best = null;
  for (const oid of order) {
    const o = scenes.get(oid);
    const key = `${id}:${oid}`;
    if (oid === id || !o?.view || !points.has(oid) || tried.has(key)) continue;
    tried.add(key);
    const m = PH.stitch.match(cv, points.get(id), points.get(oid));
    if (m && (!best || m.inliers > best.inliers)) best = { ...m, o };
    if (best?.inliers >= 150) break;
  }
  return best;
}

const scaled = (k) => [k, 0, 0, 0, k, 0, 0, 0, 1];

// Photos without the finished part onto one they overlap (core/stitch.js),
// repeated while one more finds its place: a close-up of a tray taken
// before the overview gets its place with the overview.
function placeAll() {
  const { mulH } = PH.geom;
  let more = true;
  while (more) {
    more = false;
    for (const [id, s] of scenes) {
      if (s.view || !points.has(id)) continue;
      const best = overlapOf(id);
      if (!best) continue;
      // Points are in photo pixels, views in working pixels.
      const H = mulH(scaled(best.o.scale), mulH(best.H, scaled(1 / s.scale)));
      PH.pipeline.placeScene(s, mulH(best.o.view.Hi, H));
      more = true;
    }
  }
}

// Scale of the photos of the same size before (a sweep at one height), for
// one without loose pieces to measure.
function scaleHint(image) {
  const v = [...scenes.values()]
    .filter(
      (s) => Math.abs(s.width / s.scale - image.width) < 2 && Math.abs(s.height / s.scale - image.height) < 2,
    )
    .map((s) => s.scale)
    .sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
}

function forget() {
  scenes.clear();
  analyses.clear();
  points.clear();
  near.clear();
  tried.clear();
  table = null;
}

// Shown photos with pieces of about 65 px, at least 1200 and at most 2400 px:
// a sweep 30 cm over the table brings many photos with large pieces.
// size: longer side of the photo as analysed.
const viewMax = (size, s) => Math.round(Math.min(2400, Math.max(1200, 0.75 * s.scale * size)));

// Analyses are stored in the app's database: after a reload, or in a new
// worker after a stop, a photo comes back in a moment instead of being
// analysed again (minutes on a phone). Stored under the photo's id with the
// app's key (version, file) and the reference and grid they were made with.
const db = new Promise((resolve) => {
  if (!self.indexedDB) return resolve(null);
  const r = indexedDB.open('puzzlehelfer', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => resolve(null);
});
// The result of one request, or null if anything fails (no stored analysis:
// the photo is analysed as without one).
async function request(mode, f) {
  const d = await db;
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const tx = d.transaction('kv', mode);
      const r = f(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(r.result ?? null);
      tx.onabort = () => {
        console.warn(tx.error);
        resolve(null);
      };
    } catch (err) {
      console.warn(err);
      resolve(null);
    }
  });
}
const stored = (sceneId) => request('readonly', (os) => os.get(`analysis:${sceneId}`));
const keep = (sceneId, value) => request('readwrite', (os) => os.put(value, `analysis:${sceneId}`));
// A copy without functions (feature matches carry one for the groups found
// during the analysis), which cannot be stored.
function plain(v, seen = new Map()) {
  if (typeof v === 'function') return undefined;
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
  if (seen.has(v)) return seen.get(v);
  const o = Array.isArray(v) ? [] : {};
  seen.set(v, o);
  for (const k of Object.keys(v)) {
    const x = plain(v[k], seen);
    if (x !== undefined || Array.isArray(v)) o[k] = x;
  }
  return o;
}

// Steps of one photo (analyzeScene, then laying it onto the others here) and
// where each starts as part of the time the photo takes (Cats photos,
// desktop); steps without a finished part or feature points are skipped.
// at, to: part done at this message and at the next, for the progress bars.
const PLACING = 'Foto wird eingeordnet …';
const SCENE_STEPS = new Map([
  ['Teilgröße wird gemessen …', 0],
  ['Teile werden vom Tisch getrennt …', 0.07],
  ['Merkmalspunkte werden gesucht …', 0.22],
  ['Fertiger Teil wird auf die Vorlage gelegt …', 0.52],
  ['Teile werden vermessen …', 0.71],
  ['Merkmalspunkte werden verglichen …', 0.76],
  [PLACING, 0.95],
]);
function sceneStep(text) {
  const at = SCENE_STEPS.get(text);
  if (at === undefined) return {};
  return { at, to: [...SCENE_STEPS.values()].find((v) => v > at) ?? 1 };
}
// The search for places compares piece by piece, a second time after the
// colours were fitted again.
function solveStep(text) {
  const m = / (\d+) von (\d+)/.exec(text);
  if (!m) return text.startsWith('Umrisse') ? { at: 0.02, to: 0.1 } : {};
  const [a, b] = text.startsWith('Feinabgleich') ? [0.6, 0.95] : [0.1, 0.6];
  const n = Number(m[1]);
  const N = Number(m[2]);
  return { at: a + ((b - a) * (n - 1)) / N, to: a + ((b - a) * Math.min(N, n + 9)) / N };
}
const progressFor = (id, step) => (text) => postMessage({ type: 'progress', id, text, ...step(text) });

// Where the pieces are, as parts of the photo's width and height: marks of
// the user follow their piece when a photo is analysed again.
const centers = (s) =>
  s.pieces.map(({ outline: o }) => [
    o.reduce((a, p) => a + p[0], 0) / o.length / s.width,
    o.reduce((a, p) => a + p[1], 0) / o.length / s.height,
  ]);

// The reference corners and grid that the seams of a finished part show
// (PH.geom.gridFromSeams), mapped back onto the reference photo.
function seamQuad(seams) {
  if (!seams || !refQuad) return null;
  const { W, H, C } = ref;
  const g = PH.geom.gridFromSeams(
    seams,
    refCount || ref.cols * ref.rows,
    ref.hi.w / ref.hi.h,
    ref.cols,
    ref.rows,
  );
  if (!g) return null;
  const Hq = PH.geom.homography(
    [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ],
    refQuad,
  );
  const at = (u, v) => PH.geom.applyH(Hq, u * C, v * C);
  return {
    quad: [at(g.x.from, g.y.from), at(g.x.to, g.y.from), at(g.x.to, g.y.to), at(g.x.from, g.y.to)],
    cols: g.cols,
    rows: g.rows,
    // Largest correction of a grid line, in places.
    shift: Math.max(
      Math.abs(g.x.from),
      Math.abs(g.y.from),
      Math.abs(g.x.to - ref.cols),
      Math.abs(g.y.to - ref.rows),
    ),
  };
}

// The search for places with the user's marks (app.js solve) and what its
// result depends on: the photos, each by the analysis it has, their places on
// the table, and the marks as far as the search reads them.
function search({ placed = [], removed = [], nofit = [], cells = [], crop = null }) {
  const ids = [...scenes.keys()];
  const list = ids.map((k) => scenes.get(k));
  const local = (arr) =>
    arr.map((p) => ({ ...p, scene: ids.indexOf(p.sceneId) })).filter((p) => p.scene >= 0);
  const opts = { placed: local(placed), removed: local(removed), nofit: local(nofit), cells, crop };
  const key = JSON.stringify([
    ref.key,
    ref.cols,
    ref.rows,
    ids.map((k) => [k, analyses.get(k) ?? null, scenes.get(k).view?.H ?? null]),
    opts.placed.map((p) => [p.scene, p.index, p.cell, p.rot]),
    opts.removed.map((p) => [p.scene, p.index]),
    opts.nofit.map((p) => [p.scene, p.index, p.cell]),
    cells.map((c) => [c.cell, c.free]),
    crop,
  ]);
  return { ids, list, opts, key };
}

const handlers = {
  quad({ image }) {
    return { quad: PH.reference.findPictureQuad(cv, image) };
  },
  reference({ image, quad, cols, rows, count, cache }) {
    refQuad = quad;
    refCount = count;
    const prev = ref ?? cache;
    ref = PH.reference.buildReference(cv, image, quad, cols, rows, prev);
    // Places depend on the grid, so old analyses no longer fit.
    forget();
    // New feature points go back to the app, which stores them.
    const fresh = ref.feat !== prev?.feat ? { key: ref.key, feat: ref.feat } : null;
    // Finer copy for the views, which can be zoomed.
    const f = Math.min(3, 1600 / Math.max(ref.W, ref.H));
    const view = PH.reference.rectify(cv, image, quad, Math.round(ref.W * f), Math.round(ref.H * f));
    return { rgba: ref.rgba.data, W: ref.W, H: ref.H, C: ref.C, cache: fresh, view };
  },
  // Without image: the stored analysis, or {miss: true}.
  async scene({ id, sceneId, image = null, next = [], key = '' }) {
    if (!ref) throw new Error('Keine Vorlage');
    const made = `${key}:${ref.key}:${ref.cols}x${ref.rows}`;
    let s;
    let pts;
    let stamp;
    // Whether the analysis is in the database (a new worker can get it back).
    let kept = true;
    if (!image) {
      const r = await stored(sceneId);
      if (r?.made !== made) return { miss: true };
      ({ s, points: pts, stamp } = r);
    } else {
      const progress = progressFor(id, sceneStep);
      s = PH.pipeline.analyzeScene(cv, image, ref, progress, { scale: scaleHint(image), table });
      progress(PLACING);
      pts = PH.stitch.describe(cv, image);
      // As analysed: placing and solving add to it.
      stamp = `${Date.now()}:${Math.random()}`;
      kept = !!(await keep(sceneId, { made, s: plain(s), points: pts, stamp }));
    }
    if (s.table) table = s.table;
    scenes.set(sceneId, s);
    analyses.set(sceneId, stamp);
    points.set(sceneId, pts);
    near.set(sceneId, next);
    placeAll();
    return {
      pieces: s.pieces.length,
      unclear: s.unclear.length,
      board: !!s.board,
      // Photos laid onto the table so far (one more may have found its place).
      placed: [...scenes].filter(([, x]) => x.view).map(([k]) => k),
      border: s.board?.border ?? null,
      aspect: ref.hi.w / ref.hi.h,
      seams: seamQuad(s.board?.seams),
      viewMax: viewMax(pts.size, s),
      centers: centers(s),
      kept,
    };
  },
  // All photos with the puzzle as one picture from above. images: [sceneId,
  // ImageData] of the photos laid onto the table, as shown by the app.
  table({ images }) {
    const ids = [...scenes.keys()];
    const shown = new Map(images);
    const t = PH.pipeline.tableView(
      cv,
      ids.map((k) => scenes.get(k)),
      ids.map((k) => shown.get(k)),
      ref,
    );
    if (!t) throw new Error('Kein Foto zeigt den fertigen Teil');
    return { ...t, views: t.views.map((v) => ({ sceneId: ids[v.scene], M: v.M })) };
  },
  removeScene({ sceneId }) {
    scenes.delete(sceneId);
    analyses.delete(sceneId);
    points.delete(sceneId);
    near.delete(sceneId);
    return {};
  },
  clearScenes() {
    forget();
    return {};
  },
  // The search once more without an answer, after a stored result: it fills
  // the caches of the outline fit (pipeline.js outlineFits), so that the
  // next search, after the next tap, takes half the time.
  warm(marks) {
    const { list, opts } = search(marks);
    if (list.length) PH.pipeline.solve(ref, list, opts);
    return {};
  },
  // stored: the stored result if it was searched with the same photos,
  // analyses and marks (after a reload).
  async solve({ id, stored: fromStore = false, ...marks }) {
    const { ids, list, opts, key } = search(marks);
    let sugg = null;
    if (fromStore) {
      const r = await request('readonly', (os) => os.get('solved'));
      if (r?.key === key) sugg = Object.assign(r.list, { gaps: r.gaps });
    }
    const hit = !!sugg;
    if (!sugg) {
      sugg = PH.pipeline.solve(ref, list, { ...opts, progress: progressFor(id, solveStep) });
      request('readwrite', (os) => os.put({ key, list: [...sugg], gaps: sugg.gaps ?? [] }, 'solved'));
    }
    const { free } = PH.pipeline.boardState(ref, list, opts.cells);
    return {
      suggestions: sugg.map((s) => ({ ...s, sceneId: ids[s.scene] })),
      gaps: (sugg.gaps ?? []).map((g) => ({
        ...g,
        cands: g.cands.map((c) => ({ ...c, sceneId: ids[c.scene] })),
      })),
      free: [...free.keys()].filter((c) => free[c]),
      stored: hit,
      scenes: ids.map((sid, i) => {
        const s = list[i];
        return {
          id: sid,
          width: s.width,
          height: s.height,
          board: s.board ? { H: s.board.H, filled: s.board.filled } : null,
          view: s.view ? { H: s.view.H } : null,
          unclear: s.unclear,
          groups: s.groups,
          pieces: s.pieces.map((p) => ({ outline: p.outline, rgba: p.raw.rgba, P: p.raw.P })),
        };
      }),
    };
  },
};

// One message after the other, also while one waits for the database.
let queue = ready;
self.onmessage = (e) => {
  queue = queue.then(() => handle(e)).catch((err) => console.error(err));
};
async function handle(e) {
  const { id, type } = e.data;
  try {
    const data = await handlers[type](e.data);
    // The table picture (up to 48 MB) goes over without a copy.
    postMessage({ type: 'result', id, data }, type === 'table' ? [data.rgba.buffer] : []);
  } catch (err) {
    console.error(err);
    postMessage({ type: 'error', id, message: String(err?.message ?? err) });
  }
}
