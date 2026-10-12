# Contributing

Bug reports, photos with misdetections and pull requests are welcome.

## Setup

Requirements: Node.js 24, Google Chrome (for the browser test) and Python 3
with NumPy and Pillow (for the test photos from `tools/synth.py`).

```sh
npm ci
npm run serve        # http://localhost:8793
```

There is no build step; the files in the root directory are the app, the
image recognition lives in `core/` and runs in the browser as well as in
Node.

## Before a pull request

```sh
npm run lint:fix     # Biome: format and lint
npm test             # unit and recognition tests (node:test)
npm run test:e2e     # end to end in headless Chrome, loose and half-finished
```

CI runs the same steps, plus Ruff for `tools/*.py`.

## Notes

- Changes to app files: bump `VERSION` in `sw.js`, otherwise the service
  worker keeps serving the old version.
- Measure changes to the recognition with `tools/bench.mjs` over several
  scenes from `tools/synth.py`, also with `--badref`, and state the numbers
  before/after in the pull request. What matters most is "sure, of which
  right": a wrong sure suggestion weighs more than a missing one.
- All pixel sizes are tuned to pieces of about 90 px; choose new thresholds
  relative to that.
- OpenCV.js: fetch memory views (`mat.data`) only after all allocations;
  growing WASM memory invalidates older views. Keep JS copies
  (`Uint8Array.from(mat.data)`) when more allocations follow.
- No photos by other authors in the repository.
- Code, comments, documentation and commit messages in English. The app's
  user interface is German.
