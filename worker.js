// Image recognition runs in the background so the 6.6 MB OpenCV blocks the UI
// neither while loading nor while computing. Reference and scenes live here.
importScripts(
  'vendor/opencv.js',
  'core/geom.js',
  'core/piece.js',
  'core/segment.js',
  'core/reference.js',
  'core/match.js',
  'core/board.js',
  'core/knn.js',
  'core/gpu.js',
  'core/feature.js',
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
const scenes = new Map(); // id → result of analyzeScene

const progressFor = (id) => (text) => postMessage({ type: 'progress', id, text });

// The reference corners and grid that the seams of a finished part show
// (in places of the current grid), mapped back onto the reference photo.
function seamQuad(g) {
  if (!g || !refQuad) return null;
  const { W, H, C } = ref;
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
    cols: g.x.n,
    rows: g.y.n,
    // Largest correction of a grid line, in places.
    shift: Math.max(
      Math.abs(g.x.from),
      Math.abs(g.y.from),
      Math.abs(g.x.to - ref.cols),
      Math.abs(g.y.to - ref.rows),
    ),
  };
}

const handlers = {
  quad({ image }) {
    return { quad: PH.reference.findPictureQuad(cv, image) };
  },
  reference({ image, quad, cols, rows, cache }) {
    refQuad = quad;
    const prev = ref ?? cache;
    ref = PH.reference.buildReference(cv, image, quad, cols, rows, prev);
    // Places depend on the grid, so old analyses no longer fit.
    scenes.clear();
    // New feature points go back to the app, which stores them.
    const fresh = ref.feat !== prev?.feat ? { key: ref.key, feat: ref.feat } : null;
    // Finer copy for the views, which can be zoomed.
    const f = Math.min(3, 1600 / Math.max(ref.W, ref.H));
    const view = PH.reference.rectify(cv, image, quad, Math.round(ref.W * f), Math.round(ref.H * f));
    return { rgba: ref.rgba.data, W: ref.W, H: ref.H, C: ref.C, cache: fresh, view };
  },
  scene({ id, sceneId, image }) {
    if (!ref) throw new Error('Keine Vorlage');
    const s = PH.pipeline.analyzeScene(cv, image, ref, progressFor(id));
    scenes.set(sceneId, s);
    return {
      pieces: s.pieces.length,
      unclear: s.unclear.length,
      board: !!s.board,
      border: s.board?.border ?? null,
      aspect: ref.hi.w / ref.hi.h,
      seams: seamQuad(s.board?.seams),
    };
  },
  removeScene({ sceneId }) {
    scenes.delete(sceneId);
    return {};
  },
  clearScenes() {
    scenes.clear();
    return {};
  },
  solve({ id }) {
    const ids = [...scenes.keys()];
    const list = ids.map((k) => scenes.get(k));
    const sugg = PH.pipeline.solve(ref, list, { progress: progressFor(id) });
    return {
      suggestions: sugg.map((s) => ({ ...s, sceneId: ids[s.scene] })),
      scenes: ids.map((sid, i) => {
        const s = list[i];
        return {
          id: sid,
          width: s.width,
          height: s.height,
          board: s.board ? { H: s.board.H, filled: s.board.filled } : null,
          unclear: s.unclear,
          groups: s.groups,
          pieces: s.pieces.map((p) => ({ outline: p.outline, rgba: p.raw.rgba, P: p.raw.P })),
        };
      }),
    };
  },
};

self.onmessage = async (e) => {
  const { id, type } = e.data;
  await ready;
  try {
    postMessage({ type: 'result', id, data: handlers[type](e.data) });
  } catch (err) {
    console.error(err);
    postMessage({ type: 'error', id, message: String(err?.message ?? err) });
  }
};
