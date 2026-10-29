#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace ps2::ipu::detail {
inline std::size_t convert_pixels(const std::uint8_t *raw, std::uint8_t *pixels,
                                 bool rgb16, std::uint16_t th0, std::uint16_t th1) {
    std::size_t size = 0;
#ifdef __wasm_simd128__
    const v128_t zero = wasm_i32x4_splat(0), maximum = wasm_i32x4_splat(255);
    const auto clamp = [&](v128_t value) { return wasm_i32x4_min(wasm_i32x4_max(value, zero), maximum); };
    for (int y = 0; y < 16; ++y) {
        for (int x = 0; x < 16; x += 4) {
            const v128_t bytes = wasm_v128_load32_zero(raw + y * 16 + x);
            const v128_t values = wasm_u32x4_extend_low_u16x8(wasm_u16x8_extend_low_u8x16(bytes));
            const v128_t lum = wasm_i32x4_mul(wasm_i32x4_max(wasm_i32x4_sub(values, wasm_i32x4_splat(16)), zero), wasm_i32x4_splat(149));
            const int at = (y / 2) * 8 + x / 2;
            const int cb0 = raw[256 + at] - 128, cb1 = raw[257 + at] - 128;
            const int cr0 = raw[320 + at] - 128, cr1 = raw[321 + at] - 128;
            const v128_t cb = wasm_i32x4_make(cb0, cb0, cb1, cb1), cr = wasm_i32x4_make(cr0, cr0, cr1, cr1);
            const v128_t rounded = wasm_i32x4_add(lum, wasm_i32x4_splat(64));
            const v128_t r = clamp(wasm_i32x4_shr(wasm_i32x4_add(rounded, wasm_i32x4_mul(cr, wasm_i32x4_splat(204))), 7));
            const v128_t g = clamp(wasm_i32x4_shr(wasm_i32x4_sub(wasm_i32x4_sub(rounded, wasm_i32x4_mul(cb, wasm_i32x4_splat(50))), wasm_i32x4_mul(cr, wasm_i32x4_splat(104))), 7));
            const v128_t b = clamp(wasm_i32x4_shr(wasm_i32x4_add(rounded, wasm_i32x4_mul(cb, wasm_i32x4_splat(258))), 7));
            const auto below = [&](std::uint16_t threshold) {
                const auto t = wasm_i32x4_splat(threshold);
                return wasm_v128_and(wasm_v128_and(wasm_i32x4_lt(r, t), wasm_i32x4_lt(g, t)), wasm_i32x4_lt(b, t));
            };
            const v128_t alpha = wasm_v128_andnot(wasm_v128_bitselect(wasm_i32x4_splat(0x40), wasm_i32x4_splat(0x80), below(th1)), below(th0));
            if (rgb16) {
                const v128_t rg = wasm_v128_or(wasm_i32x4_shr(r, 3), wasm_i32x4_shl(wasm_i32x4_shr(g, 3), 5));
                const v128_t ba = wasm_v128_or(wasm_i32x4_shl(wasm_i32x4_shr(b, 3), 10), wasm_i32x4_shl(wasm_v128_and(alpha, wasm_i32x4_splat(0x80)), 8));
                wasm_v128_store64_lane(pixels + size, wasm_u16x8_narrow_i32x4(wasm_v128_or(rg, ba), zero), 0);
                size += 8;
            } else {
                const v128_t rg = wasm_v128_or(r, wasm_i32x4_shl(g, 8));
                const v128_t ba = wasm_v128_or(wasm_i32x4_shl(b, 16), wasm_i32x4_shl(alpha, 24));
                wasm_v128_store(pixels + size, wasm_v128_or(rg, ba));
                size += 16;
            }
        }
    }
#else
    for (int y = 0; y < 16; ++y)
        for (int x = 0; x < 16; ++x) {
            const int lum = 149 * std::max(0, raw[y * 16 + x] - 16);
            const int cb = raw[256 + (y / 2) * 8 + x / 2] - 128, cr = raw[320 + (y / 2) * 8 + x / 2] - 128;
            const int r = std::clamp((lum + 204 * cr + 64) >> 7, 0, 255);
            const int g = std::clamp((lum - 50 * cb - 104 * cr + 64) >> 7, 0, 255);
            const int b = std::clamp((lum + 258 * cb + 64) >> 7, 0, 255);
            int a = 0x80;
            if (r < th0 && g < th0 && b < th0) a = 0;
            else if (r < th1 && g < th1 && b < th1) a = 0x40;
            if (rgb16) {
                const std::uint16_t p = static_cast<std::uint16_t>((r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10) | (a & 0x80 ? 0x8000 : 0));
                std::memcpy(pixels + size, &p, 2); size += 2;
            } else {
                const std::uint8_t p[4] = {static_cast<std::uint8_t>(r), static_cast<std::uint8_t>(g), static_cast<std::uint8_t>(b), static_cast<std::uint8_t>(a)};
                std::memcpy(pixels + size, p, 4); size += 4;
            }
        }
#endif
    return size;
}
}
