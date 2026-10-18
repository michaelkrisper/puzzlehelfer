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
const previews = new Map(); // id → photo at most 2400 px, for the table view

function shrink(image, max) {
  const f = Math.min(1, max / Math.max(image.width, image.height));
  if (f === 1) return image;
  const src = cv.matFromImageData(image);
  const dst = new cv.Mat();
  cv.resize(
    src,
    dst,
    new cv.Size(Math.round(image.width * f), Math.round(image.height * f)),
    0,
    0,
    cv.INTER_AREA,
  );
  const out = { data: new Uint8ClampedArray(dst.data), width: dst.cols, height: dst.rows };
  src.delete();
  dst.delete();
  return out;
}

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
    previews.clear();
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
    previews.set(sceneId, shrink(image, 2400));
    return {
      pieces: s.pieces.length,
      unclear: s.unclear.length,
      board: !!s.board,
      border: s.board?.border ?? null,
      aspect: ref.hi.w / ref.hi.h,
      seams: seamQuad(s.board?.seams),
    };
  },
  // All photos with the puzzle as one picture from above.
  table() {
    const ids = [...scenes.keys()];
    const t = PH.pipeline.tableView(
      cv,
      ids.map((k) => scenes.get(k)),
      ids.map((k) => previews.get(k)),
      ref,
    );
    if (!t) throw new Error('Kein Foto zeigt den fertigen Teil');
    return { ...t, views: t.views.map((v) => ({ sceneId: ids[v.scene], M: v.M })) };
  },
  removeScene({ sceneId }) {
    scenes.delete(sceneId);
    previews.delete(sceneId);
    return {};
  },
  clearScenes() {
    scenes.clear();
    previews.clear();
    return {};
  },
  solve({ id, placed = [], removed = [], cells = [], crop = null }) {
    const ids = [...scenes.keys()];
    const list = ids.map((k) => scenes.get(k));
    const local = (arr) =>
      arr.map((p) => ({ ...p, scene: ids.indexOf(p.sceneId) })).filter((p) => p.scene >= 0);
    const sugg = PH.pipeline.solve(ref, list, {
      progress: progressFor(id),
      placed: local(placed),
      removed: local(removed),
      cells,
      crop,
    });
    const { free } = PH.pipeline.boardState(ref, list, cells);
    return {
      suggestions: sugg.map((s) => ({ ...s, sceneId: ids[s.scene] })),
      free: [...free.keys()].filter((c) => free[c]),
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
