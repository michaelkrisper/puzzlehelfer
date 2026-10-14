// Two nearest neighbours by brute force on the graphics card (WebGL2; in the
// worker through OffscreenCanvas). Same results as core/knn.js, which stays
// the fallback where WebGL2 is missing (older Safari, Node) or fails.
// Pixel 4a: about 1.8× faster than the WASM module for large sets.
(() => {
  globalThis.PH ??= {};
  const PH = globalThis.PH;

  const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // One fragment per query point q0 + i, over the reference points r0 … r1-1.
  // Descriptors as uvec4 texels (16 bytes), nv per point. Hamming: 32-bit
  // popcount (GLSL ES 3.00 has no bitCount). L2: squared, four bytes per
  // channel. The query is fetched anew per reference point: keeping it in
  // registers lowers the parallelism (Adreno) or does not compile at all.
  const FS = (dist) => `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D qTex;
uniform usampler2D rTex;
uniform int nv;
uniform int q0;
uniform int nq;
uniform int r0;
uniform int r1;
uniform int outW;
uniform int texW;
out uvec4 o;
uint pc(uint v) {
  v = v - ((v >> 1u) & 0x55555555u);
  v = (v & 0x33333333u) + ((v >> 2u) & 0x33333333u);
  return (((v + (v >> 4u)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24u;
}
uint sq4(uint a, uint b) {
  uint d = 0u;
  for (uint sh = 0u; sh < 32u; sh += 8u) {
    int x = int((a >> sh) & 255u) - int((b >> sh) & 255u);
    d += uint(x * x);
  }
  return d;
}
ivec2 at(int i) { return ivec2(i % texW, i / texW); }
void main() {
  int i = int(gl_FragCoord.y) * outW + int(gl_FragCoord.x);
  if (i >= nq) { o = uvec4(0u); return; }
  int q = q0 + i;
  uint b = 0xffffffffu;
  uint s = 0xffffffffu;
  uint bi = 0xffffffffu;
  for (int j = r0; j < r1; j++) {
    uint d = 0u;
    for (int k = 0; k < 16; k++) {
      if (k >= nv) break;
      uvec4 qk = texelFetch(qTex, at(q * nv + k), 0);
      uvec4 r = texelFetch(rTex, at(j * nv + k), 0);
      ${
        dist === 'hamming'
          ? 'uvec4 x = qk ^ r; d += pc(x.x) + pc(x.y) + pc(x.z) + pc(x.w);'
          : 'd += sq4(qk.x, r.x) + sq4(qk.y, r.y) + sq4(qk.z, r.z) + sq4(qk.w, r.w);'
      }
    }
    if (d < b) { s = b; b = d; bi = uint(j); } else if (d < s) { s = d; }
  }
  o = uvec4(bi, b, s, 1u);
}`;

  const TEX_W = 2048; // texels per texture row
  const OUT_W = 256; // query points per output row
  // Points per draw. Mobile drivers silently abort long draws and leave the
  // context unusable (Pixel 4a at 5000 × 8000), so every draw stays short.
  const QB = 4096;
  const CHUNK = 2048;

  let ctx = null;
  function init() {
    if (ctx !== null) return ctx;
    ctx = false;
    try {
      if (typeof OffscreenCanvas === 'undefined' || globalThis.PH_NOGPU) return ctx;
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false });
      if (!gl) return ctx;
      // Software rendering (SwiftShader, llvmpipe) is far slower than WASM.
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) return ctx;
      const prog = (fs) => {
        const p = gl.createProgram();
        for (const [type, src] of [
          [gl.VERTEX_SHADER, VS],
          [gl.FRAGMENT_SHADER, fs],
        ]) {
          const sh = gl.createShader(type);
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
          if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
          gl.attachShader(p, sh);
        }
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const u = {};
        for (const n of ['qTex', 'rTex', 'nv', 'q0', 'nq', 'r0', 'r1', 'outW', 'texW'])
          u[n] = gl.getUniformLocation(p, n);
        return { p, u };
      };
      const out = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, out);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, OUT_W, QB / OUT_W);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
      ctx = {
        gl,
        progs: { hamming: prog(FS('hamming')), l2: prog(FS('l2')) },
        fb,
        refs: new WeakMap(), // reference descriptor array → texture
      };
    } catch (err) {
      console.warn('WebGL2 matching unavailable', err);
      ctx = false;
    }
    return ctx;
  }

  // Bytes (rows of 16·nv) as an RGBA32UI texture.
  function upload(gl, data, n, nv) {
    const texels = n * nv;
    const h = Math.max(1, Math.ceil(texels / TEX_W));
    const u = new Uint32Array(TEX_W * h * 4);
    const a = data.byteOffset % 4 ? data.slice() : data;
    u.set(new Uint32Array(a.buffer, a.byteOffset, texels * 4));
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, TEX_W, h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, u);
    return t;
  }

  // Same contract as PH.knn.knn2: per query [index, distance, second
  // distance], distances 0xffffffff if missing; L2 squared. Throws if the
  // graphics card fails, and then stays off.
  function knn2(kind, q, nq, r, nr, bytes) {
    const c = init();
    const { gl } = c;
    const nv = bytes / 16;
    const { p, u } = c.progs[kind];
    let rt = c.refs.get(r);
    if (!rt) {
      rt = upload(gl, r, nr, nv);
      c.refs.set(r, rt);
    }
    const qt = upload(gl, q, nq, nv);
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fb);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, qt);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, rt);
    gl.uniform1i(u.qTex, 0);
    gl.uniform1i(u.rTex, 1);
    gl.uniform1i(u.nv, nv);
    gl.uniform1i(u.outW, OUT_W);
    gl.uniform1i(u.texW, TEX_W);
    const out = new Uint32Array(nq * 3).fill(0xffffffff);
    const px = new Uint32Array(QB * 4);
    try {
      for (let q0 = 0; q0 < nq; q0 += QB) {
        const qn = Math.min(QB, nq - q0);
        const oh = Math.ceil(qn / OUT_W);
        gl.viewport(0, 0, OUT_W, oh);
        gl.uniform1i(u.q0, q0);
        gl.uniform1i(u.nq, qn);
        for (let r0 = 0; r0 < nr; r0 += CHUNK) {
          gl.uniform1i(u.r0, r0);
          gl.uniform1i(u.r1, Math.min(nr, r0 + CHUNK));
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.readPixels(0, 0, OUT_W, oh, gl.RGBA_INTEGER, gl.UNSIGNED_INT, px);
          // Every written fragment sets the 4th channel; zeros mean the
          // driver dropped the draw.
          if (px[3] !== 1 || px[(qn - 1) * 4 + 3] !== 1 || gl.isContextLost())
            throw new Error('WebGL2 matching failed');
          // Merge in order; on equal distance the earlier point wins, as in
          // the CPU version.
          for (let i = 0; i < qn; i++) {
            const o = (q0 + i) * 3;
            const b = px[i * 4 + 1];
            if (b < out[o + 1]) {
              out[o + 2] = Math.min(out[o + 1], px[i * 4 + 2]);
              out[o + 1] = b;
              out[o] = px[i * 4];
            } else out[o + 2] = Math.min(out[o + 2], b);
          }
        }
      }
    } catch (err) {
      ctx = false;
      throw err;
    } finally {
      if (ctx) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteTexture(qt);
      }
    }
    return out;
  }

  // Drivers compile shaders on first use (about 2 s on a Pixel 4a): done in
  // advance while the worker is idle.
  function warm() {
    if (!init()) return;
    try {
      knn2('hamming', new Uint8Array(64), 1, new Uint8Array(128), 2, 64);
      knn2('l2', new Uint8Array(128), 1, new Uint8Array(256), 2, 128);
    } catch (err) {
      console.warn(err);
    }
  }

  PH.gpu = { available: () => !!init(), knn2, warm };
})();
