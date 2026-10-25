#include "vu_jit_web.hpp"
#include "ps2/vu_ops.hpp"

#include <array>
#include <cstring>
#include <emscripten.h>
#include <thread>

namespace {
unsigned interpreted = 0;
}

namespace ps2::vu {
void interpret(int, std::uint32_t) { ++interpreted; }
void kick(int, std::uint32_t) {}
std::uint32_t top() { return 0; }
std::uint32_t itop() { return 0; }
}

// No game data: an unseen microprogram must compile, link all runtime helpers,
// execute integer arithmetic and perform its store in the end-delay slot.
extern "C" EMSCRIPTEN_KEEPALIVE int run_vu_jit_fixture() {
    std::array<std::uint8_t, 16384> code{}, memory{};
    const std::uint32_t instructions[] = {
        (0x08u << 25) | (2u << 16) | (1u << 11) | 7u, 0x400002FFu,
        (0x05u << 25) | (8u << 21) | (2u << 16), 0x000002FFu,
    };
    std::memcpy(code.data(), instructions, sizeof instructions);
    const auto program = ps2::vu::jit::compile(code.data(), 0);
    if (!program) return 1;
    ps2::Vu0Regs registers{};
    registers.vi[1] = 16;
    program(registers, memory.data());
    std::uint32_t stored = 0;
    std::memcpy(&stored, memory.data(), sizeof stored);
    if (registers.vi[2] != 23 || stored != 23 || registers.tpc != 16) return 2;
    return interpreted ? 3 : 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE int run_vu_jit_worker_fixture() {
    int result = -1;
    std::thread worker([&] { result = run_vu_jit_fixture(); });
    worker.join();
    return result;
}
