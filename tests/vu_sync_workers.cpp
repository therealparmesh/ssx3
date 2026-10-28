#include "ps2/cpu.hpp"
#include "ps2/system.hpp"
#include "hw.hpp"
#include "vu_micro.hpp"
#include "vu_jit_web.hpp"
#include <array>
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <emscripten.h>
#include <pthread.h>

// Supply memory and a GIF sink without game assets or a GPU. The fixture
// deliberately selects the interpreter; runtime JIT has separate coverage.
namespace ps2 {
Cpu g_cpu{};
Options g_options{};
alignas(16) std::uint8_t g_vu0_code[4096]{},g_vu0_mem[4096]{},g_vu1_code[16384]{},g_vu1_mem[16384]{};
}
namespace ps2::vu::jit {
bool g_dry=false;
std::int64_t g_escape=-1;
std::vector<std::uint32_t>*g_kicks=nullptr;
int mode(){return 0;}
ProgramFn compile(const std::uint8_t*,std::uint32_t){assert(false);return nullptr;}
}
namespace ps2::vu {void run_fast(int,std::uint32_t);}
namespace {
struct GifError {unsigned value;};
bool throw_gif=false;
unsigned kicks=0;
constexpr std::uint32_t nop=0x8000033c,upper_nop=0x2ff,end=0x40000000;
std::uint64_t hash(const void*p,std::size_t n){auto*b=static_cast<const unsigned char*>(p);std::uint64_t h=1469598103934665603ull;while(n--){h^=*b++;h*=1099511628211ull;}return h;}
void put(unsigned unit,unsigned pc,std::uint32_t lo,std::uint32_t hi=upper_nop){auto*code=unit?ps2::g_vu1_code:ps2::g_vu0_code;std::memcpy(code+pc,&lo,4);std::memcpy(code+pc+4,&hi,4);}
std::uint32_t lower(unsigned index,unsigned fields){return 0x80000000u|((index/4)<<6)|(0x3cu+(index&3))|fields;}
void fixtures(){
    setenv("PS2_VU_EXACT","1",1);
    for(unsigned unit:{0u,1u})for(unsigned test=0;test<4;++test){
        auto&r=ps2::vu::regs(unit);auto*mem=unit?ps2::g_vu1_mem:ps2::g_vu0_mem;auto*code=unit?ps2::g_vu1_code:ps2::g_vu0_code;const auto size=unit?16384u:4096u;
        std::memset(&r,0,sizeof r);r.vf[0].w[3]=0x3f800000;r.vf[1].w[0]=0x3f800000;r.vf[2].w[0]=0x40000000;
        for(unsigned i=0;i<size;++i)mem[i]=static_cast<std::uint8_t>(i*7+test);
        std::memset(code,0,size);
        if(test<2){
            const std::uint32_t add=(0xfu<<21)|(2u<<16)|(1u<<11)|(3u<<6)|0x28u;
            for(unsigned pc=0;pc<64*8;pc+=8)put(unit,pc,nop,test?add:upper_nop);
            if(test)put(unit,60*8,(0x16u<<25)|(2u<<16)|(1u<<21)|0x7ffu,add);
            put(unit,62*8,nop,(test?add:upper_nop)|end);
        }else if(test==2){
            r.vi[1]=64;put(unit,0,(9u<<25)|(1u<<16)|(1u<<11)|1u);put(unit,8,nop);
            put(unit,16,(0x29u<<25)|(1u<<11)|0x7fdu);put(unit,24,nop);put(unit,32,nop,upper_nop|end);put(unit,40,nop);
        }else{
            r.vi[1]=4;r.vi[2]=8;
            put(unit,0,lower(0x34,(0xfu<<21)|(3u<<16)|(1u<<11)));
            put(unit,8,lower(0x35,(0xfu<<21)|(2u<<16)|(3u<<11)));
            put(unit,16,nop,upper_nop|end);put(unit,24,nop);
        }
        ps2::vu::code_changed(unit);
        ps2::Vu0Regs before{};std::memcpy(&before,&r,sizeof r);std::array<std::uint8_t,16384> initial{};std::memcpy(initial.data(),mem,size);
        ps2::vu::run_fast(unit,0);ps2::Vu0Regs fast{};std::memcpy(&fast,&r,sizeof r);std::array<std::uint8_t,16384> written{};std::memcpy(written.data(),mem,size);
        if(test==1)assert(r.vf[3].w[0]==0x40400000);
        if(test==2)assert(r.vi[1]==0);
        if(test==3){assert(r.vi[1]==5&&r.vi[2]==9);assert(std::memcmp(mem+8*16,initial.data()+4*16,16)==0);}
        std::memcpy(&r,&before,sizeof r);std::memcpy(mem,initial.data(),size);ps2::vu::run(unit,0);
        assert(std::memcmp(&r,&fast,sizeof r)==0);assert(std::memcmp(mem,written.data(),size)==0);
        std::printf("STATE %u %u %016llX %016llX\n",unit,test,(unsigned long long)hash(&r,sizeof r),(unsigned long long)hash(mem,size));
    }
    // XGKICK crosses both changed functions and a legacy C++ exception bridge.
    auto&r=ps2::vu::regs(1);std::memset(&r,0,sizeof r);r.vf[0].w[3]=0x3f800000;r.vi[1]=1;
    std::memset(ps2::g_vu1_code,0,16384);std::memset(ps2::g_vu1_mem,0,16384);ps2::g_vu1_mem[16+1]=0x80;
    put(1,0,lower(0x6c,1u<<11),upper_nop|end);put(1,8,nop);ps2::vu::code_changed(1);
    throw_gif=true;bool caught=false;
    try{ps2::vu::run_fast(1,0);}catch(const GifError&e){caught=e.value==42;}
    assert(caught&&kicks==1);throw_gif=false;ps2::vu::run_fast(1,0);assert(kicks==2&&r.tpc==16);
    std::puts("PASS: synchronous VU0/VU1 scalar references, integer branches, flags, memory writes and XGKICK exception recovery");
}
std::atomic<bool> done{false};
EM_JS(void,require_sync,(),{if(!ENVIRONMENT_IS_PTHREAD)abort('VU fixture requires a pthread');Asyncify.handleSleep=()=>abort('Unexpected asynchronous VU-worker operation');});
void*worker(void*arg){require_sync();if(arg)emscripten_sleep(1);fixtures();done.store(true);return nullptr;}
}
namespace ps2::gif {
void transfer(int path,const std::uint8_t*data,std::uint32_t count){
    assert(path==1&&count==1&&data[1]==0x80);++kicks;if(throw_gif)throw GifError{42};
}
}
int main(int argc,char**){pthread_t thread;if(pthread_create(&thread,nullptr,worker,argc>1?reinterpret_cast<void*>(1):nullptr))return 1;while(!done.load())emscripten_sleep(1);pthread_join(thread,nullptr);emscripten_sleep(10);emscripten_force_exit(0);}
