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
#include <string>
#include <vector>
fs::path CAppConfig::GetBasePath() const { return "/tmp"; }
class Fixture : public CGSH_OpenGL {
public:
  Fixture() : CGSH_OpenGL(false) {}
  void close() { ReleaseImpl(); }

protected:
  void PresentBackbuffer() override {}
};
uint32 blend(uint32 src, uint32 dst) {
  uint32 out = src & 0xff000000;
  for (unsigned shift = 0; shift < 24; shift += 8) {
    int s = (src >> shift) & 255, d = (dst >> shift) & 255,
        p = (s - d) * int(src >> 24);
    int v = d + (p >= 0 ? p / 128 : -((-p + 127) / 128));
    out |= uint32(std::max(0, std::min(255, v))) << shift;
  }
  return out;
}
int main() {
  try {
    unsigned cases = 0, pixels = 0;
    for (unsigned context = 0; context < 2; context++) {
      EmscriptenWebGLContextAttributes a;
      emscripten_webgl_init_context_attributes(&a);
      a.majorVersion = 2;
      a.alpha = false;
      a.antialias = false;
      auto handle = emscripten_webgl_create_context("#canvas", &a);
      if (handle <= 0)
        throw std::runtime_error("No WebGL2");
      emscripten_webgl_make_context_current(handle);
      // clang-format off
  EM_ASM({if(new URLSearchParams(location.search).has('skipDestination')){const original=GLctx.getUniformLocation;GLctx.getUniformLocation=function(program,name){return name==='g_destination'?null:original.call(this,program,name);};}});
      // clang-format on
      {
        Fixture gs;
        gs.Initialize();
        for (unsigned reset = 0; reset < 2; reset++) {
          gs.Reset();
          gs.DrainPendingCalls();
          memset(gs.GetRam(), 0, 4 << 20);
          std::vector<uint8> expected(4 << 20);
          auto reg = [&](unsigned id, uint64 value) {
            gs.WriteRegister({uint8(id), value});
          };
          const unsigned base = reset * 65536;
          reg(0x1a, 1);
          reg(0x46, 1);
          reg(0x4c, (base / 8192) | (1ull << 16));
          reg(0x4e, ((2 << 20) / 8192) | (1ull << 24) | (1ull << 32));
          reg(0x40, (63ull << 16) | (63ull << 48));
          reg(0x18, 0);
          reg(0x49, 0);
          reg(0x4a, 0);
          reg(0x42, 0x44);
          uint32 color = 0;
          struct Step {
            uint32 src, mask, test;
            bool abe;
          };
          const Step steps[] = {{0x80304050, 0, 0, false},
                                {0x4060a0e0, 0, 0, true},
                                {0x20f09010, 0x00f00f00, 0, false},
                                {0x8080c040, 0, (1 << 14) | (1 << 15), false},
                                {0x80402080, 0, 1 << 14, false},
                                {0x400080c0, 0, 0, true},
                                {0x802060a0, 0, 0, false},
                                {0x60f08030, 0, 0, true}};
          for (const auto &step : steps) {
            reg(0, 6 | (uint64(step.abe) << 6));
            reg(0x4c, (base / 8192) | (1ull << 16) | (uint64(step.mask) << 32));
            reg(0x47, step.test);
            reg(1, 0x3f80000000000000ull | step.src);
            reg(5, 4 * 16ull | (4 * 16ull << 16));
            reg(5, 12 * 16ull | (12 * 16ull << 16));
            gs.DrainPendingCalls();
            gs.SyncMemoryForValidation();
            const bool datePass =
                !(step.test & (1 << 14)) ||
                (((color >> 31) & 1) == ((step.test >> 15) & 1));
            if (datePass) {
              auto next = step.abe ? blend(step.src, color) : step.src;
              color = (next & ~step.mask) | (color & step.mask);
            }
            CGsPixelFormats::CPixelIndexorPSMCT32 indexor(expected.data(), base,
                                                          1);
            for (unsigned y = 4; y < 12; y++)
              for (unsigned x = 4; x < 12; x++)
                indexor.SetPixel(x, y, color);
            if (memcmp(expected.data(), gs.GetRam(), expected.size()))
              throw std::runtime_error("Destination sampler mismatch context=" +
                                       std::to_string(context) +
                                       " reset=" + std::to_string(reset) +
                                       " step=" + std::to_string(cases % 8));
            cases++;
            pixels += 64;
          }
        }
        gs.close();
      }
      if (glGetError())
        throw std::runtime_error("GL error");
      emscripten_webgl_destroy_context(handle);
    }
    printf("PASS destination sampler contexts=2 resets=4 cases=%u pixels=%u\n",
           cases, pixels);
    // clang-format off
 EM_ASM({window.fixtureResult=({cases:$0,pixels:$1,glError:0});},cases,pixels);
    // clang-format on
    return 0;
  } catch (const std::exception &e) {
    printf("FAIL %s\n", e.what());
    // clang-format off
EM_ASM({window.fixtureResult=({error:UTF8ToString($0)});},e.what());
    // clang-format on
    return 2;
  }
}
