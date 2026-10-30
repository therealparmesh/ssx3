#include "app_shared/AppConfig.h"
#include "gs/GSH_OpenGL/GSH_OpenGL.h"
#include "gs/GsPixelFormats.h"
#include <GLES3/gl3.h>
#include <algorithm>
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
void setPixel(uint8 *mem, unsigned psm, unsigned x, unsigned y, uint32 value) {
  if (psm == 2) {
    CGsPixelFormats::CPixelIndexorPSMCT16 i(mem, 0, 2);
    i.SetPixel(x, y, value);
  } else if (psm == 10) {
    CGsPixelFormats::CPixelIndexorPSMCT16S i(mem, 0, 2);
    i.SetPixel(x, y, value);
  } else {
    CGsPixelFormats::CPixelIndexorPSMCT32 i(mem, 0, 2);
    i.SetPixel(x, y, value);
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
    struct Rect {
      unsigned x, y, w, h;
    };
    for (unsigned psm : {0u, 1u, 2u, 10u})
      for (Rect rect : {Rect{0, 0, 128, 512}, Rect{7, 11, 37, 29},
                        Rect{127, 511, 1, 1}, Rect{63, 31, 4, 3}}) {
        memset(gs.GetRam(), 0, 4 << 20);
        for (unsigned y = 0; y < 512; y++)
          for (unsigned x = 0; x < 128; x++) {
            uint32 word = y * 128 + x;
            setPixel(gs.GetRam(), psm, x, y,
                     psm == 0 || psm == 1 ? word * 2654435761u : word);
          }
        gs.SeedReadbackForValidation(psm);
        // GPU is now authoritative. Poison CPU storage without marking an
        // upload.
        memset(gs.GetRam(), 0xa5, 4 << 20);
        std::vector<uint8> expectedRam(4 << 20, 0xa5), expected;
        unsigned bpp = psm == 0 ? 4 : psm == 1 ? 3 : 2;
        for (unsigned y = rect.y; y < rect.y + rect.h; y++)
          for (unsigned x = rect.x; x < rect.x + rect.w; x++) {
            uint32 word = y * 128 + x,
                   value = psm == 0 || psm == 1 ? word * 2654435761u : word;
            for (unsigned k = 0; k < bpp; k++)
              expected.push_back(value >> (k * 8));
            if (psm == 1)
              value = (value & 0xffffff) | 0xa5000000;
            setPixel(expectedRam.data(), psm, x, y, value);
          }
        unsigned bytes = (expected.size() + 15) & ~15u;
        std::vector<uint8> actual(bytes + 32, 0xcd);
        auto reg = [&](unsigned id, uint64_t value) {
          gs.WriteRegister({uint8_t(id), value});
        };
        reg(0x50, (2ull << 16) | (uint64_t(psm) << 24));
        reg(0x51, rect.x | (uint64_t(rect.y) << 16));
        reg(0x52, rect.w | (uint64_t(rect.h) << 32));
        reg(0x53, 1);
        gs.ProcessWriteBuffer(nullptr);
        gs.ReadImageData(actual.data(), bytes);
        gs.DrainPendingCalls();
        if (!std::equal(expected.begin(), expected.end(), actual.begin()))
          throw std::runtime_error("Packed transfer mismatch psm=" +
                                   std::to_string(psm));
        if (memcmp(expectedRam.data(), gs.GetRam(), 4 << 20))
          throw std::runtime_error(
              "VRAM mismatch/outside rectangle changed psm=" +
              std::to_string(psm));
        if (!std::all_of(actual.begin() + bytes, actual.end(),
                         [](uint8 b) { return b == 0xcd; }))
          throw std::runtime_error("Readback wrote past output psm=" +
                                   std::to_string(psm));
        cases++;
        pixels += rect.w * rect.h;
        printf("PASS readback psm=%u rect=%u,%u %ux%u\n", psm, rect.x, rect.y,
               rect.w, rect.h);
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
