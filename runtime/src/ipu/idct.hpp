#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace ps2::ipu::detail {
// The basis is stored by frequency, then output position. Each SIMD lane is
// an independent scalar output; additions retain the original frequency order.
inline void inverse_dct(const int *in, std::int16_t *out, const double (&basis)[8][8]) {
    alignas(16) double rows[8][8];
#ifdef __wasm_simd128__
    // An all-zero frequency row transforms to zero. Skipping it cannot
    // change the final rounded integer samples; active rows retain their order.
    unsigned active[8], count = 0;
    for (int v = 0; v < 8; ++v) {
        if (!wasm_v128_any_true(wasm_v128_or(wasm_v128_load(in + v * 8), wasm_v128_load(in + v * 8 + 4)))) continue;
        active[count++] = static_cast<unsigned>(v);
        for (int x = 0; x < 8; x += 2) {
            v128_t sum = wasm_f64x2_splat(0);
            for (int u = 0; u < 8; ++u)
                sum = wasm_f64x2_add(sum, wasm_f64x2_mul(wasm_v128_load(basis[u] + x),
                    wasm_f64x2_splat(static_cast<double>(in[v * 8 + u]))));
            wasm_v128_store(rows[v] + x, sum);
        }
    }
    if (!count) { std::fill(out, out + 64, 0); return; }
    for (int y = 0; y < 8; ++y)
        for (int x = 0; x < 8; x += 2) {
            v128_t sum = wasm_f64x2_splat(0);
            if (count == 8) {
                for (int v = 0; v < 8; ++v)
                    sum = wasm_f64x2_add(sum, wasm_f64x2_mul(wasm_f64x2_splat(basis[v][y]), wasm_v128_load(rows[v] + x)));
            } else {
                for (unsigned i = 0; i < count; ++i) {
                    const unsigned v = active[i];
                    sum = wasm_f64x2_add(sum, wasm_f64x2_mul(wasm_f64x2_splat(basis[v][y]), wasm_v128_load(rows[v] + x)));
                }
            }
            const v128_t rounded = wasm_f64x2_floor(wasm_f64x2_add(sum, wasm_f64x2_splat(0.5)));
            const v128_t bounded = wasm_f64x2_min(wasm_f64x2_max(rounded, wasm_f64x2_splat(-256)), wasm_f64x2_splat(255));
            const v128_t words = wasm_i32x4_trunc_sat_f64x2_zero(bounded);
            wasm_v128_store32_lane(out + y * 8 + x, wasm_i16x8_narrow_i32x4(words, words), 0);
        }
#else
    for (int v = 0; v < 8; ++v)
        for (int x = 0; x < 8; ++x) {
            double sum = 0;
            for (int u = 0; u < 8; ++u) sum += basis[u][x] * in[v * 8 + u];
            rows[v][x] = sum;
        }
    for (int y = 0; y < 8; ++y)
        for (int x = 0; x < 8; ++x) {
            double sum = 0;
            for (int v = 0; v < 8; ++v) sum += basis[v][y] * rows[v][x];
            out[y * 8 + x] = static_cast<std::int16_t>(std::clamp(static_cast<int>(std::floor(sum + 0.5)), -256, 255));
        }
#endif
}
}
