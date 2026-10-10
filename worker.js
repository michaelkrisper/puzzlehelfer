// Bilderkennung im Hintergrund, damit das 10-MB-OpenCV die Oberfläche weder
// beim Laden noch beim Rechnen blockiert. Vorlage und Szenen bleiben hier.
importScripts(
  'vendor/opencv.js',
  'core/geom.js',
  'core/piece.js',
  'core/segment.js',
  'core/reference.js',
  'core/match.js',
  'core/board.js',
  'core/pipeline.js',
);

const ready = new Promise((resolve) => {
  if (self.cv.Mat) resolve();
  else self.cv.onRuntimeInitialized = resolve;
}).then(() => {
  // Das Emscripten-Modul ist "thenable" und würde jedes await blockieren.
  delete self.cv.then;
  postMessage({ type: 'ready' });
});

let ref = null;
const scenes = new Map(); // id → Ergebnis von analyzeScene

const progressFor = (id) => (text) => postMessage({ type: 'progress', id, text });

const handlers = {
  quad({ image }) {
    return { quad: PH.reference.findPictureQuad(cv, image) };
  },
  reference({ image, quad, cols, rows }) {
    ref = PH.reference.buildReference(cv, image, quad, cols, rows);
    // Plätze hängen am Raster, alte Analysen passen nicht mehr.
    scenes.clear();
    return { rgba: ref.rgba.data, W: ref.W, H: ref.H, C: ref.C };
  },
  scene({ id, sceneId, image }) {
    if (!ref) throw new Error('Keine Vorlage');
    const s = PH.pipeline.analyzeScene(cv, image, ref, progressFor(id));
    scenes.set(sceneId, s);
    return { pieces: s.pieces.length, unclear: s.unclear.length, board: !!s.board };
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
