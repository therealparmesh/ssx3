#include "app_shared/AppConfig.h"
#include "gs/GSH_OpenGL/GSH_OpenGL.h"
#include "gs/GsPixelFormats.h"
#include <GLES3/gl3.h>
#include <cstdio>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <stdexcept>
fs::path CAppConfig::GetBasePath() const { return "/tmp"; }
class Fixture : public CGSH_OpenGL {
public:
  Fixture() : CGSH_OpenGL(false) {}
  void close() { ReleaseImpl(); }

protected:
  void PresentBackbuffer() override {}
};
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
    unsigned total = 0, different = 0;
    for (unsigned psm : {0u, 2u, 10u})
      for (bool dirty : {false, true}) {
        CGsPixelFormats::CPixelIndexorPSMCT32 indexor32(gs.GetRam(), 0, 1);
        CGsPixelFormats::CPixelIndexorPSMCT16 indexor(gs.GetRam(), 0, 1);
        CGsPixelFormats::CPixelIndexorPSMCT16S indexorS(gs.GetRam(), 0, 1);
        for (unsigned y = 0; y < 1024; y++)
          for (unsigned x = 0; x < 64; x++) {
            unsigned word = y * 64 + x;
            if (psm == 0)
              indexor32.SetPixel(x, y, word * 2654435761u);
            else if (psm == 2)
              indexor.SetPixel(x, y, word);
            else
              indexorS.SetPixel(x, y, word);
          }
        auto actual = gs.ReadPopulationForValidation(psm, dirty);
        unsigned mismatches = 0;
        for (unsigned i = 0; i < 65536; i++) {
          unsigned w = dirty ? i ^ 65535 : i;
          unsigned expected = ((w & 31) << 3) | (((w >> 5) & 31) << 11) |
                              (((w >> 10) & 31) << 19) |
                              ((w & 32768) ? 0x80000000 : 0);
          if (psm == 0)
            expected = (i * 2654435761u) ^ (dirty ? 0xffffffffu : 0);
          unsigned got;
          memcpy(&got, actual.data() + i * 4, 4);
          if (got != expected) {
            if (mismatches < 3)
              printf("DIFF psm=%u dirty=%d word=%04x got=%08x expected=%08x\n",
                     psm, dirty, w, got, expected);
            mismatches++;
          }
        }
        total += 65536;
        different += mismatches;
        printf("POPULATION psm=%u dirty=%d mismatches=%u/65536\n", psm, dirty,
               mismatches);
      }
    unsigned error = glGetError();
    EM_ASM(
        {
          window.fixtureResult =
              ({differentPixels : $0, pixels : $1, glError : $2});
        },
        different, total, error);
    gs.close();
    return different || error ? 1 : 0;
  } catch (const std::exception &e) {
    EM_ASM({ window.fixtureResult = ({error : UTF8ToString($0)}); }, e.what());
    return 2;
  }
}
