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
    check_fade_and_modulation(scale);
    ps2::gs::gpu::wait_idle();
    EM_ASM({window.qaProbe.result=({passed:true,frames:$0,pixels:$1,hash:$2>>>0,scale:$3,synchronous:true,nonzeroSourceOffset:$4,modulationCases:4,fadeCases:3,combinedFadeTint:true});},received,pixels,hash,scale,offset);
    return 0;
}
