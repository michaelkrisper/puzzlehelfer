// HEIC photos (iPhone) where the browser cannot open them (Chrome): the
// HEIF container is read here and its HEVC tiles go through the graphics
// chip's video decoder (WebCodecs). Without a HEVC decoder it stays at the
// browser's error. parse() is plain JS (tested in Node), decode() needs a
// browser.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  // Boxes of an ISO base media file in d[o, end): [{ type, o (content), end }].
  function boxes(d, v, o, end) {
    const out = [];
    while (o + 8 <= end) {
      let size = v.getUint32(o);
      const type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
      let head = 8;
      if (size === 1) {
        size = Number(v.getBigUint64(o + 8));
        head = 16;
      } else if (size === 0) size = end - o;
      if (size < head || o + size > end) break;
      out.push({ type, o: o + head, end: o + size });
      o += size;
    }
    return out;
  }

  const child = (d, v, b, type, skip = 0) => boxes(d, v, b.o + skip, b.end).find((x) => x.type === type);

  function uint(v, o, n) {
    if (n === 0) return 0;
    if (n === 1) return v.getUint8(o);
    if (n === 2) return v.getUint16(o);
    if (n === 4) return v.getUint32(o);
    if (n === 8) return Number(v.getBigUint64(o));
    throw new Error(`HEIF: Feldbreite ${n}`);
  }

  function isHeif(d) {
    if (d.length < 12) return false;
    const type = String.fromCharCode(...d.subarray(4, 8));
    const brand = String.fromCharCode(...d.subarray(8, 12));
    return type === 'ftyp' && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(brand);
  }

  // hvcC → WebCodecs codec strings (ISO/IEC 14496-15 Annex E), the stated
  // profile first, then Main: iPhones write Main Still Picture (3), which
  // hardware decoders often do not list but decode as Main.
  function codecs(c) {
    const space = ['', 'A', 'B', 'C'][c[1] >> 6];
    const tier = c[1] & 0x20 ? 'H' : 'L';
    const profile = c[1] & 0x1f;
    let compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
    let rev = 0;
    for (let i = 0; i < 32; i++, compat >>>= 1) rev = ((rev << 1) | (compat & 1)) >>> 0;
    const cons = [...c.subarray(6, 12)];
    while (cons.length && cons.at(-1) === 0) cons.pop();
    const tail = cons.map((x) => `.${x.toString(16).toUpperCase()}`).join('');
    const level = `${tier}${c[12]}`;
    const own = `hvc1.${space}${profile}.${rev.toString(16).toUpperCase()}.${level}${tail}`;
    return [...new Set([own, `hvc1.1.6.${level}.B0`])];
  }

  // The primary image: { width, height, crop { x, y, width, height }, rot (quarter turns anticlockwise),
  // mirror (null, 0 vertical axis, 1 horizontal axis), cols, rows,
  // tiles [{ data, x, y }], tile { width, height, config, codecs } }.
  function parse(buf) {
    const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (!isHeif(d)) throw new Error('Keine HEIF-Datei');
    const meta = boxes(d, v, 0, d.length).find((b) => b.type === 'meta');
    if (!meta) throw new Error('HEIF: kein meta');
    const kids = boxes(d, v, meta.o + 4, meta.end);
    const get = (t) => kids.find((b) => b.type === t);

    const pitm = get('pitm');
    const primary = d[pitm.o] === 0 ? v.getUint16(pitm.o + 4) : v.getUint32(pitm.o + 4);

    // Item types.
    const types = new Map();
    const iinf = get('iinf');
    const n0 = d[iinf.o] === 0 ? 6 : 8;
    for (const e of boxes(d, v, iinf.o + n0, iinf.end)) {
      if (e.type !== 'infe' || d[e.o] < 2) continue;
      const wide = d[e.o] === 3;
      const id = wide ? v.getUint32(e.o + 4) : v.getUint16(e.o + 4);
      const at = e.o + (wide ? 10 : 8);
      types.set(id, String.fromCharCode(...d.subarray(at, at + 4)));
    }

    // Item data, from the file or from idat.
    const idat = get('idat');
    const locs = new Map();
    const iloc = get('iloc');
    {
      const ver = d[iloc.o];
      let o = iloc.o + 4;
      const offSize = d[o] >> 4;
      const lenSize = d[o] & 15;
      const baseSize = d[o + 1] >> 4;
      const idxSize = ver === 1 || ver === 2 ? d[o + 1] & 15 : 0;
      o += 2;
      const count = ver < 2 ? v.getUint16(o) : v.getUint32(o);
      o += ver < 2 ? 2 : 4;
      for (let i = 0; i < count; i++) {
        const id = ver < 2 ? v.getUint16(o) : v.getUint32(o);
        o += ver < 2 ? 2 : 4;
        const method = ver === 1 || ver === 2 ? v.getUint16(o) & 15 : 0;
        if (ver === 1 || ver === 2) o += 2;
        o += 2; // data_reference_index
        const base = uint(v, o, baseSize);
        o += baseSize;
        const n = v.getUint16(o);
        o += 2;
        const parts = [];
        for (let k = 0; k < n; k++) {
          o += idxSize;
          const off = uint(v, o, offSize);
          o += offSize;
          const len = uint(v, o, lenSize);
          o += lenSize;
          parts.push([base + off, len]);
        }
        locs.set(id, { method, parts });
      }
    }
    const data = (id) => {
      const l = locs.get(id);
      if (!l) throw new Error(`HEIF: Daten von ${id} fehlen`);
      if (l.method > 1) throw new Error('HEIF: Daten über Verweis');
      const src = l.method === 1 ? d.subarray(idat.o, idat.end) : d;
      const total = l.parts.reduce((s, [, len]) => s + len, 0);
      if (l.parts.length === 1) {
        const [off, len] = l.parts[0];
        return src.subarray(off, off + (len || src.length - off));
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const [off, len] of l.parts) {
        out.set(src.subarray(off, off + len), at);
        at += len;
      }
      return out;
    };

    // Tiles of a grid, in order.
    const dimg = new Map();
    const iref = get('iref');
    if (iref) {
      const wide = d[iref.o] === 1;
      for (const r of boxes(d, v, iref.o + 4, iref.end)) {
        let o = r.o;
        const rd = () => {
          const x = wide ? v.getUint32(o) : v.getUint16(o);
          o += wide ? 4 : 2;
          return x;
        };
        const from = rd();
        const n = v.getUint16(o);
        o += 2;
        const to = [];
        for (let k = 0; k < n; k++) to.push(rd());
        if (r.type === 'dimg') dimg.set(from, to);
      }
    }

    // Properties per item.
    const iprp = get('iprp');
    const ipco = child(d, v, iprp, 'ipco');
    const props = boxes(d, v, ipco.o, ipco.end);
    const assoc = new Map();
    for (const m of boxes(d, v, iprp.o, iprp.end).filter((b) => b.type === 'ipma')) {
      const ver = d[m.o];
      const big = d[m.o + 3] & 1;
      let o = m.o + 4;
      const count = v.getUint32(o);
      o += 4;
      for (let i = 0; i < count; i++) {
        const id = ver < 1 ? v.getUint16(o) : v.getUint32(o);
        o += ver < 1 ? 2 : 4;
        const n = d[o++];
        const list = assoc.get(id) ?? [];
        for (let k = 0; k < n; k++) {
          const idx = big ? v.getUint16(o) & 0x7fff : d[o] & 0x7f;
          o += big ? 2 : 1;
          if (idx) list.push(props[idx - 1]);
        }
        assoc.set(id, list);
      }
    }
    const prop = (id, t) => (assoc.get(id) ?? []).find((p) => p?.type === t);
    const ispe = (id) => {
      const p = prop(id, 'ispe');
      return p ? [v.getUint32(p.o + 4), v.getUint32(p.o + 8)] : null;
    };

    let tileIds;
    let width;
    let height;
    let cols = 1;
    let rows = 1;
    const kind = types.get(primary);
    if (kind === 'grid') {
      const g = data(primary);
      const wide = g[1] & 1;
      rows = g[2] + 1;
      cols = g[3] + 1;
      const gv = new DataView(g.buffer, g.byteOffset, g.byteLength);
      width = wide ? gv.getUint32(4) : gv.getUint16(4);
      height = wide ? gv.getUint32(8) : gv.getUint16(wide ? 8 : 6);
      tileIds = dimg.get(primary) ?? [];
      if (tileIds.length !== rows * cols) throw new Error('HEIF: Kacheln fehlen');
    } else if (kind === 'hvc1') {
      tileIds = [primary];
      [width, height] = ispe(primary) ?? [0, 0];
    } else throw new Error(`HEIF: Bildart ${kind ?? '?'}`);
    if (tileIds.some((id) => types.get(id) !== 'hvc1')) throw new Error('HEIF: nicht HEVC');

    const first = tileIds[0];
    const hvcC = prop(first, 'hvcC');
    if (!hvcC) throw new Error('HEIF: hvcC fehlt');
    const config = d.slice(hvcC.o, hvcC.end);
    const [tw, th] = ispe(first) ?? [width, height];
    const tiles = tileIds.map((id, i) => ({
      data: data(id),
      x: (i % cols) * tw,
      y: Math.floor(i / cols) * th,
    }));

    // Clean aperture: the visible part, centred plus an offset.
    let crop = { x: 0, y: 0, width, height };
    const clap = prop(primary, 'clap');
    if (clap) {
      const q = (k) => v.getInt32(clap.o + k * 8) / v.getInt32(clap.o + k * 8 + 4);
      const cw = Math.round(q(0));
      const ch = Math.round(q(1));
      crop = {
        x: Math.round((width - cw) / 2 + q(2)),
        y: Math.round((height - ch) / 2 + q(3)),
        width: cw,
        height: ch,
      };
    }

    const irot = prop(primary, 'irot');
    const imir = prop(primary, 'imir');
    return {
      width,
      height,
      crop,
      rot: irot ? d[irot.o] & 3 : 0,
      mirror: imir ? d[imir.o] & 1 : null,
      cols,
      rows,
      tiles,
      tile: { width: tw, height: th, config, codecs: codecs(config) },
    };
  }

  // An ImageBitmap of a HEIC file, upright; throws where the browser has no
  // HEVC decoder.
  async function decode(blob) {
    if (typeof VideoDecoder === 'undefined') throw new Error('Kein VideoDecoder');
    const h = parse(new Uint8Array(await blob.arrayBuffer()));
    const base = {
      description: h.tile.config,
      codedWidth: h.tile.width,
      codedHeight: h.tile.height,
    };
    let config = null;
    for (const codec of h.tile.codecs) {
      const r = await VideoDecoder.isConfigSupported({ ...base, codec }).catch(() => null);
      if (r?.supported) {
        config = r.config;
        break;
      }
    }
    if (!config) throw new Error('Kein HEVC-Decoder');

    const canvas = new OffscreenCanvas(h.width, h.height);
    const g = canvas.getContext('2d');
    // iPhone tiles are full range but carry no colour information; Chrome
    // reads them as limited range (16-235), which stretches dark and light
    // apart (Pixel 4a: 71 -> 64, 205 -> 218 against libheif). Pressed back
    // per tile; highlights clipped by the stretch stay clipped.
    const tile = new OffscreenCanvas(h.tile.width, h.tile.height);
    const tg = tile.getContext('2d', { willReadFrequently: true });
    const back = Uint8Array.from({ length: 256 }, (_, x) => Math.round(16 + (x * 219) / 255));
    let failed = null;
    const dec = new VideoDecoder({
      output: (frame) => {
        const t = h.tiles[frame.timestamp];
        const full = frame.colorSpace?.fullRange === true;
        if (full) g.drawImage(frame, t.x, t.y, h.tile.width, h.tile.height);
        else {
          tg.drawImage(frame, 0, 0, h.tile.width, h.tile.height);
          const im = tg.getImageData(0, 0, h.tile.width, h.tile.height);
          const px = im.data;
          for (let i = 0; i < px.length; i += 4) {
            px[i] = back[px[i]];
            px[i + 1] = back[px[i + 1]];
            px[i + 2] = back[px[i + 2]];
          }
          g.putImageData(im, t.x, t.y);
        }
        frame.close();
      },
      error: (e) => {
        failed = e;
      },
    });
    try {
      dec.configure(config);
      h.tiles.forEach((t, i) => {
        dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: i, data: t.data }));
      });
      await dec.flush();
    } finally {
      if (dec.state !== 'closed') dec.close();
    }
    if (failed) throw failed;

    // clap, then irot, then imir (ISO/IEC 23008-12: transformative
    // properties in this order).
    const { x, y, width: w, height: ht } = h.crop;
    const q = h.rot;
    const side = q % 2 === 1;
    const out = new OffscreenCanvas(side ? ht : w, side ? w : ht);
    const o = out.getContext('2d');
    o.translate(out.width / 2, out.height / 2);
    if (h.mirror === 0) o.scale(-1, 1);
    else if (h.mirror === 1) o.scale(1, -1);
    o.rotate((-q * Math.PI) / 2);
    o.drawImage(canvas, x, y, w, ht, -w / 2, -ht / 2, w, ht);
    canvas.width = 0;
    canvas.height = 0;
    return out.transferToImageBitmap();
  }

  PH.heic = { isHeif, parse, codecs, decode };
})();
