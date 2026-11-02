#include "gs/gs.hpp"
#include "gs/raster.hpp"
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#ifdef PS2_RASTER_COVERAGE_STANDALONE
namespace ps2::hw { void intc_raise(unsigned) { throw std::runtime_error("Unexpected interrupt"); } }
#endif
using Point=std::array<std::int64_t,2>;
std::int64_t cross(Point a,Point b){return a[0]*b[1]-b[0]*a[1];}
Point sub(Point a,Point b){return {a[0]-b[0],a[1]-b[1]};}
bool inside(const std::array<Point,3>&v,int x,int y){
 auto area=cross(sub(v[1],v[0]),sub(v[2],v[0]));if(!area)return false;auto sign=area>0?1:-1;
 for(int i=0;i<3;i++){const auto a=v[(i+1)%3],b=v[(i+2)%3];auto e=cross(sub(a,{x*16,y*16}),sub(b,{x*16,y*16}))*sign;auto gx=(a[1]-b[1])*sign,gy=(b[0]-a[0])*sign;if(!(e>0||(e==0&&(gx>0||(gx==0&&gy>0)))))return false;}return true;
}
int main(){try{using namespace ps2::gs;init();unsigned cases=0,pixels=0,miss=0;
 for(const auto size:std::array<Point,3>{{{512,448},{640,448},{511,447}}})
 for(const auto anchor:std::array<Point,3>{{{10,10},{size[0]/2,size[1]/2},{78,size[1]-79}}})
 for(int mirror:{-1,1})for(bool reverse:{false,true}) {
  std::array<Point,3> v{{{-32767,-32766},{32766,32765},{32767,32766}}};
  for(auto&p:v){p[0]=anchor[0]*16+p[0]*mirror;p[1]+=anchor[1]*16;}
  if(reverse)std::swap(v[0],v[1]);
  std::int64_t minx=v[0][0],miny=v[0][1];for(auto&p:v){minx=std::min(minx,p[0]);miny=std::min(miny,p[1]);}
  const auto ofx=-minx,ofy=-miny;if(ofx<0||ofx>65535||ofy<0||ofy>65535)throw std::runtime_error("Invalid XYOFFSET");
  std::memset(memory(),0,kMemorySize);State state{};state.prmodecont=state.colclamp=1;state.prim=3;
  auto&ctx=state.ctx[0];ctx.xyoffset=std::uint64_t(ofx)|(std::uint64_t(ofy)<<32);ctx.frame=(std::uint64_t(size[0]+63)/64)<<16;ctx.zbuf=128ull|(1ull<<24);
  const int px=int(anchor[0]),py=int(anchor[1]);ctx.scissor=std::uint64_t(px-2)|(std::uint64_t(px+2)<<16)|(std::uint64_t(py-2)<<32)|(std::uint64_t(py+2)<<48);
  Vertex input[3]{};for(int i=0;i<3;i++){auto x=v[i][0]+ofx,y=v[i][1]+ofy;if(x<0||x>65535||y<0||y>65535)throw std::runtime_error("Invalid XY");input[i].x=unsigned(x);input[i].y=unsigned(y);input[i].z=100;input[i].q=1;input[i].r=input[i].a=255;}
  raster::draw(state,input,3);
  for(int y=py-2;y<=py+2;y++)for(int x=px-2;x<=px+2;x++){const auto expected=inside(v,x,y)?0xff0000ffu:0u;auto actual=read_pixel(PSMCT32,0,unsigned(size[0]+63)/64,x,y);pixels++;if(actual!=expected){if(!miss)std::printf("First mismatch %d,%d want=%08x actual=%08x\n",x,y,expected,actual);miss++;}}
  cases++;
 }
 std::printf("%s cases=%u pixels=%u wrong=%u\n",miss?"FAIL":"PASS",cases,pixels,miss);return miss?1:0;
}catch(const std::exception&e){std::fprintf(stderr,"FAIL %s\n",e.what());return 1;}}
