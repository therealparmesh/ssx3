#pragma once

#include <cstdint>

namespace ps2 {

// Guest entry IDs are uint16_t. This entry only prepares the host function;
// generated code must return before touching guest state.
inline constexpr std::uint32_t kWarmupEntry = 0xFFFFFFFFu;
using CodeWarmup = void (*)();

// Register on the host thread before starting workers. Old generated code
// registers nothing and remains usable without preparation.
void register_code_warmup(CodeWarmup function);
void warm_generated_code(unsigned passes = 1);

}
