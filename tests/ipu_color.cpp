#include "ipu/color.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>

#ifndef __wasm_simd128__
#error This fixture must exercise the Wasm SIMD path.
#endif

// The previous scalar converter is the oracle, including threshold ordering,
// signed chroma, truncation, channel packing and RGB16 alpha semantics.
std::size_t reference(const std::uint8_t *raw, std::uint8_t *pixels, bool rgb16,
                      std::uint16_t th0, std::uint16_t th1) {
    std::size_t size = 0;
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
    return size;
}
std::uint64_t blocks = 0;
void compare(const std::uint8_t *raw, std::uint16_t th0, std::uint16_t th1) {
    for (const bool rgb16 : {false, true}) {
        std::array<std::uint8_t, 1040> actual, expected;
        actual.fill(0xA5); expected.fill(0xA5);
        const auto a = ps2::ipu::detail::convert_pixels(raw, actual.data() + 3, rgb16, th0, th1);
        const auto b = reference(raw, expected.data() + 3, rgb16, th0, th1);
        if (a != b || actual != expected) {
            std::fprintf(stderr, "FAIL: block %llu RGB%d thresholds %u/%u\n", blocks, rgb16 ? 16 : 32, th0, th1);
            std::exit(1);
        }
        ++blocks;
    }
}
int main() {
    std::array<std::uint8_t, 386> storage{};
    auto *raw = storage.data() + 1;
    for (int i = 0; i < 256; ++i) raw[i] = static_cast<std::uint8_t>(i);
    for (int cb = 0; cb < 256; ++cb)
        for (int cr = 0; cr < 256; ++cr) {
            std::fill(raw + 256, raw + 320, static_cast<std::uint8_t>(cb));
            std::fill(raw + 320, raw + 384, static_cast<std::uint8_t>(cr));
            compare(raw, static_cast<std::uint16_t>((cb * 5 + cr) % 257), static_cast<std::uint16_t>((cb + cr * 3) % 513));
        }
    std::uint32_t seed = 0x13579BDF;
    constexpr std::uint16_t edges[] = {0, 1, 15, 16, 127, 128, 254, 255, 256, 32768, 65535};
    for (unsigned n = 0; n < 2048; ++n) {
        for (unsigned i = 0; i < 384; ++i) { seed = seed * 1664525u + 1013904223u; raw[i] = seed >> 24; }
        compare(raw, edges[n % 11], edges[(n / 11) % 11]);
    }
    std::printf("PASS: %llu macroblock/format comparisons, exhaustive Y/Cb/Cr, changing chroma, alpha edges, unaligned buffers and output bounds\n", blocks);
    return 0;
}
