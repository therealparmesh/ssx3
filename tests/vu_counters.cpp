#include "ps2/cpu.hpp"
#include "hw.hpp"
#include "vu_micro.hpp"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <thread>

namespace ps2::vu { void run_fast(int, std::uint32_t); }

int main(int argc, char **argv) {
    const bool counted = argc > 1 && std::strcmp(argv[1], "count") == 0;
#ifdef _WIN32
    _putenv_s("PS2_VU_COUNT", counted ? "1" : "");
#else
    if (counted) setenv("PS2_VU_COUNT", "1", 1);
    else unsetenv("PS2_VU_COUNT");
#endif
    for (const int unit : {0, 1}) {
        auto &registers = ps2::vu::regs(unit);
        std::memset(&registers, 0, sizeof registers);
        registers.vf[0].w[3] = 0x3F800000;
        auto *code = unit ? ps2::g_vu1_code : ps2::g_vu0_code;
        std::memset(code, 0, unit ? 16384 : 4096);
        // 64 NOP pairs, including the E-bit instruction and its delay slot.
        for (unsigned pc = 0; pc < 512; pc += 8) {
            const std::uint32_t lower = 0x8000033C;
            const std::uint32_t upper = 0x000002FF | (pc == 496 ? 0x40000000 : 0);
            std::memcpy(code + pc, &lower, 4);
            std::memcpy(code + pc + 4, &upper, 4);
        }
        ps2::vu::code_changed(unit);
    }
    std::atomic<bool> start{false};
    const auto work = [&](int unit) {
        while (!start.load(std::memory_order_acquire)) std::this_thread::yield();
        for (unsigned i = 0; i < 10000; ++i) ps2::vu::run_fast(unit, 0);
    };
    std::thread a(work, 0), b(work, 1);
    start.store(true, std::memory_order_release);
    a.join(); b.join();
    // The final diagnostic sample is taken with no other program in flight.
    for (unsigned i = 0; i < 20000; ++i) ps2::vu::run_fast(0, 0);
    ps2::Vu0Regs expected;
    std::memset(&expected, 0, sizeof expected);
    expected.vf[0].w[3] = 0x3F800000;
    expected.tpc = 512;
    for (const int unit : {0, 1}) {
        if (std::memcmp(&ps2::vu::regs(unit), &expected, sizeof expected)) {
            std::fprintf(stderr, "Unexpected VU%d register state\n", unit);
            return 1;
        }
    }
    std::puts("PASS: concurrent VU0/VU1 interpretation preserves terminal registers");
}
