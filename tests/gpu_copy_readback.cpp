#include "ps2/system.hpp"
#include "gs/gpu/gpu.hpp"
#include <emscripten.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <stdexcept>
#ifdef PS2_GPU_WEBGL
#include <GLES3/gl3.h>
#include <algorithm>
#endif

namespace {
using ps2::gs::gpu::DisplaySource;
std::uint32_t pixel(std::uint32_t seed, std::uint32_t index) {
    return 0xff000000u | seed | (((index * 7 + seed * 3) & 255u) << 8) | (((index * 11 + seed * 5) & 255u) << 16);
}
void check(bool ok, const char *what) { if (!ok) { std::fprintf(stderr, "PROBE_FAIL: %s\n", what); std::abort(); } }
DisplaySource source(std::uint32_t seed) {
    const std::uint32_t widths[] = {32, 64, 128, 64}, heights[] = {16, 32, 64, 16};
    return {0, (widths[(seed-1)%4]+63)/64, ps2::gs::PSMCT32, 0, 0, widths[(seed-1)%4], heights[(seed-1)%4], false};
}

constexpr DisplaySource color_source{0, 1, ps2::gs::PSMCT32, 0, 0, 32, 16, false};
void fill_color(std::uint32_t rgba) {
    const std::vector<std::uint32_t> input(color_source.width * color_source.height, rgba);
    ps2::gs::State transfer{};
    transfer.bitbltbuf = static_cast<std::uint64_t>(color_source.fbw) << 48;
    transfer.trxreg = color_source.width | (static_cast<std::uint64_t>(color_source.height) << 32);
    ps2::gs::gpu::image_begin(transfer);
    ps2::gs::gpu::image_data(reinterpret_cast<const std::uint8_t *>(input.data()), input.size() * 4);
}
void color_rectangle(bool textured, std::uint32_t rgba) {
    ps2::gs::State state{};
    state.prim = 6u | (textured ? 0x110u : 0x40u);
    state.prmodecont = 1;
    state.colclamp = 1;
    auto &context = state.ctx[0];
    context.frame = static_cast<std::uint64_t>(color_source.fbw) << 16;
    context.zbuf = 1ull << 32;
    context.scissor = (static_cast<std::uint64_t>(color_source.width - 1) << 16) |
                      (static_cast<std::uint64_t>(color_source.height - 1) << 48);
    // PSMCT32, 32x16 texture, neutral alpha, MODULATE. Reading and writing
    // the same framebuffer follows the game's final color-pass path.
    context.tex0 = (1ull << 14) | (5ull << 26) | (4ull << 30) | (1ull << 34);
    context.clamp = 1u | (1u << 2);
    context.alpha = 0x44; // (source - destination) * source alpha / 128 + destination
    ps2::gs::Vertex vertices[2]{};
    for (auto &vertex : vertices) {
        vertex.r = rgba & 255u;
        vertex.g = (rgba >> 8) & 255u;
        vertex.b = (rgba >> 16) & 255u;
        vertex.a = rgba >> 24;
        vertex.q = 1;
    }
    vertices[1].x = vertices[1].u = color_source.width * 16;
    vertices[1].y = vertices[1].v = color_source.height * 16;
    ps2::gs::gpu::draw(state, vertices, 2);
}
void expect_color(std::uint32_t rgb, std::uint32_t scale) {
    std::vector<std::uint32_t> output;
    std::uint32_t width = 0, height = 0;
    check(ps2::gs::gpu::display(color_source, output, width, height), "Color fixture readback");
    check(width == color_source.width * scale && height == color_source.height * scale,
          "Color fixture scaled dimensions");
    check(output.size() == static_cast<std::size_t>(width) * height, "Color fixture pixel count");
    for (auto value : output) check((value & 0xFFFFFFu) == rgb, "GS fade and modulation pixels");
}
void check_fade_and_modulation(std::uint32_t scale) {
    // Fixed expected colors, independent of the renderer's shader helpers.
    const std::uint32_t cases[][3] = {
        {0x80FFFFFFu, 0x80808080u, 0xFFFFFFu},
        {0x80FFFFFFu, 0x807F5279u, 0xFDA3F1u}, // White -> RGB241/163/253 in the captured final tint pass.
        {0x80C08040u, 0x807F5279u, 0xBE523Cu},
        {0x806496C8u, 0x80FFFFFFu, 0xC7FFFFu},
    };
    for (const auto &sample : cases) {
        fill_color(sample[0]);
        color_rectangle(true, sample[1]);
        expect_color(sample[2], scale);
    }
    const std::uint32_t fades[][2] = {
        {0, 0x4B1F11u}, {64, 0xA58F88u}, {128, 0xFFFFFFu},
    };
    for (const auto &sample : fades) {
        fill_color(0x804B1F11u);
        color_rectangle(false, 0xFFFFFFu | (sample[0] << 24));
        expect_color(sample[1], scale);
    }
    fill_color(0x804B1F11u);
    color_rectangle(false, 0x80FFFFFFu);
    color_rectangle(true, 0x807F5279u);
    expect_color(0xFDA3F1u, scale);
}
}
#ifdef PS2_GPU_WEBGL
#include <array>
#include "gpu_mip_fixture.inc"
#endif

int main() {
    ps2::gs::init();
    check(ps2::gs::gpu::mode() == ps2::gs::gpu::Mode::primary, "Actual GS GPU initialization");
    const std::uint32_t scale = std::getenv("PS2_SCALE") ? std::atoi(std::getenv("PS2_SCALE")) : 1;
    std::vector<std::uint32_t> input, output;
    std::uint32_t width=0, height=0, received=0, pixels=0, hash=2166136261u;
    auto verify = [&] {
        check(!output.empty(), "Nonempty readback");
        const auto seed = output[0] & 255u;
        check(seed == received+1 && seed <= 64, "Every asynchronous frame remains ordered and distinct");
        const auto src = source(seed);
        check(width == src.width*scale && height == src.height*scale, "Resized readback dimensions");
        check(output.size() == static_cast<std::size_t>(width)*height, "Readback pixel count");
        for (std::uint32_t y=0; y<height; ++y) for (std::uint32_t x=0; x<width; ++x) {
            const auto value = output[y*width+x];
            check(value == pixel(seed, (y/scale)*src.width+x/scale), "Display shader pixels and readback copy ordering");
            hash = (hash ^ value) * 16777619u; ++pixels;
        }
        ++received;
    };
    for (std::uint32_t seed=1; seed<=64; ++seed) {
        const auto src = source(seed);
        input.resize(src.width*src.height);
        for (std::uint32_t i=0; i<input.size(); ++i) input[i]=pixel(seed,i);
        ps2::gs::State state{};
        state.bitbltbuf=static_cast<std::uint64_t>(src.fbw)<<48;
        state.trxreg=src.width | (static_cast<std::uint64_t>(src.height)<<32);
        ps2::gs::gpu::image_begin(state);
        ps2::gs::gpu::image_data(reinterpret_cast<const std::uint8_t*>(input.data()),input.size()*4);
        if (ps2::gs::gpu::display_async(src,output,width,height)) verify();
    }
    if (ps2::gs::gpu::display_async(source(64),output,width,height)) verify();
    check(received==64,"All requested frames returned");
    check(ps2::gs::gpu::display(source(64),output,width,height), "Synchronous display readback");
    const auto syncsrc=source(64);
    check(width==syncsrc.width*scale && height==syncsrc.height*scale,"Synchronous dimensions");
    for (std::uint32_t y=0;y<height;++y) for(std::uint32_t x=0;x<width;++x)
        check(output[y*width+x]==pixel(64,(y/scale)*syncsrc.width+x/scale),"Synchronous pixels");
    const auto offset=ps2::gs::address32(0,2,64,40);
    check(offset>=8192,"Exercise a nonzero source-copy offset");
    std::vector<std::uint8_t> memory(ps2::gs::kMemorySize);
    ps2::gs::gpu::download(memory.data(),offset,4,offset);
    for (const auto x: {64u,80u,127u}) {
        std::uint32_t value=0;
        std::memcpy(&value,memory.data()+ps2::gs::address32(0,2,x,40),4);
        check(value==pixel(63,40*128+x),"Nonzero-offset synchronous VRAM readback");
    }
    ps2::gs::gpu::wait_idle();
#ifdef PS2_GPU_WEBGL
    using namespace ps2::gs;
    check(gpu::flush_pending(),"Synchronous WebGL work requests a host browser yield");
    check(!gpu::flush_pending(),"Idle WebGL polling does not request another yield");
    std::vector<std::uint32_t> saved, palette;
    std::uint32_t savedScale=0;
    gpu::read_state(saved,savedScale,palette);
    check(savedScale==1 && saved.size()>kMemorySize/4,"Native GPU snapshot carries transfer metadata");
    gpu::write_state(saved,savedScale,palette);
    check(gpu::display(source(64),output,width,height),"Display after native snapshot restore");
    for(unsigned i=0;i<output.size();i++)check(output[i]==pixel(64,i),"Snapshot retains uploaded pixels");
    State copyState{};
    copyState.bitbltbuf=(1ull<<16)|(0x1000ull<<32)|(1ull<<48);
    copyState.trxpos=2ull|(1ull<<16)|(4ull<<32)|(2ull<<48);
    copyState.trxreg=8ull|(3ull<<32);
    gpu::local_copy(copyState);
    gpu::download(memory.data());
    auto valueAt=[&](unsigned bp,unsigned bw,unsigned x,unsigned y){std::uint32_t value;std::memcpy(&value,memory.data()+address32(bp,bw,x,y),4);return value;};
    for(unsigned y=0;y<3;y++)for(unsigned x=0;x<8;x++)check(valueAt(0x1000,1,4+x,2+y)==pixel(64,(1+y)*64+2+x),"Uncached local copy retains source pixels");
    State state{};state.prim=6;state.prmodecont=1;state.colclamp=1;
    state.ctx[0].frame=1ull<<16;state.ctx[0].zbuf=256ull|(1ull<<24);
    state.ctx[0].test=0x30000;state.ctx[0].scissor=(63ull<<16)|(63ull<<48);
    Vertex vertices[2]{};vertices[0].x=8*16;vertices[0].y=12*16;vertices[1].x=24*16;vertices[1].y=32*16;
    for(auto& v:vertices){v.r=0x19;v.g=0xa9;v.b=0x41;v.a=0x9b;v.z=0x123456;v.q=1;}
    gpu::draw(state,vertices,2);gpu::download(memory.data());
    for(unsigned y=12;y<32;y++)for(unsigned x=8;x<24;x++)check(valueAt(0,1,x,y)==0x9b41a919,"Actual GPU draw exports correct color");
    gpu::read_state(saved,savedScale,palette);const auto exact=saved;
    vertices[0].r=vertices[1].r=0xe8;gpu::draw(state,vertices,2);
    gpu::write_state(saved,savedScale,palette);gpu::download(memory.data());
    check(std::memcmp(memory.data(),exact.data(),kMemorySize)==0,"Restore discards GPU work after snapshot");
    State image{};image.bitbltbuf=(0x1000ull<<32)|(1ull<<48)|(1ull<<56);image.trxpos=(9ull<<32)|(13ull<<48);image.trxreg=6ull|(1ull<<32);
    std::uint8_t payload[32]{};for(unsigned i=0;i<6;i++)for(unsigned b=0;b<3;b++)payload[i*3+b]=(0x123456+i*0x03070b)>>(8*b);
    gpu::image_begin(image);gpu::image_data(payload,16);gpu::read_state(saved,savedScale,palette);
    gpu::write_state(saved,savedScale,palette);gpu::image_data(payload+16,16);gpu::download(memory.data());
    for(unsigned x=0;x<6;x++)check((valueAt(0x1000,1,9+x,13)&0xffffff)==0x123456+x*0x03070b,"Snapshot restores partial RGB24 image transfer");
    gpu::read_state(saved,savedScale,palette);auto invalid=saved;invalid[kMemorySize/4+1]=99;
    bool rejected=false;try{gpu::write_state(invalid,savedScale,palette);}catch(const std::invalid_argument&){rejected=true;}
    check(rejected,"Malformed native snapshot metadata rejected");gpu::download(memory.data());
    check(std::memcmp(memory.data(),saved.data(),kMemorySize)==0,"Rejected snapshot leaves VRAM intact");

    // Errors remain observable after removing per-alias glGetError queries.
    // The negative control consumes real driver errors but lies about success.
    EM_ASM({
      if(new URLSearchParams(location.search).has('skipWebglErrors')){
        const original=GLctx.getError.bind(GLctx);
        GLctx.getError=function(){original();return 0;};
      }
    });
    auto rejectGlFault=[&](auto action,const char* message){
        EM_ASM({GLctx.enable(0xffffffff);});
        bool caught=false;
        try{action();}catch(const std::runtime_error&){caught=true;}
        check(caught,message);
        check(glGetError()==GL_NO_ERROR,"Boundary must consume the injected GL error");
    };
    vertices[0].r=vertices[1].r=0x33;gpu::draw(state,vertices,2);gpu::flush();
    std::fill(memory.begin(),memory.end(),0xa5);const auto sentinel=memory;
    rejectGlFault([&]{gpu::download(memory.data());},"Dirty WebGL export must reject a GL fault");
    check(memory==sentinel,"Failed dirty export must leave caller memory intact");
    gpu::download(memory.data());
    for(unsigned y=12;y<32;y++)for(unsigned x=8;x<24;x++)check(valueAt(0,1,x,y)==0x9b41a933,"Dirty export retry retains GPU pixels");
    const auto clean=memory;
    rejectGlFault([&]{gpu::download(memory.data());},"Clean WebGL export must reject a GL fault");
    check(memory==clean,"Failed clean export must leave caller memory intact");
    saved={0x12345678};palette={0x87654321};savedScale=77;
    rejectGlFault([&]{gpu::read_state(saved,savedScale,palette);},"WebGL snapshot must reject a GL fault");
    check(saved==std::vector<std::uint32_t>{0x12345678} && palette==std::vector<std::uint32_t>{0x87654321} && savedScale==77,"Failed snapshot must leave caller state intact");
    rejectGlFault([&]{gpu::display(source(64),output,width,height);},"WebGL display must reject a GL fault");
    rejectGlFault([&]{gpu::display_async(source(64),output,width,height);},"Async WebGL display must reject a GL fault");
    auto fallback=source(64);fallback.dbx=64;
    rejectGlFault([&]{gpu::display(fallback,output,width,height);},"CPU display fallback must reject a GL fault");
    check(gpu::display(source(64),output,width,height),"Display retries after consumed GL faults");
    for(unsigned y=0;y<height;y++)for(unsigned x=0;x<width;x++)check(output[y*width+x]==(valueAt(0,1,x,y)|0xff000000u),"Display retry retains exact pixels");
#endif
#ifdef PS2_GPU_WEBGL
    verify_runtime_mips();
    EM_ASM({window.qaProbe.webglIntegration=({snapshot:true,drawExport:true,localCopy:true,partialRgb24:true,rejectedSnapshot:true,browserYield:true,glFaults:6});});
#endif
    check_fade_and_modulation(scale);
    ps2::gs::gpu::wait_idle();
    EM_ASM({window.qaProbe.result=({passed:true,frames:$0,pixels:$1,hash:$2>>>0,scale:$3,synchronous:true,nonzeroSourceOffset:$4,modulationCases:4,fadeCases:3,combinedFadeTint:true});},received,pixels,hash,scale,offset);
    return 0;
}
