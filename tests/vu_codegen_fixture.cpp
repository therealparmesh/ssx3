#include "ps2/vu_ops.hpp"

#include <array>
#include <filesystem>
#include <format>
#include <fstream>

// No game assets: add to VI2, then store it in the end-delay instruction.
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    std::array<std::uint8_t, 16384> code{};
    const std::uint32_t instructions[] = {
        (0x08u << 25) | (2u << 16) | (1u << 11) | 7u, 0x400002FFu,
        (0x05u << 25) | (8u << 21) | (2u << 16), 0x000002FFu,
    };
    std::memcpy(code.data(), instructions, sizeof instructions);
    const auto pcs = ps2::vu::reachable(code.data(), code.size() - 1, 0);
    const auto key = ps2::vu::program_key(code.data(), pcs, 0);
    std::filesystem::create_directories(argv[1]);
    std::ofstream out(std::filesystem::path(argv[1]) / std::format("{:016X}_0000.bin", key), std::ios::binary);
    out.write(reinterpret_cast<const char *>(code.data()), code.size());
    return out.good() ? 0 : 1;
}
