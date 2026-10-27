#include "dmac.hpp"
#include "ipu/ipu.hpp"
#include "ps2/state.hpp"

#include <array>
#include <cstdio>
#include <stdexcept>
#include <vector>

namespace {
void expect(bool ok, const char *why) { if (!ok) throw std::runtime_error(why); }
void reset() { ps2::dmac::reset(); ps2::ipu::reset(); }
bool busy() { return (ps2::ipu::read32(0x10002004) & 0x80000000u) != 0; }
std::uint32_t result() { return ps2::ipu::read32(0x10002000); }
void command(std::uint32_t value) { ps2::ipu::write32(0x10002000, value); }
std::uint32_t bits(const std::array<std::uint8_t, 32> &data, unsigned start, unsigned count) {
    std::uint32_t value = 0;
    for (unsigned i = 0; i < count; ++i) value = (value << 1) | ((data[(start + i) / 8] >> (7 - (start + i) % 8)) & 1u);
    return value;
}
void partial_fixed_decode() {
    reset();
    std::array<std::uint8_t, 32> data{};
    for (unsigned i = 0; i < data.size(); ++i) data[i] = static_cast<std::uint8_t>(37 * i + 11);
    ps2::ipu::write_fifo(data.data());
    command(0x4000003F); // FDEC: skip 63, peek 32 without consuming the result.
    expect(!busy() && result() == bits(data, 63, 32), "FDEC returned the wrong unaligned bits");
    command(0x4000003F); // Requires 158 bits, but the FIFO currently has 128.
    expect(busy(), "Incomplete FDEC finished without its remaining input");
    // Round-trip a waiting command before supplying the second FIFO qword.
    ps2::state::Writer saved; ps2::ipu::state(saved);
    ps2::state::Reader restored(saved.out.data(), saved.out.size()); ps2::ipu::state(restored);
    ps2::ipu::write_fifo(data.data() + 16);
    expect(!busy() && result() == bits(data, 126, 32), "Resumed FDEC lost its original bit position");
}
void short_variable_decode() {
    reset();
    std::array<std::uint8_t, 16> data{};
    data[15] = 0x02; // Bit 126 is the one-bit macroblock-address code 1.
    ps2::ipu::write_fifo(data.data());
    command(0x4000003F);
    expect(!busy(), "FDEC setup failed");
    command(0x3000003F);
    expect(!busy() && (result() & 0xFFFF) == 1, "A complete short VLC waited for unnecessary look-ahead");
    command(0x30000000); // One zero bit remains: not enough to identify a code.
    expect(busy(), "Truncated VLC was treated as an invalid complete code");
    std::array<std::uint8_t, 16> rest{};
    rest[0] = 0x80; // Remaining prefix 0 + 10 is MB-address increment 3.
    ps2::ipu::write_fifo(rest.data());
    expect(!busy() && (result() & 0xFFFF) == 3, "VLC resume consumed its partial prefix twice");
}
void invalid_variable_decode() {
    reset();
    std::array<std::uint8_t, 16> zero{};
    ps2::ipu::write_fifo(zero.data()); command(0x30000000);
    expect(!busy() && (ps2::ipu::read32(0x10002010) & 0x4000), "Invalid VLC did not set ECD and release BUSY");
    reset(); command(0x3400003F); // Invalid picture type, but the skip is incomplete.
    expect(busy(), "VDEC reported picture-type failure before receiving its skip bits");
    ps2::ipu::write_fifo(zero.data());
    expect(!busy() && (ps2::ipu::read32(0x10002010) & 0x4000), "Invalid picture-type recovery failed");
}
void append_bits(std::vector<std::uint8_t> &data, unsigned &bits, const char *code) {
    for (; *code; ++code) {
        if (bits / 8 == data.size()) data.push_back(0);
        if (*code == '1') data[bits / 8] |= 1u << (7 - bits % 8);
        ++bits;
    }
}
void streamed_macroblock() {
    std::vector<std::uint8_t> input;
    unsigned bits = 0;
    // Six dense intra blocks: zero DC difference, sixty +1 AC values, EOB.
    // At 1108 bits this cannot fit in the hardware FIFO in one transaction.
    for (unsigned block = 0; block < 6; ++block) {
        append_bits(input, bits, block < 4 ? "100" : "00");
        for (unsigned coefficient = 0; coefficient < 60; ++coefficient) append_bits(input, bits, "110");
        append_bits(input, bits, "10");
    }
    input.resize((input.size() + 15) / 16 * 16, 0);
    reset(); command(0x2C080000u); // BDEC, intra, reset DC, progressive, QSC 8.
    for (unsigned at = 0; at < input.size(); at += 16) {
        ps2::ipu::write_fifo(input.data() + at);
        const auto control = ps2::ipu::read32(0x10002010u);
        expect(!(control & 0x4000u), "Valid dense macroblock raised ECD");
        if (at + 16 < input.size()) {
            expect(busy() && !(control & 0xF0u), "Partial macroblock committed output early");
            std::array<std::uint8_t, 16> empty;
            empty.fill(0xFF); ps2::ipu::read_fifo(empty.data());
            for (auto value : empty) expect(value == 0, "Partial macroblock exposed temporary pixels");
            ps2::state::Writer saved; ps2::ipu::state(saved);
            ps2::state::Reader restored(saved.out.data(), saved.out.size()); ps2::ipu::state(restored);
        }
    }
    unsigned bytes = 0;
    std::uint32_t hash = 2166136261u;
    while (ps2::ipu::read32(0x10002010u) & 0xF0u) {
        std::array<std::uint8_t, 16> word;
        ps2::ipu::read_fifo(word.data());
        for (auto value : word) hash = (hash ^ value) * 16777619u;
        bytes += word.size();
    }
    // Frozen from the preceding decoder, including dequantization, mismatch
    // control, IDCT and luma/chroma layout. No game data is used.
    expect(bytes == 768 && hash == 0x8F66ACF5u, "Streamed macroblock changed decoded samples or state continuity");
    expect(!busy(), "Drained macroblock did not release BUSY");
}
void sparse_macroblock() {
    reset();
    std::array<std::uint8_t, 16> input{};
    input[0] = 0xAA; // CBP 32 (1010), first coefficient +1 (10), EOB (10).
    command(0x20080000u); ps2::ipu::write_fifo(input.data());
    std::array<std::int16_t, 384> output{};
    for (unsigned at = 0; at < sizeof output; at += 16)
        ps2::ipu::read_fifo(reinterpret_cast<std::uint8_t *>(output.data()) + at);
    for (unsigned at = 0; at < output.size(); ++at)
        expect(output[at] == (at < 128 && at % 16 < 8 ? 3 : 0), "Sparse CBP reconstructed an unselected block or lost its coefficient");
    expect(!busy() && !(ps2::ipu::read32(0x10002010u) & 0x4000u), "Sparse macroblock did not complete cleanly");
}

}
int main() {
    try {
        partial_fixed_decode(); short_variable_decode(); invalid_variable_decode(); streamed_macroblock(); sparse_macroblock();
        std::puts("PASS: IPU unaligned FDEC, partial FIFO/state resume, short VLC, invalid-code handling, streamed macroblocks and sparse CBP");
    } catch (const std::exception &error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); return 1; }
}
