#pragma once
#include <cstddef>
#include <cstdint>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

namespace ps2::ipu::detail {
inline std::uint32_t read_bits(const std::uint8_t *data, std::size_t size,
                               std::size_t bit, unsigned count) {
    if (!count) return 0;
    const std::size_t byte = bit >> 3;
    std::uint64_t value = 0;
#ifdef __wasm_simd128__
    if (byte <= size && size - byte >= 8) {
        const v128_t bytes = wasm_v128_load64_zero(data + byte);
        const v128_t reversed = wasm_i8x16_shuffle(bytes, bytes, 7, 6, 5, 4, 3, 2, 1, 0, 8, 9, 10, 11, 12, 13, 14, 15);
        value = static_cast<std::uint64_t>(wasm_i64x2_extract_lane(reversed, 0));
    } else
#endif
    {
        // Soft look-ahead may reach beyond the FIFO: keep its zero padding.
        for (std::size_t i = 0; i < 8; ++i)
            value = (value << 8) | (byte + i < size ? data[byte + i] : 0u);
    }
    return static_cast<std::uint32_t>((value << (bit & 7u)) >> (64 - count));
}
}
