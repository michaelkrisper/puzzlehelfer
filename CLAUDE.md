# CLAUDE.md

Puzzlehelfer is an installable PWA that photographs jigsaw pieces and tells
where each belongs and how to turn it. Vanilla JS, no build step, OpenCV.js
(custom SIMD build in `vendor/`) in a web worker; everything runs on the
device. Deployed to GitHub Pages from `main`. Target devices are phones
(a low-RAM Android and a small iPhone): speed and memory matter more than on
the desktop.

## Commands

```sh
npm ci                  # Biome only; no runtime dependencies
npm run serve           # http://localhost:8793 (python3 -m http.server)
npm run lint            # Biome check (format + lint); npm run lint:fix writes
npx biome ci .          # exactly what CI runs
npm test                # node:test unit + recognition tests (needs python3 with numpy, Pillow)
npm run test:e2e        # headless Chrome at phone size, loose and half-finished puzzle
pipx run ruff check tools && pipx run ruff format --check tools
python3 tools/synth.py --image tests/fixtures/picture.jpg --pieces 100 --seed 1 --out DIR
node tools/bench.mjs DIR [--badref]   # detection/assignment on synthetic scenes
```

`tests/e2e.mjs` starts its own server (port 8794) and Chrome (CDP 9337);
override Chrome with `CHROME=/path`. Only one headless browser at a time on
small machines; delete temporary Chrome profiles afterwards.

## Architecture

- `index.html`, `app.js`, `style.css`: UI (German). Tabs "Vorlage" (reference
  photo, corners, piece count, grid) and "Teile" (photos, step cards "Nach
  Lücke" / "Nach Teil" / "Suchliste", "Am Tisch" full-screen mode, sweep).
- `worker.js`: owns OpenCV, the reference and all scene analyses; messages
  `reference`, `scene`, `solve`, `table`, ...; caches analyses and the last
  solve in IndexedDB.
- `core/` (shared by worker and Node tests, each file sets `PH.<name>`):
  `reference.js` (find and rectify the box picture, cells), `segment.js`
  (pieces vs. table), `piece.js` (core rectangle, side types and curves),
  `feature.js` + `knn.js` / `gpu.js` (SIFT/BRISK matching, WASM and WebGL2
  nearest neighbours), `match.js` (image comparison, scores), `board.js`
  (finished part: registration, filled places, rims, islands, seam grid),
  `fit.js` (outline fit of a piece into a gap), `pipeline.js`
  (`analyzeScene` per photo, `solve` over all photos), `geom.js`, `stitch.js`
  (photo overlap), `track.js` (sweep tracking).
- `sw.js`: offline cache named `puzzlehelfer-<version>`; other apps share the
  origin, so cleanup only touches this prefix.
- `tools/`: `synth.py` (synthetic scenes with known truth), `eval.mjs`
  (`loadCore`, `loadImage` for Node experiments), `bench.mjs`,
  `stamp-version.mjs` (deploy).

## Rules and pitfalls

- `clone()` of this OpenCV.js build shares the pixels: copy with `copyTo`
  into a new `Mat`. Delete every `Mat` you create.
- Never keep a typed-array view on WASM memory across a call that may grow it
  (`mem.grow` detaches the buffer); create the view after growing and
  `.slice()` results before the next call.
- All pixel thresholds are tuned to pieces of about 90 px; photos are scaled
  to that (`TARGET_SIDE` in `core/pipeline.js`). Never tune a constant at
  another scale.
- Recognition changes are judged on real photos, not on synthetic scenes
  alone; synthetic tests are a smoke test. State before/after numbers in the
  PR. A wrong "sure" suggestion weighs more than a missing one; shown
  percentages should stay honest (they are capped at 95 %).
- The analysis phase (`analyzeScene`) and the solve phase (`solve`) are
  separate: solve-only changes can reuse cached analyses, analysis changes
  need fresh ones (piece indices then change).
- `app.js` and `worker.js` both open IndexedDB `puzzlehelfer` at version 1;
  change both together. Cached analyses are keyed by app version, file,
  reference/corners and grid.
- UI text German, plain and short; code, comments and docs English. Comments
  explain the non-obvious why, not the code. No new dependencies.
- Biome formats Markdown too: `_emphasis_`, not `*emphasis*`.

## Workflow

- Every change starts with a GitHub issue. Branch `<issue>-<slug>` from
  `main` (`gh issue develop <issue> --checkout`), open a PR with
  `Closes #<issue>`. Never push to `main` directly.
- PRs auto-merge (squash) once CI and the "Linked ticket" check pass; drafts
  are not merged.
- Versions exist only as git tags `vX.Y.Z`. Every merge to `main` tags the
  next patch; never edit version numbers in files (`VERSION` in `sw.js` and
  `APP_VERSION` in `app.js` are placeholders the deploy stamps).
  `CHANGELOG.md` is frozen; release notes come from PR titles and tickets.
  Minor/major releases: Actions -> Release.
- Merging to `main` deploys to GitHub Pages automatically.
- Details: CONTRIBUTING.md.
