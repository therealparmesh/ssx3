#include "gs/gs.hpp"
#include "gs/raster.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <stdexcept>

#ifdef PS2_RASTER_FLAT_STANDALONE
namespace ps2::hw {
void intc_raise(unsigned) { throw std::runtime_error("Unexpected GS interrupt"); }
}
#endif

namespace {
void expect(bool ok, const char *what) {
    if (!ok) throw std::runtime_error(what);
}
constexpr unsigned background = 0x6f123456, flat = 0x40a7c953, z = 175;

void test(bool line, bool reverse, bool clip, unsigned mode) {
    using namespace ps2::gs;
    const bool gouraudDepthOnly = mode == 2;
    const bool constantAlpha = mode == 3;
    const bool mixedColor = mode == 4;
    const unsigned depthValue = mode == 0 ? 0 : z;
    std::memset(memory(), 0, kMemorySize);
    State s{};
    s.prmodecont = s.colclamp = 1;
    s.prim = (line ? 1u : 3u) | ((gouraudDepthOnly || constantAlpha || mixedColor) ? 8u : 0u) | (constantAlpha ? 64u : 0u);
    auto &c = s.ctx[0];
    c.xyoffset = 16384ull | (16384ull << 32);
    c.frame = 1ull << 16;
    if (gouraudDepthOnly) c.frame |= 0xffffffffull << 32;
    c.zbuf = 128ull | (1ull << 24);
    c.test = 0x30000;
    if (constantAlpha) {
        c.alpha = 0x81; // (Cd - Cs) * As / 128 + 0: identity for Cs=0, As=128.
        c.frame |= 0xff000000ull << 32;
    }
    c.scissor = (63ull << 16) | (63ull << 48);
    if (clip) c.scissor = 9ull | (39ull << 16) | (11ull << 32) | (45ull << 48);
    for (unsigned y = 0; y < 64; ++y)
        for (unsigned x = 0; x < 64; ++x) {
            write_pixel(PSMCT32, 0, 1, x, y, background);
            write_pixel(0x31, 4096, 1, x, y, 0);
        }
    // A non-power-of-two triangle area exposes rounding that axis-aligned
    // rectangles hide. Colors differ, so flat shading must select the endpoint.
    const float xy[3][2] = {
        {3.0625f, 5.9375f}, {59.8125f, 9.125f}, {17.9375f, 55.0625f},
    };
    Vertex v[3]{};
    for (unsigned i = 0; i < 3; ++i) {
        v[i].x = unsigned(xy[i][0] * 16) + 16384;
        v[i].y = unsigned(xy[i][1] * 16) + 16384;
        v[i].z = depthValue;
        v[i].q = 1;
        v[i].r = 13 + i * 7; v[i].g = 37 + i * 9;
        v[i].b = 61 + i * 11; v[i].a = 83 + i * 13;
    }
    if (line) { v[1].x = v[2].x; v[1].y = v[2].y; }
    if (reverse) std::swap(v[0], v[1]);
    auto &last = v[line ? 1 : 2];
    last.r = flat & 255; last.g = (flat >> 8) & 255;
    last.b = (flat >> 16) & 255; last.a = flat >> 24;
    if (constantAlpha)
        for (auto &vertex : v) {
            vertex.r = vertex.g = vertex.b = 0; vertex.a = 128;
        }
    if (mixedColor)
        for (auto &vertex : v) vertex.g = vertex.b = vertex.a = 128;
    raster::draw(s, v, line ? 2 : 3);
    unsigned covered = 0;
    for (unsigned y = 0; y < 64; ++y)
        for (unsigned x = 0; x < 64; ++x) {
            const auto rgba = read_pixel(PSMCT32, 0, 1, x, y);
            const auto depth = read_pixel(0x31, 4096, 1, x, y);
            if (rgba != background || depth != 0) {
                ++covered;
                expect(depth == depthValue, "Equal vertex depths must remain constant");
                if (mixedColor)
                    expect((rgba & 0xffffff00u) == 0x80808000u,
                           "Constant channels must survive a varying red component");
                else
                    expect(rgba == ((gouraudDepthOnly || constantAlpha) ? background : flat),
                           "Flat or constant-alpha color must remain exact");
            }
        }
    expect(covered > 0, "Regression shape must draw pixels");
}

void test_constant_attributes(bool texture, bool gouraud, bool reverse, bool clip, float q) {
    using namespace ps2::gs;
    std::memset(memory(), 0, kMemorySize);
    State s{};
    s.prmodecont = s.colclamp = 1;
    s.prim = 3u | (gouraud ? 8u : 0u) | (texture ? 16u : 32u);
    auto &c = s.ctx[0];
    c.xyoffset = 16384ull | (16384ull << 32);
    c.frame = 1ull << 16;
    c.zbuf = 128ull | (1ull << 24);
    c.scissor = (63ull << 16) | (63ull << 48);
    if (clip) c.scissor = 9ull | (39ull << 16) | (11ull << 32) | (45ull << 48);
    c.tex0 = 2048ull | (1ull << 14) | (6ull << 26) | (6ull << 30) |
             (1ull << 34) | (1ull << 35); // RGBA32, DECAL, 64x64.
    for (unsigned y = 0; y < 64; ++y)
        for (unsigned x = 0; x < 64; ++x) {
            write_pixel(PSMCT32, 0, 1, x, y, background);
            write_pixel(0x31, 4096, 1, x, y, 0);
            write_pixel(PSMCT32, 2048, 1, x, y,
                        x * 4 | (y * 4 << 8) | ((x ^ y) * 4 << 16) |
                            ((x & 8) ? 0x80000000u : 0));
        }
    const int xy[3][2] = {{66, 81}, {958, 147}, {199, 965}};
    Vertex v[3]{};
    for (unsigned i = 0; i < 3; ++i) {
        v[i].x = xy[i][0] + 16384; v[i].y = xy[i][1] + 16384;
        v[i].z = 200;
        v[i].r = v[i].g = v[i].b = texture ? 128 : 255;
        v[i].a = 128; v[i].f = 255;
        v[i].s = 3 * q / 64; v[i].t = 17 * q / 64; v[i].q = q;
    }
    if (reverse) std::swap(v[0], v[1]);
    raster::draw(s, v, 3);
    const auto cross = [](std::int64_t ax, std::int64_t ay, std::int64_t bx, std::int64_t by) {
        return ax * by - bx * ay;
    };
    const auto area = cross(std::int64_t(v[1].x) - v[0].x, std::int64_t(v[1].y) - v[0].y,
                            std::int64_t(v[2].x) - v[0].x, std::int64_t(v[2].y) - v[0].y);
    const int sign = area > 0 ? 1 : -1;
    unsigned covered = 0;
    for (int y = 0; y < 64; ++y)
        for (int x = 0; x < 64; ++x) {
            bool hit = !clip || (x >= 9 && x <= 39 && y >= 11 && y <= 45);
            for (int i = 0; hit && i < 3; ++i) {
                const auto &a = v[(i + 1) % 3], &b = v[(i + 2) % 3];
                const auto edge = cross(std::int64_t(a.x) - 16384 - x * 16,
                                        std::int64_t(a.y) - 16384 - y * 16,
                                        std::int64_t(b.x) - 16384 - x * 16,
                                        std::int64_t(b.y) - 16384 - y * 16) * sign;
                const auto gx = (std::int64_t(a.y) - b.y) * sign;
                const auto gy = (std::int64_t(b.x) - a.x) * sign;
                hit = edge > 0 || (edge == 0 && (gx > 0 || (gx == 0 && gy > 0)));
            }
            const unsigned expected = hit ? (texture ? 0x0048440cu : 0x80fefefeu) : background;
            expect(read_pixel(PSMCT32, 0, 1, x, y) == expected,
                   "Constant STQ/fog must retain independent texel/fog values");
            expect(read_pixel(0x31, 4096, 1, x, y) == 0, "Disabled depth must remain unchanged");
            covered += hit;
        }
    expect(covered > 0, "Constant-attribute oracle must exercise covered pixels");
}
}

int main() {
    try {
        ps2::gs::init();
        unsigned cases = 0;
        for (bool line : {false, true})
            for (bool reverse : {false, true})
                for (bool clip : {false, true})
                    for (unsigned mode = 0; mode < 5; ++mode) {
                        test(line, reverse, clip, mode);
                        ++cases;
                    }
        for (bool texture : {false, true})
            for (bool gouraud : {false, true})
                for (bool reverse : {false, true})
                    for (bool clip : {false, true})
                        for (float q : {0.5f, 1.0f, 2.0f}) {
                            test_constant_attributes(texture, gouraud, reverse, clip, q);
                            ++cases;
                        }
        std::printf("PASS %u flat color, constant channels/depth/STQ/fog cases\n", cases);
        return 0;
    } catch (const std::exception &e) {
        std::fprintf(stderr, "FAIL: %s\n", e.what());
        return 1;
    }
}
