# Changelog

## Unreleased

- Much faster, above all on phones (Pixel 4a: about 16 s per photo instead
  of about 2 min): OpenCV 4.14 with WebAssembly SIMD and only the needed
  modules (6.6 MB instead of 11), feature points detected once per photo,
  nearest-neighbour matching in an own SIMD module (`wasm/knn.c`), reference
  feature points kept across −/+ and app restarts.
- Finished part: RANSAC with more iterations, and BRISK pairs besides SIFT,
  so the fit no longer depends on chance.
- Feature points (SIFT, BRISK) locate pieces directly in the reference,
  regardless of their shape, and act as a strong vote in the assignment.
  OpenCV.js is now a custom build with SIFT (see `vendor/README.md`).
- Pieces with big knobs and wavy cuts: core rectangle from projection
  profiles, core size from the finished part on the table. Rectangular
  pieces (e.g. 12 × 20) are supported; their rotation is fixed up to 180°.
- Separating pieces on wooden tables: table colours by hue (light falloff,
  darker planks), outlines from local structure so brown pieces no longer
  break apart, fragments are joined.
- Half-finished puzzle: matched with feature points of the high-resolution
  reference, homography plus a smooth cubic correction, which straightens a
  bent or wavy reference. Occupied places are also recognised by comparing
  photo and reference.
- Groups of joined pieces and pieces lying against each other are located
  as a whole (letter, arrow, rotation); their places are reserved.
- Fixed: loose pieces inside a closed border vanished from the mask; a
  single large area could be taken as the typical piece size.
- Documentation, comments and code in English; the user interface stays
  German.

## 1.0.0 – 2026-10-10

- Reference from the box lid: picture border found automatically and
  adjustable by hand, grid from piece count and aspect ratio.
- Recognise pieces on the table (table colour model, hysteresis, GrabCut for
  poor shapes), corners and side profiles (knob, hole, flat).
- Place and rotation by image comparison with colour fitting per candidate,
  robust against poor, blurry or glossy references.
- Puzzle rules: straight sides only at the border and facing outwards, knob
  and hole profiles of the neighbours, the solution grows from the outside
  in.
- Half-finished puzzle in the photo: occupied places, gap outlines, arrows
  straight to the place.
- Several photos per round, pieces photographed twice are recognised.
- Installable and offline, no data leaves the device.
- Biome, Ruff, unit and recognition tests on artificial scenes, browser
  test, CI with deployment to GitHub Pages.
