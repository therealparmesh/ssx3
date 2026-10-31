#include "gs/webgl/register_stream.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <utility>
#include <vector>

using namespace ps2::gs;
using Event = std::pair<std::uint8_t, std::uint64_t>;
void expect(bool condition, const char *message) {
  if (!condition)
    throw std::runtime_error(message);
}

int main() {
  try {
    webgl::RegisterStream stream;
    State s{};
    s.prim = 4;
    s.prmodecont = 0;
    s.prmode = 0x358;
    s.ctx[0].frame = 0x1111222233334444ull;
    s.ctx[1].frame = 0x5555666677778888ull;
    s.ctx[0].tex0 = 0xE000000012345678ull;
    s.colclamp = 1;
    Vertex v{0xfffe, 0xffff, 0xabcdef, 0x12,   0x34,   0x56, 0x78,
             0.5f,   -3.25f, 14.5f,    0x1234, 0x1abc, 0xa5};
    std::array<Vertex, 3> vertices{v, v, v};
    std::array<unsigned char, sizeof(s)> before{};
    std::memcpy(before.data(), &s, sizeof(s));
    std::vector<Event> events;
    auto sink = [&](std::uint8_t id, std::uint64_t value) {
      events.emplace_back(id, value);
    };
    auto has = [&](unsigned id, std::uint64_t value) {
      return std::find(events.begin(), events.end(), Event{id, value}) !=
             events.end();
    };
    auto count = [&](unsigned id) {
      return std::count_if(events.begin(), events.end(),
                           [&](auto e) { return e.first == id; });
    };
    stream.draw(s, vertices.data(), 3, 1, sink);
    expect(has(0x1A, 1) && has(0, (s.prmode & ~7ull) | 3),
           "Resolved context/mode or strip normalization changed");
    expect(has(0x4C, s.ctx[0].frame) && has(0x4D, s.ctx[1].frame),
           "GS contexts were conflated");
    expect(has(6, 0x12345678), "Setup replay must not reload CLUT");
    expect(has(1, 0x3f00000078563412ull), "RGBA/Q bit packing changed");
    expect(has(3, 0x1abc1234) && count(2) == 0 && count(0x0A) == 0,
           "Fixed-coordinate draw forwarded unused ST/fog attributes");
    expect(count(5) == 3, "Repeated XYZ kicks were dropped");
    expect(has(5, 0x00abcdeffffffffeull), "XYZ bit packing changed");
    expect(std::memcmp(before.data(), &s, sizeof(s)) == 0,
           "Borrowed GS state was mutated");
    events.clear();
    stream.draw(s, vertices.data(), 3, 1, sink);
    expect(events.size() == 3 && count(5) == 3,
           "Unchanged setup/attributes were replayed or vertices lost");
    s.ctx[1].test = 0x515cd;
    events.clear();
    stream.draw(s, vertices.data(), 3, 2, sink);
    expect(has(0x48, 0x515cd) && count(5) == 3,
           "Setup revision did not update context1");
    events.clear();
    stream.load_clut(s.ctx[0].tex0, 7, sink);
    stream.load_clut(s.ctx[0].tex0, 7, sink);
    expect(count(6) == 2 && has(6, 0x2000000012345678ull),
           "Repeated palette loads were suppressed");
    events.clear();
    stream.draw(s, vertices.data(), 3, 2, sink);
    expect(has(6, 0x12345678) && has(0x1C, 0),
           "Palette side effects were not restored to draw state");
    s.bitbltbuf = 0x123456789abcdef0ull;
    s.trxpos = 9;
    s.trxreg = 0x200000001ull;
    events.clear();
    stream.image_begin(s, sink);
    stream.image_begin(s, sink);
    stream.local_copy(s, sink);
    stream.local_copy(s, sink);
    expect(count(0x50) == 1 && count(0x53) == 4 && has(0x53, 0) && has(0x53, 2),
           "Transfer actions were cached away");
    events.clear();
    stream.texflush(sink);
    stream.texflush(sink);
    expect(events.size() == 2 && count(0x3F) == 2,
           "Texture invalidation actions were dropped");
    stream.invalidate();
    events.clear();
    stream.draw(s, vertices.data(), 3, 2, sink);
    expect(has(0x4D, s.ctx[1].frame),
           "Invalidation did not restore full setup");
    for (unsigned kind : {0u, 1u, 2u, 3u, 4u, 5u, 6u}) {
      stream.invalidate();
      events.clear();
      s.prim = kind;
      s.prmodecont = 1;
      const int n = kind == 0                               ? 1
                    : (kind == 1 || kind == 2 || kind == 6) ? 2
                                                            : 3;
      stream.draw(s, vertices.data(), n, 3, sink);
      expect(has(0, kind == 6   ? 6
                    : kind <= 2 ? (kind == 0 ? 0 : 1)
                                : 3),
             "Primitive normalization changed");
      expect(count(5) == n, "Primitive vertex count changed");
    }
    events.clear();
    s.prim = 7;
    stream.draw(s, nullptr, 0, 4, sink);
    expect(events.empty(), "Reserved primitive rasterized");
    s.prim = 3;
    bool rejected = false;
    try {
      stream.draw(s, vertices.data(), 2, 5, sink);
    } catch (const std::invalid_argument &) {
      rejected = true;
    }
    expect(rejected && events.empty(),
           "Malformed draw partially emitted commands");
    {
      // Change every attribute while toggling its consumer. Re-enabling ST,
      // UV or fog must restore the current value before every XYZ action.
      webgl::RegisterStream replay;
      State state{};
      std::array<std::uint64_t, 128> regs{};
      unsigned verticesChecked = 0;
      for (unsigned step = 0; step < 16; ++step) {
        const unsigned flags = ((step & 1) ? 0x10 : 0) |
                               ((step & 2) ? 0x100 : 0) |
                               ((step & 4) ? 0x20 : 0);
        state.prmodecont = step < 8;
        state.prim = 3 | (state.prmodecont ? flags : (flags ^ 0x130));
        state.prmode = flags;
        std::array<Vertex, 3> changing{};
        for (unsigned i = 0; i < changing.size(); ++i) {
          changing[i] = v;
          changing[i].s = -float(step * 3 + i) - 3.25f;
          changing[i].t = float(step * 3 + i) + 14.5f;
          changing[i].u = step * 48 + i * 16;
          changing[i].v = step * 64 + i * 16;
          changing[i].f = step * 3 + i;
        }
        unsigned st = 0, uv = 0, fog = 0, kicks = 0;
        auto hardware = [&](std::uint8_t id, std::uint64_t value) {
          regs[id] = value;
          st += id == 2; uv += id == 3; fog += id == 0x0A;
          if (id != 5) return;
          const auto &vertex = changing[kicks++];
          if (flags & 0x10) {
            if (flags & 0x100)
              expect(regs[3] == (std::uint64_t(vertex.u) | (std::uint64_t(vertex.v) << 16)),
                     "Re-enabled UV consumed a stale vertex");
            else
              expect(regs[2] == (std::uint64_t(std::bit_cast<std::uint32_t>(vertex.s)) |
                                    (std::uint64_t(std::bit_cast<std::uint32_t>(vertex.t)) << 32)),
                     "Re-enabled ST consumed a stale vertex");
          }
          if (flags & 0x20)
            expect(regs[0x0A] == std::uint64_t(vertex.f) << 56,
                   "Re-enabled fog consumed a stale vertex");
          ++verticesChecked;
        };
        replay.draw(state, changing.data(), 3, step + 200, hardware);
        expect(kicks == 3, "Attribute pruning changed vertex actions");
        expect(st == (((flags & 0x110) == 0x10) ? 3u : 0u) &&
                   uv == (((flags & 0x110) == 0x110) ? 3u : 0u) &&
                   fog == ((flags & 0x20) ? 3u : 0u),
               "Unused texture/fog attributes were replayed");
      }
      expect(verticesChecked == 48, "Attribute mode sequence did not finish");
    }
    {
      webgl::RegisterStream replay;
      State state{};
      state.prim = 3;
      state.prmodecont = 1;
      std::array<std::uint64_t, 128> registers{};
      unsigned checked = 0;
      auto hardware = [&](std::uint8_t id, std::uint64_t value) {
        registers[id] = value;
        if ((id == 6 || id == 7) && (registers[0x14 + id - 6] & 512))
          registers[0x34 + id - 6] = 0xfeedface; // TEX0's hidden register action.
        if (id == 5) {
          for (unsigned c = 0; c < 2; ++c)
            expect(registers[0x34 + c] == state.ctx[c].miptbp1 &&
                       registers[0x36 + c] == state.ctx[c].miptbp2,
                   "Draw observed stale mip registers after TEX0");
          ++checked;
        }
      };
      for (unsigned c = 0; c < 2; ++c) {
        state.ctx[c].tex1 = 512;
        state.ctx[c].tex0 = 0x123400 + c;
        state.ctx[c].miptbp1 = 0x987654321 + c;
        state.ctx[c].miptbp2 = 0x123456789 + c;
      }
      replay.draw(state, vertices.data(), 3, 100, hardware);
      // New TEX0 values can produce the same final mip image. Value caching
      // must not suppress restoration after the implicit backend action.
      state.ctx[0].tex0 ^= 1ull << 34;
      state.ctx[1].tex0 ^= 1ull << 34;
      replay.draw(state, vertices.data(), 3, 101, hardware);
      replay.load_clut(state.ctx[0].tex0, 0, hardware);
      replay.draw(state, vertices.data(), 3, 102, hardware);
      replay.invalidate();
      replay.draw(state, vertices.data(), 3, 103, hardware);
      expect(checked == 12, "Mip replay sequence did not draw all vertices");
    }
    std::cout << "PASS GS register stream: modes, contexts, packing, caching, "
                 "side effects, invalidation\n";
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
