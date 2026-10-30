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
  void seedClut() {
    for (unsigned i = 0; i < 512; i++)
      m_pCLUT[i] = i ^ 0x5a5a;
  }
  bool clutValid() {
    for (unsigned i = 0; i < 512; i++)
      if (m_pCLUT[i] != (i ^ 0x5a5a))
        return false;
    return true;
  }

protected:
  void PresentBackbuffer() override {}
};
void seed(uint8 *ram, unsigned psm, unsigned salt) {
  CGsPixelFormats::CPixelIndexorPSMCT32 i32(ram, 0, 2);
  CGsPixelFormats::CPixelIndexorPSMCT16 i16(ram, 0, 2);
  CGsPixelFormats::CPixelIndexorPSMCT16S i16s(ram, 0, 2);
  for (unsigned y = 0; y < 512; y++)
    for (unsigned x = 0; x < 128; x++) {
      unsigned value = (y * 128 + x) ^ salt;
      if (psm == 0 || psm == 1)
        i32.SetPixel(x, y, value * 2654435761u);
      else if (psm == 2)
        i16.SetPixel(x, y, value);
      else
        i16s.SetPixel(x, y, value);
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
    unsigned cases = 0, pixels = 0;
    for (unsigned psm : {0u, 1u, 2u, 10u})
      for (unsigned salt : {0xffffu, 0x5555u, 0xaaaau})
        for (bool pending : {false, true}) {
          seed(gs.GetRam(), psm, 0);
          gs.SeedReadbackForValidation(psm);
          if (pending) {
            auto reg = [&](unsigned id, uint64_t value) {
              gs.WriteRegister({uint8_t(id), value});
            };
            reg(0x1a, 1);
            reg(0, 6);
            reg(0x46, 1);
            reg(0x4c, (2ull << 16) | (uint64_t(psm) << 24));
            reg(0x4e, 256ull | (1ull << 24) | (1ull << 32));
            reg(0x40, (127ull << 16) | (511ull << 48));
            reg(0x47, 0);
            reg(0x18, 0);
            reg(1, 0x3f8000008044cc22ull);
            reg(5, 16 * 16ull | (24 * 16ull << 16));
            reg(5, 48 * 16ull | (56 * 16ull << 16));
            gs.DrainPendingCalls();
          }
          // Replace CPU memory exactly as snapshot restoration does; caches
          // still hold old bytes.
          seed(gs.GetRam(), psm, salt);
          std::vector<uint8> expectedRam(gs.GetRam(), gs.GetRam() + (4 << 20));
          gs.seedClut();
          gs.GetRegisters()[0x3d] = 0x010203;
          std::vector<uint64_t> registers(gs.GetRegisters(),
                                          gs.GetRegisters() + 128);
          gs.RestoreMemoryForValidation();
          gs.RestoreMemoryForValidation();
          if (!gs.clutValid() ||
              memcmp(registers.data(), gs.GetRegisters(), 128 * 8))
            throw std::runtime_error(
                "Restore invalidation changed loaded registers/CLUT");
          if (memcmp(expectedRam.data(), gs.GetRam(), 4 << 20))
            throw std::runtime_error("Restore hook overwrote loaded RAM");
          auto actual = gs.ReadCachedForValidation(psm);
          unsigned different = 0;
          for (unsigned i = 0; i < 65536; i++) {
            unsigned w = i ^ salt;
            unsigned expected = psm == 0 || psm == 1
                                    ? w * 2654435761u
                                    : ((w & 31) << 3) |
                                          (((w >> 5) & 31) << 11) |
                                          (((w >> 10) & 31) << 19) |
                                          ((w & 32768) ? 0x80000000 : 0);
            unsigned got;
            memcpy(&got, actual.data() + i * 4, 4);
            different += expected != got;
          }
          if (different)
            throw std::runtime_error(
                "Stale framebuffer after restore psm=" + std::to_string(psm) +
                " pixels=" + std::to_string(different));
          cases++;
          pixels += 65536;
          printf("PASS restore psm=%u salt=%04x pending=%d\n", psm, salt,
                 pending);
        }
    unsigned error = glGetError();
    EM_ASM(
        { window.fixtureResult = ({cases : $0, pixels : $1, glError : $2}); },
        cases, pixels, error);
    gs.close();
    return error ? 1 : 0;
  } catch (const std::exception &e) {
    printf("FAIL %s\n", e.what());
    EM_ASM({ window.fixtureResult = ({error : UTF8ToString($0)}); }, e.what());
    return 2;
  }
}
