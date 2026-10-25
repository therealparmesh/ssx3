#include "dmac.hpp"
#include "ipu/ipu.hpp"
#include "ps2/state.hpp"

#include <array>
#include <cstdio>
#include <stdexcept>

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
}
int main() {
    try {
        partial_fixed_decode(); short_variable_decode(); invalid_variable_decode();
        std::puts("PASS: IPU unaligned FDEC, partial FIFO/state resume, short VLC and invalid-code handling");
    } catch (const std::exception &error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); return 1; }
}
