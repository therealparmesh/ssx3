#include "ipu.hpp"
#include "idct.hpp"

#include "tables.hpp"
#include "color.hpp"
#include "bits.hpp"
#include "../dmac.hpp"
#include "../hw.hpp"

#include "ps2/state.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace ps2::ipu {

namespace {

using namespace tables;

struct NeedData {};
struct BadCode {};

constexpr std::uint32_t kEcd = 0x4000u, kScd = 0x8000u, kReset = 0x40000000u;
constexpr std::size_t kFifoBytes = 128;

constexpr std::uint8_t kDefaultIntra[64] = {
    8,  16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40,
    22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83,
};

constexpr std::uint8_t kNonLinearScale[32] = {0,  1,  2,  3,  4,  5,  6,  7,  8,  10, 12, 14, 16, 18, 20, 22,
                                              24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 104, 112};

struct Entry {
    std::uint8_t length = 0;
    std::uint32_t value = 0;
};

struct Lookup {
    unsigned bits = 0;
    std::vector<Entry> entries;
};

struct DctEntry {
    std::uint8_t length = 0;
    std::uint8_t run = 0;
    std::int16_t level = 0;
};

struct DctLookup {
    unsigned bits = 0;
    std::vector<DctEntry> entries;
};

template <std::size_t N>
Lookup build(const Vlc (&table)[N]) {
    Lookup l;
    for (const Vlc &e : table) l.bits = std::max<unsigned>(l.bits, e.length);
    l.entries.resize(std::size_t{1} << l.bits);
    for (const Vlc &e : table) {
        const unsigned shift = l.bits - e.length;
        for (std::uint32_t i = 0; i < (1u << shift); ++i) l.entries[(static_cast<std::uint32_t>(e.code) << shift) | i] = {e.length, e.value};
    }
    return l;
}

template <std::size_t N>
DctLookup build(const Dct (&table)[N]) {
    DctLookup l;
    for (const Dct &e : table) l.bits = std::max<unsigned>(l.bits, e.length);
    l.entries.resize(std::size_t{1} << l.bits);
    for (const Dct &e : table) {
        const unsigned shift = l.bits - e.length;
        for (std::uint32_t i = 0; i < (1u << shift); ++i) l.entries[(static_cast<std::uint32_t>(e.code) << shift) | i] = {e.length, e.run, e.level};
    }
    return l;
}

struct Tables {
    Lookup mbai = build(kMbAddressIncrement), mb_i = build(kMbTypeI), mb_p = build(kMbTypeP), mb_b = build(kMbTypeB);
    Lookup motion = build(kMotionCode), dmv = build(kDmVector), dc_luma = build(kDcSizeLuma), dc_chroma = build(kDcSizeChroma);
    Lookup cbp = build(kCodedBlockPattern);
    DctLookup dct0 = build(kDctTable0), dct1 = build(kDctTable1);
    double cosines_by_frequency[8][8];

    Tables() {
        for (int x = 0; x < 8; ++x)
            for (int u = 0; u < 8; ++u)
                cosines_by_frequency[u][x] = (u ? 0.5 : 0.5 / std::sqrt(2.0)) * std::cos((2 * x + 1) * u * 3.14159265358979323846 / 16.0);
    }
};

const Tables &tables() {
    static const Tables t;
    return t;
}

enum Command { kBclr, kIdec, kBdec, kVdec, kFdec, kSetiq, kSetvq, kCsc, kPack, kSetth };

std::vector<std::uint8_t> g_in;
std::size_t g_bit = 0;
std::vector<std::uint8_t> g_out;
std::size_t g_out_pos = 0;

std::uint32_t g_ctrl = 0, g_result = 0, g_command = 0;
int g_last = -1;
bool g_busy = false, g_decoding = false, g_interrupt = true, g_starved = false;
int g_phase = 0;
std::uint32_t g_qsc = 0, g_count = 0;
bool g_first = true;
std::uint8_t g_intra_iq[64], g_nonintra_iq[64];
std::uint16_t g_vqclut[16];
std::uint16_t g_th0 = 0, g_th1 = 0;
std::int16_t g_dc[3];

// Derived work only: a partial command still exposes its original cursor/DC
// state. Completed coefficient blocks can be reused when the FIFO is refilled.
struct MacroblockCache {
    bool valid = false, intra = false, field = false, dc_reset = false;
    std::uint32_t command = 0, ctrl = 0, qsc = 0;
    std::size_t bit = 0, resume_bit = 0;
    unsigned cbp = 0, next = 0;
    std::int16_t initial_dc[3]{}, resume_dc[3]{};
    int coefficients[6][64];
};
MacroblockCache g_macroblock;

std::uint64_t g_commands[16], g_stalls = 0, g_out_qwords = 0;

bool pull() {
    std::uint8_t q[16];
    if (!dmac::ipu_pull(q)) return false;
    g_in.insert(g_in.end(), q, q + 16);
    return true;
}

bool have(std::size_t bits) {
    while (g_in.size() * 8 < g_bit + bits)
        if (!pull()) return false;
    return true;
}

std::size_t available() { return g_in.size() * 8 > g_bit ? g_in.size() * 8 - g_bit : 0; }

std::uint32_t bits_at(std::size_t bit, unsigned n) {
    return detail::read_bits(g_in.data(), g_in.size(), bit, n);
}

std::uint32_t peek(unsigned n) {
    if (!have(n)) throw NeedData{};
    return bits_at(g_bit, n);
}

std::uint32_t get(unsigned n) {
    const std::uint32_t v = peek(n);
    g_bit += n;
    return v;
}

void skip(unsigned n) {
    if (!have(n)) throw NeedData{};
    g_bit += n;
}

std::uint32_t peek_soft(unsigned n, std::size_t &avail) {
    have(n);
    avail = available();
    return bits_at(g_bit, n);
}

std::uint32_t decode(const Lookup &l) {
    std::size_t avail;
    const Entry &e = l.entries[peek_soft(l.bits, avail)];
    if (!e.length) {
        if (avail < l.bits) throw NeedData{};
        throw BadCode{};
    }
    if (e.length > avail) throw NeedData{};
    g_bit += e.length;
    return e.value;
}

std::uint32_t peek_now() {
    const unsigned n = static_cast<unsigned>(std::min<std::size_t>(32, available()));
    return n ? bits_at(g_bit, n) << (32 - n) : 0u;
}

void commit() {
    g_macroblock.valid = false;
    const std::size_t drop = std::min(g_bit / 128 * 16, g_in.size() / 16 * 16);
    g_in.erase(g_in.begin(), g_in.begin() + static_cast<std::ptrdiff_t>(drop));
    g_bit -= drop * 8;
}

void top_up() {
    while (g_in.size() < kFifoBytes && pull()) {}
}

unsigned dc_precision() { return (g_ctrl >> 16) & 3u; }
bool alternate_scan() { return g_ctrl & 0x100000u; }
bool intra_vlc_one() { return g_ctrl & 0x200000u; }
bool nonlinear_q() { return g_ctrl & 0x400000u; }
bool mpeg1() { return g_ctrl & 0x800000u; }
unsigned picture_type() { return (g_ctrl >> 24) & 7u; }

int read_dc_diff(int channel) {
    const unsigned size = decode(channel ? tables().dc_chroma : tables().dc_luma) & 0xFFFFu;
    if (!size) return 0;
    const int v = static_cast<int>(get(size));
    return v < (1 << (size - 1)) ? v + 1 - (1 << size) : v;
}

bool read_coefficient(const DctLookup &l, int &run, int &level, unsigned eob_bits) {
    std::size_t avail;
    std::uint32_t window;
    if (eob_bits) {
        if (!have(eob_bits)) throw NeedData{};
        avail = available();
        window = bits_at(g_bit, l.bits);
        if ((window >> (l.bits - eob_bits)) == (eob_bits == 4 ? 6u : 2u)) {
            g_bit += eob_bits;
            return false;
        }
        // Preserve the original refill before looking up a non-EOB code.
        if (avail < l.bits) window = peek_soft(l.bits, avail);
    } else {
        window = peek_soft(l.bits, avail);
    }
    const DctEntry &e = l.entries[window];
    if (!e.length) {
        if (avail < l.bits) throw NeedData{};
        throw BadCode{};
    }
    if (e.length > avail) throw NeedData{};
    g_bit += e.length;
    if (e.run == kEscape) {
        run = static_cast<int>(get(6));
        if (mpeg1()) {
            int v = static_cast<int>(get(8));
            if (v == 0) v = static_cast<int>(get(8));
            else if (v == 128) v = static_cast<int>(get(8)) - 256;
            else if (v > 128) v -= 256;
            level = v;
        } else {
            const int v = static_cast<int>(get(12));
            level = v & 0x800 ? v - 0x1000 : v;
        }
        return true;
    }
    run = e.run;
    // The lookup already read this sign bit for shorter codes. Keep the
    // original reader for a code at the look-ahead limit or a partial FIFO.
    if (e.length < l.bits && e.length < avail) {
        const bool negative = (window >> (l.bits - e.length - 1)) & 1u;
        ++g_bit;
        level = negative ? -e.level : e.level;
    } else {
        level = get(1) ? -e.level : e.level;
    }
    return true;
}

void idct(const int *in, std::int16_t *out) {
    detail::inverse_dct(in, out, tables().cosines_by_frequency);
}

void decode_coefficients(int *coef, int channel, bool intra) {
    std::fill(coef, coef + 64, 0);
    int index = 0;
    const DctLookup &table = intra && intra_vlc_one() ? tables().dct1 : tables().dct0;
    const bool table_one = &table == &tables().dct1;
    if (intra) {
        g_dc[channel] = static_cast<std::int16_t>(g_dc[channel] + read_dc_diff(channel));
        coef[0] = g_dc[channel];
        index = 1;
    } else if (peek(1)) {
        coef[0] = get(2) & 1u ? -1 : 1;
        index = 1;
    }
    for (;;) {
        int run = 0, level = 0;
        if (!read_coefficient(table, run, level, index ? (table_one ? 4u : 2u) : 0u)) break;
        index += run;
        if (index >= 64) throw BadCode{};
        coef[index++] = level;
    }
}

void reconstruct_block(const int *coef, std::int16_t *out, bool intra, std::uint32_t qsc) {
    const std::uint8_t *scan = alternate_scan() ? kAlternate : kZigzag;
    const std::uint8_t *weights = intra ? g_intra_iq : g_nonintra_iq;
    const int scale = mpeg1() || !nonlinear_q() ? static_cast<int>(qsc) * 2 : kNonLinearScale[qsc & 31u];
    int f[64] = {};
    int sum = 0;
    for (int k = 0; k < 64; ++k) {
        const int v = coef[k];
        const int r = scan[k];
        int x;
        if (intra && k == 0) {
            x = v * (8 >> dc_precision());
        } else {
            if (!v) continue;
            const int sign = v > 0 ? 1 : -1;
            x = intra ? (v * weights[r] * scale * 2) / 32 : ((2 * v + sign) * weights[r] * scale) / 32;
            if (mpeg1() && x && !(x & 1)) x -= sign;
        }
        x = std::clamp(x, -2048, 2047);
        f[r] = x;
        sum += x;
    }
    if (!mpeg1() && !(sum & 1)) f[63] += f[63] & 1 ? -1 : 1;
    idct(f, out);
}

void decode_macroblock(std::int16_t *raw, bool intra, bool field, bool dc_reset, std::uint32_t qsc) {
    const unsigned cbp = intra ? 0x3Fu : decode(tables().cbp) & 0xFFu;
    if (dc_reset) g_dc[0] = g_dc[1] = g_dc[2] = static_cast<std::int16_t>(128 << dc_precision());
    auto &cached = g_macroblock;
    const bool resume = cached.valid && cached.command == g_command && cached.ctrl == g_ctrl &&
        cached.bit == g_bit && cached.intra == intra && cached.field == field &&
        cached.dc_reset == dc_reset && cached.qsc == qsc && cached.cbp == cbp &&
        std::equal(g_dc, g_dc + 3, cached.initial_dc);
    if (!resume) {
        cached.valid = true;
        cached.command = g_command; cached.ctrl = g_ctrl; cached.bit = g_bit;
        cached.intra = intra; cached.field = field; cached.dc_reset = dc_reset;
        cached.qsc = qsc; cached.cbp = cbp; cached.next = 0;
        cached.resume_bit = g_bit;
        std::copy(g_dc, g_dc + 3, cached.initial_dc);
        std::copy(g_dc, g_dc + 3, cached.resume_dc);
    } else {
        g_bit = cached.resume_bit;
        std::copy(cached.resume_dc, cached.resume_dc + 3, g_dc);
    }
    for (unsigned b = cached.next; b < 6; ++b) {
        if (cbp & (32u >> b)) decode_coefficients(cached.coefficients[b], b < 4 ? 0 : b - 3, intra);
        cached.next = b + 1;
        cached.resume_bit = g_bit;
        std::copy(g_dc, g_dc + 3, cached.resume_dc);
    }
    std::int16_t blocks[6][64] = {};
    for (int b = 0; b < 6; ++b)
        if (cbp & (32u >> b)) reconstruct_block(cached.coefficients[b], blocks[b], intra, qsc);
    for (int i = 0; i < 8; ++i) {
        const int top = field ? 2 * i : i, bottom = field ? 2 * i + 1 : i + 8;
        std::memcpy(raw + top * 16, blocks[0] + i * 8, 16);
        std::memcpy(raw + top * 16 + 8, blocks[1] + i * 8, 16);
        std::memcpy(raw + bottom * 16, blocks[2] + i * 8, 16);
        std::memcpy(raw + bottom * 16 + 8, blocks[3] + i * 8, 16);
    }
    std::memcpy(raw + 256, blocks[4], 128);
    std::memcpy(raw + 320, blocks[5], 128);
    cached.valid = false;
}

void convert(const std::uint8_t *raw, bool rgb16) {
    std::uint8_t pixels[1024];
    const std::size_t size = detail::convert_pixels(raw, pixels, rgb16, g_th0, g_th1);
    g_out.insert(g_out.end(), pixels, pixels + size);
}

void emit_raw16(const std::int16_t *raw) {
    const auto *bytes = reinterpret_cast<const std::uint8_t *>(raw);
    g_out.insert(g_out.end(), bytes, bytes + 768);
}

bool start_code_follows() {
    std::size_t avail;
    const std::uint32_t next = peek_soft(8, avail);
    return avail >= 8 && next == 0;
}

template <typename F>
bool atomic(F &&body) {
    const std::size_t bit = g_bit;
    std::int16_t dc[3];
    std::memcpy(dc, g_dc, sizeof dc);
    const std::size_t out = g_out.size();
    try {
        body();
        return true;
    } catch (const NeedData &) {
        ++g_stalls;
        g_bit = bit;
        std::memcpy(g_dc, dc, sizeof dc);
        g_out.resize(out);
        return false;
    }
}

bool run_idec() {
    const bool dtd = (g_command >> 24) & 1u, rgb16 = (g_command >> 27) & 1u;
    for (;;) {
        bool ok = true;
        switch (g_phase) {
        case 0:
            ok = atomic([&] { skip(g_command & 0x3Fu); });
            if (ok) g_phase = 1;
            break;
        case 1:
            ok = atomic([&] {
                const std::uint32_t type = decode(tables().mb_i) & 0xFFFFu;
                const bool field = dtd && get(1);
                std::uint32_t qsc = g_qsc;
                if (type & 0x10u) qsc = get(5);
                std::int16_t raw[384];
                decode_macroblock(raw, true, field, g_first, qsc);
                std::uint8_t raw8[384];
                for (int i = 0; i < 384; ++i) raw8[i] = static_cast<std::uint8_t>(std::clamp<int>(raw[i], 0, 255));
                convert(raw8, rgb16);
                g_qsc = qsc;
            });
            if (ok) {
                g_first = false;
                g_phase = 2;
            }
            break;
        case 2:
            ok = atomic([&] {
                std::size_t avail;
                const std::uint32_t next = peek_soft(8, avail);
                if (avail < 8) throw NeedData{};
                if (next == 0) {
                    g_bit = (g_bit + 7) & ~std::size_t{7};
                    g_phase = 3;
                    return;
                }
                std::uint32_t v;
                do v = decode(tables().mbai) & 0xFFFFu;
                while (v == 0x22u || v == 0x23u);
                g_phase = 1;
            });
            break;
        case 3:
            ok = atomic([&] {
                for (;;) {
                    std::size_t avail;
                    const std::uint32_t code = peek_soft(24, avail);
                    if (avail < 24 || code == 1) {
                        g_phase = 4;
                        return;
                    }
                    if (code != 0) throw BadCode{};
                    g_bit += 8;
                }
            });
            break;
        default:
            g_ctrl |= kScd;
            return true;
        }
        if (!ok) return false;
        commit();
    }
}

bool run_command() {
    const std::uint32_t cmd = g_command;
    switch (cmd >> 28) {
    case kBclr:
        g_in.clear();
        g_bit = cmd & 0x7Fu;
        return true;
    case kIdec:
        return run_idec();
    case kBdec: {
        const bool ok = atomic([&] {
            skip(cmd & 0x3Fu);
            std::int16_t raw[384];
            decode_macroblock(raw, (cmd >> 27) & 1u, (cmd >> 25) & 1u, (cmd >> 26) & 1u, (cmd >> 16) & 0x1Fu);
            emit_raw16(raw);
        });
        if (!ok) return false;
        commit();
        if (start_code_follows()) {
            g_ctrl |= kScd;
            g_interrupt = false;
        }
        return true;
    }
    case kVdec: {
        const auto skipped = cmd & 0x3Fu;
        if (!have(skipped)) { ++g_stalls; return false; }
        const Lookup *table = nullptr;
        switch ((cmd >> 26) & 3u) {
        case 0: table = &tables().mbai; break;
        case 1:
            switch (picture_type()) {
            case 1: table = &tables().mb_i; break;
            case 2: table = &tables().mb_p; break;
            case 3: table = &tables().mb_b; break;
            default: g_bit += skipped; throw BadCode{};
            }
            break;
        case 2: table = &tables().motion; break;
        default: table = &tables().dmv; break;
        }
        // Commit only after a complete code is present. Short valid codes may
        // complete with less than the table's maximum look-ahead available.
        // This avoids an exception-catching lambda for every VDEC command.
        have(skipped + table->bits);
        const auto avail = available();
        if (avail < skipped) { ++g_stalls; return false; }
        const Entry &entry = table->entries[bits_at(g_bit + skipped, table->bits)];
        if (!entry.length) {
            if (avail - skipped < table->bits) { ++g_stalls; return false; }
            g_bit += skipped;
            throw BadCode{};
        }
        if (entry.length > avail - skipped) { ++g_stalls; return false; }
        g_bit += skipped + entry.length;
        g_result = entry.value;
        commit();
        return true;
    }
    case kFdec: {
        const auto skipped = cmd & 0x3Fu;
        if (!have(skipped + 32)) { ++g_stalls; return false; }
        g_bit += skipped;
        g_result = bits_at(g_bit, 32);
        commit();
        return true;
    }
    case kSetiq: {
        std::uint8_t *matrix = (cmd >> 27) & 1u ? g_nonintra_iq : g_intra_iq;
        std::uint8_t values[64];
        const bool ok = atomic([&] {
            skip(cmd & 0x3Fu);
            for (std::uint8_t &v : values) v = static_cast<std::uint8_t>(get(8));
        });
        if (!ok) return false;
        for (int k = 0; k < 64; ++k) matrix[kZigzag[k]] = values[k];
        commit();
        return true;
    }
    case kSetvq: {
        std::uint16_t values[16];
        const bool ok = atomic([&] {
            skip(cmd & 0x3Fu);
            for (std::uint16_t &v : values) v = static_cast<std::uint16_t>(get(16));
        });
        if (!ok) return false;
        std::memcpy(g_vqclut, values, sizeof values);
        commit();
        return true;
    }
    case kCsc:
        while (g_count) {
            std::uint8_t raw[384];
            const bool ok = atomic([&] {
                for (std::uint8_t &v : raw) v = static_cast<std::uint8_t>(get(8));
                convert(raw, (cmd >> 27) & 1u);
            });
            if (!ok) return false;
            commit();
            --g_count;
        }
        return true;
    case kSetth:
        g_th0 = static_cast<std::uint16_t>(cmd & 0x1FFu);
        g_th1 = static_cast<std::uint16_t>((cmd >> 16) & 0x1FFu);
        return true;
    default:
        std::fprintf(stderr, "[ipu] command 0x%08X is not implemented\n", cmd);
        return true;
    }
}

void drain() {
    while (g_out_pos + 16 <= g_out.size() && dmac::ipu_push(g_out.data() + g_out_pos)) {
        g_out_pos += 16;
        ++g_out_qwords;
    }
    if (g_out_pos == g_out.size()) {
        g_out.clear();
        g_out_pos = 0;
    }
}

void step() {
    if (g_busy && g_decoding) {
        try {
            g_starved = !run_command();
            if (!g_starved) g_decoding = false;
        } catch (const BadCode &) {
            g_macroblock.valid = false;
            std::fprintf(stderr, "[ipu] bad code in command 0x%08X\n", g_command);
            g_ctrl |= kEcd;
            g_decoding = false;
            g_busy = false;
        }
    }
    drain();
    if (g_busy && !g_decoding && g_out.empty()) {
        g_busy = false;
        if (g_interrupt) hw::intc_raise(8);
    }
    top_up();
}

}

void reset() {
    g_macroblock.valid = false;
    g_in.clear();
    g_out.clear();
    g_bit = g_out_pos = 0;
    g_ctrl = g_result = g_command = 0;
    g_last = -1;
    g_busy = g_decoding = false;
    std::memcpy(g_intra_iq, kDefaultIntra, 64);
    std::fill(std::begin(g_nonintra_iq), std::end(g_nonintra_iq), 16);
    std::memset(g_vqclut, 0, sizeof g_vqclut);
    g_th0 = g_th1 = 0;
    std::memset(g_dc, 0, sizeof g_dc);
}

std::uint32_t read32(std::uint32_t a) {
    switch (a & 0xFFFFFFFCu) {
    case 0x10002000u:
        return g_last == kVdec || g_last == kFdec ? g_result : peek_now();
    case 0x10002004u:
        return g_busy ? 0x80000000u : 0u;
    case 0x10002010u: {
        const std::uint32_t ifc = g_starved ? 0u : static_cast<std::uint32_t>(std::min<std::size_t>(8, g_in.size() / 16));
        const std::uint32_t ofc = static_cast<std::uint32_t>(std::min<std::size_t>(8, (g_out.size() - g_out_pos) / 16));
        return (g_ctrl & ~0x800000FFu) | (g_busy ? 0x80000000u : 0u) | ifc | (ofc << 4);
    }
    case 0x10002020u: {
        if (g_starved) return 0;
        const std::uint32_t bp = static_cast<std::uint32_t>(g_bit & 127u);
        std::uint32_t ifc = static_cast<std::uint32_t>(g_in.size() / 16 - std::min(g_in.size() / 16, g_bit / 128));
        std::uint32_t fp = 0;
        if (bp && ifc) {
            fp = 1;
            --ifc;
        }
        return (fp << 16) | (std::min<std::uint32_t>(ifc, 8) << 8) | bp;
    }
    case 0x10002030u:
        return g_busy ? 0u : peek_now();
    case 0x10002034u:
        return g_busy || available() < 32 ? 0x80000000u : 0u;
    default:
        return 0;
    }
}

void write32(std::uint32_t a, std::uint32_t v) {
    switch (a) {
    case 0x10002000u: {
    }
        g_macroblock.valid = false;
        g_ctrl &= ~(kEcd | kScd);
        g_starved = false;
        ++g_commands[v >> 28];
        g_command = v;
        g_last = static_cast<int>(v >> 28);
        g_busy = g_decoding = g_interrupt = true;
        g_phase = 0;
        g_qsc = (v >> 16) & 0x1Fu;
        g_first = true;
        g_count = v & 0x7FFu;
        step();
        {
            static const char *trace = std::getenv("PS2_TRACE_IPU");
            static std::uint64_t traced = 0, from = trace ? std::strtoull(trace, nullptr, 10) : 0;
            if (trace && ++traced >= from && traced < from + 200000)
                std::fprintf(stderr, "[ipu] cmd 0x%08X -> result %08X ctrl %08X bit %zu next %08X%08X\n", v, g_result, g_ctrl, g_bit,
                             bits_at(g_bit, 32), bits_at(g_bit + 32, 32));
        }
        break;
    case 0x10002010u:
        if (v & kReset) {
            g_macroblock.valid = false;
            g_starved = false;
            g_in.clear();
            g_out.clear();
            g_bit = g_out_pos = 0;
            g_busy = g_decoding = false;
            g_th0 = g_th1 = 0;
        }
        g_ctrl = (g_ctrl & ~0x3FFF0000u) | (v & 0x3FFF0000u);
        break;
    default:
        if (a >= 0x10007010u && a < 0x10007020u) {
            const std::uint8_t *bytes = reinterpret_cast<const std::uint8_t *>(&v);
            g_in.insert(g_in.end(), bytes, bytes + 4);
            step();
        }
        break;
    }
}

void write_fifo(const std::uint8_t *qword) {
    g_in.insert(g_in.end(), qword, qword + 16);
    step();
}

void read_fifo(std::uint8_t *qword) {
    if (g_out_pos + 16 <= g_out.size()) {
        std::memcpy(qword, g_out.data() + g_out_pos, 16);
        g_out_pos += 16;
    } else {
        std::memset(qword, 0, 16);
    }
    step();
}

void dma_started(int) { step(); }

void stats() {
    std::fprintf(stderr, "[ipu] commands:");
    for (int i = 0; i < 16; ++i)
        if (g_commands[i]) std::fprintf(stderr, " %X:%llu", i, static_cast<unsigned long long>(g_commands[i]));
    std::fprintf(stderr, " stalls %llu out %llu qwords, busy %d decoding %d cmd 0x%08X in %zu bytes bit %zu out %zu\n",
                 static_cast<unsigned long long>(g_stalls), static_cast<unsigned long long>(g_out_qwords), g_busy, g_decoding, g_command,
                 g_in.size(), g_bit, g_out.size() - g_out_pos);
}

}

namespace ps2::ipu {

void state(ps2::state::Stream &s) {
    // The cache can be reconstructed from the serialized FIFO and predictors.
    g_macroblock.valid = false;
    s.tag("ipu");
    s.vec(g_in);
    s.size(g_bit);
    s.vec(g_out);
    s.size(g_out_pos);
    s.pod(g_ctrl);
    s.pod(g_result);
    s.pod(g_command);
    s.pod(g_last);
    s.pod(g_busy);
    s.pod(g_decoding);
    s.pod(g_interrupt);
    s.pod(g_starved);
    s.pod(g_phase);
    s.pod(g_qsc);
    s.pod(g_count);
    s.pod(g_first);
    s.pod(g_intra_iq);
    s.pod(g_nonintra_iq);
    s.pod(g_vqclut);
    s.pod(g_th0);
    s.pod(g_th1);
    s.pod(g_dc);
}

}
