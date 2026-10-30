// Asset-free adapter around the unchanged CPU GS rasterizer.
// Packed test input layout is documented in README.md.
#include "gs/gs.hpp"
#include "gs/raster.hpp"
#include <cmath>
#include <cstring>
#include <emscripten.h>
struct PackedVertex {
  float x, y;
  unsigned z, rgba;
  float s, t, q;
  unsigned fog;
};
static_assert(sizeof(PackedVertex) == 32);
extern "C" EMSCRIPTEN_KEEPALIVE int reference(const unsigned *config,
                                              const PackedVertex *data,
                                              unsigned count,
                                              unsigned *output) {
  if (count > 65535)
    return 1;
  using namespace ps2::gs;
  init();
  raster::reset();
  memset(memory(), 0, kMemorySize);
  State s{};
  s.prmodecont = 1;
  s.prim = config[0];
  s.ctx[0].test = config[1];
  s.ctx[0].alpha = config[2] | (uint64_t(config[3]) << 32);
  s.ctx[0].frame =
      (1ull << 16) | (uint64_t(config[26]) << 24) | (uint64_t(config[4]) << 32);
  s.ctx[0].zbuf =
      128ull | (uint64_t(config[27]) << 24) | (uint64_t(config[13]) << 32);
  s.pabe = config[5];
  s.ctx[0].fba = config[6];
  s.colclamp = config[7];
  s.scanmsk = config[10];
  s.fogcol = config[21];
  unsigned texturePsm = config[25] == 2         ? PSMT8
                        : config[25] == 3       ? PSMT4
                        : config[25] == 4       ? PSMT8H
                        : (config[29] & 3) == 1 ? PSMCT16
                        : (config[29] & 3) == 2 ? PSMCT24
                                                : PSMCT32;
  s.texa = (config[28] & 255u) | (uint64_t((config[28] >> 8) & 255u) << 32) |
           ((config[28] & 65536u) ? 1ull << 15 : 0);
  s.ctx[0].tex0 =
      2048ull | ((config[25] >= 2 && (config[29] & 3) == 1) ? 2ull << 51 : 0) |
      (uint64_t(texturePsm) << 20) | (1ull << 14) | (6ull << 26) |
      (6ull << 30) | (uint64_t((config[14] >> 2) & 1) << 34) |
      (uint64_t(config[14] & 3) << 35);
  s.ctx[0].tex1 = (config[15] & 1) ? 1ull << 5 : 0;
  s.ctx[0].clamp = config[16] | (uint64_t(config[17]) << 4) |
                   (uint64_t(config[18]) << 14) | (uint64_t(config[19]) << 24) |
                   (uint64_t(config[20]) << 34);
  s.ctx[0].scissor = uint64_t(config[11]) | (uint64_t(config[12]) << 32);
  auto pack16 = [](unsigned c) {
    return ((c >> 3) & 31) | (((c >> 11) & 31) << 5) |
           (((c >> 19) & 31) << 10) | ((c & 0x80000000u) ? 0x8000u : 0);
  };
  auto expand16 = [](unsigned c) {
    return ((c & 31) << 3) | (((c >> 5) & 31) << 11) |
           (((c >> 10) & 31) << 19) | ((c & 0x8000) ? 0x80000000u : 0);
  };
  unsigned framePsm = config[26], depthPsm = 0x30 | config[27];
  bool sixteen = framePsm == PSMCT16 || framePsm == PSMCT16S;
  for (unsigned y = 0; y < 64; y++)
    for (unsigned x = 0; x < 64; x++) {
      write_pixel(sixteen ? framePsm : PSMCT32, 0, 1, x, y,
                  sixteen ? pack16(config[8]) : config[8]);
      write_pixel(depthPsm, 4096, 1, x, y, config[9]);
    }
  for (unsigned i = 0; i < 256; i++) {
    unsigned color = ((i * 17) & 255) | (((i * 13) & 255) << 8) |
                     ((255 - i) << 16) | ((i & 1) ? 0x80000000u : 0);
    s.clut[i] = (config[25] >= 2 && (config[29] & 3) == 1)
                    ? (i == 0 ? 0 : pack16(color))
                    : color;
  }
  for (unsigned y = 0; y < 64; y++)
    for (unsigned x = 0; x < 64; x++) {
      unsigned pixel = (x * 4) | ((y * 4) << 8) | (((x ^ y) * 4) << 16) |
                       ((x & 8) ? 0x80000000u : 0);
      if (texturePsm == PSMT8 || texturePsm == PSMT4)
        pixel = ((x >> 2) + (y >> 2) * 13) & (texturePsm == PSMT4 ? 15 : 255);
      if (texturePsm == PSMT8H) {
        pixel = 17 | ((((x >> 2) + (y >> 2) * 13) & 255) << 24);
        write_pixel(PSMCT32, 2048, 1, x, y, pixel);
      } else
        write_pixel(texturePsm, 2048, 1, x, y,
                    texturePsm == PSMCT16 ? pack16(pixel) : pixel);
    }
  for (unsigned i = 0; i < count; i++) {
    Vertex v[3]{};
    for (unsigned j = 0; j < 3; j++) {
      const auto &p = data[i * 3 + j];
      auto &q = v[j];
      q.x = std::lround(p.x * 16);
      q.y = std::lround(p.y * 16);
      q.z = p.z;
      q.r = p.rgba;
      q.g = p.rgba >> 8;
      q.b = p.rgba >> 16;
      q.a = p.rgba >> 24;
      q.s = p.s;
      q.t = p.t;
      q.q = p.q;
      q.u = std::lround(p.s);
      q.v = std::lround(p.t);
      q.f = p.fog;
    }
    raster::draw(s, v, 3);
  }
  for (unsigned y = 0; y < 64; y++)
    for (unsigned x = 0; x < 64; x++) {
      unsigned color = read_pixel(sixteen ? framePsm : PSMCT32, 0, 1, x, y);
      output[y * 64 + x] = sixteen ? expand16(color) : color;
      output[4096 + y * 64 + x] = read_pixel(depthPsm, 4096, 1, x, y);
    }
  return 0;
}
