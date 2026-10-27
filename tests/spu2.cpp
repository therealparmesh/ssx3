#include "iop/iop.hpp"
#include "iop/kernel.hpp"
#include "iop/spu2.hpp"
#include "ps2/state.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace {
std::vector<std::int16_t> output;
void expect(bool ok, const char *why) { if (!ok) throw std::runtime_error(why); }
void reg(unsigned core, unsigned offset, unsigned value) { ps2::iop::spu2::write(0x1F900000 + core * 0x400 + offset, value, 2); }
void master(unsigned core, unsigned offset, unsigned value) { ps2::iop::spu2::write(0x1F900760 + core * 0x28 + offset, value, 2); }
void run(unsigned frames) { ps2::iop::run(static_cast<std::uint64_t>(frames) * 6144); }
void reset() {
    ps2::iop::reset();
    ps2::iop::spu2::set_sink([](const std::int16_t *samples, std::size_t frames) { output.insert(output.end(), samples, samples + frames * 2); });
    output.clear();
    for (unsigned core = 0; core < 2; ++core) {
        master(core, 0, 0x3FFF); master(core, 2, 0x3FFF);
        master(core, 8, 0x7FFF); master(core, 10, 0x7FFF);
        master(core, 12, 0x7FFF); master(core, 14, 0x7FFF);
    }
}
void stream(unsigned core, std::int16_t left, std::int16_t right, bool impulse = false) {
    std::array<std::int16_t, 512> samples{};
    for (unsigned i = 0; i < 256; ++i) {
        samples[i] = (!impulse || i == 0) ? left : 0;
        samples[i + 256] = (!impulse || i == 0) ? right : 0;
    }
    std::memcpy(ps2::iop::ram_ptr(0x10000), samples.data(), sizeof samples);
    reg(core, 0x1B0, 1u << core);
    ps2::iop::spu2::dma(core, 0x10000, sizeof samples / 4, true, -1);
}
void routing() {
    reset(); reg(1, 0x198, 0xC0); stream(1, 12000, -6000); run(128);
    expect(output.size() >= 64, "Audio scheduler produced no samples");
    expect(output[0] == 11998 && output[1] == -6000, "Stereo input/master volume or core routing is wrong");
    output.clear(); reg(1, 0x198, 0); run(64);
    expect(std::all_of(output.begin(), output.end(), [](auto x) { return x == 0; }), "MMIX did not mute direct input");
    reset(); reg(0, 0x198, 0xC0); reg(1, 0x198, 0xC); stream(0, 12000, -6000); run(128);
    expect(output[0] > 11000 && output[1] < -5500, "Core 0 output did not cascade through core 1 external volume");
    reset(); reg(0, 0x198, 0xC0); reg(1, 0x198, 0); stream(0, 12000, -6000); run(128);
    expect(std::all_of(output.begin(), output.end(), [](auto x) { return x == 0; }), "Core 0 bypassed core 1 external routing");
}
void room() {
    // PS2SDK libsd's ROOM hardware preset (32 16-bit effect parameters).
    constexpr std::uint16_t params[] = {
        0x007D,0x005B,0x6D80,0x54B8,0xBED0,0x0000,0x0000,0xBA80,
        0x5800,0x5300,0x04D6,0x0333,0x03F0,0x0227,0x0374,0x01EF,
        0x0336,0x01B7,0x0335,0x01B6,0x0334,0x01B5,0x0334,0x01B5,
        0x0334,0x01B5,0x01B4,0x0136,0x00B8,0x005C,0x8000,0x8000
    };
    // ROOM uses 0x26C0 bytes. Its offsets rely on wrapping at that size.
    reg(1, 0x2E0, 0xF); reg(1, 0x2E2, 0xECA0); reg(1, 0x33C, 0xF);
    for (unsigned i = 0; i < 22; ++i) {
        const auto words = static_cast<unsigned>(params[i < 2 ? i : i + 8]) * 4;
        reg(1, 0x2E4 + i * 4, words >> 16); reg(1, 0x2E6 + i * 4, words & 0xFFFF);
    }
    for (unsigned i = 0; i < 10; ++i) master(1, 0x14 + i * 2, params[i < 8 ? i + 2 : i + 22]);
    master(1, 4, 0x6000); master(1, 6, 0x6000);
    reg(1, 0x198, 0x30); reg(1, 0x19A, 0x80);
}
void reverb() {
    reset(); room();
    expect(ps2::iop::spu2::read(0x1F90079C, 2) == 0x6D80, "Effect coefficients were discarded or mapped to the wrong core");
    std::fill(ps2::iop::spu2::ram() + 0xFEBA0, ps2::iop::spu2::ram() + 0xFECA0, 0x5AA5);
    stream(1, 16000, 8000, true); run(48000);
    bool tail_left = false, tail_right = false;
    for (unsigned i = 2000; i + 1 < output.size(); i += 2) {
        tail_left |= output[i] != 0; tail_right |= output[i + 1] != 0;
    }
    if (!tail_left || !tail_right) {
        unsigned left = 0, right = 0;
        int peak = 0;
        for (unsigned i = 0; i + 1 < output.size(); i += 2) {
            left += output[i] != 0; right += output[i + 1] != 0;
            peak = std::max({peak, std::abs(static_cast<int>(output[i])), std::abs(static_cast<int>(output[i + 1]))});
        }
        std::fprintf(stderr, "Wet impulse: %zu frames, %u/%u nonzero L/R, peak %d\n", output.size() / 2, left, right, peak);
        unsigned nonzero = 0;
        for (unsigned i = 0xFECA0; i < 0x100000; ++i) nonzero += ps2::iop::spu2::ram()[i] != 0;
        std::fprintf(stderr, "Effect memory: %u nonzero halfwords, ESA %X:%X, EEA %X\n", nonzero,
            ps2::iop::spu2::read(0x1F9006E0, 2), ps2::iop::spu2::read(0x1F9006E2, 2), ps2::iop::spu2::read(0x1F90073C, 2));
    }
    expect(tail_left && tail_right, "Wet-only impulse produced no stereo reflection tail");
    expect(std::all_of(ps2::iop::spu2::ram() + 0xFEBA0, ps2::iop::spu2::ram() + 0xFECA0,
                       [](auto x) { return x == 0x5AA5; }), "Reverb wrote before ESA");
    const std::vector<std::uint16_t> before(ps2::iop::spu2::ram() + 0xFECA0, ps2::iop::spu2::ram() + 0x100000);
    reg(1, 0x19A, 0); output.clear(); run(256);
    expect(std::equal(before.begin(), before.end(), ps2::iop::spu2::ram() + 0xFECA0), "Disabled effects still wrote into delay memory");
    master(1, 4, 0); master(1, 6, 0); output.clear(); run(256);
    expect(std::all_of(output.begin(), output.end(), [](auto x) { return x == 0; }), "Zero effect volumes did not mute the wet-only output");
}
void state_roundtrip() {
    reset(); room(); stream(1, 16000, 0, true); run(1800);
    ps2::state::Writer saved; saved.set_version(6); ps2::iop::state(saved);
    output.clear(); run(512); const auto expected = output;
    expect(std::any_of(expected.begin(), expected.end(), [](auto x) { return x != 0; }), "State comparison missed the reverb tail");
    ps2::state::Reader restored(saved.out.data(), saved.out.size()); restored.set_version(6); ps2::iop::state(restored);
    output.clear(); run(512);
    expect(output == expected, "State restore lost effect position, filter history, coefficients or delay memory");
    // Old fixtures have no coefficients/history. They must load safely and not
    // inherit the coefficients from a previously running machine.
    ps2::state::Writer legacy; legacy.set_version(5); ps2::iop::state(legacy);
    ps2::state::Reader old(legacy.out.data(), legacy.out.size()); old.set_version(5); ps2::iop::state(old);
    expect(ps2::iop::spu2::read(0x1F90079C, 2) == 0, "Legacy state inherited unrelated effect coefficients");
}
void interrupt_clock() {
    reset(); reg(1, 0x198, 0xC0); stream(1, 12000, -6000);
    // Keep a real IOP thread in a critical section. A deferred guest alarm
    // deliberately precedes the next hardware tick in the event queue.
    constexpr std::uint32_t loop[] = {0x1000FFFFu, 0};
    std::memcpy(ps2::iop::ram_ptr(0x18000), loop, sizeof loop);
    const int id = ps2::iop::kernel::create_thread(0x18000, 0x2000, 32, 0, 0, 0);
    ps2::iop::kernel::start_thread(id, 0); run(1);
    expect(ps2::iop::kernel::current() && ps2::iop::kernel::current()->id == id, "Critical-section test thread did not run");
    static unsigned alarms = 0; alarms = 0;
    ps2::iop::kernel::register_job(ps2::iop::kernel::kJobAlarm, [](const auto &) { ++alarms; });
    ps2::iop::kernel::schedule(ps2::iop::kernel::now() + 1, ps2::iop::kernel::Job{ps2::iop::kernel::kJobAlarm});
    ps2::iop::kernel::interrupt_state(true);
    ps2::state::Writer saved; saved.set_version(6); ps2::iop::state(saved);
    output.clear(); run(96);
    expect(output.size() == 96 * 2, "SPU2 clock stopped while guest interrupts were suspended");
    expect(!alarms && ps2::iop::kernel::interrupts_suspended(), "Audio ticking preempted the guest critical section");
    const auto expected = output;
    ps2::state::Reader restored(saved.out.data(), saved.out.size()); restored.set_version(6); ps2::iop::state(restored);
    output.clear(); run(96);
    expect(output == expected && !alarms, "State restore lost hardware clock or deferred guest event continuity");
    ps2::iop::kernel::interrupt_state(false); run(1);
    expect(alarms == 1, "Deferred guest event did not run once after interrupts resumed");
    expect(output.size() == expected.size(), "Resuming interrupts replayed hardware audio ticks");
    run(64); expect(alarms == 1, "Deferred guest event was replayed twice");
    expect(output.size() == (96 + 64) * 2, "Audio clock lost its cadence after interrupts resumed");
    ps2::state::Reader unmasked(saved.out.data(), saved.out.size()); unmasked.set_version(6); ps2::iop::state(unmasked);
    ps2::iop::kernel::interrupt_state(false); alarms = 0; output.clear(); run(96);
    expect(output == expected && alarms == 1, "Interrupt masking changed hardware PCM samples");
}
void deadline_clock() {
    reset(); output.clear(); run(32);
    expect(output.size() == 32 * 2, "A due SPU2 tick remained pending at the elapsed-time boundary");
    ps2::iop::run(0);
    expect(output.size() == 32 * 2, "A zero-cycle synchronization duplicated an audio tick");
    run(32);
    expect(output.size() == 64 * 2, "Consecutive exact-deadline advances lost audio cadence");
}
void event_order() {
    static std::vector<int> order;
    for (const bool alarm_first : {false, true}) {
        ps2::iop::reset(); order.clear();
        ps2::iop::spu2::set_sink([](const auto *, auto) { order.push_back(1); });
        ps2::iop::kernel::register_job(ps2::iop::kernel::kJobAlarm, [](const auto &) { order.push_back(2); });
        const auto alarm = [] { ps2::iop::kernel::schedule(32 * 768, ps2::iop::kernel::Job{ps2::iop::kernel::kJobAlarm}); };
        if (alarm_first) alarm();
        ps2::iop::spu2::read(0x1F900760, 2); // Schedule the first 32-frame tick.
        if (!alarm_first) alarm();
        run(32);
        expect(order == (alarm_first ? std::vector<int>{2, 1} : std::vector<int>{1, 2}),
               "Splitting hardware events changed equal-time guest event order");
    }
}
}
int main() {
    try {
        routing(); reverb(); state_roundtrip(); deadline_clock(); interrupt_clock(); event_order(); ps2::iop::spu2::set_sink({});
        std::puts("PASS: SPU2 stereo routing, effects, mute, interrupt-independent clock, deferred callbacks, event order and state continuity");
    } catch (const std::exception &error) { std::fprintf(stderr, "FAIL: %s\n", error.what()); return 1; }
}
