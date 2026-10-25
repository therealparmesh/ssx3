#include "ps2/vu_ops.hpp"
#include "ps2/warmup.hpp"

#include <array>
#include <cstdio>
#include <stdexcept>

void register_generated_vu();

namespace {
ps2::vu::ProgramFn program = nullptr;
unsigned preparations = 0;
void observe() { ++preparations; }
void expect(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
}

namespace ps2::vu {
void register_programs(const Program *programs, std::uint32_t count) {
    expect(count == 1, "Expected one generated VU fixture");
    program = programs[0].function;
}
void interpret(int, std::uint32_t) { throw std::runtime_error("Unexpected VU interpreter fallback"); }
}

int main() {
    try {
        ps2::warm_generated_code();
        register_generated_vu();
        ps2::register_code_warmup(nullptr);
        ps2::register_code_warmup(observe);
        ps2::register_code_warmup(observe);
        ps2::warm_generated_code();
        expect(preparations == 1, "Duplicate preparation callback ran twice");
        ps2::warm_generated_code(0);
        expect(preparations == 1, "Zero preparation passes invoked a callback");
        ps2::warm_generated_code(3);
        expect(preparations == 4, "Repeated preparation did not preserve callback registration");

        ps2::Vu0Regs registers;
        std::memset(&registers, 0xA5, sizeof registers);
        std::array<std::uint8_t, sizeof registers> before;
        std::memcpy(before.data(), &registers, sizeof registers);
        program(registers, nullptr);
        expect(std::memcmp(before.data(), &registers, sizeof registers) == 0,
               "VU preparation changed guest registers or flags");

        registers = {};
        registers.vi[1] = 16;
        std::array<std::uint8_t, 16384> memory{};
        program(registers, memory.data());
        std::uint32_t stored = 0;
        std::memcpy(&stored, memory.data(), sizeof stored);
        expect(registers.vi[2] == 23 && stored == 23 && registers.tpc == 16,
               "Preparation changed normal VU execution or its end-delay store");
        std::puts("Generated VU preparation and normal execution passed");
    } catch (const std::exception &error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
