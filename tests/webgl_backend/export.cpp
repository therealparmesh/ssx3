#include "app_shared/AppConfig.h"
#include "gs/GSH_OpenGL/GSH_OpenGL.h"
#include "gs/GsPixelFormats.h"
#include <GLES3/gl3.h>
#include <cstdio>
#include <cstring>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <stdexcept>
#include <vector>
fs::path CAppConfig::GetBasePath() const { return "/tmp"; }
class Fixture : public CGSH_OpenGL {
public:
  Fixture() : CGSH_OpenGL(false) {}
  void close() { ReleaseImpl(); }

protected:
  void PresentBackbuffer() override {}
};
void draw(Fixture &gs, unsigned colorPsm, unsigned depthPsm, unsigned zbase,
          unsigned x, unsigned y, unsigned w, unsigned h, unsigned color,
          unsigned z) {
  auto reg = [&](unsigned id, uint64_t value) {
    gs.WriteRegister({uint8_t(id), value});
  };
  reg(0x1a, 1);
  reg(0, 6);
  reg(0x46, 1);
  reg(0x4c, (1ull << 16) | (uint64_t(colorPsm) << 24));
  reg(0x4e, (zbase / 8192) | (uint64_t(depthPsm) << 24));
  reg(0x40, (63ull << 16) | (63ull << 48));
  reg(0x47, 0x30000);
  reg(0x18, 0);
  reg(0x49, 0);
  reg(0x4a, 0);
  reg(1, 0x3f80000000000000ull | color);
  reg(5, x * 16ull | (y * 16ull << 16) | (uint64_t(z) << 32));
  reg(5, (x + w) * 16ull | ((y + h) * 16ull << 16) | (uint64_t(z) << 32));
  gs.DrainPendingCalls();
}
// Independent expected GS16 words for the deliberately unaligned test colors.
unsigned pack(unsigned c) {
  switch (c) {
  case 0x9b41a919:
    return 0xa2a3;
  case 0x7fb9d143:
    return 0x5f48;
  case 0x82c91969:
    return 0xe46d;
  case 0x80402018:
    return 0xa083;
  default:
    throw std::runtime_error("Missing expected GS16 test color");
  }
}
void expectedRect(std::vector<uint8> &ram, unsigned cp, unsigned dp, unsigned x,
                  unsigned y, unsigned w, unsigned h, unsigned c, unsigned z) {
  CGsPixelFormats::CPixelIndexorPSMCT32 c32(ram.data(), 0, 1);
  CGsPixelFormats::CPixelIndexorPSMCT16 c16(ram.data(), 0, 1);
  CGsPixelFormats::CPixelIndexorPSMCT16S c16s(ram.data(), 0, 1);
  CGsPixelFormats::CPixelIndexorPSMZ32 z32(ram.data(), 2 << 20, 1);
  CGsPixelFormats::CPixelIndexor<CGsPixelFormats::STORAGEPSMZ16> z16(
      ram.data(), 2 << 20, 1);
  CGsPixelFormats::CPixelIndexorPSMZ16S z16s(ram.data(), 2 << 20, 1);
  for (unsigned py = y; py < y + h; py++)
    for (unsigned px = x; px < x + w; px++) {
      if (cp == 0)
        c32.SetPixel(px, py, c);
      else if (cp == 1)
        c32.SetPixel(px, py,
                     (c & 0xffffff) | (c32.GetPixel(px, py) & 0xff000000));
      else if (cp == 2)
        c16.SetPixel(px, py, pack(c));
      else
        c16s.SetPixel(px, py, pack(c));
      if (dp == 1)
        z32.SetPixel(px, py,
                     (z & 0xffffff) | (z32.GetPixel(px, py) & 0xff000000));
      else if (dp == 2)
        z16.SetPixel(px, py, z);
      else
        z16s.SetPixel(px, py, z);
    }
}
int main() {
  try {
    EmscriptenWebGLContextAttributes a;
    emscripten_webgl_init_context_attributes(&a);
    a.majorVersion = 2;
    a.alpha = false;
    a.antialias = false;
    auto c = emscripten_webgl_create_context("#canvas", &a);
    if (c <= 0)
      throw std::runtime_error("No WebGL2");
    emscripten_webgl_make_context_current(c);
    Fixture gs;
    gs.Initialize();
    gs.Reset();
    gs.DrainPendingCalls();
    unsigned cases = 0;
    for (unsigned cp : {0u, 1u, 2u, 10u})
      for (unsigned dp : {1u, 2u, 10u}) {
        gs.Reset();
        gs.DrainPendingCalls();
        memset(gs.GetRam(), 0x5a, 4 << 20);
        std::vector<uint8> expected(gs.GetRam(), gs.GetRam() + (4 << 20));
        unsigned z = dp == 1 ? 0x123456 : 0x3456;
        draw(gs, cp, dp, 2 << 20, 8, 12, 16, 20, 0x9b41a919, z);
        expectedRect(expected, cp, dp, 8, 12, 16, 20, 0x9b41a919, z);
        bool skip = EM_ASM_INT({
          return new URLSearchParams(location.search).get('mutant') ==
                 'skip-sync';
        });
        if (!skip)
          gs.SyncMemoryForValidation();
        if (memcmp(expected.data(), gs.GetRam(), 4 << 20)) {
          unsigned count = 0;
          for (unsigned i = 0; i < (4 << 20); i++)
            if (expected[i] != gs.GetRam()[i]) {
              if (count < 6)
                printf("DIFF cp=%u dp=%u byte=%x got=%x expected=%x\n", cp, dp,
                       i, gs.GetRam()[i], expected[i]);
              count++;
            }
          throw std::runtime_error(
              "GPU export differs from expected VRAM cp=" + std::to_string(cp) +
              " dp=" + std::to_string(dp) + " bytes=" + std::to_string(count));
        }
        auto reads = gs.SyncReadbacksForValidation();
        if (reads != 2)
          throw std::runtime_error(
              "Dirty color/depth not exported exactly once");
        gs.SyncMemoryForValidation();
        if (reads != gs.SyncReadbacksForValidation())
          throw std::runtime_error("Clean memory export repeated readbacks");
        // Leave new GPU writes pending before a one-pixel CPU upload on that
        // page.
        draw(gs, cp, dp, 2 << 20, 8, 40, 16, 8, 0x7fb9d143, z);
        expectedRect(expected, cp, dp, 8, 40, 16, 8, 0x7fb9d143, z);
        // Uploads on an unrelated physical page must not trigger any readback.
        auto distantReg = [&](unsigned id, uint64_t value) {
          gs.WriteRegister({uint8_t(id), value});
        };
        distantReg(0x50, (uint64_t((3 << 20) / 256) << 32) | (1ull << 48));
        distantReg(0x51, 0);
        distantReg(0x52, 1ull | (1ull << 32));
        distantReg(0x53, 0);
        gs.ProcessWriteBuffer(nullptr);
        uint32 distant[4] = {0x87654321, 0, 0, 0};
        gs.FeedImageData(distant, 16);
        gs.DrainPendingCalls();
        {
          CGsPixelFormats::CPixelIndexorPSMCT32 i(expected.data(), 3 << 20, 1);
          i.SetPixel(0, 0, distant[0]);
        }
        if (gs.SyncReadbacksForValidation() != 2)
          throw std::runtime_error(
              "Disjoint CPU upload stalled on GPU readback");
        unsigned upload = cp == 2 || cp == 10 ? pack(0x80402018) : 0x80402018;
        auto reg = [&](unsigned id, uint64_t value) {
          gs.WriteRegister({uint8_t(id), value});
        };
        reg(0x50, (1ull << 48) | (uint64_t(cp) << 56));
        reg(0x51, (9ull << 32) | (41ull << 48));
        reg(0x52, 1ull | (1ull << 32));
        reg(0x53, 0);
        gs.ProcessWriteBuffer(nullptr);
        uint8 bytes[16]{};
        memcpy(bytes, &upload, cp == 0 ? 4 : cp == 1 ? 3 : 2);
        gs.FeedImageData(bytes, 16);
        gs.DrainPendingCalls();
        if (cp == 0 || cp == 1) {
          CGsPixelFormats::CPixelIndexorPSMCT32 i(expected.data(), 0, 1);
          i.SetPixel(9, 41,
                     cp == 1 ? (upload & 0xffffff) |
                                   (i.GetPixel(9, 41) & 0xff000000)
                             : upload);
        } else if (cp == 2) {
          CGsPixelFormats::CPixelIndexorPSMCT16 i(expected.data(), 0, 1);
          i.SetPixel(9, 41, upload);
        } else {
          CGsPixelFormats::CPixelIndexorPSMCT16S i(expected.data(), 0, 1);
          i.SetPixel(9, 41, upload);
        }
        if (memcmp(expected.data(), gs.GetRam(), 4 << 20) ||
            gs.SyncReadbacksForValidation() != 4)
          throw std::runtime_error(
              "CPU upload did not synchronize pending GPU writes");
        draw(gs, cp, dp, 2 << 20, 32, 40, 8, 8, 0x82c91969, z);
        expectedRect(expected, cp, dp, 32, 40, 8, 8, 0x82c91969, z);
        gs.SyncMemoryForValidation();
        if (memcmp(expected.data(), gs.GetRam(), 4 << 20))
          throw std::runtime_error(
              "Partial CPU upload lost GPU writes or changed padding cp=" +
              std::to_string(cp) + " dp=" + std::to_string(dp));
        cases++;
        printf("PASS export and partial upload cp=%u dp=%u\n", cp, dp);
      }
    for (unsigned dp : {1u, 2u, 10u}) {
      gs.Reset();
      gs.DrainPendingCalls();
      memset(gs.GetRam(), 0x7e, 4 << 20);
      std::vector<uint8> expected(4 << 20, 0xa5);
      CGsPixelFormats::CPixelIndexorPSMZ32 source32(gs.GetRam(), 2 << 20, 2),
          expected32(expected.data(), 2 << 20, 2);
      CGsPixelFormats::CPixelIndexor<CGsPixelFormats::STORAGEPSMZ16> source16(
          gs.GetRam(), 2 << 20, 2),
          expected16(expected.data(), 2 << 20, 2);
      CGsPixelFormats::CPixelIndexorPSMZ16S source16s(gs.GetRam(), 2 << 20, 2),
          expected16s(expected.data(), 2 << 20, 2);
      const unsigned edges[] = {0,        1,        2,       0x7fffff,
                                0xfffffd, 0xfffffe, 0xffffff};
      for (unsigned i = 0; i < 65536; i++) {
        unsigned value = dp == 1 ? ((i * 2654435761u) & 0xffffff) : i;
        if (dp == 1 && i < 7)
          value = edges[i];
        unsigned x = i % 128, y = i / 128;
        if (dp == 1) {
          source32.SetPixel(x, y, value | 0x7e000000);
          expected32.SetPixel(x, y, value | 0xa5000000);
        } else if (dp == 2) {
          source16.SetPixel(x, y, value);
          expected16.SetPixel(x, y, value);
        } else {
          source16s.SetPixel(x, y, value);
          expected16s.SetPixel(x, y, value);
        }
      }
      gs.SeedDepthExportForValidation(dp);
      memset(gs.GetRam(), 0xa5, 4 << 20);
      gs.SyncMemoryForValidation();
      if (memcmp(expected.data(), gs.GetRam(), 4 << 20))
        throw std::runtime_error("Depth roundtrip failed dp=" +
                                 std::to_string(dp));
      if (gs.SyncReadbacksForValidation() != 1)
        throw std::runtime_error("Unexpected depth export readback count");
      cases++;
      printf("PASS65536 depth values dp=%u\n", dp);
    }
    gs.Reset();
    gs.DrainPendingCalls();
    memset(gs.GetRam(), 0x5a, 4 << 20);
    {
      std::vector<uint8> expected(gs.GetRam(), gs.GetRam() + (4 << 20));
      uint8 payload[32]{};
      CGsPixelFormats::CPixelIndexorPSMCT32 i(expected.data(), 0, 1);
      for (unsigned x = 0; x < 6; x++) {
        unsigned value = 0x123456 + x * 0x03070b;
        for (unsigned b = 0; b < 3; b++)
          payload[x * 3 + b] = value >> (8 * b);
        i.SetPixel(9 + x, 13, value | 0x5a000000);
      }
      auto reg = [&](unsigned id, uint64_t value) {
        gs.WriteRegister({uint8_t(id), value});
      };
      reg(0x50, (1ull << 48) | (1ull << 56));
      reg(0x51, (9ull << 32) | (13ull << 48));
      reg(0x52, 6ull | (1ull << 32));
      reg(0x53, 0);
      gs.ProcessWriteBuffer(nullptr);
      gs.FeedImageData(payload, 16);
      gs.DrainPendingCalls();
      gs.FeedImageData(payload + 16, 16);
      gs.DrainPendingCalls();
      if (memcmp(expected.data(), gs.GetRam(), 4 << 20))
        throw std::runtime_error(
            "Chunked24 upload lost carry or wrote padding outside rectangle");
      cases++;
      printf("PASS chunked24 upload carry and padding\n");
    }
    for (unsigned psm : {0x13u, 0x14u, 0x1bu, 0x24u, 0x2cu}) {
      gs.Reset();
      gs.DrainPendingCalls();
      memset(gs.GetRam(), 0x5a, 4 << 20);
      std::vector<uint8> expected(gs.GetRam(), gs.GetRam() + (4 << 20));
      if (psm == 0x13) {
        CGsPixelFormats::CPixelIndexorPSMT8 i(expected.data(), 0, 2);
        i.SetPixel(9, 13, 0xab);
      } else if (psm == 0x14) {
        CGsPixelFormats::CPixelIndexorPSMT4 i(expected.data(), 0, 2);
        i.SetPixel(9, 13, 0xb);
      } else {
        CGsPixelFormats::CPixelIndexorPSMCT32 i(expected.data(), 0, 2);
        unsigned old = i.GetPixel(9, 13);
        unsigned mask = psm == 0x1b   ? 0xff000000
                        : psm == 0x24 ? 0x0f000000
                                      : 0xf0000000;
        unsigned value = psm == 0x1b   ? 0xab000000
                         : psm == 0x24 ? 0x0b000000
                                       : 0xb0000000;
        i.SetPixel(9, 13, (old & ~mask) | value);
      }
      auto reg = [&](unsigned id, uint64_t value) {
        gs.WriteRegister({uint8_t(id), value});
      };
      reg(0x50, (2ull << 48) | (uint64_t(psm) << 56));
      reg(0x51, (9ull << 32) | (13ull << 48));
      reg(0x52, 1ull | (1ull << 32));
      reg(0x53, 0);
      gs.ProcessWriteBuffer(nullptr);
      uint8 data[16]{};
      data[0] = psm == 0x13 || psm == 0x1b ? 0xab : 0xdb;
      gs.FeedImageData(data, 16);
      gs.DrainPendingCalls();
      if (memcmp(expected.data(), gs.GetRam(), 4 << 20))
        throw std::runtime_error("Indexed upload padding changed VRAM psm=" +
                                 std::to_string(psm));
      cases++;
      printf("PASS indexed upload padding psm=%u\n", psm);
    }
    gs.Reset();
    gs.DrainPendingCalls();
    memset(gs.GetRam(), 0x5a, 4 << 20);
    std::vector<uint8> unchanged(gs.GetRam(), gs.GetRam() + (4 << 20));
    draw(gs, 0, 1, 0, 0, 0, 64, 64, 0x9b41a919, 0x123456);
    bool rejected = false;
    try {
      gs.SyncMemoryForValidation();
    } catch (const std::exception &e) {
      rejected = std::string(e.what()).find("alias reconciliation") !=
                 std::string::npos;
    }
    if (!rejected || memcmp(unchanged.data(), gs.GetRam(), 4 << 20))
      throw std::runtime_error("Ambiguous export changed RAM or was accepted");
    if (gs.SyncReadbacksForValidation() != 0)
      throw std::runtime_error("Alias ownership was checked after readback");
    gs.Reset();
    gs.DrainPendingCalls();
    memset(gs.GetRam(), 0x5a, 4 << 20);
    draw(gs, 0, 0, 2 << 20, 8, 12, 16, 20, 0x9b41a919, 0xf0123456);
    rejected = false;
    try {
      gs.SyncMemoryForValidation();
    } catch (const std::exception &e) {
      rejected = std::string(e.what()).find("integer depth storage") !=
                 std::string::npos;
    }
    if (!rejected || memcmp(unchanged.data(), gs.GetRam(), 4 << 20) ||
        gs.SyncReadbacksForValidation() != 0)
      throw std::runtime_error("Lossy Z32 export was accepted or changed RAM");
    unsigned error = glGetError();
    EM_ASM(
        {
          window.fixtureResult = ({
            cases : $0,
            aliasRejected : true,
            z32Rejected : true,
            orderedBatches : Module.ps2OrderedRaster
                ? Module.ps2OrderedRaster.stats.batches
                : 0,
            glError : $1
          });
        },
        cases, error);
    gs.close();
    return error ? 1 : 0;
  } catch (const std::exception &e) {
    printf("FAIL %s\n", e.what());
    EM_ASM(
        { window.fixtureResult = ({error : UTF8ToString($0), glError : $1}); },
        e.what(), glGetError());
    return 2;
  }
}
