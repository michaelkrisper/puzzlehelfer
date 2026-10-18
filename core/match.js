// Piece ↔ place: image comparison (coarse over block means, fine pixel by
// pixel) and shape fit (border, knob/hole of the neighbours), then stepwise
// assignment.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;
  const DIRS = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ]; // top, right, bottom, left

  // Rectified patch of a piece: core square plus one block of margin all
  // round (for the knobs), at the cell size of the reference. Corner 0 ends up
  // top left.
  function extractPatch(cv, srcMat, maskMat, corners, C, G) {
    const e = 1 / G;
    const P = C + 2 * (C / G);
    const H = PH.geom.homography(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      corners,
    );
    // Patch pixel → unit square → photo.
    const S = [1 / C, 0, -e, 0, 1 / C, -e, 0, 0, 1];
    const M = mul3(H, S);
    const m = cv.matFromArray(3, 3, cv.CV_64F, M);
    const size = new cv.Size(P, P);
    const out = new cv.Mat();
    cv.warpPerspective(srcMat, out, m, size, cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT);
    const outM = new cv.Mat();
    cv.warpPerspective(maskMat, outM, m, size, cv.INTER_NEAREST | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT);
    const rgba = new Uint8ClampedArray(out.data);
    const mask = new Uint8Array(outM.data);
    m.delete();
    out.delete();
    outM.delete();
    return { rgba, mask, P };
  }

  function mul3(A, B) {
    const R = new Array(9).fill(0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return R;
  }

  // Rotate by k·90° clockwise (square, ch channels).
  function rotate(arr, P, ch, k) {
    if (k === 0) return arr;
    const out = new arr.constructor(arr.length);
    for (let y = 0; y < P; y++) {
      for (let x = 0; x < P; x++) {
        let nx;
        let ny;
        if (k === 1) {
          nx = P - 1 - y;
          ny = x;
        } else if (k === 2) {
          nx = P - 1 - x;
          ny = P - 1 - y;
        } else {
          nx = y;
          ny = P - 1 - x;
        }
        for (let c = 0; c < ch; c++) out[(ny * P + nx) * ch + c] = arr[(y * P + x) * ch + c];
      }
    }
    return out;
  }

  // Block means with coverage (share of piece pixels per block).
  function patchBlocks(lab, mask, P, b) {
    const n = P / b;
    const mean = new Float32Array(n * n * 3);
    const cov = new Float32Array(n * n);
    for (let y = 0; y < P; y++) {
      for (let x = 0; x < P; x++) {
        if (!mask[y * P + x]) continue;
        const o = Math.floor(y / b) * n + Math.floor(x / b);
        const i = (y * P + x) * 3;
        mean[o * 3] += lab[i];
        mean[o * 3 + 1] += lab[i + 1];
        mean[o * 3 + 2] += lab[i + 2];
        cov[o]++;
      }
    }
    for (let o = 0; o < n * n; o++) {
      if (cov[o]) for (let c = 0; c < 3; c++) mean[o * 3 + c] /= cov[o];
      cov[o] /= b * b;
    }
    return { mean, cov, n };
  }

  function erodeMask(mask, P, r) {
    let cur = mask;
    for (let it = 0; it < r; it++) {
      const out = new Uint8Array(P * P);
      for (let y = 1; y < P - 1; y++) {
        for (let x = 1; x < P - 1; x++) {
          const i = y * P + x;
          out[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - P] && cur[i + P] ? 1 : 0;
        }
      }
      cur = out;
    }
    return cur;
  }

  // Prepares an analysed piece for the comparison. color: mapping of the photo
  // colours onto the reference (per channel a·x + b).
  function preparePiece(raw, C, G, color) {
    const { P } = raw;
    const n = P * P;
    const lab = PH.segment.rgbaToLab(raw.rgba, n);
    if (color) {
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 3; c++) lab[i * 3 + c] = lab[i * 3 + c] * color[c][0] + color[c][1];
      }
    }
    const mask = erodeMask(
      raw.mask.map((v) => (v ? 1 : 0)),
      P,
      2,
    );
    const rots = [];
    for (let k = 0; k < 4; k++) {
      const l = rotate(lab, P, 3, k);
      const m = rotate(mask, P, 1, k);
      rots.push({ lab: l, mask: m, blocks: patchBlocks(l, m, P, C / G) });
    }
    return { P, rots };
  }

  function borderDirs(r, c, ref) {
    return [r === 0, c === ref.cols - 1, r === ref.rows - 1, c === 0];
  }

  // Side type that points in direction d after rotating by k.
  function sideAt(sides, d, k) {
    return sides[(d - k + 4) % 4];
  }

  // Rectangular pieces fit with the long side along the long cell side
  // (prep.allowRot). Wavy pieces with big knobs are often measured the wrong
  // way round, so the other rotations are only penalised, not excluded.
  function rotPenalty(prep, k) {
    return prep.allowRot && !prep.allowRot[k] ? 0.5 : 0;
  }

  function borderPenalty(sides, r, c, k, ref) {
    const bd = borderDirs(r, c, ref);
    let pen = 0;
    for (let d = 0; d < 4; d++) {
      const flat = sideAt(sides, d, k).type === 0;
      if (flat !== bd[d]) pen++;
    }
    return pen;
  }

  // Residual after the best linear fit per channel (q ≈ a·p + b).
  // Reflections, colour cast and exposure of the box photo shift colours
  // locally; the structure of the motif stays. acc: per channel
  // [Sp, Sq, Spp, Spq, Sqq], plus the weight sum sw.
  const GAIN = [
    [0.6, 1.7],
    [0.3, 1.7],
    [0.3, 1.7],
  ];
  function affineResidual(acc, sw) {
    let r = 0;
    for (let c = 0; c < 3; c++) {
      const [sp, sq, spp, spq, sqq] = acc[c];
      const vp = spp - (sp * sp) / sw;
      const cpq = spq - (sp * sq) / sw;
      let a = vp > 1e-6 ? cpq / vp : 1;
      a = Math.max(GAIN[c][0], Math.min(GAIN[c][1], a));
      const b = (sq - a * sp) / sw;
      r += sqq - 2 * a * spq - 2 * b * sq + a * a * spp + 2 * a * b * sp + b * b * sw;
    }
    return Math.max(0, r) / sw;
  }
  // Share of the plain colour difference besides the fitted one. The fit
  // alone explains every light, plain area of the reference equally well;
  // on real photos (1173 labelled pieces, also a photographed poster with
  // colour cast) 1.0 places more pieces right than 0.3.
  const RAW_WEIGHT = 1.0;
  // Image distance as a ratio instead of absolute (logit = −BETA·ln e): blur
  // or colour cast of the reference make all distances larger, the ratio of
  // best to second best place stays meaningful.
  const BETA = 8;

  // Coarse search over all places, rotations and quarter-cell offsets.
  // fits(cell, rot): false rules a place out (knobs and holes against the
  // gap sides of the finished part).
  function coarseSearch(prep, sides, ref, free, keep, fits) {
    const { blocks, cols, rows, G } = ref;
    const bw = blocks.w;
    const bh = blocks.h;
    const n = prep.rots[0].blocks.n;
    const res = [];
    for (let k = 0; k < 4; k++) {
      const rp = rotPenalty(prep, k);
      const { mean, cov } = prep.rots[k].blocks;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (free && !free[r * cols + c]) continue;
          const bp = borderPenalty(sides, r, c, k, ref);
          if (bp > (prep.strictBorder ? 0 : 1)) continue;
          if (fits && !fits(r * cols + c, k)) continue;
          const pen = bp + rp;
          let best = Infinity;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x0 = c * G - 1 + dx;
              const y0 = r * G - 1 + dy;
              let s = 0;
              let ws = 0;
              const acc = [
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
              ];
              for (let j = 0; j < n; j++) {
                const by = y0 + j;
                if (by < 0 || by >= bh) continue;
                for (let i = 0; i < n; i++) {
                  const bx = x0 + i;
                  const w = cov[j * n + i];
                  if (bx < 0 || bx >= bw || w < 0.3) continue;
                  const p = (j * n + i) * 3;
                  const q = (by * bw + bx) * 3;
                  let d = 0;
                  for (let ch = 0; ch < 3; ch++) {
                    const pv = mean[p + ch];
                    const qv = blocks.data[q + ch];
                    d += (pv - qv) ** 2;
                    const A = acc[ch];
                    A[0] += w * pv;
                    A[1] += w * qv;
                    A[2] += w * pv * pv;
                    A[3] += w * pv * qv;
                    A[4] += w * qv * qv;
                  }
                  s += w * Math.min(d, 1600);
                  ws += w;
                }
              }
              if (ws > 4) best = Math.min(best, affineResidual(acc, ws) + (RAW_WEIGHT * s) / ws);
            }
          }
          if (best < Infinity) res.push({ cell: r * cols + c, rot: k, coarse: best, pen });
        }
      }
    }
    res.sort((a, b) => a.coarse + a.pen * 200 - (b.coarse + b.pen * 200));
    return res.slice(0, keep);
  }

  // Pixel comparison around the cell, ± a quarter cell.
  function fineScore(prep, ref, cand) {
    const { C, G, W, H, lab: rl, cols } = ref;
    const { lab, mask } = prep.rots[cand.rot];
    const P = prep.P;
    const r = Math.floor(cand.cell / cols);
    const c = cand.cell % cols;
    const bx = c * C - C / G;
    const by = r * C - C / G;
    const T2 = 900;
    const evalAt = (ox, oy, step) => {
      let s = 0;
      let ws = 0;
      const acc = [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ];
      for (let y = 0; y < P; y += step) {
        const ry = by + oy + y;
        if (ry < 0 || ry >= H) continue;
        for (let x = 0; x < P; x += step) {
          if (!mask[y * P + x]) continue;
          const rx = bx + ox + x;
          if (rx < 0 || rx >= W) continue;
          const i = (y * P + x) * 3;
          const j = (ry * W + rx) * 3;
          let d = 0;
          for (let ch = 0; ch < 3; ch++) {
            const pv = lab[i + ch];
            const qv = rl[j + ch];
            d += (pv - qv) ** 2;
            const A = acc[ch];
            A[0] += pv;
            A[1] += qv;
            A[2] += pv * pv;
            A[3] += pv * qv;
            A[4] += qv * qv;
          }
          s += d < T2 ? d : T2;
          ws++;
        }
      }
      return ws > 20 ? affineResidual(acc, ws) + (RAW_WEIGHT * s) / ws : Infinity;
    };
    const R = C / G;
    let best = { e: Infinity, ox: 0, oy: 0 };
    for (let oy = -R; oy <= R; oy += 4) {
      for (let ox = -R; ox <= R; ox += 4) {
        const e = evalAt(ox, oy, 3);
        if (e < best.e) best = { e, ox, oy };
      }
    }
    const c0 = best;
    for (let oy = c0.oy - 3; oy <= c0.oy + 3; oy++) {
      for (let ox = c0.ox - 3; ox <= c0.ox + 3; ox++) {
        const e = evalAt(ox, oy, 2);
        if (e < best.e) best = { e, ox, oy };
      }
    }
    return { ...cand, e: best.e, ox: best.ox, oy: best.oy };
  }

  // Candidates of a piece: coarse over everything, fine over the best.
  // must: places with rotation that are always compared finely (e.g. from
  // feature points), even if the coarse search does not rank them high.
  function candidates(prep, sides, ref, free, must = [], fits = null) {
    const coarse = coarseSearch(prep, sides, ref, free, 40, fits);
    for (const m of must) {
      if ((free && !free[m.cell]) || (fits && !fits(m.cell, m.rot))) continue;
      if (coarse.some((c) => c.cell === m.cell && c.rot === m.rot)) continue;
      const r = Math.floor(m.cell / ref.cols);
      const c = m.cell % ref.cols;
      const bp = borderPenalty(sides, r, c, m.rot, ref);
      if (bp <= (prep.strictBorder ? 0 : 1))
        coarse.push({ cell: m.cell, rot: m.rot, coarse: Infinity, pen: bp + rotPenalty(prep, m.rot) });
    }
    const fine = coarse.map((c) => fineScore(prep, ref, c));
    fine.sort((a, b) => a.e - b.e);
    return fine;
  }

  // Feature points that RANSAC maps onto the same place: random pairs hardly
  // ever agree, from about six the place is as good as certain. Measured on
  // artificial photos with a known solution.
  function featBonus(inliers) {
    return Math.max(0, Math.min(FEAT_MAX, (inliers - FEAT_MIN) * FEAT_STEP));
  }
  const FEAT_MIN = 3;
  const FEAT_STEP = 1.5;
  const FEAT_MAX = 10;

  // Stepwise assignment: always the surest piece first, then its sides act as
  // constraints for the neighbouring places.
  function assign(pieces, ref, opts = {}) {
    const { cols, rows } = ref;
    const N = cols * rows;
    const taken = new Uint8Array(N);
    const constraint = new Map(); // "cell,d" → {need, side}
    for (const f of opts.filled ?? []) taken[f] = 1;
    for (const [key, v] of opts.holes ?? []) constraint.set(key, v);
    const minConf = opts.minConf ?? 0.6;
    // As when solving by hand: first the border and places next to pieces
    // already placed, where knob and hole help check. In the middle of
    // nowhere only with a very clear picture.
    const minConfIsolated = opts.minConfIsolated ?? 0.85;
    // The border alone anchors only with feature points on the place: with
    // 60 border places at 12 × 20 the picture alone is no surer there than
    // inside (cream and red border pieces went to the wrong border place).
    const anchored = (cell, feat) => {
      const r = Math.floor(cell / cols);
      const c = cell % cols;
      if (feat > 0 && (r === 0 || c === 0 || r === rows - 1 || c === cols - 1)) return true;
      for (let d = 0; d < 4; d++) {
        if (constraint.has(`${cell},${d}`) || taken[(r + DIRS[d][1]) * cols + c + DIRS[d][0]]) return true;
      }
      return false;
    };

    const evalPiece = (p) => {
      const scored = [];
      for (const cd of p.cands) {
        if (taken[cd.cell]) continue;
        let topo = -cd.pen * 4;
        for (let d = 0; d < 4; d++) {
          const ct = constraint.get(`${cd.cell},${d}`);
          if (!ct) continue;
          const mine = sideAt(p.sides, d, cd.rot);
          if (mine.type !== ct.need) topo -= 4;
          else if (ct.hole) {
            const hd = PH.piece.holeDistance(mine, ct.hole);
            topo += hd < 0.04 ? 2.5 : hd < 0.07 ? 1.2 : hd < 0.1 ? 0 : -2;
          } else if (ct.side) {
            const sd = PH.piece.sideDistance(mine, ct.side);
            topo += sd < 0.05 ? 1.5 : sd < 0.1 ? 0.5 : -1;
          } else topo += 0.3;
        }
        const f = p.feat;
        const feat = f && f.cell === cd.cell && f.rot === cd.rot ? featBonus(f.inliers) : 0;
        scored.push({ ...cd, logit: -BETA * Math.log(cd.e + 10) + topo + feat, feat });
      }
      if (!scored.length) return null;
      scored.sort((a, b) => b.logit - a.logit);
      // Several rotations at the same place count as one place.
      const free = N - taken.reduce((a, b) => a + b, 0);
      const other = scored[scored.length - 1].logit - 1 + Math.log(Math.max(1, free - scored.length));
      let z = Math.exp(other - scored[0].logit);
      // Places away from the finished part (opts.unknown, not compared): the
      // piece may as well belong there, knobs and holes cannot be checked.
      // Each counts like a candidate of middling colour without shape support;
      // a plain piece is then no longer sure just because its rivals at the
      // edge are taken.
      if (opts.unknown) {
        const mid = scored[scored.length >> 1];
        z += Math.exp(-BETA * Math.log(mid.e + 10) + Math.log(opts.unknown) - scored[0].logit);
      }
      for (const s of scored) z += Math.exp(s.logit - scored[0].logit);
      const top = scored[0];
      return {
        top,
        conf: 1 / z,
        alts: scored.slice(1, 4).map((s) => ({ ...s, p: Math.exp(s.logit - top.logit) / z })),
        scored,
        z,
      };
    };

    const result = new Map();
    const open = new Set(pieces.keys());
    let step = 0;
    while (open.size) {
      let pick = null;
      for (const i of open) {
        const ev = evalPiece(pieces[i]);
        if (!ev) continue;
        result.set(i, ev);
        const margin = ev.conf - (anchored(ev.top.cell, ev.top.feat) ? minConf : minConfIsolated);
        if (margin >= 0 && (!pick || margin > pick.margin)) pick = { i, ev, margin };
      }
      if (!pick) break;
      const { i, ev } = pick;
      open.delete(i);
      step++;
      result.set(i, { ...ev, step });
      const cell = ev.top.cell;
      taken[cell] = 1;
      const r = Math.floor(cell / cols);
      const c = cell % cols;
      for (let d = 0; d < 4; d++) {
        const nr = r + DIRS[d][1];
        const nc = c + DIRS[d][0];
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const side = sideAt(pieces[i].sides, d, ev.top.rot);
        if (side.type === 0) continue;
        constraint.set(`${nr * cols + nc},${(d + 2) % 4}`, { need: -side.type, side });
      }
    }
    // The pieces left over share the free places: one place per piece, the
    // most probable combination overall (instead of each piece on its own
    // best place, where several often want the same one).
    const rest = [];
    for (const i of open) {
      const ev = evalPiece(pieces[i]);
      if (ev) {
        result.set(i, ev);
        rest.push(i);
      } else result.delete(i);
    }
    if (rest.length > 1) {
      const cells = [...new Set(rest.flatMap((i) => result.get(i).scored.map((s) => s.cell)))];
      const best = rest.map((i) => {
        const m = new Map();
        for (const s of result.get(i).scored) if (!m.has(s.cell)) m.set(s.cell, s);
        return m;
      });
      // Cost −ln p; a place outside the candidates costs as much as the
      // least likely candidate plus a margin.
      const cost = rest.map((i, r) => {
        const ev = result.get(i);
        const lp = (s) => -(s.logit - ev.top.logit) + Math.log(ev.z);
        const worst = Math.max(...[...best[r].values()].map(lp)) + 5;
        // Extra columns: no place of its own (the piece keeps its best).
        return [
          ...cells.map((c) => (best[r].has(c) ? lp(best[r].get(c)) : worst)),
          ...rest.map(() => worst + 5),
        ];
      });
      const pick = hungarian(cost);
      rest.forEach((i, r) => {
        const ev = result.get(i);
        const s = best[r].get(cells[pick[r]]);
        if (!s || s === ev.top) return;
        const p = Math.exp(s.logit - ev.top.logit) / ev.z;
        result.set(i, {
          ...ev,
          top: s,
          conf: p,
          alts: [{ ...ev.top, p: ev.conf }, ...ev.alts.filter((a) => a !== s)].slice(0, 3),
        });
      });
    }
    return result;
  }

  // Minimum-cost assignment of rows to distinct columns (rows ≤ columns),
  // Hungarian method with potentials. Returns the column per row.
  function hungarian(a) {
    const n = a.length;
    const m = a[0].length;
    const u = new Float64Array(n + 1);
    const v = new Float64Array(m + 1);
    const p = new Int32Array(m + 1);
    const way = new Int32Array(m + 1);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Float64Array(m + 1).fill(Infinity);
      const used = new Uint8Array(m + 1);
      do {
        used[j0] = 1;
        const i0 = p[j0];
        let delta = Infinity;
        let j1 = 0;
        for (let j = 1; j <= m; j++) {
          if (used[j]) continue;
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
        for (let j = 0; j <= m; j++) {
          if (used[j]) {
            u[p[j]] += delta;
            v[j] -= delta;
          } else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0);
    }
    const res = new Int32Array(n);
    for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
    return res;
  }

  PH.match = {
    extractPatch,
    preparePiece,
    candidates,
    assign,
    rotate,
    sideAt,
    borderPenalty,
    DIRS,
    patchBlocks,
  };
})();
