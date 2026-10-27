#include "ipu/bits.hpp"
#include <array>
#include <cstdio>
#include <cstdlib>
#ifndef __wasm_simd128__
#error This fixture must exercise the Wasm SIMD reader.
#endif

// Independent bit-by-bit oracle, including reads that require zero padding.
std::uint32_t reference(const std::uint8_t *data, std::size_t size, std::size_t bit, unsigned count) {
    std::uint32_t result = 0;
    for (unsigned i = 0; i < count; ++i) {
        const std::size_t at = bit + i;
        result = (result << 1) | (at / 8 < size ? (data[at / 8] >> (7 - at % 8)) & 1u : 0u);
    }
    return result;
}
int main() {
    std::array<std::uint8_t, 144> storage;
    std::uint32_t seed = 0xDEADBEEF;
    for (auto &value : storage) { seed = seed * 1664525u + 1013904223u; value = seed >> 24; }
    const auto *data = storage.data() + 1;
    std::uint64_t cases = 0;
    for (std::size_t size = 0; size <= 128; ++size)
        for (std::size_t bit = 0; bit < size * 8 + 64; ++bit)
            for (unsigned count = 0; count <= 32; ++count) {
                const auto actual = ps2::ipu::detail::read_bits(data, size, bit, count);
                const auto expected = reference(data, size, bit, count);
                if (actual != expected) {
                    std::fprintf(stderr, "FAIL: size=%zu bit=%zu count=%u actual=%u expected=%u\n", size, bit, count, actual, expected);
                    return 1;
                }
                ++cases;
            }
    for (unsigned count = 0; count <= 32; ++count)
        if (ps2::ipu::detail::read_bits(nullptr, 0, 0, count) != 0) return 2;
    std::printf("PASS: %llu bit-reader cases, all bit alignments and widths, short FIFOs, unaligned buffers and zero padding\n", cases);
    return 0;
}
