# Contributing

Bug reports, photos with misdetections and pull requests are welcome.

## Workflow

1. Every change starts with an issue: a bug report or a feature request.
2. Work on a branch named after the issue. `gh issue develop <issue> --checkout`
   creates `<issue>-<title>`.
3. Open a pull request against `main`. The _Tickets_ check links the issue
   (`Closes #<issue>`); a pull request without a ticket fails.
4. CI runs on every pull request. When all checks are green, _Auto-merge_
   squash-merges it. Open the pull request as a draft while it is not ready.
5. The merge closes the issue. `main` always holds the latest valid state
   (trunk-based development).

## Versions and releases

- Versions follow [Semantic Versioning](https://semver.org) and exist only as
  git tags (`vMAJOR.MINOR.PATCH`).
- CI tags every merge to `main` with the next patch version.
- A release bundles the changes since the previous one: run
  _Actions → Release → Run workflow_ and pick `minor` or `major`. It tags
  `main` and publishes a GitHub release listing the merged pull requests and
  closed tickets.

## Setup

Requirements: Node.js 24 or newer (CI uses 26, see `.nvmrc`), Google Chrome (for the browser test) and Python 3
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

- The deploy stamps the version tag into `VERSION` in `sw.js` (the service
  worker's cache) and `APP_VERSION` in `app.js` (`tools/stamp-version.mjs`);
  the values in the repository are placeholders. Release notes come from the
  pull requests and tickets, so give them clear titles.
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
