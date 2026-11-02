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
void check_constant_alpha(std::uint32_t scale) {
    fill_color(0x802814c8u);
    ps2::gs::State state{};
    state.prim = 3u | 8u | 64u;
    state.prmodecont = state.colclamp = 1;
    auto &context = state.ctx[0];
    context.frame = (1ull << 16) | (0xff000000ull << 32);
    context.zbuf = 1ull << 32;
    context.scissor = (31ull << 16) | (15ull << 48);
    context.alpha = 0x81; // Black at alpha 128 leaves destination RGB unchanged.
    ps2::gs::Vertex vertices[3]{};
    const float xy[3][2] = {{1.125f, 1.0625f}, {30.875f, 3.1875f}, {6.4375f, 15.3125f}};
    for (unsigned i = 0; i < 3; ++i) {
        vertices[i].x = unsigned(xy[i][0] * 16);
        vertices[i].y = unsigned(xy[i][1] * 16);
        vertices[i].a = 128;
        vertices[i].q = 1;
    }
    ps2::gs::gpu::draw(state, vertices, 3);
    expect_color(0x2814c8u, scale);
}
void check_varying_color(std::uint32_t scale) {
    fill_color(0x802814c8u);
    ps2::gs::State state{};
    state.prim = 3u | 8u;
    state.prmodecont = state.colclamp = 1;
    auto &context = state.ctx[0];
    context.frame = 1ull << 16;
    context.zbuf = 1ull << 32;
    context.scissor = (31ull << 16) | (15ull << 48);
    ps2::gs::Vertex vertices[3]{};
    const unsigned xy[3][2] = {{1, 1}, {29, 1}, {1, 15}};
    const unsigned red[3] = {0, 128, 255};
    for (unsigned i = 0; i < 3; ++i) {
        vertices[i].x = xy[i][0] * 16; vertices[i].y = xy[i][1] * 16;
        vertices[i].r = red[i]; vertices[i].g = vertices[i].b = vertices[i].a = 128;
        vertices[i].q = 1;
    }
    ps2::gs::gpu::draw(state, vertices, 3);
    std::vector<std::uint32_t> output;
    std::uint32_t width = 0, height = 0;
    check(ps2::gs::gpu::display(color_source, output, width, height), "Varying-color readback");
    check(width == color_source.width * scale && height == color_source.height * scale,
          "Varying-color scaled dimensions");
    // Independent GS sample coordinates: R=floor(128*(x-1)/28+255*(y-1)/14).
    // Every selected value is away from an integer boundary. Green/blue stay 128.
    const unsigned samples[3][3] = {{4, 4, 68}, {18, 2, 95}, {2, 10, 168}};
    for (const auto &sample : samples)
        check((output[sample[1] * scale * width + sample[0] * scale] & 0xffffffu) ==
                  (0x808000u | sample[2]), "Varying red and constant green/blue remain exact");
}
void check_varying_line_color(std::uint32_t scale) {
    fill_color(0x80123456u);
    ps2::gs::State state{};
    state.prim = 1u | 8u;
    state.prmodecont = state.colclamp = 1;
    state.ctx[0].frame = 1ull << 16;
    state.ctx[0].zbuf = 1ull << 32;
    state.ctx[0].scissor = (31ull << 16) | (15ull << 48);
    ps2::gs::Vertex vertices[2]{};
    vertices[0].x = 2 * 16; vertices[1].x = 30 * 16;
    for (auto &v : vertices) { v.y = 3 * 16; v.g = v.b = v.a = 128; v.q = 1; }
    vertices[1].r = 128;
    ps2::gs::gpu::draw(state, vertices, 2);
    std::vector<std::uint32_t> output;
    std::uint32_t width = 0, height = 0;
    check(ps2::gs::gpu::display(color_source, output, width, height), "Varying line readback");
    check(width == 32 * scale && height == 16 * scale, "Varying line dimensions");
    // Independent samples away from integer boundaries: R=floor(128*(x-2)/28).
    // Green/blue remain128. The x=9 rounding-boundary discrepancy is tracked separately.
    const unsigned samples[][2] = {{8, 27}, {19, 77}, {27, 114}};
    for (const auto &sample : samples) {
        const auto actual = output[3 * scale * width + sample[0] * scale] & 0xffffffu;
        const auto expected = 0x808000u | sample[1];
        if (actual != expected) std::fprintf(stderr, "PROBE_LINE_DETAILS x=%u scale=%u actual=%06x expected=%06x\n", sample[0], scale, actual, expected);
        check(actual == expected, "Varying line red and constant green/blue remain exact");
    }
}
void check_triangle_coverage(std::uint32_t scale) {
    fill_color(0x80123456u);
    ps2::gs::State state{};
    state.prim = 3u | 8u;
    state.prmodecont = state.colclamp = 1;
    state.ctx[0].frame = 1ull << 16;
    state.ctx[0].zbuf = 1ull << 32;
    state.ctx[0].scissor = (31ull << 16) | (15ull << 48);
    ps2::gs::Vertex vertices[3]{};
    const unsigned xy[][2] = {{1, 1}, {29, 1}, {1, 15}};
    for (unsigned i = 0; i < 3; ++i) {
        vertices[i].x = xy[i][0] * 16; vertices[i].y = xy[i][1] * 16;
        vertices[i].r = 17; vertices[i].g = 90; vertices[i].b = 165; vertices[i].a = 128; vertices[i].q = 1;
    }
    ps2::gs::gpu::draw(state, vertices, 3);
    std::vector<std::uint32_t> output;
    std::uint32_t width = 0, height = 0;
    check(ps2::gs::gpu::display(color_source, output, width, height), "Triangle coverage readback");
    check(width == 32 * scale && height == 16 * scale, "Triangle coverage dimensions");
    // Integer-coordinate oracle: left/top edges included, diagonal excluded.
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
        const bool inside = x >= scale && y >= scale &&
            14 * (x - scale) + 28 * (y - scale) < 392 * scale;
        const unsigned expected = inside ? 0xa55a11u : 0x123456u;
        check((output[y * width + x] & 0xffffffu) == expected, "Exact triangle coverage and untouched pixels");
    }
}
void check_disjoint_setups(std::uint32_t scale) {
    fill_color(0x80123456u);
    ps2::gs::State state{};
    state.prim = 3u | 8u;
    state.prmodecont = state.colclamp = 1;
    state.ctx[0].zbuf = 1ull << 32;
    state.ctx[0].scissor = (31ull << 16) | (15ull << 48);
    const unsigned origins[3][2] = {{0, 0}, {4, 0}, {0, 0}};
    const unsigned masks[3] = {0x00ffff00u, 0x00ff00ffu, 0x00ff00ffu};
    for (unsigned n = 0; n < 3; ++n) {
        state.ctx[0].frame = (1ull << 16) | (static_cast<std::uint64_t>(masks[n]) << 32);
        ++ps2::gs::g_setup_generation;
        ps2::gs::Vertex vertices[3]{};
        for (auto &v : vertices) { v.r = v.g = v.b = 255; v.a = 128; v.q = 1; }
        vertices[0].x = vertices[2].x = origins[n][0] * 16;
        vertices[0].y = vertices[1].y = origins[n][1] * 16;
        vertices[1].x = (origins[n][0] + 3) * 16;
        vertices[2].y = (origins[n][1] + 3) * 16;
        ps2::gs::gpu::draw(state, vertices, 3);
    }
    std::vector<std::uint32_t> output;
    std::uint32_t width = 0, height = 0;
    check(ps2::gs::gpu::display(color_source, output, width, height), "Disjoint setup readback");
    check(width == 32 * scale && height == 16 * scale, "Disjoint setup dimensions");
    // All triangles share a tile. The missed middle triangle introduces the
    // green mask reused by the last triangle. Skipping it must preserve the
    // pixel's cached setup identity until the visible triangle loads that mask.
    const unsigned samples[][3] = {{1, 1, 0x12ffffu}, {5, 1, 0x12ff56u}, {1, 5, 0x123456u},
                                   {2, 2, 0x123456u}, {6, 2, 0x123456u}, {7, 7, 0x123456u}};
    for (const auto &sample : samples)
        check((output[sample[1] * scale * width + sample[0] * scale] & 0xffffffu) == sample[2],
              "Disjoint triangle setups and untouched pixels remain exact");
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
    unsigned failed_readback_cases = 0;
    if (EM_ASM_INT({ return !!window.qaTestReadFailures; })) {
        EM_ASM({ qaProbe.failNextRead = true; });
        check(!ps2::gs::gpu::display(syncsrc, output, width, height), "Failed synchronous readback is rejected");
        check(ps2::gs::gpu::display(syncsrc, output, width, height), "Synchronous readback recovers");
        ++failed_readback_cases;
        EM_ASM({ qaProbe.failNextRead = true; });
        check(!ps2::gs::gpu::display_async(syncsrc, output, width, height), "Failed asynchronous readback is rejected");
        check(ps2::gs::gpu::display_async(syncsrc, output, width, height), "Asynchronous readback recovers");
        ++failed_readback_cases;
        check(width == syncsrc.width * scale && height == syncsrc.height * scale, "Recovered readback dimensions");
        for (std::uint32_t y = 0; y < height; ++y) for (std::uint32_t x = 0; x < width; ++x)
            check(output[y * width + x] == pixel(64, (y / scale) * syncsrc.width + x / scale), "Recovered readback pixels");
    }
    check_constant_alpha(scale);
    check_varying_color(scale);
    check_varying_line_color(scale);
    check_triangle_coverage(scale);
    check_fade_and_modulation(scale);
    check_disjoint_setups(scale);
    ps2::gs::gpu::wait_idle();
    EM_ASM({window.qaProbe.result=({passed:true,frames:$0,pixels:$1,hash:$2>>>0,scale:$3,synchronous:true,nonzeroSourceOffset:$4,modulationCases:4,fadeCases:3,constantAlphaCases:1,varyingColorCases:3,varyingLineCases:3,failedReadbackCases:$5,disjointSetupSamples:6,coveragePixels:512*$3*$3,combinedFadeTint:true});},received,pixels,hash,scale,offset,failed_readback_cases);
    return 0;
}
