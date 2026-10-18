# Changelog

## Unreleased

- "Tisch abfahren": the camera runs in the app; moving the phone over the
  table and holding it still for a moment takes a photo whenever it has
  moved on by about a third of the picture ("Foto jetzt" takes one at
  once). Photos are analysed in the background, the places searched at
  "Fertig".
- Photos without the finished part (close-ups of a tray) are laid onto a
  photo they overlap by ORB points of mat, trays and pieces, and get their
  place on the table like the others: their pieces are part of the table
  picture and of the outline fit at the end. On the photos of 18 October
  the tray close-up found its place with 169 common points.
- The newest photo wins: where a later photo shows the table, pieces of
  earlier photos there are left out (they were put in or laid out anew),
  and the table picture shows the later photo on top, its border blended
  in. Gap rims come per side from the photo that shows that side
  sharpest.
- Photos that neither show the finished part nor overlap another photo
  are marked "nicht eingeordnet".

- "Nach Teil" lists each candidate place once (the same place turned
  otherwise came twice).

- The step card fits one try on one screen: the gap as the photo shows it
  (the real rim, not the reference picture) next to the piece cut from the
  photo, turned as it goes in and at the same scale with its knobs whole,
  and below where the piece lies on the table, ringed. Candidate places in
  "Nach Teil" show the real gaps too. Big buttons; the list of all pieces
  and the map are folded away.

- Much less memory: the app was ended by the phone after a handful of
  photos. Feature points of the reference are found in tiles (SIFT doubles
  the picture inside and kept about 700 MB of WebAssembly memory, which is
  never given back), photos in smaller tiles; after the reference and two
  photos 280 MB instead of 1070 MB, same results. A photo's pixels go to
  the worker without a copy and are not kept afterwards (a new grid decodes
  the photo again), photos are shown at 2400 px, the table picture comes
  over without a copy.

- Gap rims grow inward: a piece put in with "Passt" lends its own outline,
  laid into its place, as the rim of its free neighbours, so a hole is
  filled from its border to the middle without a new photo. In the last
  photo of the Great Wave (9 gaps nobody could fill) a replay of the gap
  mode places all 9, each at the first try.
- Each side of a gap is the edge of another finished piece, each lying a
  little off: after the piece is laid in as a whole, every side may shift
  on its own by up to 8 % of a place (right piece first at 17 of 21 real
  gaps instead of 13). The fit also starts turned 7° either way, and from
  where the rim's corners put the place (the grid was off by a fifth of a
  place at the far side of a photo).
- Every piece goes into one gap only: a piece that fits another gap far
  better drops back here (soft one-to-one assignment over all gaps).
- At the very end, with two or three pieces left, gaps still get their
  suggestions (at least three pieces were needed to compare). Where a rim
  is measured, a side read wrongly as knob or hole no longer rules out the
  right piece.
- Measured on two photos from the table with the solution from photos of
  the finished puzzle: right piece first at 19 of 21 gaps (was 12); replay
  of the 28-gap photo: 25 of 26 pieces placed, 1.36 tries each.

- "Nach Lücke": at the end the card shows a gap with two or three finished
  neighbours and the three pieces whose outline fits it best, clearest gaps
  first; the photo shows the piece tried with its arrow. At a single side
  many sky pieces fit alike, so gaps with one neighbour are left out.
  "Nach Teil" switches back; tapping a piece also does.
- "Passt" / "Passt nicht" replace "Eingesetzt": "Passt nicht" rules the
  piece out at that place for the next search. Every attempt is kept on the
  phone (photo, piece position, place, rotation, result) and can be saved
  with "Versuche exportieren"; "Rückgängig" also drops it.
- Hidden buttons stay hidden ("Rückgängig" showed without anything to
  undo).
- Sorting trays (grey leather with sheen) next to the black mat: mat and
  trays count together as table against a plain puzzle area at the photo
  border, and the sheen no longer lets cream pieces pass as table. Tray
  close-ups: 21, 15 and 18 pieces instead of 21, 2 and 1; an overview with
  trays took over ten minutes, now 45 s.
- At the end (gaps with rims), pieces from photos without a recognisable
  finished part get no place: without an outline on the table only colour
  and side profiles were left, and those put 6 of 7 top suggestions wrong
  at the table. Places next to the finished part without a rim to compare
  are not suggested either.
- The outline fit counts how much better a piece fits than all the others
  (a single knob matches many sky pieces, two or three sides tell them
  apart), and percentages stay modest: the same piece on two photos often
  prefers different places, so a fit alone is no certainty.
- Plain pieces at the end are placed by their whole outline: each piece is
  laid into each gap of the finished part (turn and shift searched) and
  every point of the gap's rim must lie on the piece's outline. Corners and
  side profiles of the same piece on two photos differed as much as two
  different sky pieces; with the outline the same piece gets the same best
  place on 18 of 21 double photos instead of 3. Five sky photos: 5 pieces
  above 50 % instead of none above 20 %.
- Piece outlines are traced again at the photo's full resolution (about
  125 instead of 90 px per piece on the sky photos), the edge halfway
  between table and piece.
- Gap rims follow the outline of the finished part from corner to corner
  (where it turns at the seam), not a band along the grid, which picked up
  the neighbouring places' rims where the grid sits a little off.
- Pieces are numbered by probability (1 = likeliest) instead of green,
  yellow and red; the step card and the piece list show the percentage,
  grey means no place.
- Plain-coloured pieces at the end (Great Wave sky): the grid of the
  finished part follows its seams and outline, not only the feature points,
  which leave plain areas to a smooth fit (it missed the pieces there by up
  to half a place, so finished places at the gap counted as free and gap
  sides sat in the wrong place). At the edge of the finished part only
  places and rotations whose knobs and holes fit the gap are compared; the
  colour orders them. A piece may also belong further inside the gap, so a
  plain piece is no longer "sure" just because its rivals are taken.
  Sky photo: 87 instead of 20 pieces with a place.
- Pieces and gaps are measured on the table seen from above: an oblique
  photo squashed far pieces by up to a fifth, more than knob shapes differ.
- Photos of part of the puzzle: places the photo does not show are not
  suggested; gap sides come from every photo with the finished part.
- "Tisch von oben": all photos with some of the finished part as one
  picture of the table from above, the puzzle upright as in the reference,
  each spot from the closest photo; with arrows, numbers and the free
  places. Default with two or more such photos; "Bild wählen" takes several
  photos at once and searches places once at the end.
- "Korrigieren" in the table view: drag the corners to keep only part of
  the table (pieces outside are ignored), tap a place to switch it between
  free and filled; "Fertig" searches again, "Rückgängig" undoes.
- A piece on several photos with the finished part is matched by its spot
  on the table instead of its looks (plain pieces look alike), also across
  three photos; the sharper photo is kept. Five sky photos: 83 pieces
  instead of 88 counted.
- Dark blue pieces in the finished part no longer count as free places:
  the mask takes them for the black mat, the picture in the middle of the
  place still matches the reference (15 → 2 wrong free places on five
  photos).
- The finished part cut off by the photo edge is no longer reported as an
  unclear blob.

- Step by step: a card shows one piece at a time, the surest first, turned
  as it goes in, with its candidate places from the reference; the photo
  shows only this piece, the arrow to the chosen place and the turn.
  "Eingesetzt", "Überspringen" (to the end of the queue) or "Entfernen"
  move on. Below, all found pieces in rows with their candidate places;
  tapping a row or a piece in the photo picks it. "Alle Pfeile zeigen"
  switches back to all arrows.
- "Entfernen" in the piece details: a wrong find (no piece, or a piece
  the app got wrong) is left out and takes no place; "Rückgängig" undoes
  the last "Eingesetzt" or "Entfernen".
- Version number in the header (the code running now); when a newer one has
  been installed in the background, "neu laden" appears next to it.
- "Eingesetzt" in the piece details: the piece is hidden, its place counts
  as taken, its knobs and holes become gap sides for the neighbouring
  places, and the next arrow moves up. "Rückgängig" takes the last one back.
- Building on the finished part: with a large finished part in the photo,
  only places right next to it are suggested, and a piece is placed only if
  its knobs and holes fit every neighbouring gap side (no forced places).
- Grid from the seams: the box picture often shows a little more or less
  than the puzzle, and the count alone does not fix columns and rows. The
  seams of the finished part give the real grid (Great Wave: 36 x 28 instead
  of 37 x 27, rows shifted by a third of a piece); corners and grid are
  adopted once, if they fit the piece count.
- Large areas of the finished part are no longer searched as joined groups
  (an overview photo took minutes).
- Large puzzles (1000 pieces, overview photo of the whole puzzle on a mat):
  feature points of the reference from up to 2400 px instead of 1200 (about
  60 instead of 30 px per piece), more of them; with a finished part the
  piece size comes from its places, blobs next to it of about one place are
  loose pieces, and loose pieces are compared only with the gaps of the
  reference (half the time, fewer rivals). A large finished part is no
  longer rejected for an odd piece size or cut into fake pieces.
- Puzzle mats: the background is the frequent and plain colour at the image
  border, not simply the most frequent one (a close-up with finished puzzle
  at the border lost all loose pieces); table noise only from border pixels
  of that colour; printed dashes and lines on the mat are no pieces and no
  longer set the typical piece size.
- The plain colour difference counts fully besides the colour-fitted one:
  the fit alone explains every light, plain area of the reference equally
  well. HIWIN: 810 instead of 795 right, 566 instead of 513 sure (6
  wrong); other real photos: 70 instead of 67 right, 48 instead of 41
  sure, none wrong.
- A "finished part" of fewer than 8 places is taken as loose pieces lying
  together (still located as a group), so the other blobs in the photo
  get split. HIWIN photos: 1010 instead of 996 recognised, 795 instead of
  778 placed right.
- Splitting touching pieces no longer cuts single pieces in half: a piece
  with two opposite holes has a waist; parts below 0.7 piece areas join
  the neighbour they share the longest border with. HIWIN photos (1054
  labelled pieces): 996 instead of 925 recognised, 778 instead of 682
  placed right; Cats & Kittens and black mat: 67 instead of 61 of 119.
- Green means right: a suggestion is shown as sure only with independent
  support (feature points on the same place, or an image comparison
  without any rival) and a cleanly measured outline. Measured on 1054
  labelled pieces in 40 real photos of another puzzle (Kaggle "Jigsaw
  Puzzle Pieces", CC BY-SA 4.0): 4 wrong of 437 sure instead of 98 of
  711; on the Cats & Kittens photos 0 wrong of 41 instead of 2 of 58.
  The rest is shown as likely.
- Tighter outlines on wooden tables: the dark rim at the edge of a piece
  (cardboard edge, contact shadow) was counted as piece. Pixels in a band
  of about 3 % of a piece side that match the table colour in shadow and
  are clearly darker than the piece just inside are now table. Real
  photos, 95 verified pieces: 46 instead of 45 right, 43 instead of 39
  sure, 2 instead of 4 of them wrong.
- Fewer wrong green suggestions: a border place alone no longer lowers the
  bar for "sure"; it needs feature points on the place or a neighbour
  already placed. Checked on 95 pieces in five real photos (new truth
  from an all-pieces photo and a close-up): 4 instead of 6 wrong
  sure, right sure unchanged; synthetic scenes unchanged.
- Border first: the button "Nur Rand" shows only the pieces whose place is
  on the border, and dims the inside of the map, to build the frame.
  Pieces with a clearly straight side (and clean corners) are compared
  only with border places, in the one rotation that puts the side
  outwards; pieces without one never with border places. Thresholds from
  the measured side depths (straight sides 0.01-0.02, knobs lost to a
  touching neighbour from 0.03); same results on all test photos, fewer
  comparisons.
- Pieces lying against each other on the table (no finished part in the
  photo) are split at their narrow contacts instead of shown as one
  unclear area; also two touching pieces that make one too large outline.
  On a photo of all 240 pieces: 32 instead of 26 of 40 checked pieces
  recognised, 17 instead of 15 placed right.
- Photos of many loose pieces (e.g. all 240 on the table): large photos are
  searched for feature points in tiles (a 2800 × 2800 photo no longer runs
  out of memory), pieces lying against each other are no longer taken for
  the finished part, and without a finished part the piece size comes from
  the typical piece area. Synthetic photos without a finished part: 88
  instead of 45 of 128 pieces found, 94 instead of 86 of 99 right.
- WebGL2 matching is skipped on software renderers (SwiftShader, llvmpipe),
  where it was far slower than WASM.
- Feature matching on the graphics card (WebGL2 in the worker): Pixel 4a
  about 1.8× faster for large sets, a photo 16 s instead of 23 s; same
  results as the WASM module, which stays the fallback (and takes over if
  the driver fails).
- Two tabs at the bottom like a native app: Vorlage and Teile. The piece
  count is required and asked for right after cropping; count and grid
  sit above the preview. Reference preview and map of places zoom with two
  fingers (finer preview), the page itself never zooms.
- Assignment checked against a solved photo of a real puzzle (26 verified
  pieces): 18 instead of 15 placed right. Rectangular pieces measured the
  wrong way round no longer lose their right rotation (penalty instead of
  exclusion), and the pieces that are not sure share the free places
  (one place per piece) instead of several pointing at the same place.
- Cropping the reference: handles in the middle of each side move the whole
  side, and a magnifier above or beside the finger shows the dragged point.
- Grid for rectangular pieces: the finished border in a photo is one piece
  thick, its thickness in the reference gives columns and rows (e.g. 12 × 20
  for 240 pieces instead of 14 × 17). The app switches once by itself unless
  the grid was set with −/+.
- Reference corners: of nearly equally large outlines the one that follows
  the edges best wins, and a plain band on one side (a poster's title bar) is
  no longer cut off as a box margin.
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
