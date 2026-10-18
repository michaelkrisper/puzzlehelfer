// Photos put together on the table: a photo without the finished part (a
// close-up of a tray) is laid onto a photo it overlaps by ORB points of mat,
// trays and pieces, which all lie in the plane of the table. ORB needs a few
// MB where SIFT needs hundreds, and finds 70 to 3000 common points between
// an overview and a close-up or two neighbouring photos of a sweep.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;
  const SIDE = 1600; // longer side the points are found at
  const MIN_INLIERS = 40;

  // Points of a photo (ImageData) in working pixels (photo pixel · scale).
  function describe(cv, image, scale) {
    const f = Math.min(1, SIDE / Math.max(image.width, image.height));
    const src = cv.matFromImageData(image);
    const small = new cv.Mat();
    cv.resize(
      src,
      small,
      new cv.Size(Math.round(image.width * f), Math.round(image.height * f)),
      0,
      0,
      cv.INTER_AREA,
    );
    src.delete();
    const gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    small.delete();
    const orb = new cv.ORB(5000);
    const kp = new cv.KeyPointVector();
    const desc = new cv.Mat();
    const none = new cv.Mat();
    orb.detectAndCompute(gray, none, kp, desc);
    const n = kp.size();
    const pts = new Float32Array(n * 2);
    const k = scale / f;
    for (let i = 0; i < n; i++) {
      const p = kp.get(i).pt;
      pts[i * 2] = p.x * k;
      pts[i * 2 + 1] = p.y * k;
    }
    const out = {
      n,
      pts,
      desc: Uint8Array.from(desc.data),
      cols: desc.cols,
      size: (Math.max(gray.cols, gray.rows) / f) * scale,
    };
    for (const x of [gray, orb, kp, desc, none]) x.delete();
    return out;
  }

  const toMat = (cv, d) => {
    const m = new cv.Mat(d.n, d.cols, cv.CV_8U);
    m.data.set(d.desc);
    return m;
  };

  // Homography from photo a's working pixels to photo b's, with the number
  // of points that agree; null if the two do not overlap clearly.
  function match(cv, a, b) {
    if (a.n < MIN_INLIERS || b.n < MIN_INLIERS) return null;
    const da = toMat(cv, a);
    const db = toMat(cv, b);
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    const mm = new cv.DMatchVectorVector();
    bf.knnMatch(da, db, mm, 2);
    const pa = [];
    const pb = [];
    for (let i = 0; i < mm.size(); i++) {
      const pair = mm.get(i);
      if (pair.size() < 2) continue;
      const m0 = pair.get(0);
      if (m0.distance >= 0.8 * pair.get(1).distance) continue;
      pa.push(a.pts[m0.queryIdx * 2], a.pts[m0.queryIdx * 2 + 1]);
      pb.push(b.pts[m0.trainIdx * 2], b.pts[m0.trainIdx * 2 + 1]);
    }
    for (const x of [da, db, bf, mm]) x.delete();
    if (pa.length / 2 < MIN_INLIERS) return null;
    const am = cv.matFromArray(pa.length / 2, 1, cv.CV_32FC2, pa);
    const bm = cv.matFromArray(pb.length / 2, 1, cv.CV_32FC2, pb);
    const inl = new cv.Mat();
    // About 4 px at the size the points were found at.
    const tol = (4 * b.size) / SIDE;
    const Hm = cv.findHomography(am, bm, cv.RANSAC, tol, inl, 5000, 0.999);
    let n = 0;
    for (let i = 0; i < inl.rows; i++) if (inl.data[i]) n++;
    const H = Hm.empty() ? null : Array.from(Hm.data64F);
    for (const x of [am, bm, inl, Hm]) x.delete();
    if (!H || n < MIN_INLIERS || !plausible(H)) return null;
    return { H, inliers: n };
  }

  // A photo of the same table from another spot: no mirror, no extreme
  // squeeze or tilt.
  function plausible(H) {
    const d = (H[0] * H[4] - H[1] * H[3]) / (H[8] * H[8]);
    if (!(d > 0.02 && d < 50)) return false;
    return Math.abs(H[6] / H[8]) < 0.01 && Math.abs(H[7] / H[8]) < 0.01;
  }

  PH.stitch = { describe, match };
})();
