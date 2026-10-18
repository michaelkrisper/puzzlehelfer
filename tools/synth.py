#!/usr/bin/env python3
"""Synthetic test data for Puzzlehelfer.

Cuts an image into puzzle pieces and renders a box photo (reference.jpg), a table
photo with loose (and optionally partly assembled) pieces (scene.jpg) and the exact
ground truth (truth.json).

Example:
  python3 tools/synth.py --image picture.jpg --pieces 100 --seed 1 --out ~/.cache/puzzlehelfer-work/x
"""

import argparse
import json
import math
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 4  # supersampling for masks
PAD = 14  # margin around each tile so the shadow fits
Q = 4  # cell size of the occupancy map in scene pixels
GAP = 8  # minimum gap between loose pieces in scene pixels
LIGHT = np.array([-0.6, -0.8])  # direction to the light source (top left), image coordinates


# ---------------------------------------------------------------- Geometry


def choose_grid(n, aspect):
    best = None
    for rows in range(1, n + 1):
        for cols in {max(1, n // rows), max(1, -(-n // rows))}:
            score = abs(cols * rows - n) / n + 0.3 * abs(math.log(aspect * rows / cols))
            if best is None or score < best[0]:
                best = (score, cols, rows)
    return best[1], best[2]


def grid_points(cols, rows, w, h, rng):
    cw, ch = w / cols, h / rows
    xs, ys = np.meshgrid(np.arange(cols + 1) * cw, np.arange(rows + 1) * ch)
    jx = rng.uniform(-0.04, 0.04, xs.shape) * cw
    jy = rng.uniform(-0.04, 0.04, ys.shape) * ch
    # border points stay on the image edge but slide along it
    jx[:, [0, -1]] = 0
    jy[[0, -1], :] = 0
    return np.stack([xs + jx, ys + jy], -1)


@dataclass
class Knob:
    sign: int  # +1: tab points to +x or +y
    pos: float  # position along the edge (fraction)
    radius: float  # head radius; like all lengths, in units of the cell side
    beta_l: float
    beta_r: float
    neck: float
    flare_l: float
    flare_r: float
    skew: float
    wave1: float
    wave2: float

    @property
    def head_y(self):
        return self.neck + self.radius * (math.sin(self.beta_l) + math.sin(self.beta_r)) / 2


def random_knob(rng):
    return Knob(
        sign=int(rng.choice([-1, 1])),
        pos=rng.uniform(0.4, 0.6),
        radius=rng.uniform(0.15, 0.19),
        beta_l=math.radians(rng.uniform(42, 58)),
        beta_r=math.radians(rng.uniform(42, 58)),
        neck=rng.uniform(0.035, 0.06),
        flare_l=rng.uniform(0.03, 0.055),
        flare_r=rng.uniform(0.03, 0.055),
        skew=rng.uniform(-0.02, 0.02),
        wave1=rng.uniform(-0.02, 0.02),
        wave2=rng.uniform(-0.01, 0.01),
    )


def fix_collisions(hk, vk, cols, rows, lx, ly):
    """Two holes at the same piece corner must not touch.

    With head radii around 0.2 and position 0.4 they would overlap; then both tabs
    become smaller and more centred.
    """

    def heads(r, c):
        out = {}
        k = hk.get((r, c))
        if k and k.sign > 0:
            out['t'] = (k, (k.pos * lx + k.skew, k.head_y))
        k = hk.get((r + 1, c))
        if k and k.sign < 0:
            out['b'] = (k, (k.pos * lx + k.skew, ly - k.head_y))
        k = vk.get((r, c))
        if k and k.sign > 0:
            out['l'] = (k, (k.head_y, k.pos * ly + k.skew))
        k = vk.get((r, c + 1))
        if k and k.sign < 0:
            out['r'] = (k, (lx - k.head_y, k.pos * ly + k.skew))
        return out

    changed = True
    while changed:
        changed = False
        for r in range(rows):
            for c in range(cols):
                hs = heads(r, c)
                for a, b in (('t', 'l'), ('t', 'r'), ('b', 'l'), ('b', 'r')):
                    if a not in hs or b not in hs:
                        continue
                    (ka, pa), (kb, pb) = hs[a], hs[b]
                    if math.dist(pa, pb) < ka.radius + kb.radius + 0.05:
                        for k in (ka, kb):
                            k.radius = max(0.1, k.radius * 0.96)
                            k.pos = 0.5 + (k.pos - 0.5) * 0.85
                        changed = True
                        hs = heads(r, c)


def bezier(p0, p1, p2, p3, n):
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3


def knob_profile(k, length):
    """Edge profile (x along, y across, y>0 towards the tab) in cell-side units."""
    c, r, hy = k.pos * length, k.radius, k.head_y
    cx = c + k.skew
    cl, sl, cr, sr = math.cos(k.beta_l), math.sin(k.beta_l), math.cos(k.beta_r), math.sin(k.beta_r)
    al = np.array([cx - r * cl, hy - r * sl])
    ar = np.array([cx + r * cr, hy - r * sr])
    bl = np.array([c - r * cl - k.flare_l, 0.0])
    br = np.array([c + r * cr + k.flare_r, 0.0])
    tl = np.array([-sl, cl])
    tr = np.array([-sr, -cr])
    k1l, k1r = 0.6 * k.flare_l + 0.02, 0.6 * k.flare_r + 0.02
    k2 = 0.6 * k.neck + 0.03
    left = bezier(bl, bl + (k1l, 0), al - k2 * tl, al, 16)
    ang = np.linspace(math.pi + k.beta_l, -k.beta_r, 48)
    arc = np.stack([cx + r * np.cos(ang), hy + r * np.sin(ang)], -1)
    right = bezier(ar, ar + k2 * tr, br - (k1r, 0), br, 16)
    base_l = np.stack([np.linspace(0, bl[0], 8, endpoint=False), np.zeros(8)], -1)
    base_r = np.stack([np.linspace(br[0], length, 8)[1:], np.zeros(7)], -1)
    prof = np.concatenate([base_l, left, arc[1:-1], right, base_r])
    prof[:, 1] *= k.sign
    x = prof[:, 0] / length
    prof[:, 1] += k.wave1 * np.sin(math.pi * x) + k.wave2 * np.sin(2 * math.pi * x)
    return prof


def edge_polyline(a, b, knob, side, vertical):
    if knob is None:
        return np.array([a, b], float)
    d = b - a
    length = float(np.hypot(*d))
    d = d / length
    n = np.array([d[1], -d[0]]) if vertical else np.array([-d[1], d[0]])
    prof = knob_profile(knob, length / side)
    return a + np.outer(prof[:, 0] * side, d) + np.outer(prof[:, 1] * side, n)


class Puzzle:
    def __init__(self, w, h, cols, rows, rng):
        self.w, self.h, self.cols, self.rows = w, h, cols, rows
        self.pts = grid_points(cols, rows, w, h, rng)
        cw, ch = w / cols, h / rows
        self.side = math.sqrt(cw * ch)
        hk = {(i, c): random_knob(rng) for i in range(1, rows) for c in range(cols)}
        vk = {(r, j): random_knob(rng) for r in range(rows) for j in range(1, cols)}
        fix_collisions(hk, vk, cols, rows, cw / self.side, ch / self.side)
        self.hk, self.vk = hk, vk
        p = self.pts
        self.hl = [
            [edge_polyline(p[i, c], p[i, c + 1], hk.get((i, c)), self.side, False) for c in range(cols)]
            for i in range(rows + 1)
        ]
        self.vl = [
            [edge_polyline(p[r, j], p[r + 1, j], vk.get((r, j)), self.side, True) for j in range(cols + 1)]
            for r in range(rows)
        ]

    def outline(self, r, c):
        parts = [self.hl[r][c], self.vl[r][c + 1], self.hl[r + 1][c][::-1], self.vl[r][c][::-1]]
        return np.concatenate([q[:-1] for q in parts])

    def corners(self, r, c):
        p = self.pts
        return np.array([p[r, c], p[r, c + 1], p[r + 1, c + 1], p[r + 1, c]])

    def edge_signs(self):
        h = [[self.hk[(i, c)].sign for c in range(self.cols)] for i in range(1, self.rows)]
        v = [[self.vk[(r, j)].sign for j in range(1, self.cols)] for r in range(self.rows)]
        return {'h': h, 'v': v}


# ---------------------------------------------------------------- Transforms


def translate(tx, ty):
    return np.array([[1, 0, tx], [0, 1, ty], [0, 0, 1]], float)


def rotation(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])


def apply_h(m, pts):
    p = np.c_[pts, np.ones(len(pts))] @ m.T
    return p[:, :2] / p[:, 2:3]


def homography(src, dst):
    a, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b += [u, v]
    return np.append(np.linalg.solve(np.array(a, float), np.array(b, float)), 1).reshape(3, 3)


def warp(src, src_to_out, size):
    inv = np.linalg.inv(src_to_out)
    inv /= inv[2, 2]
    return src.transform(size, Image.PERSPECTIVE, tuple(inv.ravel()[:8]), Image.BICUBIC)


def poly_mask(polys, size, origin, width=0):
    big = Image.new('L', (size[0] * SS, size[1] * SS), 0)
    d = ImageDraw.Draw(big)
    for p in polys:
        q = [tuple(v) for v in (p - origin) * SS]
        if width:
            d.line(q + [q[0]], fill=255, width=width * SS, joint='curve')
        else:
            d.polygon(q, fill=255)
    return big.reduce(SS)


def to_f(img):
    return np.asarray(img, np.float32) / 255


# ---------------------------------------------------------------- Textures and photo effects


def lowfreq(rng, w, h, gw, gh):
    small = rng.standard_normal((max(2, gh), max(2, gw))).astype(np.float32)
    return np.asarray(Image.fromarray(small, 'F').resize((w, h), Image.BICUBIC))


def table_texture(kind, w, h, rng):
    fine = rng.standard_normal((h, w), dtype=np.float32)
    if kind == 'wood':
        y = np.arange(h, dtype=np.float32)[:, None]
        plank_h = rng.uniform(260, 420)
        yy = y + rng.uniform(0, plank_h)
        plank = (yy // plank_h).astype(int)
        n_planks = plank.max() + 1
        phase = rng.uniform(0, 100, n_planks)[plank]
        tone = rng.uniform(-1, 1, n_planks)[plank]
        meander = lowfreq(rng, w, h, w // 450, h // 30) * 14 + lowfreq(rng, w, h, w // 120, h // 60) * 3
        period = rng.uniform(9, 14)
        grain = (0.5 + 0.5 * np.sin(2 * math.pi * (yy + meander + phase) / period)) ** 3
        streak = lowfreq(rng, w, h, w // 50, h // 2)
        v = 0.55 + 0.12 * tone - 0.3 * grain + 0.06 * streak + 0.02 * fine
        light = np.array([196, 150, 102], np.float32) * rng.uniform(0.9, 1.08)
        dark = np.array([112, 72, 42], np.float32)
        v = np.clip(v, 0, 1)[..., None]
        out = dark + (light - dark) * v
        seam = (yy - plank * plank_h) < 3
        out[np.broadcast_to(seam, (h, w))] *= 0.45
        return out
    if kind == 'cloth':
        base = [(150, 62, 58), (62, 84, 132), (186, 176, 150), (90, 120, 92)][rng.integers(4)]
        x = np.arange(w, dtype=np.float32)[None, :]
        y = np.arange(h, dtype=np.float32)[:, None]
        weave = np.sin(2 * math.pi * x / 3.3) * np.sin(2 * math.pi * y / 3.3)
        folds = lowfreq(rng, w, h, w // 300, h // 300)
        v = 1 + 0.05 * weave + 0.05 * fine + 0.06 * folds
        return np.array(base, np.float32) * v[..., None]
    if kind == 'plain':
        v = 1 + 0.03 * lowfreq(rng, w, h, w // 400, h // 400) + 0.012 * fine
        return np.array([208, 206, 200], np.float32) * v[..., None]
    if kind == 'dark':
        fibre = lowfreq(rng, w, h, w // 2, h // 2)
        v = 1 + 0.08 * fibre + 0.05 * fine + 0.08 * lowfreq(rng, w, h, w // 350, h // 350)
        return np.array([34, 72, 46], np.float32) * v[..., None]
    raise ValueError(kind)


def photo_finish(arr, rng, noise=3.0):
    h, w = arr.shape[:2]
    yy, xx = np.mgrid[-1 : 1 : h * 1j, -1 : 1 : w * 1j].astype(np.float32)
    a = rng.uniform(0, 2 * math.pi)
    light = 1 + (xx * math.cos(a) + yy * math.sin(a)) * rng.uniform(0.06, 0.12)
    light *= 1 - rng.uniform(0.12, 0.22) * (xx**2 + yy**2) / 2
    arr = np.clip(arr * light[..., None], 0, 255).astype(np.uint8)
    arr = np.asarray(Image.fromarray(arr).filter(ImageFilter.GaussianBlur(0.6)), np.float32)
    arr += rng.standard_normal(arr.shape, dtype=np.float32) * noise
    return Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8))


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except (OSError, TypeError):
        return ImageFont.load_default()


# ---------------------------------------------------------------- Box photo


def reference_photo(pic, n_pieces, rng):
    scale = min(1.0, 1400 / max(pic.size))
    pw, ph = round(pic.width * scale), round(pic.height * scale)
    m = round(0.045 * max(pw, ph))
    band = round(0.1 * ph)
    colors = [(24, 44, 92), (236, 232, 222), (150, 28, 34), (20, 20, 22)]
    bg = colors[rng.integers(len(colors))]
    fg = (240, 240, 240) if sum(bg) < 400 else (30, 30, 30)
    face = Image.new('RGB', (pw + 2 * m, ph + 2 * m + band), bg)
    face.paste(pic.resize((pw, ph), Image.LANCZOS), (m, m))
    d = ImageDraw.Draw(face)
    ty = m + ph + m // 2
    d.ellipse([m, ty, m + band * 0.8, ty + band * 0.8], fill=(214, 160, 40))
    d.text((m + band, ty + band * 0.05), 'PUZZLE', fill=fg, font=font(int(band * 0.55)))
    d.text(
        (face.width - m, ty + band * 0.15),
        f'{n_pieces} Teile',
        fill=fg,
        font=font(int(band * 0.4)),
        anchor='ra',
    )
    fw, fh = face.size
    out_w, out_h = round(fw * 1.3), round(fh * 1.3)
    tex = table_texture(['plain', 'wood', 'cloth'][rng.integers(3)], out_w, out_h, rng)
    src = np.array([[0, 0], [fw, 0], [fw, fh], [0, fh]], float)
    rot = rotation(rng.uniform(-5, 5))
    dst = apply_h(rot, src - (fw / 2, fh / 2)) + (out_w / 2, out_h / 2)
    dst += rng.uniform(-0.035, 0.035, (4, 2)) * (fw, fh)
    hb = homography(src, dst)
    warped = to_f(warp(face, hb, (out_w, out_h))) * 255
    mask = to_f(poly_mask([dst], (out_w, out_h), (0, 0)))
    shadow = to_f(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10)))
    shadow = np.roll(shadow, (8, 6), (0, 1))
    tex *= (1 - 0.4 * shadow)[..., None]
    arr = warped * mask[..., None] + tex * (1 - mask[..., None])
    quad = apply_h(hb, np.array([[m, m], [m + pw, m], [m + pw, m + ph], [m, m + ph]], float))
    return photo_finish(arr, rng, noise=2.5), quad


# ---------------------------------------------------------------- Placement


def dilate(a, r):
    """Square dilation (Chebyshev radius r); result is r larger on each side."""
    h, w = a.shape
    rows = np.zeros((h, w + 2 * r), bool)
    for dx in range(2 * r + 1):
        rows[:, dx : dx + w] |= a
    out = np.zeros((h + 2 * r, w + 2 * r), bool)
    for dy in range(2 * r + 1):
        out[dy : dy + h] |= rows
    return out


class Placer:
    """Occupancy map in Q-pixel cells; footprints are conservative, gap >= GAP."""

    def __init__(self, w, h):
        self.occ = np.zeros((-(-h // Q), -(-w // Q)), bool)
        self.occ[:3] = self.occ[-3:] = True
        self.occ[:, :3] = self.occ[:, -3:] = True
        self.grow = -(-GAP // Q)

    def footprint(self, poly_rel, delta):
        """Footprint of a polygon (relative to its centre), centre at Q*a + delta."""
        a = np.ceil((-poly_rel.min(0) + 2) / Q).astype(int)
        size = np.ceil((poly_rel.max(0) + Q * a + delta + 2) / Q).astype(int)
        img = Image.new('L', tuple(size * Q), 0)
        ImageDraw.Draw(img).polygon([tuple(v) for v in poly_rel + Q * a + delta], fill=1, outline=1)
        f = np.asarray(img).reshape(size[1], Q, size[0], Q).max(axis=(1, 3)) > 0
        return f, a

    def block(self, f, i, j):
        g, r = dilate(f, self.grow), self.grow
        i0, j0 = i - r, j - r
        h, w = self.occ.shape
        si, sj = max(0, -i0), max(0, -j0)
        ei, ej = min(g.shape[0], h - i0), min(g.shape[1], w - j0)
        self.occ[i0 + si : i0 + ei, j0 + sj : j0 + ej] |= g[si:ei, sj:ej]

    def block_poly(self, poly):
        img = Image.new('L', (self.occ.shape[1], self.occ.shape[0]), 0)
        ImageDraw.Draw(img).polygon([tuple(v) for v in poly / Q], fill=1, outline=1)
        self.block(np.asarray(img) > 0, 0, 0)

    def find(self, f, rng, tries=40):
        fh, fw = f.shape
        h, w = self.occ.shape
        if fh > h or fw > w:
            return None
        for _ in range(tries):
            i, j = rng.integers(0, h - fh + 1), rng.integers(0, w - fw + 1)
            if not (self.occ[i : i + fh, j : j + fw] & f).any():
                return i, j
        # random search found nothing: find all free spots via FFT correlation
        spec = np.fft.rfft2(self.occ.astype(np.float32)) * np.conj(np.fft.rfft2(f.astype(np.float32), (h, w)))
        corr = np.fft.irfft2(spec, (h, w))[: h - fh + 1, : w - fw + 1]
        free = np.argwhere(corr < 0.5)
        if not len(free):
            return None
        return tuple(free[rng.integers(len(free))])


# ---------------------------------------------------------------- Rendering


def shade(mask_img):
    """Cardboard edge: edges facing the light brighter, those facing away and the rim darker."""
    m = to_f(mask_img)
    mb = to_f(mask_img.filter(ImageFilter.GaussianBlur(1.4)))
    gy, gx = np.gradient(mb)
    facing = -(gx * LIGHT[0] + gy * LIGHT[1])
    return m, np.clip(1 + 1.4 * facing - 0.35 * (1 - mb), 0.55, 1.35)


def shadow_of(mask_img):
    sh = to_f(mask_img.filter(ImageFilter.GaussianBlur(3)))
    return np.roll(sh, (4, 3), (0, 1))


class Canvas:
    def __init__(self, table):
        self.img = table
        self.h, self.w = table.shape[:2]
        self.shadow = np.ones((self.h, self.w), np.float32)
        self.label = np.zeros((self.h, self.w), np.int32)
        self.layers = []

    def clip(self, x0, y0, w, h):
        sx, sy = max(0, -x0), max(0, -y0)
        ex, ey = min(w, self.w - x0), min(h, self.h - y0)
        return (slice(y0 + sy, y0 + ey), slice(x0 + sx, x0 + ex)), (slice(sy, ey), slice(sx, ex))

    def add(self, x0, y0, rgb, mask_img, gain=1.0, seam=None):
        rgb = np.asarray(rgb, np.float32)
        m, s = shade(mask_img)
        if seam is not None:
            s = s * (1 - 0.55 * seam)
        dst, src = self.clip(x0, y0, m.shape[1], m.shape[0])
        self.shadow[dst] *= 1 - 0.5 * shadow_of(mask_img)[src]
        lid = len(self.layers) + 1
        lab = self.label[dst]
        if (lab[m[src] > 0.02] != 0).any():
            raise RuntimeError('pieces overlap')
        lab[m[src] > 0.02] = lid
        self.layers.append((dst, src, rgb * (s * gain)[..., None], m))

    def render(self):
        out = self.img * self.shadow[..., None]
        for dst, src, rgb, m in self.layers:
            a = m[src][..., None]
            out[dst] = rgb[src] * a + out[dst] * (1 - a)
        return out

    def min_gap_ok(self, gap):
        """Checks with a maximum filter that every piece is >= gap away from other pieces."""
        for lid, (dst, _, _, _) in enumerate(self.layers, 1):
            y, x = dst
            ys = slice(max(0, y.start - gap), y.stop + gap)
            xs = slice(max(0, x.start - gap), x.stop + gap)
            lab = self.label[ys, xs]
            near = dilate(lab == lid, gap - 1)[gap - 1 : 1 - gap, gap - 1 : 1 - gap]
            if ((lab != 0) & (lab != lid) & near).any():
                return False
        return True


def place_loose(cells, puzzle, src, aq, k, placer, canvas, rng, rot90):
    placed, dropped = [], []
    for r, c in cells:
        # table full: more FFT searches only cost time
        if len(dropped) >= 12:
            dropped.append((r, c))
            continue
        poly = puzzle.outline(r, c)
        corners = puzzle.corners(r, c)
        center_ref = corners.mean(0)
        for _attempt in range(3):
            if rot90:
                angle = (90 * rng.integers(4) + rng.uniform(-8, 8)) % 360
            else:
                angle = rng.uniform(0, 360)
            base = rotation(angle) @ np.diag([k, k, 1.0]) @ translate(*-center_ref)
            rel = apply_h(base, poly)
            delta = rng.uniform(0, Q, 2)
            f, a = placer.footprint(rel, delta)
            spot = placer.find(f, rng)
            if spot is not None:
                break
        if spot is None:
            dropped.append((r, c))
            continue
        i, j = spot
        placer.block(f, i, j)
        center = Q * (np.array([j, i]) + a) + delta
        m = translate(*center) @ base
        spoly = apply_h(m, poly)
        x0, y0 = np.floor(spoly.min(0)).astype(int) - PAD
        size = tuple(int(v) for v in np.ceil(spoly.max(0)).astype(int) + PAD - (x0, y0))
        rgb = warp(src, translate(-x0, -y0) @ m @ np.linalg.inv(aq), size)
        mask = poly_mask([spoly], size, (x0, y0))
        canvas.add(x0, y0, rgb, mask, gain=rng.uniform(0.94, 1.06))
        sc = apply_h(m, corners)
        placed.append(
            {
                'row': r,
                'col': c,
                'cx': round(float(sc[:, 0].mean()), 2),
                'cy': round(float(sc[:, 1].mean()), 2),
                'angle': round(float(angle), 3) % 360,
                'corners': np.round(sc, 2).tolist(),
            }
        )
    return placed, dropped


def choose_filled(cols, rows, frac, rng):
    n_fill = round(frac * cols * rows)
    ring = [(0, c) for c in range(cols)] + [(r, cols - 1) for r in range(1, rows)]
    ring += [(rows - 1, c) for c in range(cols - 2, -1, -1)] if rows > 1 else []
    ring += [(r, 0) for r in range(rows - 2, 0, -1)] if cols > 1 else []
    nb = len(ring)
    filled = set()
    if n_fill >= nb:
        take = round(nb * rng.uniform(0.85, 1.0))
    else:
        take = round(n_fill * rng.uniform(0.7, 0.9))
    take = min(take, n_fill, nb)
    if take:
        # the border is built in connected runs with a few gaps
        missing = nb - take
        g = 1 if missing == 0 else int(rng.integers(1, min(3, missing, take) + 1))

        def split(total):
            cuts = np.sort(rng.integers(0, total + 1, g - 1))
            return np.diff([0, *cuts, total])

        pos = int(rng.integers(nb))
        for seg, gap in zip(split(take), split(missing)):
            filled.update(ring[(pos + i) % nb] for i in range(seg))
            pos += seg + gap
    free = [(r, c) for r in range(rows) for c in range(cols) if (r, c) not in filled]
    while len(filled) < n_fill:
        nbs = [
            sum((r + dr, c + dc) in filled for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1))) for r, c in free
        ]
        wts = np.array([3.0 * n * n if n else 0.05 for n in nbs])
        idx = int(rng.choice(len(free), p=wts / wts.sum()))
        filled.add(free.pop(idx))
    return sorted(filled)


def board_quad(w, h, k, scene_w, scene_h, rng, margin=30):
    """Pose of the assembled puzzle: rotation up to 20 degrees, pushed to one side."""
    s = 1.0
    while True:
        for _ in range(60):
            bw, bh = w * k * s / 2, h * k * s / 2
            # The loose pieces lie flat in the photo, so the finished part gets
            # no perspective either: one plane, as on a real table. The draw
            # keeps the random stream of the test scenes.
            rng.uniform(-0.06, 0.06, 2)
            t1 = t2 = 0.0
            local = np.array(
                [
                    [-bw * (1 - t1), -bh * (1 - t2)],
                    [bw * (1 - t1), -bh * (1 + t2)],
                    [bw * (1 + t1), bh * (1 + t2)],
                    [-bw * (1 + t1), bh * (1 - t2)],
                ]
            )
            quad = apply_h(rotation(rng.uniform(-20, 20)), local)
            lo = -quad.min(0) + margin
            hi = np.array([scene_w, scene_h]) - quad.max(0) - margin
            if (hi >= lo).all():
                u = np.where(rng.random(2) < 0.5, rng.uniform(0, 0.2, 2), rng.uniform(0.8, 1, 2))
                return quad + lo + (hi - lo) * u, s
        s *= 0.95


def draw_debug(scene, truth, puzzle, hb):
    img = scene.copy()
    d = ImageDraw.Draw(img)
    f = font(18)
    if hb is not None:
        filled = {tuple(rc) for rc in truth['filled']}
        for r in range(puzzle.rows):
            for c in range(puzzle.cols):
                q = apply_h(hb, puzzle.corners(r, c))
                col = (40, 230, 60) if (r, c) in filled else (255, 60, 60)
                d.line([tuple(v) for v in q] + [tuple(q[0])], fill=col, width=1)
                cx, cy = q.mean(0)
                if (r, c) not in filled:
                    d.text((cx, cy), f'{r},{c}', fill=col, font=f, anchor='mm')
    for p in truth['loose']:
        q = np.array(p['corners'])
        d.line([tuple(v) for v in q] + [tuple(q[0])], fill=(255, 230, 0), width=2)
        d.ellipse([q[0][0] - 5, q[0][1] - 5, q[0][0] + 5, q[0][1] + 5], fill=(255, 0, 0))
        top = (q[0] + q[1]) / 2
        d.line([(p['cx'], p['cy']), tuple(top)], fill=(0, 255, 255), width=3)
        d.text((p['cx'], p['cy'] + 4), f'{p["row"]},{p["col"]}', fill=(255, 255, 255), font=f, anchor='ma')
        d.text((p['cx'], p['cy'] + 24), f'{p["angle"]:.0f}', fill=(255, 200, 200), font=f, anchor='ma')
    return img


# ---------------------------------------------------------------- Main


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--image', required=True)
    ap.add_argument('--pieces', type=int, default=100)
    ap.add_argument('--cols', type=int)
    ap.add_argument('--rows', type=int)
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--out', required=True)
    ap.add_argument('--mode', choices=['loose', 'partial'], default='loose')
    ap.add_argument('--loose', type=int, help='number of loose pieces (default: all that fit)')
    ap.add_argument('--filled', type=float, default=0.5, help='fraction of filled cells (partial)')
    ap.add_argument(
        '--piece-px', type=float, default=110, help='edge length of the piece core in scene pixels'
    )
    ap.add_argument('--size', default='2400x1800')
    ap.add_argument('--table', choices=['wood', 'cloth', 'plain', 'dark'], default='wood')
    ap.add_argument('--rot90', action='store_true', help='only multiples of 90 degrees (+-8 degrees)')
    ap.add_argument('--debug', action='store_true', help='debug.png with ground truth drawn in')
    a = ap.parse_args()
    if (a.cols is None) != (a.rows is None):
        ap.error('--cols and --rows only together')
    return a


def main():
    args = parse_args()
    t_start = time.perf_counter()
    rng = np.random.default_rng(args.seed)
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    scene_w, scene_h = (int(v) for v in args.size.lower().split('x'))

    pic = Image.open(Path(args.image).expanduser()).convert('RGB')
    w, h = pic.size
    cols, rows = (args.cols, args.rows) if args.cols else choose_grid(args.pieces, w / h)
    puzzle = Puzzle(w, h, cols, rows, rng)
    pic.save(out / 'reference_clean.png')

    ref_img, ref_quad = reference_photo(pic, cols * rows, rng)
    ref_img.save(out / 'reference.jpg', quality=88)

    k = args.piece_px / puzzle.side
    hb, filled = None, []
    if args.mode == 'partial':
        quad, s = board_quad(w, h, k, scene_w, scene_h, rng)
        k *= s
        hb = homography(np.array([[0, 0], [w, 0], [w, h], [0, h]], float), quad)
        filled = choose_filled(cols, rows, args.filled, rng)

    # prescaled image with edge padding so border pieces get no black seams
    sw, sh = max(1, round(w * k)), max(1, round(h * k))
    pad = 8
    small = np.asarray(pic.resize((sw, sh), Image.LANCZOS))
    src = Image.fromarray(np.pad(small, ((pad, pad), (pad, pad), (0, 0)), mode='edge'))
    aq = np.array([[sw / w, 0, pad], [0, sh / h, pad], [0, 0, 1]])

    canvas = Canvas(table_texture(args.table, scene_w, scene_h, rng))
    placer = Placer(scene_w, scene_h)

    if hb is not None and filled:
        polys = [apply_h(hb, puzzle.outline(r, c)) for r, c in filled]
        allp = np.concatenate(polys)
        x0, y0 = np.floor(allp.min(0)).astype(int) - PAD
        size = tuple(int(v) for v in np.ceil(allp.max(0)).astype(int) + PAD - (x0, y0))
        rgb = warp(src, translate(-x0, -y0) @ hb @ np.linalg.inv(aq), size)
        mask = poly_mask(polys, size, (x0, y0))
        seam = to_f(poly_mask(polys, size, (x0, y0), width=1))
        canvas.add(x0, y0, rgb, mask, seam=seam)
    if hb is not None:
        placer.block_poly(quad)

    all_cells = [(r, c) for r in range(rows) for c in range(cols)]
    missing = [rc for rc in all_cells if rc not in set(filled)]
    order = [missing[i] for i in rng.permutation(len(missing))]
    if args.loose is not None:
        order = order[: args.loose]
    loose, dropped = place_loose(order, puzzle, src, aq, k, placer, canvas, rng, args.rot90)
    if not canvas.min_gap_ok(GAP):
        raise RuntimeError('minimum gap violated')

    scene = photo_finish(canvas.render(), rng)
    scene.save(out / 'scene.jpg', quality=85)

    truth = {
        'cols': cols,
        'rows': rows,
        'pieceCount': cols * rows,
        'mode': args.mode,
        'seed': args.seed,
        'piecePx': round(k * puzzle.side, 2),
        'reference': {'width': w, 'height': h},
        'scene': {'width': scene_w, 'height': scene_h},
        'loose': sorted(loose, key=lambda p: (p['row'], p['col'])),
        'notPlaced': [list(rc) for rc in sorted(dropped)],
        'filled': [list(rc) for rc in filled],
        'referenceQuad': np.round(ref_quad, 2).tolist(),
        # jittered grid corners in reference_clean pixels, [row][col] = [x, y]
        'gridPoints': np.round(puzzle.pts, 3).tolist(),
        # h[i][c]: edge between row i and i+1 in column c; v[r][j]: between column j and j+1 in row r.
        # +1 = tab points to +y (down) or +x (right), i.e. the piece with the smaller index
        # has the tab, the other the hole; -1 the other way round. Relative to the unrotated image.
        'edges': puzzle.edge_signs(),
    }
    if hb is not None:
        truth['boardHomography'] = (hb / hb[2, 2]).tolist()
    (out / 'truth.json').write_text(json.dumps(truth, indent=1))
    if args.debug:
        draw_debug(scene, truth, puzzle, hb).save(out / 'debug.png')

    msg = f'{cols}x{rows}={cols * rows} pieces, {len(loose)} loose'
    if filled:
        msg += f', {len(filled)} filled'
    if dropped:
        msg += f', {len(dropped)} did not fit on the table'
    print(f'{msg}, piece size {k * puzzle.side:.0f} px, {time.perf_counter() - t_start:.1f} s -> {out}')


if __name__ == '__main__':
    main()
