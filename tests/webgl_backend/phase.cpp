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
 EM_ASM({Module.qaUboUploads=0;const original=GLctx.bufferData;GLctx.bufferData=function(target,...args){if(target===this.UNIFORM_BUFFER)Module.qaUboUploads++;return original.call(this,target,...args);};if(new URLSearchParams(location.search).has('skipAlphaPhase')){const get=GLctx.getUniformLocation;GLctx.getUniformLocation=function(program,name){return name==='g_alphaPhase'?null:get.call(this,program,name);};}});
    // clang-format on
    Fixture gs;
    gs.Initialize();
    unsigned cases = 0, pixels = 0, deferredSequences = 0;
    for (unsigned reset = 0; reset < 3; reset++)
      for (unsigned method = 0; method < 8; method++)
        for (unsigned fail = 0; fail < 4; fail++) {
          const bool deferred = reset == 2;
          gs.Reset();
          gs.DrainPendingCalls();
          memset(gs.GetRam(), 0, 4 << 20);
          std::vector<uint8> expected(4 << 20);
          uint32 color = 0, depth = 0;
          auto reg = [&](unsigned id, uint64 value) {
            gs.WriteRegister({uint8(id), value});
          };
          reg(0x1a, 1);
          reg(0x46, 1);
          reg(0x4c, 1ull << 16);
          reg(0x4e, ((2 << 20) / 8192) | (1ull << 24));
          reg(0x40, (63ull << 16) | (63ull << 48));
          reg(0x18, 0);
          reg(0x49, 0);
          reg(0x4a, 0);
          reg(0x42, 0x44);
          const uint32 sources[] = {0x8090a0b0, 0x40506070, 0x80f01020,
                                    0x6090d010, 0x404080c0, 0x80a0b0c0};
          for (unsigned step = 0; step < 6; step++) {
            const uint32 src = sources[step], z = 100 * (step + 1);
            const bool abe = step != 0;
            const uint64 test =
                0x30000 | (step ? 1ull | (uint64(method) << 1) | (96ull << 4) |
                                      (uint64(fail) << 12)
                                : 0);
            reg(0, 6 | (uint64(abe) << 6));
            reg(0x47, test);
            reg(1, 0x3f80000000000000ull | src);
            const unsigned left = 4 + (deferred ? step : 0);
            reg(5, left * 16ull | (4 * 16ull << 16) | (uint64(z) << 32));
            reg(5, 12 * 16ull | (12 * 16ull << 16) | (uint64(z) << 32));
            gs.DrainPendingCalls();
            const unsigned alpha = src >> 24;
            const bool pass =
                step == 0 || method == 1 || (method == 2 && alpha < 96) ||
                (method == 3 && alpha <= 96) || (method == 4 && alpha == 96) ||
                (method == 5 && alpha >= 96) || (method == 6 && alpha > 96) ||
                (method == 7 && alpha != 96);
            const auto next = abe ? blend(src, color) : src;
            if (pass) {
              color = next;
              depth = z;
            } else if (fail == 1)
              color = next;
            else if (fail == 2)
              depth = z;
            else if (fail == 3)
              color = (color & 0xff000000) | (next & 0xffffff);
            CGsPixelFormats::CPixelIndexorPSMCT32 ci(expected.data(), 0, 1);
            CGsPixelFormats::CPixelIndexorPSMZ32 zi(expected.data(), 2 << 20,
                                                    1);
            for (unsigned y = 4; y < 12; y++)
              for (unsigned x = left; x < 12; x++) {
                ci.SetPixel(x, y, color);
                zi.SetPixel(x, y, depth);
              }
            // Nested rectangles retain each intermediate result in a separate
            // strip. The deferred cycle exercises successive native passes
            // without a RAM export invalidating all cached GL state.
            if (!deferred || step == 5) {
              gs.SyncMemoryForValidation();
              if (memcmp(expected.data(), gs.GetRam(), expected.size()))
                throw std::runtime_error(
                    "Alpha phase mismatch method=" + std::to_string(method) +
                    " fail=" + std::to_string(fail) +
                    " step=" + std::to_string(step));
              cases++;
              pixels += 64;
              if (deferred)
                ++deferredSequences;
            }
          }
        }
    const auto error = glGetError();
    gs.close();
    if (error)
      throw std::runtime_error("GL error");
    printf("PASS alpha phases cases=%u pixels=%u\n", cases, pixels);
    // clang-format off
EM_ASM({window.fixtureResult=({cases:$0,pixels:$1,deferredSequences:$2,glError:0,uboUploads:Module.qaUboUploads});},cases,pixels,deferredSequences);
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
