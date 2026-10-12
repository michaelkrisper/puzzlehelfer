// Two nearest neighbours by brute force, WebAssembly SIMD.
// out[3i..3i+2] = index of the nearest, its distance, distance of the second.
// Build: see vendor/README.md.
#include <stdint.h>
#include <wasm_simd128.h>

extern unsigned char __heap_base;
uintptr_t heap_base(void) { return (uintptr_t)&__heap_base; }

// Sums of the four lanes of a, b, c, d as one vector.
static inline v128_t hsum4(v128_t a, v128_t b, v128_t c, v128_t d) {
  v128_t ab = wasm_i32x4_add(wasm_i32x4_shuffle(a, b, 0, 4, 1, 5), wasm_i32x4_shuffle(a, b, 2, 6, 3, 7));
  v128_t cd = wasm_i32x4_add(wasm_i32x4_shuffle(c, d, 0, 4, 1, 5), wasm_i32x4_shuffle(c, d, 2, 6, 3, 7));
  return wasm_i32x4_add(wasm_i32x4_shuffle(ab, cd, 0, 1, 4, 5), wasm_i32x4_shuffle(ab, cd, 2, 3, 6, 7));
}

static inline void keep(uint32_t d, int32_t j, uint32_t *b, uint32_t *s, int32_t *bi) {
  if (d < *b) {
    *s = *b;
    *b = d;
    *bi = j;
  } else if (d < *s) {
    *s = d;
  }
}

// Four distances at once; only if one beats the second best they are
// looked at one by one.
static inline void keep4(v128_t d, int32_t j, uint32_t *b, uint32_t *s, int32_t *bi) {
  if (!wasm_v128_any_true(wasm_u32x4_lt(d, wasm_u32x4_splat(*s)))) return;
  keep(wasm_u32x4_extract_lane(d, 0), j, b, s, bi);
  keep(wasm_u32x4_extract_lane(d, 1), j + 1, b, s, bi);
  keep(wasm_u32x4_extract_lane(d, 2), j + 2, b, s, bi);
  keep(wasm_u32x4_extract_lane(d, 3), j + 3, b, s, bi);
}

static inline v128_t popsum(const v128_t *qv, const uint8_t *rp, int nv) {
  v128_t acc = wasm_i8x16_splat(0);
  for (int k = 0; k < nv; k++)
    acc = wasm_i8x16_add(acc, wasm_i8x16_popcnt(wasm_v128_xor(qv[k], wasm_v128_load(rp + k * 16))));
  return wasm_u32x4_extadd_pairwise_u16x8(wasm_u16x8_extadd_pairwise_u8x16(acc));
}

// Hamming distance, bytes a multiple of 16 and at most 256.
void knn_hamming(const uint8_t *q, int nq, const uint8_t *r, int nr, int bytes, int32_t *out) {
  int nv = bytes / 16;
  for (int i = 0; i < nq; i++) {
    v128_t qv[16];
    for (int k = 0; k < nv; k++) qv[k] = wasm_v128_load(q + i * bytes + k * 16);
    uint32_t b = 0xffffffff, s = 0xffffffff;
    int32_t bi = -1;
    int j = 0;
    for (; j + 4 <= nr; j += 4) {
      const uint8_t *rp = r + j * bytes;
      keep4(hsum4(popsum(qv, rp, nv), popsum(qv, rp + bytes, nv), popsum(qv, rp + 2 * bytes, nv),
                  popsum(qv, rp + 3 * bytes, nv)),
            j, &b, &s, &bi);
    }
    for (; j < nr; j++) {
      v128_t w = popsum(qv, r + j * bytes, nv);
      keep(wasm_i32x4_extract_lane(w, 0) + wasm_i32x4_extract_lane(w, 1) + wasm_i32x4_extract_lane(w, 2) +
               wasm_i32x4_extract_lane(w, 3),
           j, &b, &s, &bi);
    }
    out[i * 3] = bi;
    out[i * 3 + 1] = (int32_t)b;
    out[i * 3 + 2] = (int32_t)s;
  }
}

static inline v128_t sqsum(const v128_t *qlo, const v128_t *qhi, const uint8_t *rp, int nv) {
  v128_t acc = wasm_i32x4_splat(0);
  for (int k = 0; k < nv; k++) {
    v128_t v = wasm_v128_load(rp + k * 16);
    v128_t dl = wasm_i16x8_sub(qlo[k], wasm_u16x8_extend_low_u8x16(v));
    v128_t dh = wasm_i16x8_sub(qhi[k], wasm_u16x8_extend_high_u8x16(v));
    acc = wasm_i32x4_add(acc, wasm_i32x4_add(wasm_i32x4_dot_i16x8(dl, dl), wasm_i32x4_dot_i16x8(dh, dh)));
  }
  return acc;
}

// Squared L2 distance of unsigned bytes (SIFT descriptors are integers
// 0..255, so this is exact), bytes a multiple of 16 and at most 256.
void knn_l2u8(const uint8_t *q, int nq, const uint8_t *r, int nr, int bytes, int32_t *out) {
  int nv = bytes / 16;
  for (int i = 0; i < nq; i++) {
    v128_t qlo[16], qhi[16];
    for (int k = 0; k < nv; k++) {
      v128_t v = wasm_v128_load(q + i * bytes + k * 16);
      qlo[k] = wasm_u16x8_extend_low_u8x16(v);
      qhi[k] = wasm_u16x8_extend_high_u8x16(v);
    }
    uint32_t b = 0xffffffff, s = 0xffffffff;
    int32_t bi = -1;
    int j = 0;
    for (; j + 4 <= nr; j += 4) {
      const uint8_t *rp = r + j * bytes;
      keep4(hsum4(sqsum(qlo, qhi, rp, nv), sqsum(qlo, qhi, rp + bytes, nv), sqsum(qlo, qhi, rp + 2 * bytes, nv),
                  sqsum(qlo, qhi, rp + 3 * bytes, nv)),
            j, &b, &s, &bi);
    }
    for (; j < nr; j++) {
      v128_t w = sqsum(qlo, qhi, r + j * bytes, nv);
      keep(wasm_i32x4_extract_lane(w, 0) + wasm_i32x4_extract_lane(w, 1) + wasm_i32x4_extract_lane(w, 2) +
               wasm_i32x4_extract_lane(w, 3),
           j, &b, &s, &bi);
    }
    out[i * 3] = bi;
    out[i * 3 + 1] = (int32_t)b;
    out[i * 3 + 2] = (int32_t)s;
  }
}
