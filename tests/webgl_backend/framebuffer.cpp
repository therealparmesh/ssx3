// Asset-free native framebuffer source and pixel-local feedback verification.
#include "app_shared/AppConfig.h"
#include "gs/GSH_OpenGL/GSH_OpenGL.h"
#include <GLES3/gl3.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <stdexcept>
#include <string>
#include <vector>
fs::path CAppConfig::GetBasePath() const { return "/tmp"; }
void check(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
class WebglFramebufferSpriteFixture : public CGSH_OpenGL {
public:
 WebglFramebufferSpriteFixture():CGSH_OpenGL(false){}
 void close(){ReleaseImpl();}
 void setup(){
  Initialize();Reset();DrainPendingCalls();m_orderedRasterEnabled=true;
  src=std::make_shared<CFramebuffer>(0,128,512,PSMCT32,1,false);
  dst=std::make_shared<CFramebuffer>(1<<20,64,64,PSMCT32,1,false);
  depth=std::make_shared<CDepthbuffer>(2<<20,64,64,1,1,false);
  m_framebuffers={src,dst};m_depthbuffers={depth};
  glBindFramebuffer(GL_FRAMEBUFFER,dst->m_framebuffer);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER,GL_DEPTH_ATTACHMENT,GL_RENDERBUFFER,depth->m_depthBuffer);
  glDepthMask(GL_TRUE);glDisable(GL_SCISSOR_TEST);glClearDepthf(0);glClear(GL_DEPTH_BUFFER_BIT);
  check(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE,"Incomplete target");
  source.resize(128*512);initial.resize(64*64);palette.resize(256);
  for(unsigned y=0;y<512;y++)for(unsigned x=0;x<128;x++)source[y*128+x]=((x*37+y*13)&255)|(((x*19^y*71)&255)<<8)|(((x*43+y*97)&255)<<16)|(((x*7+y*17)&255)<<24);
  for(unsigned y=0;y<64;y++)for(unsigned x=0;x<64;x++)initial[y*64+x]=((x*23+y*59)&255)|(((x*41+y*3)&255)<<8)|(((x*13+y*31)&255)<<16)|(((x*61+y*7)&255)<<24);
  for(unsigned i=0;i<256;i++)palette[i]=((i*7)&255)|(((i*19+53)&255)<<8)|(((i*31+106)&255)<<16)|(((i*43+159)&255)<<24);
  glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,src->m_texture);glTexSubImage2D(GL_TEXTURE_2D,0,0,0,128,512,GL_RGBA,GL_UNSIGNED_BYTE,source.data());
  // These authoritative GPU pixels intentionally differ from zeroed GS RAM.
  memset(GetRam(),0,4<<20);src->m_cachedArea.ClearDirtyPages();src->m_gpuDirty.include(0,0,128,512);
  pal=Framework::OpenGl::CTexture::Create();glBindTexture(GL_TEXTURE_2D,pal);glTexStorage2D(GL_TEXTURE_2D,1,GL_RGBA8,256,1);glTexSubImage2D(GL_TEXTURE_2D,0,0,0,256,1,GL_RGBA,GL_UNSIGNED_BYTE,palette.data());
 }
 void state(unsigned psm,bool blend,unsigned logicalWidth=256){
  m_renderState={};m_renderState.isValid=true;m_renderState.frameReg=((1<<20)/8192)|(1ull<<16);
  m_renderState.zbufReg=((2<<20)/8192)|(1ull<<24)|(1ull<<32);
  m_renderState.primReg=6|16|256|(blend?64:0);
  m_renderState.testReg=0;m_renderState.alphaReg=1;
  m_renderState.scissorReg=(63ull<<16)|(63ull<<48);
  m_renderState.tex0Reg=(2ull<<14)|(uint64(psm)<<20)|(uint64(logicalWidth==256?8:7)<<26)|(9ull<<30)|(1ull<<34)|(1ull<<35);
  m_renderState.framebufferHandle=dst->m_framebuffer;m_renderState.texture0Handle=src->m_texture;m_renderState.texture1Handle=pal;m_renderState.texture0AlphaAsIndex=psm==PSMT8H;
  m_renderState.texture0MinFilter=GL_NEAREST;m_renderState.texture0MagFilter=GL_NEAREST;
  m_renderState.tex1Reg=0;m_renderState.clampReg=0;m_renderState.texAReg=0x8000000000ull;
  m_nReg[GS_REG_PABE]=0;m_nReg[GS_REG_FBA_1]=0;m_nReg[GS_REG_COLCLAMP]=1;m_nReg[GS_REG_SCANMSK]=0;m_nReg[0x45]=0;
  m_primitiveType=PRIM_SPRITE;m_drawingToDepth=false;m_validGlState=0;
  glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,dst->m_texture);glTexSubImage2D(GL_TEXTURE_2D,0,0,0,64,64,GL_RGBA,GL_UNSIGNED_BYTE,initial.data());
 }
 void rectangle(float x0,float y0,float x1,float y1,float u0,float v0,float u1,float v1,unsigned logicalWidth=256){
  auto vertex=[&](float x,float y,float u,float v){return PRIM_VERTEX{x,y,0x4000,0x80808080,u/logicalWidth,v/512,1,0};};
  m_vertexBuffer={vertex(x0,y0,u0,v0),vertex(x1,y0,u1,v0),vertex(x0,y1,u0,v1),vertex(x0,y1,u0,v1),vertex(x1,y0,u1,v0),vertex(x1,y1,u1,v1)};
 }
 std::vector<unsigned> pixels(){std::vector<unsigned> out(64*64);glBindFramebuffer(GL_FRAMEBUFFER,dst->m_framebuffer);glReadPixels(0,0,64,64,GL_RGBA,GL_UNSIGNED_BYTE,out.data());check(glGetError()==0,"Framebuffer read GL error");return out;}
 void positive(unsigned psm,bool blend,unsigned flips,unsigned logicalWidth,bool clipped=false,bool fractional=false){
  state(psm,blend,logicalWidth);
  const float x0=clipped?-8:fractional?4.25f:4,y0=fractional?8.25f:8,x1=x0+32,y1=y0+32;
  const float s0=clipped?-7.5f:fractional?32.75f:32.5f,t0=fractional?24.75f:24.5f;
  const float u0=(flips&1)?s0+32:s0,u1=(flips&1)?s0:s0+32,v0=(flips&2)?t0+32:t0,v1=(flips&2)?t0:t0+32;
  rectangle(x0,y0,x1,y1,u0,v0,u1,v1,logicalWidth);
  check(IsOrderedTileEligible(),"Guarded framebuffer source not structurally eligible");
  if(EM_ASM_INT({return new URLSearchParams(location.search).has('wrongAlpha');}) && psm==PSMT8H)m_renderState.texture0AlphaAsIndex=false;
  const int before=EM_ASM_INT({return Module.ps2OrderedRaster?.stats.framebufferSpriteBatches||0;});
  check(RenderOrderedTileBatch(),"Texel-center framebuffer source refused");
  check(EM_ASM_INT({return Module.ps2OrderedRaster?.stats.framebufferSpriteBatches||0;})==before+1,"Framebuffer routing counter did not advance");
  auto expected=initial;
  for(int y=std::max(0,int(std::ceil(y0)));y<std::min(64,int(std::ceil(y1)));y++)for(int x=std::max(0,int(std::ceil(x0)));x<std::min(64,int(std::ceil(x1)));x++){
   const int u=int(std::floor(u0+(u1-u0)*(x-x0)/(x1-x0))),v=int(std::floor(v0+(v1-v0)*(y-y0)/(y1-y0)));
   check(u>=0&&u<128&&v>=0&&v<512,"Invalid fixture source sample");unsigned color=source[v*128+u];if(psm==PSMT8H)color=palette[color>>24];
   if(blend){const unsigned previous=initial[y*64+x];unsigned out=color&0xff000000u;const int alpha=color>>24;for(unsigned c=0;c<24;c+=8){const int cs=(color>>c)&255,cd=(previous>>c)&255,value=std::clamp((((cd-cs)*alpha)>>7)+cs,0,255);out|=unsigned(value)<<c;}color=out;}
   expected[y*64+x]=color;
  }
  const auto actual=pixels();if(actual!=expected){for(unsigned i=0;i<actual.size();i++)if(actual[i]!=expected[i]){printf("Mismatch psm=%u blend=%u flips=%u logical=%u at=%u actual=%08x expected=%08x\n",psm,blend,flips,logicalWidth,i,actual[i],expected[i]);break;}throw std::runtime_error("Framebuffer sprite independent pixel oracle mismatch");}
 }
 void overlap(unsigned psm){
  state(psm,true);rectangle(4,8,36,40,32.5,24.5,64.5,56.5);auto first=m_vertexBuffer;
  rectangle(20,16,52,48,64.5,64.5,96.5,96.5);m_vertexBuffer.insert(m_vertexBuffer.begin(),first.begin(),first.end());
  check(IsOrderedTileEligible() && RenderOrderedTileBatch(),"Overlapping framebuffer sprites refused");
  auto expected=initial;
  for(unsigned pass=0;pass<2;pass++){const unsigned left=pass?20:4,top=pass?16:8,sx=pass?64:32,sy=pass?64:24;
   for(unsigned y=top;y<top+32;y++)for(unsigned x=left;x<left+32;x++){
    unsigned color=source[(sy+y-top)*128+sx+x-left];if(psm==PSMT8H)color=palette[color>>24];
    const unsigned previous=expected[y*64+x];unsigned out=color&0xff000000u;const int alpha=color>>24;
    for(unsigned c=0;c<24;c+=8){const int cs=(color>>c)&255,cd=(previous>>c)&255;out|=unsigned(std::clamp((((cd-cs)*alpha)>>7)+cs,0,255))<<c;}expected[y*64+x]=out;
   }
  }
  check(pixels()==expected,"Overlapping framebuffer sprites lost ordered destination updates");
 }
 void selfFeedback(unsigned psm,bool blend,unsigned mask){
  state(psm,blend,128);m_renderState.texture0Handle=dst->m_texture;
  m_renderState.textureFeedback=true;m_renderState.viewportWidth=64;m_renderState.viewportHeight=64;
  m_renderState.tex0Reg=((1<<20)/256)|(1ull<<14)|(uint64(psm)<<20)|(7ull<<26)|(9ull<<30)|(1ull<<34)|(uint64(psm==PSMCT32?0:1)<<35);
  m_renderState.frameReg|=uint64(mask)<<32;
  rectangle(4,8,36,40,4.5,8.5,36.5,40.5,128);auto first=m_vertexBuffer;
  rectangle(20,16,52,48,20.5,16.5,52.5,48.5,128);m_vertexBuffer.insert(m_vertexBuffer.begin(),first.begin(),first.end());
  const unsigned tint=0x80758588;for(auto&v:m_vertexBuffer)v.color=tint;
  check(IsOrderedTileEligible()&&IsPixelFeedbackBatch(),"Identity feedback sprite proof failed");
  const int before=EM_ASM_INT({return Module.ps2OrderedRaster?.stats.pixelFeedbackBatches||0;});
  check(RenderOrderedTileBatch(),"Identity feedback sprite refused");
  check(EM_ASM_INT({return Module.ps2OrderedRaster?.stats.pixelFeedbackBatches||0;})==before+1,"Feedback kernel not exercised");
  auto expected=initial;
  for(unsigned pass=0;pass<2;pass++){const unsigned left=pass?20:4,top=pass?16:8;
   for(unsigned y=top;y<top+32;y++)for(unsigned x=left;x<left+32;x++){
    const unsigned previous=expected[y*64+x];unsigned color=psm==PSMT8H?palette[previous>>24]:previous;
    if(psm==PSMCT32){unsigned out=0;for(unsigned c=0;c<32;c+=8)out|=unsigned(std::min(255,(int((color>>c)&255)*int((tint>>c)&255))>>7))<<c;color=out;}
    if(blend){unsigned out=color&0xff000000u;const int alpha=color>>24;for(unsigned c=0;c<24;c+=8){const int cs=(color>>c)&255,cd=(previous>>c)&255;out|=unsigned(std::clamp((((cd-cs)*alpha)>>7)+cs,0,255))<<c;}color=out;}
    expected[y*64+x]=(color&~mask)|(previous&mask);
   }
  }
  check(pixels()==expected,"Pixel feedback failed independent sequential source/destination oracle");
  // Prove raw incoming latches before changing the native flush policy.
  m_PrimitiveMode<<=m_renderState.primReg;m_nReg[GS_REG_TEX0_1]=m_renderState.tex0Reg;m_nReg[GS_REG_FRAME_1]=m_renderState.frameReg;m_nReg[GS_REG_TEX1_1]=0;m_nReg[GS_REG_XYOFFSET_1]=0;
  m_VtxBuffer[1].position=(4*16ull)|((8*16ull)<<16);m_VtxBuffer[0].position=(36*16ull)|((40*16ull)<<16);
  m_VtxBuffer[1].uv=(4*16ull+8)|((8*16ull+8)<<16);m_VtxBuffer[0].uv=(36*16ull+8)|((40*16ull+8)<<16);
  check(IsCurrentPixelFeedbackSprite(),"Valid incoming identity sprite refused");
  m_nReg[GS_REG_CLAMP_1]=2;check(!IsCurrentPixelFeedbackSprite(),"Remapped incoming feedback source accepted");m_nReg[GS_REG_CLAMP_1]=0;
  m_VtxBuffer[0].uv+=16;check(!IsCurrentPixelFeedbackSprite(),"Shifted incoming feedback source accepted");
  m_vertexBuffer[0].s+=1.0f/128;check(!IsPixelFeedbackBatch(),"Shifted queued feedback source accepted");
 }
 void rejections(){
  auto fresh=[&](){state(PSMCT32,false);rectangle(4,8,36,40,32.5,24.5,64.5,56.5);};
  auto refused=[&](){check(IsOrderedTileEligible(),"Expected structural eligibility before sample proof");const auto before=pixels();check(!RenderOrderedTileBatch(),"Unsafe sample domain accepted");check(pixels()==before,"Rejected batch mutated GPU pixels");};
  fresh();rectangle(4,8,36,40,32.5,24.5,96.5,56.5);refused(); // Scaling
  fresh();rectangle(4,8,36,40,32.25,24.5,64.25,56.5);refused(); // Noncenters
  fresh();rectangle(4,8,36,40,112.5,24.5,144.5,56.5);refused(); // Physical width
  fresh();rectangle(4,8,36,40,-16.5,24.5,15.5,56.5);refused(); // Negative U
  fresh();auto second=m_vertexBuffer;rectangle(4,8,36,40,112.5,24.5,144.5,56.5);m_vertexBuffer.insert(m_vertexBuffer.begin(),second.begin(),second.end());refused(); // One bad rectangle rejects full batch
  fresh();m_renderState.texture0MinFilter=GL_LINEAR;check(!IsOrderedTileEligible(),"Linear MIN accepted");
  fresh();m_renderState.texture0MagFilter=GL_LINEAR;check(!IsOrderedTileEligible(),"Linear MAG accepted");
  fresh();m_renderState.tex1Reg=4;check(!IsOrderedTileEligible(),"Mip chain accepted");
  fresh();m_renderState.primReg&=~256ull;check(!IsOrderedTileEligible(),"STQ alias accepted");
  fresh();m_renderState.texture0Handle=dst->m_texture;check(!IsOrderedTileEligible(),"Wrong-base feedback accepted");
  fresh();m_renderState.tex0Reg|=1;check(!IsOrderedTileEligible(),"Offset framebuffer address accepted");
  fresh();m_renderState.tex0Reg^=3ull<<14;check(!IsOrderedTileEligible(),"Incompatible buffer width accepted");
  fresh();m_renderState.clampReg=2;check(!IsOrderedTileEligible(),"Region clamp source accepted");
  fresh();m_renderState.clampReg=3;check(!IsOrderedTileEligible(),"Region repeat source accepted");
  rejected=14;
 }
 unsigned rejected=0;
protected:void PresentBackbuffer()override{}
private:FramebufferPtr src,dst;DepthbufferPtr depth;Framework::OpenGl::CTexture pal;std::vector<unsigned> source,initial,palette;
};
int main(){try{
 EmscriptenWebGLContextAttributes a;emscripten_webgl_init_context_attributes(&a);a.majorVersion=2;a.alpha=false;a.antialias=false;const auto context=emscripten_webgl_create_context("#canvas",&a);check(context>0,"No WebGL2");emscripten_webgl_make_context_current(context);
 EM_ASM({if(new URLSearchParams(location.search).has('staleFeedback')){const before=Module.orderedKernelSource;const after=before.replace('feedbackPixel = dst;','feedbackPixel = texelFetch(initialColor, pixel, 0);');if(after===before)throw Error('Stale feedback control did not apply');Module.orderedKernelSource=after;}});
 unsigned cases=0,rejections=0,feedbackBatches=0,orderedBatches=0;{WebglFramebufferSpriteFixture gs;gs.setup();for(unsigned psm:{0u,27u})for(bool blend:{false,true})for(unsigned flips=0;flips<4;flips++)for(unsigned logical:{128u,256u}){gs.positive(psm,blend,flips,logical);cases++;}for(unsigned psm:{0u,27u}){gs.positive(psm,false,0,256,true);cases++;gs.positive(psm,true,0,256,false,true);cases++;}for(unsigned psm:{0u,27u}){gs.overlap(psm);cases++;}for(unsigned psm:{0u,27u})for(bool blend:{false,true})for(unsigned mask:{0u,0xff000000u}){gs.selfFeedback(psm,blend,mask);cases++;}gs.rejections();rejections=gs.rejected;feedbackBatches=EM_ASM_INT({return Module.ps2OrderedRaster?.stats.pixelFeedbackBatches||0;});orderedBatches=EM_ASM_INT({return Module.ps2OrderedRaster?.stats.batches||0;});gs.close();}check(glGetError()==0,"GL error after release");emscripten_webgl_destroy_context(context);
 EM_ASM({globalThis.fixtureResult=({passed:true,cases:$0,pixels:$0*4096,rejections:$1,feedbackBatches:$2,orderedBatches:$3,glError:0});},cases,rejections,feedbackBatches,orderedBatches);printf("PASS framebuffer source cases=%u rejections=%u\n",cases,rejections);return 0;
 }catch(const std::exception&e){printf("FAIL %s\n",e.what());EM_ASM({globalThis.fixtureResult=({passed:false,error:UTF8ToString($0),glError:$1});},e.what(),glGetError());return 2;}}
