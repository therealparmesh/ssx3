#pragma once

#include "../gs.hpp"

#include <array>
#include <bit>
#include <cstdint>
#include <stdexcept>

namespace ps2::gs::webgl {

// State-to-register boundary for a GS backend. The caller supplies the
// runtime's setup revision and owns the sink's command queue. State/vertices
// stay borrowed only during draw(). Invalidate after reset or external register
// mutations.
class RegisterStream {
public:
  void invalidate() {
    known_.fill(false);
    setup_valid_ = false;
  }

  template <class Sink>
  void draw(const State &state, const Vertex *vertices, int count,
            std::uint32_t revision, Sink &&sink) {
    const unsigned kind = state.prim & 7u;
    if (kind == 7)
      return; // Reserved primitive does not rasterize.
    const int needed = kind == 0                               ? 1
                       : (kind == 1 || kind == 2 || kind == 6) ? 2
                                                               : 3;
    if (!vertices || count != needed)
      throw std::invalid_argument("Invalid GS draw packet");
    if (!setup_valid_ || revision_ != revision) {
      setup(state, sink);
      revision_ = revision;
      setup_valid_ = true;
    }
    const auto mode = state.prmodecont & 1
                          ? state.prim
                          : ((state.prim & 7ull) | (state.prmode & ~7ull));
    const unsigned normalized = count == 3   ? 3
                                : count == 1 ? 0
                                : kind == 6  ? 6
                                             : 1;
    emit(sink, 0, (mode & ~7ull) | normalized);
    for (int i = 0; i < count; ++i) {
      const auto &v = vertices[i];
      emit(sink, 1,
           std::uint64_t(v.r) | (std::uint64_t(v.g) << 8) |
               (std::uint64_t(v.b) << 16) | (std::uint64_t(v.a) << 24) |
               (std::uint64_t(std::bit_cast<std::uint32_t>(v.q)) << 32));
      emit(sink, 2,
           std::uint64_t(std::bit_cast<std::uint32_t>(v.s)) |
               (std::uint64_t(std::bit_cast<std::uint32_t>(v.t)) << 32));
      emit(sink, 3, std::uint64_t(v.u) | (std::uint64_t(v.v) << 16));
      emit(sink, 0x0A, std::uint64_t(v.f) << 56);
      // XYZ2 is an action, even if all bits match the previous vertex.
      emit(sink, 5,
           std::uint64_t(v.x) | (std::uint64_t(v.y) << 16) |
               (std::uint64_t(v.z) << 32),
           true);
    }
  }

  template <class Sink> void image_begin(const State &state, Sink &&sink) {
    transfer(state, 0, sink);
  }
  template <class Sink> void local_copy(const State &state, Sink &&sink) {
    transfer(state, 2, sink);
  }

  template <class Sink>
  void load_clut(std::uint64_t tex0, std::uint64_t texclut, Sink &&sink) {
    emit(sink, 0x1C, texclut);
    // The upstream GS already decided to load. Force a single load and
    // prevent later setup replay from triggering the same palette action.
    emit(sink, 6, (tex0 & ~(7ull << 61)) | (1ull << 61), true);
    setup_valid_ = false;
  }

  template <class Sink> void texflush(Sink &&sink) {
    emit(sink, 0x3F, 0, true);
  }

private:
  template <class Sink>
  bool emit(Sink &sink, unsigned reg, std::uint64_t value, bool force = false) {
    if (!force && known_[reg] && values_[reg] == value)
      return false;
    sink(static_cast<std::uint8_t>(reg), value);
    values_[reg] = value;
    known_[reg] = true;
    return true;
  }

  template <class Sink>
  void transfer(const State &s, unsigned direction, Sink &sink) {
    emit(sink, 0x50, s.bitbltbuf);
    emit(sink, 0x51, s.trxpos);
    emit(sink, 0x52, s.trxreg);
    emit(sink, 0x53, direction, true);
  }

  template <class Sink> void setup(const State &s, Sink &sink) {
    emit(sink, 0x1A, 1); // Resolve PRMODE into PRIM for every draw below.
    emit(sink, 0x1C, s.texclut);
    emit(sink, 0x22, s.scanmsk);
    emit(sink, 0x3B, s.texa);
    emit(sink, 0x3D, s.fogcol);
    emit(sink, 0x44, s.dimx);
    emit(sink, 0x45, s.dthe);
    emit(sink, 0x46, s.colclamp);
    emit(sink, 0x49, s.pabe);
    for (unsigned c = 0; c < 2; ++c) {
      const auto &v = s.ctx[c];
      emit(sink, 0x14 + c, v.tex1);
      emit(sink, 0x08 + c, v.clamp);
      emit(sink, 0x18 + c, v.xyoffset);
      emit(sink, 0x40 + c, v.scissor);
      emit(sink, 0x42 + c, v.alpha);
      emit(sink, 0x47 + c, v.test);
      emit(sink, 0x4A + c, v.fba);
      emit(sink, 0x4C + c, v.frame);
      emit(sink, 0x4E + c, v.zbuf);
      const bool tex0Written = emit(sink, 0x06 + c, v.tex0 & ~(7ull << 61));
      // TEX0 can implicitly overwrite MIPTBP1 in the backend. Restore the
      // runtime's final register image after that action, even if its value
      // equals our last emitted value. Explicit overrides must also survive.
      emit(sink, 0x34 + c, v.miptbp1,
           tex0Written && (v.tex1 & (1ull << 9)));
      emit(sink, 0x36 + c, v.miptbp2);
    }
  }

  std::array<std::uint64_t, 128> values_{};
  std::array<bool, 128> known_{};
  std::uint32_t revision_ = 0;
  bool setup_valid_ = false;
};

} // namespace ps2::gs::webgl
