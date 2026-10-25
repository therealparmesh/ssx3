#include "ps2/generated.hpp"
#include "units.hpp"

#include <cstdio>
#include <cstring>
#include <stdexcept>

void register_generated_code();

namespace {
constexpr std::uint32_t base = 0x100000, done = 0x200000;
constexpr int budget = 1000000000;

void expect(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}

void execute(ps2::Cpu &cpu) {
    unsigned dispatches = 0;
    while (cpu.pc != done) {
        expect(!(cpu.pc & ps2::kUnwind), "Unexpected execution stop");
        expect(++dispatches <= 500000, "Guest control flow did not terminate");
        ps2::dispatch(cpu, 0, 0);
    }
}
}

int main() {
    try {
        ps2::warm_generated_code(); // Older generated code has no callbacks.
        register_generated_code();
        ps2::Cpu sentinel;
        std::memset(&sentinel, 0xA5, sizeof sentinel);
        unsigned char before[sizeof sentinel];
        std::memcpy(before, &sentinel, sizeof sentinel);
        for (const auto function : {gen::unit_0000, gen::unit_0001, gen::unit_0002, gen::unit_0003}) {
            function(sentinel, ps2::kWarmupEntry, 0);
            expect(std::memcmp(before, &sentinel, sizeof sentinel) == 0, "Code preparation mutated CPU state");
        }
        ps2::warm_generated_code(262144);
        ps2::Cpu cpu{};
        cpu.pc = base;
        cpu.budget = budget;
        cpu.r[8].w[0] = base + 0x200;
        cpu.r[17].w[0] = 100000;
        cpu.r[23].w[0] = done;
        execute(cpu);
        expect(cpu.r[16].w[0] == 100000, "Indirect jump delay slot was lost");
        expect(cpu.r[18].w[0] == 700000, "Cross-unit call or tail jump was lost");
        expect(cpu.r[19].w[0] == 100000, "Backward branch delay slot was lost");
        expect(cpu.r[20].w[0] == 100000, "Call delay slot was lost");
        expect(cpu.r[2].w[0] == 42, "Final return delay slot was lost");
        expect(cpu.budget == budget - 1000003, "Guest instruction accounting changed");

        cpu = {};
        cpu.pc = base + 0xF8;
        cpu.budget = budget;
        cpu.r[31].w[0] = done;
        execute(cpu);
        expect(cpu.r[3].w[0] == 17 && cpu.r[18].w[0] == 7, "Cross-unit fallthrough was lost");
        expect(cpu.budget == budget - 6, "Fallthrough instruction accounting changed");
        std::puts("Generated control flow: 100000 calls, jumps and delay slots passed");
    } catch (const std::exception &error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
