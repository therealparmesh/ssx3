#include "app_shared/AppConfig.h"
#include "gs/GSH_OpenGL/GSH_OpenGL.h"
#include <GLES3/gl3.h>
#include <cstdio>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <stdexcept>
#include <vector>
fs::path CAppConfig::GetBasePath() const { return "/tmp"; }
class WebglAliasFixture : public CGSH_OpenGL {
public:
  WebglAliasFixture() : CGSH_OpenGL(false) {}
  void finish() {
    DrainPendingCalls();
    Finish(false);
    DrainPendingCalls();
  }
  void forceChecks() {
    m_aliasValidatedDepth.reset();
    m_aliasCopyValidated = false;
    m_aliasFullSurfaceForValidation = true;
  }
  void evictDepth() {
    m_aliasDepth.reset();
    m_depthbuffers.clear();
    m_renderState.isValid = false;
    m_validGlState = 0;
  }
  void close() { ReleaseImpl(); }
  unsigned pendingRects(){DrainPendingCalls();return m_aliasRects.size();}
  std::vector<unsigned> pixels() {
    if (!m_aliasTarget)
      throw std::runtime_error("Alias path did not create a target");
    glBindFramebuffer(GL_FRAMEBUFFER, m_aliasTarget->m_framebuffer);
    std::vector<unsigned> result(m_aliasTarget->m_width*m_aliasTarget->m_height);
    glReadPixels(0,0,m_aliasTarget->m_width,m_aliasTarget->m_height,GL_RGBA,GL_UNSIGNED_BYTE,result.data());
    return result;
  }

protected:
  void PresentBackbuffer() override {}
};
using Fixture = WebglAliasFixture;
void check(bool ok, const char *message) {
  if (!ok)
    throw std::runtime_error(message);
}
void reg(Fixture &gs, unsigned id, uint64 value) { gs.WriteRegister({uint8(id), value}); }
void seed(Fixture &gs, unsigned base, unsigned z, unsigned width = 64) {
  reg(gs, 0x1a, 1);
  reg(gs, 0, 6);
  reg(gs, 0x46, 1);
  reg(gs, 0x4c, std::uint64_t(width / 64) << 16);
  reg(gs, 0x4e, (base / 8192) | (1ull << 24));
  reg(gs, 0x40, (uint64(width - 1) << 16) | (63ull << 48));
  reg(gs, 0x47, 0x30000);
  reg(gs, 0x18, 0);
  reg(gs, 0x49, 0);
  reg(gs, 0x4a, 0);
  reg(gs, 1, 0x3f80000000110022ull);
  reg(gs, 5, uint64(z) << 32);
  reg(gs, 5, width * 16ull | (64 * 16ull << 16) | (uint64(z) << 32));
  gs.finish();
}
void alias(Fixture &gs, unsigned base, bool force, unsigned width = 64, bool offset = false, bool finishNow = true) {
  if (force)
    gs.forceChecks();
  reg(gs, 0, 0x116);
  reg(gs, 0x3b, 0x8000000000ull);
  reg(gs, 0x45, 0);
  reg(gs, 0x22, 0);
  reg(gs, 0x4c, (uint64(width / 64) << 16) | (2ull << 24) | (0x3fffull << 32));
  reg(gs, 0x4e, (base / 8192) | (1ull << 24) | (1ull << 32));
  reg(gs, 6,
      (base / 256) | (uint64(width / 64) << 14) | (0x32ull << 20) | (uint64(width == 64 ? 6 : 7) << 26) | (6ull << 30) |
          (1ull << 34) | (1ull << 35));
  reg(gs, 0x14, 0);
  reg(gs, 8, 0);
  reg(gs, 0x47, 0x30000);
  const uint64 x=offset?16:0,y=offset?2:0;
  reg(gs,3,(x*16+8)|((y*16+8)<<16));reg(gs,5,x*16|(y*16<<16));
  reg(gs,3,((x+8)*16+8)|(((y+1)*16+8)<<16));reg(gs,5,(x+8)*16|((y+1)*16<<16));
  if(finishNow)gs.finish();
}
unsigned checks() {
  return EM_ASM_INT({ return Module.aliasChecks; });
}
void resetChecks() {
  EM_ASM({ Module.aliasChecks = 0;Module.aliasBlitPixels = 0; });
}
struct Result {
  std::vector<unsigned> first, switched, recreated, resized, reset, multi;
  unsigned same = 0, total = 0, blitPixels = 0, orderedBatches = 0;
};
Result run(bool force) {
  Fixture gs;
  gs.Initialize();
  gs.Reset();
  gs.DrainPendingCalls();
  gs.SetSMODE2(0);
  gs.DrainPendingCalls();
  seed(gs, 2 << 20, 0x4000);
  seed(gs, 3 << 20, 0x8000);
  resetChecks();
  for (unsigned i = 0; i < 64; i++)
    alias(gs, 2 << 20, force);
  Result r;
  r.same = checks();
  r.first = gs.pixels();
  check(gs.GetDepthAliasStats().draws >= 64, "The guarded depth-alias path must execute");
  alias(gs, 3 << 20, force);
  r.switched = gs.pixels();
  check(r.first != r.switched, "Different source depths must change rendered bytes");
  gs.evictDepth();
  seed(gs, 3 << 20, 0xc000);
  alias(gs, 3 << 20, force);
  r.recreated = gs.pixels();
  check(r.recreated != r.switched, "Recreated depth storage must supply new values");
  seed(gs, 2 << 20, 0x4000, 128);
  alias(gs, 2 << 20, force, 128, true);
  r.resized = gs.pixels();
  r.total = checks();
  r.blitPixels = EM_ASM_INT({return Module.aliasBlitPixels;});
  gs.Reset();
  gs.DrainPendingCalls();
  seed(gs, 2 << 20, 0x4000);
  seed(gs, 3 << 20, 0x8000);
  resetChecks();
  alias(gs, 2 << 20, force);
  r.reset = gs.pixels();
  check(checks() == 2, "Reset must revalidate both alias FBOs");
  alias(gs,2<<20,force,64,false,false);
  reg(gs,3,264ull|(40ull<<16));reg(gs,5,256ull|(32ull<<16));
  reg(gs,3,392ull|(56ull<<16));reg(gs,5,384ull|(48ull<<16));
  check(gs.pendingRects()==2,"Disjoint alias rectangles must share a single batch");gs.finish();
  r.multi=gs.pixels();check(r.multi!=r.reset,"The disjoint mapping must update additional pixels");
  r.orderedBatches = EM_ASM_INT({return (Module.ps2OrderedRaster && Module.ps2OrderedRaster.stats.batches)||0;});
  gs.close();
  check(glGetError() == GL_NO_ERROR, "Depth-alias GL error");
  return r;
}
int main() {
  try {
    EmscriptenWebGLContextAttributes a;
    emscripten_webgl_init_context_attributes(&a);
    a.majorVersion = 2;
    a.alpha = false;
    auto context = emscripten_webgl_create_context("#canvas", &a);
    check(context > 0, "WebGL2 context");
    emscripten_webgl_make_context_current(context);
    EM_ASM({
      Module.aliasChecks = 0;Module.aliasBlitPixels = 0;
      const blit=GLctx.blitFramebuffer.bind(GLctx);
      GLctx.blitFramebuffer=function(a,b,c,d,e,f,g,h,mask,filter){Module.aliasBlitPixels+=Math.abs((g-e)*(h-f));return blit(a,b,c,d,e,f,g,h,mask,filter);};
      const original = GLctx.checkFramebufferStatus.bind(GLctx);
      GLctx.checkFramebufferStatus = function(target) {
        Module.aliasChecks++;
        return original(target);
      };
    });
    auto cached = run(false), control = run(true);
    check(cached.same == 2, "Unchanged attachment owners must validate only once");
    check(control.same == 128, "Forced validation must exercise the preceding per-copy behavior");
    // One source-owner change and one expired-owner replacement each need one source check.
    // Depth population also validates each recreated depth's upload FBO.
    check(cached.total >= 8 && control.total == cached.total + 128, "Owner replacement and resize must revalidate their attachments");
    check(cached.first == control.first && cached.switched == control.switched &&
              cached.recreated == control.recreated && cached.resized == control.resized &&
              cached.reset == control.reset && cached.multi==control.multi,
          "Cached and forced validation pixels differ");
    check(cached.first == cached.reset, "Reset changed alias rendering");
    check(cached.blitPixels < control.blitPixels, "Mapped source bounds must reduce depth-copy area");
    std::printf("PASS: six depth-alias ownership cases, identical pixels, %u cached checks versus %u forced checks\n",cached.total,control.total);
    EM_ASM(
        {
          window.fixtureResult =
              ({cases : 6, pixels : $0, cachedChecks : $1, controlChecks : $2, sameOwnerChecks : $3, cachedBlitPixels:$4,controlBlitPixels:$5, orderedBatches:$6, glError : 0});
        },
        cached.first.size()+cached.switched.size()+cached.recreated.size()+cached.resized.size()+cached.reset.size()+cached.multi.size(), cached.total, control.total, cached.same,cached.blitPixels,control.blitPixels,cached.orderedBatches+control.orderedBatches);
    emscripten_webgl_destroy_context(context);
    return 0;
  } catch (const std::exception &e) {
    std::fprintf(stderr, "ALIAS_FAIL: %s\n", e.what());
    EM_ASM({ window.fixtureResult = ({error : UTF8ToString($0)}); }, e.what());
    return 1;
  }
}
