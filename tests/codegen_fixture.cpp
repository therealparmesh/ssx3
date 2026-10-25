#include "analysis.hpp"
#include "codegen.hpp"
#include "elf.hpp"

#include <cstdint>
#include <string_view>
#include <vector>

// An asset-free guest program: a call whose body tail-jumps to another unit,
// an indirect jump, a backward branch, and delay slots with observable effects.
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    constexpr std::uint32_t base = 0x100000;
    std::vector<std::uint8_t> bytes(0x400);
    const auto word = [&](unsigned offset, std::uint32_t value) {
        for (unsigned i = 0; i < 4; ++i) bytes[offset + i] = value >> (8 * i);
    };
    const auto addiu = [](unsigned target, unsigned source, unsigned immediate) {
        return (9u << 26) | (source << 21) | (target << 16) | immediate;
    };
    word(0x000, (3u << 26) | ((base + 0x100) >> 2)); // jal subroutine
    word(0x004, addiu(20, 20, 1));
    word(0x008, (8u << 21) | 8u);                  // jr t0
    word(0x00C, addiu(16, 16, 1));
    word(0x0F8, addiu(3, 0, 13));                 // alternate fallthrough entry
    word(0x0FC, addiu(3, 3, 4));
    word(0x100, (2u << 26) | ((base + 0x300) >> 2)); // j tail
    word(0x104, addiu(18, 18, 3));
    word(0x200, (5u << 26) | (16u << 21) | (17u << 16) | 0xFF7Fu); // bne s0,s1,start
    word(0x204, addiu(19, 19, 1));
    word(0x208, (23u << 21) | (31u << 11) | 0x21u); // addu ra,s7,zero
    word(0x20C, (31u << 21) | 8u);                // jr ra
    word(0x210, addiu(2, 0, 42));
    word(0x300, (31u << 21) | 8u);                // jr ra
    word(0x304, addiu(18, 18, 4));
    const auto image = recomp::Image::raw(base, std::move(bytes), {0, 0x400});
    auto program = recomp::analyse(image, {base, base + 0xF8, base + 0x200, base + 0x300});
    recomp::CodegenOptions options;
    options.output = argv[1];
    options.unit_bits = 8;
    options.tail_calls = std::string_view(argv[2]) == "tail";
    recomp::generate({{&image, &program}}, options);
}
