#include "ps2/system.hpp"
#include "gs/gpu/gpu.hpp"
#include <emscripten.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

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
}
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
    EM_ASM({window.qaProbe.result=({passed:true,frames:$0,pixels:$1,hash:$2>>>0,scale:$3,synchronous:true,nonzeroSourceOffset:$4});},received,pixels,hash,scale,offset);
    return 0;
}
