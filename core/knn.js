// Two nearest neighbours by brute force in WebAssembly SIMD, several times
// faster than the BFMatcher of opencv.js (which does not vectorise Hamming
// distances). Source and build: wasm/knn.c.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;
  const WASM =
    'AGFzbQEAAAABGgVgAAF/YAZ/f39/f38AYAAAYAF/AGACf38AAwgHAgABAQMABAQFAXABAgIFBgEBQICAAgYIAX8BQZCIBAsHnwEJBm1lbW9yeQIACWhlYXBfYmFzZQABC2tubl9oYW1taW5nAAIIa25uX2wydTgAAwtfaW5pdGlhbGl6ZQAAGV9faW5kaXJlY3RfZnVuY3Rpb25fdGFibGUBAAhzZXRUaHJldwAGGV9lbXNjcmlwdGVuX3N0YWNrX3Jlc3RvcmUABBxlbXNjcmlwdGVuX3N0YWNrX2dldF9jdXJyZW50AAUJBwEAQQELAQAKhQwHAwABCwYAQZCIBAuHCAIPfwJ7IwBBgARrIgokACAEQRBtIQYCQCABQQBMDQAgA0EASgRAIARBD0wEQEEAIQYgAUEETwRAQX9BACADQQFGGyEAIAFB/P///wdxIQb9DAAAAAABAAAAAgAAAAMAAAAhFQNAIAUgFf0MDAAAAAwAAAAMAAAADAAAAP21ASIW/RsAaiICQQA2AgAgBSAW/RsBaiIEQQA2AgAgBSAW/RsCaiIHQQA2AgAgBSAW/RsDaiIIQQA2AgAgAkEANgIEIARBADYCBCAHQQA2AgQgCEEANgIEIAIgADYCCCAEIAA2AgggByAANgIIIAggADYCCCAV/QwEAAAABAAAAAQAAAAEAAAA/a4BIRUgCUEEaiIJIAZHDQALIAEgBkYNAwtBf0EAIANBAUYbIQIDQCAFIAZBDGxqIgAgAjYCCCAAQQA2AgQgAEEANgIAIAZBAWoiBiABRw0ACwwCCyAGQf7//z9xIREgBkEBcSESIAZBBHQhDyAEQfD///8HcUEQRiETA0AgDwRAIAogACAEIAhsaiAP/AoAAAtBfyELQQAhCSACIQdBfyEOQX8hDQNA/QwAAAAAAAAAAAAAAAAAAAAAIRVBACEMQQAhBgJAIBNFBEADQCAHIAZBBHQiEEEQciIUav0AAAAgCiAUav0ABAD9Uf1iIAcgEGr9AAAAIAogEGr9AAQA/VH9YiAV/W79biEVIAZBAmohBiAMQQJqIgwgEUcNAAsgEkUNAQsgByAGQQR0IgZq/QAAACAGIApq/QAEAP1R/WIgFf1uIRULIAsgFf19/X8iFf0bACAV/RsBaiAV/RsCaiAV/RsDaiIGIA0gBiANSRsgBiALSSIMGyENIAkgDiAMGyEOIAQgB2ohByAGIAsgDBshCyAJQQFqIgkgA0cNAAsgBSAIQQxsaiIGIA02AgggBiALNgIEIAYgDjYCACAIQQFqIgggAUcNAAsMAQsgBEEQTgRAQQAhBiABQQRPBEAgAUH8////B3EhBv0MAAAAAAEAAAACAAAAAwAAACEVQQAhAANAIAUgFf0MDAAAAAwAAAAMAAAADAAAAP21ASIW/RsAaiICQX82AgAgBSAW/RsBaiIDQX82AgAgBSAW/RsCaiIEQX82AgAgBSAW/RsDaiIHQX82AgAgAkF/NgIEIANBfzYCBCAEQX82AgQgB0F/NgIEIAJBfzYCCCADQX82AgggBEF/NgIIIAdBfzYCCCAV/QwEAAAABAAAAAQAAAAEAAAA/a4BIRUgAEEEaiIAIAZHDQALIAEgBkYNAgsDQCAFIAZBDGxqIgBBfzYCCCAAQn83AgAgBkEBaiIGIAFHDQALDAELIAFBDGwiAEUNACAFQf8BIAD8CwALIApBgARqJAALxQMCDn8DeyMAQYAIayIKJAAgAUEASgRAIARBEG0hD0F/QQAgA0EATCIQGyERIARBEEghEiADQQJIIRMDQAJAIBJFBEAgACAEIAxsaiEIQQAhBgNAIAogBkEEdCIHaiAHIAhq/QAAACIV/YoB/QsEACAKQYAEaiAHaiAV/YkB/QsEACAGQQFqIgYgD0cNAAtBACEOQX8hCyACIQhBfyEJQX8hDUF/IQYgEA0BA0D9DAAAAAAAAAAAAAAAAAAAAAAhFEEAIQYDQCAKIAZBBHQiB2r9AAQAIAcgCGr9AAAAIhb9igH9kQEiFSAV/boBIBT9rgEgCkGABGogB2r9AAQAIBb9iQH9kQEiFSAV/boB/a4BIRQgBkEBaiIGIA9HDQALIA0gFP0bACAU/RsBaiAU/RsCaiAU/RsDaiIHIAkgByAJSRsgByANSSIGGyEJIA4gCyAGGyELIAQgCGohCCAHIA0gBhsiBiENIAMgDkEBaiIORw0ACwwBC0F/IQkgESIGIQsgEw0AQQAhBkEAIQlBACELCyAFIAxBDGxqIgggCTYCCCAIIAY2AgQgCCALNgIAIAxBAWoiDCABRw0ACwsgCkGACGokAAsGACAAJAALBAAjAAscAEGACCgCAEUEQEGECCABNgIAQYAIIAA2AgALCw==';

  let api = null;
  function load() {
    if (api !== null) return api;
    try {
      const bytes = Uint8Array.from(atob(WASM), (c) => c.charCodeAt(0));
      api = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
      api._initialize?.();
    } catch {
      api = false; // no WebAssembly SIMD: callers fall back to opencv.js
    }
    return api;
  }

  // q (nq rows), r (nr rows): Uint8Array, rows of `bytes` (multiple of 16,
  // at most 256). kind 'hamming' or 'l2' (squared distance of bytes).
  // Returns per query [index of the nearest, its distance, second distance];
  // distances 0xffffffff if there is no such neighbour.
  function knn2(kind, q, nq, r, nr, bytes) {
    const a = load();
    const base = a.heap_base();
    const need = base + r.length + q.length + nq * 12;
    const mem = a.memory;
    if (need > mem.buffer.byteLength) mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
    const heap = new Uint8Array(mem.buffer);
    heap.set(r, base);
    heap.set(q, base + r.length);
    const out = base + r.length + q.length;
    const f = kind === 'hamming' ? a.knn_hamming : a.knn_l2u8;
    // Small calls: the engine optimises the function only after the first
    // call returns, one long first call would run unoptimised throughout.
    for (let i = 0; i < nq; i += 64)
      f(base + r.length + i * bytes, Math.min(64, nq - i), base, nr, bytes, out + i * 12);
    return new Uint32Array(mem.buffer, out, nq * 3).slice();
  }

  PH.knn = { available: () => !!load(), knn2 };
})();
