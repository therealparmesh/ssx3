#pragma once

#include <cstdint>
#include <optional>

namespace ps2::gs {

// MTBA lays out L1-L3 as square levels derived from TW, independently of TH
// and TBW0. PSMCT24 uses 32-bit storage. This helper covers the documented
// 32..1024 source widths and ordinary color/index formats.
constexpr std::optional<std::uint64_t> automatic_miptbp1(std::uint64_t tex0) {
  unsigned bits = 0;
  switch ((tex0 >> 20) & 63) {
  case 0:
  case 1:
    bits = 32;
    break;
  case 2:
  case 10:
    bits = 16;
    break;
  case 19:
    bits = 8;
    break;
  case 20:
    bits = 4;
    break;
  default:
    return std::nullopt;
  }
  const unsigned exponent = (tex0 >> 26) & 15;
  if (exponent < 5 || exponent > 10)
    return std::nullopt;
  std::uint64_t width = 1ull << exponent, address = tex0 & 0x3fff;
  std::uint64_t result = 0;
  for (unsigned level = 0; level < 3; ++level) {
    address = (address + width * width * bits / 2048) & 0x3fff;
    width = width > 1 ? width / 2 : 1;
    const auto pitch = width >= 64 ? width / 64 : 1;
    result |= (address | (pitch << 14)) << (20 * level);
  }
  return result;
}

} // namespace ps2::gs
