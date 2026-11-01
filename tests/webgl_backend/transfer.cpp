// Compare the real transfer dispatch against the preceding per-pixel algorithm.
#include "app_shared/AppConfig.h"
#include "gs/GSH_OpenGL/GSH_OpenGL.h"
#include "gs/GsPixelFormats.h"
#include <emscripten.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>
fs::path CAppConfig::GetBasePath() const { return "/tmp"; }
struct Params { uint32 psm,base,pitch,x,y,width,height,cx,cy; };
class Fixture : public CGSH_OpenGL {
public:
 Fixture():CGSH_OpenGL(false){}
 void setup(const Params& p){
  m_nReg[GS_REG_BITBLTBUF]=(uint64(p.base/256)<<32)|(uint64(p.pitch)<<48)|(uint64(p.psm)<<56);
  m_nReg[GS_REG_TRXPOS]=(uint64(p.x)<<32)|(uint64(p.y)<<48);
  m_nReg[GS_REG_TRXREG]=p.width|(uint64(p.height)<<32);
  m_trxCtx={};m_trxCtx.nRRX=p.cx;m_trxCtx.nRRY=p.cy;
 }
 bool write(const void* p,uint32 bytes,uint32 psm){return (this->*m_transferWriteHandlers[psm])(p,bytes);}
 uint32 x()const{return m_trxCtx.nRRX;} uint32 y()const{return m_trxCtx.nRRY;}
protected:void PresentBackbuffer()override{}
};
uint32 rng=0x712fea91;
uint32 randomWord(){rng^=rng<<13;rng^=rng>>17;rng^=rng<<5;return rng;}
void check(bool ok,const char* s){if(!ok)throw std::runtime_error(s);}
template<class Storage> bool reference(std::vector<uint8>& ram,const Params& p,uint32& cx,uint32& cy,const void* data,uint32 bytes){
 CGsPixelFormats::CPixelIndexor<Storage> index(ram.data(),p.base,p.pitch);
 const auto* input=static_cast<const typename Storage::Unit*>(data);bool dirty=false;
 for(uint32 i=0;i<bytes/sizeof(typename Storage::Unit)&&cy<p.height;i++){
  auto* pixel=index.GetPixelAddress((cx+p.x)%2048,(cy+p.y)%2048);
  if(*pixel!=input[i]){*pixel=input[i];dirty=true;}
  if(++cx==p.width){cx=0;++cy;}
 }
 return dirty;
}
bool reference4(std::vector<uint8>& ram,const Params& p,uint32& cx,uint32& cy,const void* data,uint32 bytes){
 CGsPixelFormats::CPixelIndexorPSMT4 index(ram.data(),p.base,p.pitch);const auto* input=static_cast<const uint8*>(data);bool dirty=false;
 for(uint32 i=0;i<bytes&&cy<p.height;i++)for(uint32 j=0;j<2&&cy<p.height;j++){
  uint32 x=(cx+p.x)%2048,y=(cy+p.y)%2048;uint8 value=(input[i]>>(j*4))&15;
  if(index.GetPixel(x,y)!=value){index.SetPixel(x,y,value);dirty=true;}
  if(++cx==p.width){cx=0;++cy;}
 }
 return dirty;
}
bool original(std::vector<uint8>& ram,const Params& p,uint32& x,uint32& y,const void* data,uint32 bytes){
 switch(p.psm){
 case 0:return reference<CGsPixelFormats::STORAGEPSMCT32>(ram,p,x,y,data,bytes);
 case 2:return reference<CGsPixelFormats::STORAGEPSMCT16>(ram,p,x,y,data,bytes);
 case 10:return reference<CGsPixelFormats::STORAGEPSMCT16S>(ram,p,x,y,data,bytes);
 case 19:return reference<CGsPixelFormats::STORAGEPSMT8>(ram,p,x,y,data,bytes);
 default:return reference4(ram,p,x,y,data,bytes);
 }
}
int main(){try{
 Fixture gs;std::vector<uint8> expected(CGSHandler::RAMSIZE),seed(CGSHandler::RAMSIZE);std::vector<uint32> payload(65536);
 for(auto& b:seed)b=randomWord();for(auto& v:payload)v=randomWord();uint32 cases=0,fragments=0;
 for(uint32 psm:{0u,2u,10u,19u,20u})for(uint32 i=0;i<48;i++){
  Params p{psm,(i%3==0?16383u:randomWord()%16384)*256,randomWord()%64,randomWord()%2048,randomWord()%2048,1+randomWord()%300,1+randomWord()%30,0,0};
  if(i<8){p.x=2040+i;p.y=2045;p.width=(i%2)?129:3;p.height=5;p.pitch=i%4;}
  if(i==8)p.width=0;
  if(i==9)p.cx=p.width+7;
  if(i==10)p.cy=p.height;
  if(i==11)p.height=0;
  if(i==12){p.width=4095;p.height=2;p.pitch=63;}
  if(i==13){p.width=4095;p.height=2;p.pitch=0;}
  if(i==14){p.width=2048;p.height=5;}
  if(i==15){p.width=1;p.height=4095;}
  if(i>=12)p.cx=randomWord()%p.width;
  for(unsigned repeat=0;repeat<2;repeat++){
   if(!repeat){std::memcpy(gs.GetRam(),seed.data(),seed.size());expected=seed;}gs.setup(p);uint32 x=p.cx,y=p.cy;
   // Include empty calls, incomplete units, row/page crossings and excess input.
   for(uint32 bytes:{0u,1u,3u,7u,16u,257u,4099u,65536u}){
    const void* data=payload.data()+((fragments*37)%1024);bool want=original(expected,p,x,y,data,bytes);bool got=gs.write(data,bytes,psm);
    check(want==got,"Dirty flag differs from original transfer");check(x==gs.x()&&y==gs.y(),"Transfer cursor differs from original");
    check(std::memcmp(gs.GetRam(),expected.data(),expected.size())==0,"Full VRAM differs from original transfer");++fragments;
   }
   // Identical complete replay must preserve dirty semantics too.
   gs.setup(p);x=p.cx;y=p.cy;bool want=original(expected,p,x,y,payload.data(),65536);bool got=gs.write(payload.data(),65536,psm);
   check(want==got&&x==gs.x()&&y==gs.y(),"Repeated transfer state differs");check(std::memcmp(gs.GetRam(),expected.data(),expected.size())==0,"Repeated transfer VRAM differs");++fragments;++cases;
  }
 }
 std::vector<uint32> alternate=payload;for(auto& v:alternate)v=~v;
 if(EM_ASM_INT({return new URLSearchParams(location.search).has('bench');}))
 for(uint32 psm:{0u,2u,10u,19u,20u}){
  Params p{psm,0,4,0,0,256,256,0,0};
  uint32 bytes=psm==0?262144:(psm==19?65536:(psm==20?32768:131072));
  std::vector<double> timings;
  for(unsigned round=0;round<6;round++){
   double begin=emscripten_get_now();
   for(unsigned n=0;n<64;n++){gs.setup(p);gs.write(n&1?alternate.data():payload.data(),bytes,psm);}
   if(round)timings.push_back((emscripten_get_now()-begin)/64);
  }
  std::sort(timings.begin(),timings.end());
  EM_ASM({(Module.transferTimings||=([])).push({psm:$0,medianUploadMs:$1,pixels:65536,changed:true});},psm,timings[2]);
 }
 std::printf("PASS transfer: %u cases, %u fragments, full VRAM and cursor equality\n",cases,fragments);
 EM_ASM({window.fixtureResult=({cases:$0,fragments:$1,fullVram:true,timings:Module.transferTimings,glError:0});},cases,fragments);return 0;
}catch(const std::exception& e){std::fprintf(stderr,"TRANSFER_FAIL: %s\n",e.what());EM_ASM({window.fixtureResult={error:UTF8ToString($0)};},e.what());return 1;}}
