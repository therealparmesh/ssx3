#include "spu2.hpp"

#include "hw.hpp"
#include "iop.hpp"
#include "kernel.hpp"

#include "ps2/state.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <vector>

namespace ps2::iop::spu2 {

namespace {

constexpr std::uint32_t kRamWords = 1u << 20;
constexpr std::uint32_t kRamMask = kRamWords - 1;
constexpr std::uint64_t kCyclesPerSample = 768;
constexpr unsigned kBatch = 32;
constexpr unsigned kInputFrames = 512;
constexpr std::uint32_t kInputBase[2] = {0x2000u, 0x2400u};
constexpr unsigned kSpuLine = 9;
constexpr std::uint32_t kRingWords = 0x200;
static_assert(kRingWords % kBatch == 0, "a batch must not straddle the ring end");

enum Phase { kOff, kAttack, kDecay, kSustain, kRelease };

struct Envelope {
    int counter = 0;
    std::int32_t level = 0;

    void step(int rate, bool decrease, bool exponential) {
        const int shift = rate >> 2;
        int cycles = 1 << std::max(0, shift - 11);
        if (exponential && !decrease && level > 0x6000) cycles *= 4;
        if (++counter < cycles) return;
        counter = 0;
        int delta = (decrease ? -8 + (rate & 3) : 7 - (rate & 3)) << std::max(0, 11 - shift);
        if (exponential && decrease) delta = delta * level / 0x8000;
        level = std::clamp(level + delta, 0, 0x7FFF);
    }
};

struct Voice {
    std::uint16_t voll = 0, volr = 0, pitch = 0, adsr1 = 0, adsr2 = 0;
    Envelope vol[2];
    std::uint32_t ssa = 0, lsax = 0, next = 0, block[2] = {};
    bool lsax_written = false, key_on = false, end = false;
    Phase phase = kOff;
    Envelope env;
    std::int16_t buffer[56] = {};
    std::int32_t s1 = 0, s2 = 0;
    std::uint32_t position = 0;
};

struct Transfer {
    std::uint32_t madr = 0, bytes = 0;
    int channel = -1;
};

struct Core {
    Voice voices[24];
    std::uint16_t attr = 0, admas = 0;
    std::uint32_t irqa = 0x800u, tsa = 0;
    std::uint16_t mvol[2] = {0x3FFF, 0x3FFF}, bvol[2] = {0x7FFF, 0x7FFF}, avol[2] = {0x7FFF, 0x7FFF}, evol[2] = {};
    bool irq = false;
    std::int16_t input[kInputFrames][2] = {};
    unsigned input_read = 0, input_count = 0;
    std::deque<Transfer> transfers;
    std::uint16_t regs[0x200] = {};
    std::int16_t effect_coefficients[10] = {};
    std::int16_t effect_input[2][64] = {}, effect_output[2][64] = {};
    std::uint32_t effect_position = 0, effect_sample = 0;
};

std::vector<std::uint16_t> g_ram(kRamWords);
Core g_cores[2];
bool g_block_end[2][24][2];

bool *block_end(const Voice &v) {
    const int c = &v >= g_cores[1].voices ? 1 : 0;
    return g_block_end[c][&v - g_cores[c].voices];
}
std::uint16_t g_spdif_out = 0, g_spdif_mode = 0, g_spdif_media = 0;
std::vector<std::int16_t> g_audio;
bool g_record = false;
std::function<void(const std::int16_t *, std::size_t)> g_sink;
std::uint64_t g_next_tick = 0;
bool g_tick_pending = false;

void check_irq(std::uint32_t address, std::uint32_t words) {
    for (Core &k : g_cores) {
        if (!(k.attr & 0x40u) || k.irq) continue;
        if (((k.irqa - address) & kRamMask) >= words) continue;
        k.irq = true;
        static const bool trace = std::getenv("PS2_TRACE_SPU2") != nullptr;
        if (trace) std::fprintf(stderr, "[spu2] core %d irq at 0x%05X (access 0x%05X+%u) time %llu\n", static_cast<int>(&k - g_cores), k.irqa, address, words,
                                static_cast<unsigned long long>(kernel::now()));
        hw::raise_interrupt(kSpuLine);
    }
}

void decode_block(Voice &v, std::int16_t *out) {
    static const int kFilter[5][2] = {{0, 0}, {60, 0}, {115, -52}, {98, -55}, {122, -60}};
    const std::uint32_t at = v.next & kRamMask;
    const std::uint16_t header = g_ram[at];
    const int shift = header & 0xF, filter = std::min((header >> 4) & 0xF, 4);
    const unsigned flags = header >> 8;
    for (int i = 0; i < 28; ++i) {
        const std::uint16_t word = g_ram[(at + 1 + i / 4) & kRamMask];
        std::int32_t sample = static_cast<std::int16_t>(((word >> ((i & 3) * 4)) & 0xF) << 12) >> shift;
        sample += (v.s1 * kFilter[filter][0] + v.s2 * kFilter[filter][1] + 32) >> 6;
        sample = std::clamp(sample, -32768, 32767);
        v.s2 = v.s1;
        v.s1 = sample;
        out[i] = static_cast<std::int16_t>(sample);
    }
    v.block[out == v.buffer ? 0 : 1] = at;
    block_end(v)[out == v.buffer ? 0 : 1] = (flags & 1u) != 0;
    if ((flags & 4u) && !v.lsax_written) v.lsax = at;
    v.next = (at + 8) & kRamMask;
    if (flags & 1u) {
        v.next = v.lsax;
        if (!(flags & 2u)) {
            v.phase = kRelease;
            v.env.level = 0;
        }
    }
}

void key_on(Voice &v) {
    v.key_on = false;
    v.lsax_written = false;
    v.end = false;
    v.next = v.ssa;
    v.s1 = v.s2 = 0;
    v.position = 0;
    v.phase = kAttack;
    v.env = Envelope{};
    decode_block(v, v.buffer);
    decode_block(v, v.buffer + 28);
    check_irq(v.block[0], 8);
}

void update_envelope(Voice &v) {
    Envelope &e = v.env;
    switch (v.phase) {
    case kAttack:
        e.step((v.adsr1 >> 8) & 0x7F, false, v.adsr1 & 0x8000u);
        if (e.level >= 0x7FFF) v.phase = kDecay;
        break;
    case kDecay:
        e.step(((v.adsr1 >> 4) & 0xF) << 2, true, true);
        if (e.level <= ((v.adsr1 & 0xF) + 1) * 0x800) v.phase = kSustain;
        break;
    case kSustain:
        e.step((v.adsr2 >> 6) & 0x7F, v.adsr2 & 0x4000u, v.adsr2 & 0x8000u);
        break;
    case kRelease:
        e.step((v.adsr2 & 0x1F) << 2, true, v.adsr2 & 0x20u);
        if (e.level <= 0) v.phase = kOff;
        break;
    default:
        break;
    }
}

std::int32_t volume(std::uint16_t reg, Envelope &e) {
    if (!(reg & 0x8000u)) return static_cast<std::int16_t>(reg << 1);
    e.step(reg & 0x7F, reg & 0x2000u, reg & 0x4000u);
    return e.level;
}

std::int16_t clamp16(std::int32_t v) { return static_cast<std::int16_t>(std::clamp(v, -32768, 32767)); }

void render_voice(Voice &v, std::int32_t (*dry)[2], std::int32_t (*wet)[2], unsigned routes, std::int16_t *raw) {
    if (v.key_on) key_on(v);
    const std::uint32_t step = std::min<std::uint32_t>(v.pitch, 0x3FFFu);
    const bool sweep_l = v.voll & 0x8000u, sweep_r = v.volr & 0x8000u;
    const std::int32_t fixed_l = static_cast<std::int16_t>(v.voll << 1), fixed_r = static_cast<std::int16_t>(v.volr << 1);
    std::uint32_t position = v.position;
    for (unsigned n = 0; n < kBatch; ++n) {
        if (v.phase == kOff) break;
        const std::uint32_t index = position >> 12, frac = position & 0xFFFu;
        const std::int32_t sample = (v.buffer[index] * static_cast<std::int32_t>(0x1000 - frac) + v.buffer[index + 1] * static_cast<std::int32_t>(frac)) >> 12;
        position += step;
        while ((position >> 12) >= 28) {
            position -= 28u << 12;
            std::memmove(v.buffer, v.buffer + 28, 28 * sizeof(std::int16_t));
            v.end |= block_end(v)[0];
            v.block[0] = v.block[1];
            block_end(v)[0] = block_end(v)[1];
            v.position = position;
            check_irq(v.block[0], 8);
            decode_block(v, v.buffer + 28);
        }
        update_envelope(v);
        const std::int32_t out = sample * v.env.level >> 15;
        if (raw) raw[n] = clamp16(out);
        const auto left = out * (sweep_l ? volume(v.voll, v.vol[0]) : fixed_l) >> 15;
        const auto right = out * (sweep_r ? volume(v.volr, v.vol[1]) : fixed_r) >> 15;
        if (routes & 1) dry[n][0] += left;
        if (routes & 2) dry[n][1] += right;
        if (routes & 4) wet[n][0] += left;
        if (routes & 8) wet[n][1] += right;
    }
    v.position = position;
}

void feed_input(int core) {
    Core &k = g_cores[core];
    while (!k.transfers.empty() && k.input_count + 256 <= kInputFrames) {
        Transfer &t = k.transfers.front();
        const std::uint32_t chunk = std::min<std::uint32_t>(t.bytes, 1024);
        const std::uint32_t frames = std::max<std::uint32_t>(chunk / 4, 1);
        const std::uint8_t *src = ram_ptr(t.madr);
        for (std::uint32_t i = 0; i < frames; ++i) {
            std::int16_t l, r;
            std::memcpy(&l, src + i * 2, 2);
            std::memcpy(&r, src + chunk / 2 + i * 2, 2);
            const unsigned slot = (k.input_read + k.input_count + i) % kInputFrames;
            k.input[slot][0] = l;
            k.input[slot][1] = r;
            g_ram[kInputBase[core] + slot] = static_cast<std::uint16_t>(l);
            g_ram[kInputBase[core] + 0x200 + slot] = static_cast<std::uint16_t>(r);
        }
        k.input_count += frames;
        t.madr += chunk;
        t.bytes -= chunk;
        if (!t.bytes) {
            const int channel = t.channel;
            k.transfers.pop_front();
            if (channel >= 0) kernel::schedule(kernel::now() + 32, kernel::Job{kernel::kJobDmaDone, static_cast<std::uint32_t>(channel)});
        }
    }
}

void render_input(int core, std::int16_t &raw_l, std::int16_t &raw_r) {
    Core &k = g_cores[core];
    if (!k.input_count) return;
    const unsigned slot = k.input_read;
    check_irq(kInputBase[core] + slot, 1);
    raw_l = k.input[slot][0];
    raw_r = k.input[slot][1];
    k.input_read = (k.input_read + 1) % kInputFrames;
    --k.input_count;
}

std::int32_t master(std::uint16_t reg) { return reg & 0x8000u ? 0x7FFF : static_cast<std::int16_t>(reg << 1); }

std::uint32_t register_pair(const Core &k, unsigned offset) {
    return k.regs[offset / 2] | (static_cast<std::uint32_t>(k.regs[offset / 2 + 1]) << 16);
}

std::uint32_t effect_address(const Core &k, unsigned offset) {
    // Address halves are high/low; voice routing masks are low/high.
    return (static_cast<std::uint32_t>(k.regs[offset / 2]) << 16) | k.regs[offset / 2 + 1];
}

// Hardware Q15 arithmetic and filter coefficients, described in psx-spx's
// SPU reverb documentation. PS2SDK libsd defines the SPU2 register layout;
// addresses here are halfwords, unlike the PSX's eight-byte register units.
constexpr std::int16_t kEffectFilter[39] = {
    -1, 0, 2, 0, -10, 0, 35, 0, -103, 0, 266, 0, -616, 0, 1332, 0,
    -2960, 0, 10246, 16384, 10246, 0, -2960, 0, 1332, 0, -616, 0,
    266, 0, -103, 0, 35, 0, -10, 0, 2, 0, -1
};

std::int32_t effect_multiply(std::int32_t sample, std::int32_t coefficient) {
    return static_cast<std::int32_t>((static_cast<std::int64_t>(sample) * coefficient) >> 15);
}

std::int16_t effect_filter(const std::int16_t *history, unsigned at, bool upsample) {
    std::int64_t sum = 0;
    for (unsigned i = 0; i < 39; ++i)
        if (kEffectFilter[i]) sum += static_cast<std::int32_t>(history[(at - i) & 63]) * kEffectFilter[i];
    return clamp16(static_cast<std::int32_t>(sum >> (upsample ? 14 : 15)));
}

void render_effect(int core, const std::int32_t input[2], std::int16_t output[2]) {
    Core &k = g_cores[core];
    const auto start = effect_address(k, 0x2E0) & kRamMask;
    const auto end = ((static_cast<std::uint32_t>(k.regs[0x33C / 2]) << 16) | 0xFFFFu) & kRamMask;
    if (start > end) { output[0] = output[1] = 0; return; }
    const auto length = end - start + 1;
    const unsigned at = k.effect_sample & 63;
    for (unsigned ch = 0; ch < 2; ++ch) {
        k.effect_input[ch][at] = clamp16(input[ch]);
        k.effect_output[ch][at] = 0;
    }
    {
        const unsigned ch = k.effect_sample & 1;
        const auto address = [&](std::int32_t offset) {
            auto relative = (static_cast<std::int64_t>(k.effect_position) + offset) % length;
            if (relative < 0) relative += length;
            return start + static_cast<std::uint32_t>(relative);
        };
        const auto load = [&](std::int32_t offset) -> std::int32_t {
            const auto index = address(offset);
            check_irq(index, 1);
            return static_cast<std::int16_t>(g_ram[index]);
        };
        const auto store = [&](std::int32_t offset, std::int32_t value) {
            const auto index = address(offset);
            check_irq(index, 1);
            g_ram[index] = static_cast<std::uint16_t>(clamp16(value));
        };
        const auto offset = [&](unsigned index) { return static_cast<std::int32_t>(effect_address(k, 0x2E4 + index * 4) & kRamMask); };
        const auto *coef = k.effect_coefficients;
        const bool writes = (k.attr & 0x80) != 0;
        if (writes) {
            // Read reflection inputs before writing either destination.
            std::int32_t reflected[4];
            {
                const auto in = effect_multiply(effect_filter(k.effect_input[ch], at, false), coef[8 + ch]);
                for (unsigned cross = 0; cross < 2; ++cross) {
                    const auto target = offset((cross ? 10 : 2) + ch);
                    const auto previous = load(target - 1);
                    const auto source = offset(cross ? 16 + (ch ^ 1) : 8 + ch);
                    const auto delta = in + effect_multiply(load(source), coef[5]) - previous;
                    // The -0x8000 IIR coefficient has the documented sign quirk.
                    const auto value = previous + effect_multiply(delta, coef[0]);
                    reflected[cross * 2 + ch] = coef[0] == -32768 ? -value : value;
                }
            }
            for (unsigned cross = 0; cross < 2; ++cross)
                store(offset((cross ? 10 : 2) + ch), reflected[cross * 2 + ch]);
        }
        {
            std::int64_t accumulated = 0;
            for (unsigned tap = 0; tap < 4; ++tap)
                accumulated += static_cast<std::int64_t>(load(offset((tap < 2 ? 4 : 8) + tap * 2 + ch))) * coef[1 + tap];
            auto value = clamp16(static_cast<std::int32_t>(accumulated >> 15));
            for (unsigned stage = 0; stage < 2; ++stage) {
                const auto target = offset(18 + stage * 2 + ch);
                const auto delayed = load(target - offset(stage));
                const auto next = clamp16(value - effect_multiply(delayed, coef[6 + stage]));
                if (writes) store(target, next);
                value = clamp16(effect_multiply(next, coef[6 + stage]) + delayed);
            }
            k.effect_output[ch][at] = value;
        }
        // Alternate L/R at 48 kHz, advancing each delay line at 24 kHz.
        if (ch) k.effect_position = (k.effect_position + 1) % length;
    }
    for (unsigned ch = 0; ch < 2; ++ch) output[ch] = effect_filter(k.effect_output[ch], at, true);
    ++k.effect_sample;
}

// Each core streams every sample into fixed rings in SPU RAM, per core c at c*0x800: input L/R (core 1's input is core 0's
// output), voice 1, voice 3; at 0x1000+c*0x800: dry L/R, wet L/R. Those writes trip IRQA, and some games (Burnout 3:
// IRQA 0x400) use that as their audio clock. One range check per ring per batch keeps it cheap.
void write_rings(int core, const std::int16_t (*rings)[kBatch]) {
    const auto pos = static_cast<std::uint32_t>(g_next_tick / (kBatch * kCyclesPerSample) % (kRingWords / kBatch) * kBatch);
    for (std::uint32_t r = 0; r < 8; ++r) {
        const std::uint32_t at = (r < 4 ? 0u : 0x1000u) + core * 0x800u + (r & 3u) * kRingWords + pos;
        for (unsigned n = 0; n < kBatch; ++n) g_ram[at + n] = static_cast<std::uint16_t>(rings[r][n]);
        check_irq(at, kBatch);
    }
}

void tick() {
    std::int16_t out[kBatch * 2];
    std::int32_t dry[2][kBatch][2] = {}, wet[2][kBatch][2] = {};
    std::int16_t inputs[2][kBatch][2] = {};
    std::int16_t rings[2][8][kBatch] = {};
    static const bool count = std::getenv("PS2_SPU2_COUNT") != nullptr;
    static std::uint64_t ticks = 0, active = 0, phases[5] = {};
    for (int c = 0; c < 2; ++c) {
        for (int i = 0; i < 24; ++i) {
            Voice &v = g_cores[c].voices[i];
            if (!v.key_on && v.phase == kOff) continue;
            if (count) {
                ++active;
                ++phases[v.phase];
            }
            unsigned routes = 0;
            for (unsigned route = 0; route < 4; ++route) {
                constexpr unsigned offsets[] = {0x188, 0x190, 0x18C, 0x194};
                if (register_pair(g_cores[c], offsets[route]) & (1u << i)) routes |= 1u << route;
            }
            render_voice(v, dry[c], wet[c], routes, i == 1 ? rings[c][2] : i == 3 ? rings[c][3] : nullptr);
        }
        for (unsigned n = 0; n < kBatch; ++n) {
            rings[c][4][n] = clamp16(dry[c][n][0]);
            rings[c][5][n] = clamp16(dry[c][n][1]);
            rings[c][6][n] = clamp16(wet[c][n][0]);
            rings[c][7][n] = clamp16(wet[c][n][1]);
        }
        for (unsigned n = 0; n < kBatch; ++n) {
            render_input(c, inputs[c][n][0], inputs[c][n][1]);
            if (!c) {
                rings[0][0][n] = inputs[0][n][0];
                rings[0][1][n] = inputs[0][n][1];
            }
        }
    }
    for (unsigned n = 0; n < kBatch; ++n) {
        std::int32_t previous[2] = {};
        for (int c = 0; c < 2; ++c) {
            Core &k = g_cores[c];
            const auto gates = k.regs[0x198 / 2] & (c ? 0xFFFu : 0xFF0u);
            std::int32_t direct[2] = {}, effect[2] = {};
            for (unsigned ch = 0; ch < 2; ++ch) {
                const auto input = effect_multiply(inputs[c][n][ch], static_cast<std::int16_t>(k.bvol[ch]));
                const auto external = effect_multiply(previous[ch], static_cast<std::int16_t>(k.avol[ch]));
                if (gates & (0x800u >> ch)) direct[ch] += dry[c][n][ch];
                if (gates & (0x200u >> ch)) effect[ch] += wet[c][n][ch];
                if (gates & (0x80u >> ch)) direct[ch] += input;
                if (gates & (0x20u >> ch)) effect[ch] += input;
                if (gates & (0x8u >> ch)) direct[ch] += external;
                if (gates & (0x2u >> ch)) effect[ch] += external;
            }
            std::int16_t reverberated[2];
            render_effect(c, effect, reverberated);
            for (unsigned ch = 0; ch < 2; ++ch) {
                const auto mixed = direct[ch] + effect_multiply(reverberated[ch], static_cast<std::int16_t>(k.evol[ch]));
                previous[ch] = clamp16(effect_multiply(clamp16(mixed), master(k.mvol[ch])));
                if (!c) rings[1][ch][n] = static_cast<std::int16_t>(previous[ch]);
            }
        }
        out[n * 2] = static_cast<std::int16_t>(previous[0]);
        out[n * 2 + 1] = static_cast<std::int16_t>(previous[1]);
    }
    write_rings(0, rings[0]);
    write_rings(1, rings[1]);
    if (count && ++ticks % 15000 == 0)
        std::fprintf(stderr, "[spu2] %.1f voices per batch (attack %.1f decay %.1f sustain %.1f release %.1f)\n", static_cast<double>(active) / ticks,
                     static_cast<double>(phases[1]) / ticks, static_cast<double>(phases[2]) / ticks, static_cast<double>(phases[3]) / ticks, static_cast<double>(phases[4]) / ticks);
    if (g_record) g_audio.insert(g_audio.end(), out, out + kBatch * 2);
    if (g_sink) g_sink(out, kBatch);
    feed_input(0);
    feed_input(1);
    g_next_tick += kBatch * kCyclesPerSample;
    kernel::schedule(g_next_tick, kernel::Job{kernel::kJobSpuTick});
}

void keep_ticking() {
    if (g_tick_pending) return;
    g_tick_pending = true;
    g_next_tick = kernel::now() + kBatch * kCyclesPerSample;
    kernel::schedule(g_next_tick, kernel::Job{kernel::kJobSpuTick});
}

std::uint32_t set_hi(std::uint32_t address, std::uint32_t v) { return ((v & 0xFu) << 16) | (address & 0xFFFFu); }
std::uint32_t set_lo(std::uint32_t address, std::uint32_t v) { return (address & 0xF0000u) | (v & 0xFFFFu); }

std::uint32_t read_voice(Core &k, std::uint32_t off) {
    if (off < 0x180u) {
        const Voice &v = k.voices[off >> 4];
        switch (off & 0xFu) {
        case 0x0: return v.voll;
        case 0x2: return v.volr;
        case 0x4: return v.pitch;
        case 0x6: return v.adsr1;
        case 0x8: return v.adsr2;
        case 0xA: return static_cast<std::uint32_t>(v.env.level);
        case 0xC: return static_cast<std::uint32_t>(v.vol[0].level);
        default: return static_cast<std::uint32_t>(v.vol[1].level);
        }
    }
    const Voice &v = k.voices[(off - 0x1C0u) / 12];
    const std::uint32_t nax = (v.block[0] + 1 + (v.position >> 14)) & kRamMask;
    switch ((off - 0x1C0u) % 12) {
    case 0: return v.ssa >> 16;
    case 2: return v.ssa & 0xFFFFu;
    case 4: return v.lsax >> 16;
    case 6: return v.lsax & 0xFFFFu;
    case 8: return nax >> 16;
    default: return nax & 0xFFFFu;
    }
}

void write_voice(Core &k, std::uint32_t off, std::uint32_t value) {
    if (off < 0x180u) {
        Voice &v = k.voices[off >> 4];
        switch (off & 0xFu) {
        case 0x0:
            v.voll = static_cast<std::uint16_t>(value);
            if (!(value & 0x8000u)) v.vol[0].level = static_cast<std::int16_t>(value << 1);
            break;
        case 0x2:
            v.volr = static_cast<std::uint16_t>(value);
            if (!(value & 0x8000u)) v.vol[1].level = static_cast<std::int16_t>(value << 1);
            break;
        case 0x4: v.pitch = static_cast<std::uint16_t>(value); break;
        case 0x6: v.adsr1 = static_cast<std::uint16_t>(value); break;
        case 0x8: v.adsr2 = static_cast<std::uint16_t>(value); break;
        case 0xA: v.env.level = static_cast<std::int16_t>(value); break;
        default: break;
        }
        return;
    }
    Voice &v = k.voices[(off - 0x1C0u) / 12];
    switch ((off - 0x1C0u) % 12) {
    case 0: v.ssa = set_hi(v.ssa, value); break;
    case 2: v.ssa = set_lo(v.ssa, value); break;
    case 4: v.lsax = set_hi(v.lsax, value); v.lsax_written = true; break;
    case 6: v.lsax = set_lo(v.lsax, value); v.lsax_written = true; break;
    case 8: v.next = set_hi(v.next, value); break;
    default: v.next = set_lo(v.next, value); break;
    }
}

void key(Core &k, std::uint32_t mask, bool on) {
    for (int i = 0; i < 24; ++i) {
        if (!(mask & (1u << i))) continue;
        Voice &v = k.voices[i];
        if (on) v.key_on = true;
        else if (v.key_on) v.key_on = false;
        else if (v.phase != kOff) v.phase = kRelease;
    }
}

std::uint32_t read_core(int core, std::uint32_t off) {
    Core &k = g_cores[core];
    if (off < 0x180u || (off >= 0x1C0u && off < 0x2E0u)) return read_voice(k, off);
    switch (off) {
    case 0x19A: return k.attr;
    case 0x19C: return k.irqa >> 16;
    case 0x19E: return k.irqa & 0xFFFFu;
    case 0x1A8: return k.tsa >> 16;
    case 0x1AA: return k.tsa & 0xFFFFu;
    case 0x1B0: return k.admas;
    case 0x340:
    case 0x342: {
        std::uint32_t endx = 0;
        for (int i = 0; i < 24; ++i)
            if (k.voices[i].end) endx |= 1u << i;
        return off == 0x340 ? endx & 0xFFFFu : endx >> 16;
    }
    case 0x344: return 0x80u;
    default: return k.regs[off >> 1];
    }
}

void write_core(int core, std::uint32_t off, std::uint32_t value) {
    Core &k = g_cores[core];
    static const bool trace = std::getenv("PS2_TRACE_SPU2") != nullptr;
    if (trace && off >= 0x180u && !(off >= 0x1C0u && off < 0x2E0u) && off != 0x1AC)
        std::fprintf(stderr, "[spu2] core %d reg 0x%03X = 0x%04X\n", core, off, value);
    if (off < 0x180u || (off >= 0x1C0u && off < 0x2E0u)) {
        write_voice(k, off, value);
        return;
    }
    k.regs[off >> 1] = static_cast<std::uint16_t>(value);
    switch (off) {
    case 0x2E0:
    case 0x2E2:
        k.effect_position = 0;
        break;
    case 0x19A:
        k.attr = static_cast<std::uint16_t>(value);
        if (!(value & 0x40u)) k.irq = false;
        break;
    case 0x19C: k.irqa = set_hi(k.irqa, value); break;
    case 0x19E: k.irqa = set_lo(k.irqa, value); break;
    case 0x1A0: key(k, value, true); break;
    case 0x1A2: key(k, value << 16, true); break;
    case 0x1A4: key(k, value, false); break;
    case 0x1A6: key(k, value << 16, false); break;
    case 0x1A8: k.tsa = set_hi(k.tsa, value); break;
    case 0x1AA: k.tsa = set_lo(k.tsa, value); break;
    case 0x1AC:
        check_irq(k.tsa, 1);
        g_ram[k.tsa] = static_cast<std::uint16_t>(value);
        k.tsa = (k.tsa + 1) & kRamMask;
        break;
    case 0x1B0:
        k.admas = static_cast<std::uint16_t>(value);
        if (!value) k.input_count = k.input_read = 0;
        break;
    case 0x340:
        for (int i = 0; i < 16; ++i) k.voices[i].end = false;
        break;
    case 0x342:
        for (int i = 16; i < 24; ++i) k.voices[i].end = false;
        break;
    default: break;
    }
}

std::uint16_t *master_reg(int core, std::uint32_t off) {
    Core &k = g_cores[core];
    switch (off) {
    case 0x0: return &k.mvol[0];
    case 0x2: return &k.mvol[1];
    case 0x4: return &k.evol[0];
    case 0x6: return &k.evol[1];
    case 0x8: return &k.avol[0];
    case 0xA: return &k.avol[1];
    case 0xC: return &k.bvol[0];
    case 0xE: return &k.bvol[1];
    default:
        if (off >= 0x14 && off < 0x28)
            return reinterpret_cast<std::uint16_t *>(&k.effect_coefficients[(off - 0x14) / 2]);
        return nullptr;
    }
}

std::uint32_t read_global(std::uint32_t off) {
    switch (off) {
    case 0x7C0: return g_spdif_out;
    case 0x7C2: return (g_cores[0].irq ? 4u : 0u) | (g_cores[1].irq ? 8u : 0u);
    case 0x7C6: return g_spdif_mode;
    case 0x7C8: return g_spdif_media;
    default: return 0;
    }
}

void write_global(std::uint32_t off, std::uint32_t value) {
    switch (off) {
    case 0x7C0: g_spdif_out = static_cast<std::uint16_t>(value); break;
    case 0x7C6: g_spdif_mode = static_cast<std::uint16_t>(value); break;
    case 0x7C8: g_spdif_media = static_cast<std::uint16_t>(value); break;
    default: break;
    }
}

}

void reset() {
    kernel::register_job(kernel::kJobSpuTick, [](const kernel::Job &) { tick(); });
    std::fill(g_ram.begin(), g_ram.end(), 0);
    for (unsigned c = 0; c < 2; ++c) {
        Core &k = g_cores[c];
        k = Core{};
        // Execution begins after BIOS initialization, not at hardware reset.
        k.regs[0x198 / 2] = c ? 0xF3C : 0xF30;
        for (unsigned off : {0x188u, 0x18Cu, 0x190u, 0x194u}) {
            k.regs[off / 2] = 0xFFFF;
            k.regs[off / 2 + 1] = 0xFF;
        }
        k.regs[0x2E0 / 2] = c ? 0xF : 0xE;
        k.regs[0x2E2 / 2] = 0xFFF8;
        k.regs[0x33C / 2] = c ? 0xF : 0xE;
    }
    std::memset(g_block_end, 0, sizeof g_block_end);
    g_spdif_out = g_spdif_mode = g_spdif_media = 0;
    g_audio.clear();
    g_record = std::getenv("PS2_DUMP_AUDIO") != nullptr;
    g_next_tick = 0;
    g_tick_pending = false;
}

std::uint16_t *ram() { return g_ram.data(); }

void start_clock() { keep_ticking(); }

std::uint32_t read(std::uint32_t a, unsigned size) {
    keep_ticking();
    const std::uint32_t off = a & 0x7FEu;
    std::uint32_t value = 0;
    if (off < 0x760u) value = read_core((off & 0x400u) ? 1 : 0, off & 0x3FEu);
    else if (off < 0x7B0u) {
        if (const std::uint16_t *reg = master_reg((off - 0x760u) / 0x28, (off - 0x760u) % 0x28)) value = *reg;
    } else value = read_global(off);
    if (size == 4) value |= read(a + 2, 2) << 16;
    return value;
}

void write(std::uint32_t a, std::uint32_t v, unsigned size) {
    keep_ticking();
    if (size == 4) {
        write(a, v & 0xFFFFu, 2);
        write(a + 2, v >> 16, 2);
        return;
    }
    const std::uint32_t off = a & 0x7FEu;
    v &= 0xFFFFu;
    if (off < 0x760u) write_core((off & 0x400u) ? 1 : 0, off & 0x3FEu, v);
    else if (off < 0x7B0u) {
        if (std::uint16_t *reg = master_reg((off - 0x760u) / 0x28, (off - 0x760u) % 0x28)) *reg = static_cast<std::uint16_t>(v);
    } else write_global(off, v);
}

void dma(int core, std::uint32_t madr, std::uint32_t words, bool to_spu, int channel) {
    keep_ticking();
    Core &k = g_cores[core];
    if (to_spu && (k.admas & (1u << core))) {
        k.transfers.push_back(Transfer{madr, words * 4, channel});
        feed_input(core);
        return;
    }
    const std::uint32_t halfwords = words * 2;
    if (to_spu) check_irq(k.tsa, halfwords);
    for (std::uint32_t i = 0; i < halfwords; ++i) {
        std::uint16_t *spu = &g_ram[(k.tsa + i) & kRamMask];
        std::uint8_t *iop = ram_ptr(madr + i * 2);
        if (to_spu) std::memcpy(spu, iop, 2);
        else std::memcpy(iop, spu, 2);
    }
    k.tsa = (k.tsa + halfwords) & kRamMask;
    if (channel >= 0) kernel::schedule(kernel::now() + 64 + words / 4, kernel::Job{kernel::kJobDmaDone, static_cast<std::uint32_t>(channel)});
}

void set_sink(std::function<void(const std::int16_t *, std::size_t)> sink) { g_sink = std::move(sink); }

void dump_voices() {
    for (int c = 0; c < 2; ++c)
        for (int i = 0; i < 24; ++i) {
            const Voice &v = g_cores[c].voices[i];
            if (v.phase == kOff && !v.end) continue;
            const std::uint16_t header = g_ram[v.block[0] & kRamMask];
            std::fprintf(stderr, "[spu2] core %d voice %d phase %d ssa 0x%05X lsax 0x%05X block 0x%05X flags %X next 0x%05X pitch 0x%04X env %d end %d\n", c, i,
                         static_cast<int>(v.phase), v.ssa, v.lsax, v.block[0], header >> 8, v.next, v.pitch, v.env.level, v.end ? 1 : 0);
        }
}

void dump_audio(const char *path) {
    std::FILE *f = std::fopen(path, "wb");
    if (!f) return;
    const std::uint32_t bytes = static_cast<std::uint32_t>(g_audio.size() * 2);
    const std::uint32_t header[] = {0x46464952u, 36 + bytes, 0x45564157u, 0x20746D66u, 16,         0x00020001u,
                                    48000,       48000 * 4,  0x00100004u, 0x61746164u, bytes};
    std::fwrite(header, 4, sizeof header / 4, f);
    std::fwrite(g_audio.data(), 2, g_audio.size(), f);
    std::fclose(f);
}

}

namespace ps2::iop::spu2 {

void state(ps2::state::Stream &s) {
    s.tag("spu2");
    s.vec(g_ram);
    for (Core &k : g_cores) {
        s.pod(k.voices);
        if (s.loading())
            for (const Voice &v : k.voices)
                for (int i = 0; i < 2; ++i) block_end(v)[i] = (g_ram[v.block[i] & kRamMask] >> 8) & 1u;
        s.pod(k.attr);
        s.pod(k.admas);
        s.pod(k.irqa);
        s.pod(k.tsa);
        s.pod(k.mvol);
        s.pod(k.bvol);
        s.pod(k.avol);
        s.pod(k.evol);
        s.pod(k.irq);
        s.pod(k.input);
        s.pod(k.input_read);
        s.pod(k.input_count);
        s.deque(k.transfers, [&s](Transfer &t) {
            s.pod(t.madr);
            s.pod(t.bytes);
            s.pod(t.channel);
        });
        s.pod(k.regs);
        if (s.version() >= 6) {
            s.pod(k.effect_coefficients);
            s.pod(k.effect_input);
            s.pod(k.effect_output);
            s.pod(k.effect_position);
            s.pod(k.effect_sample);
        } else if (s.loading()) {
            std::fill(std::begin(k.effect_coefficients), std::end(k.effect_coefficients), 0);
            std::memset(k.effect_input, 0, sizeof k.effect_input);
            std::memset(k.effect_output, 0, sizeof k.effect_output);
            k.effect_position = k.effect_sample = 0;
        }
    }
    s.pod(g_spdif_out);
    s.pod(g_spdif_mode);
    s.pod(g_spdif_media);
    s.pod(g_next_tick);
    s.pod(g_tick_pending);
}

}
