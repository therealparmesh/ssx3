#include "gs/gs.hpp"
#include "ps2/state.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <utility>
#include <vector>

#ifdef PS2_GS_READBACK_STANDALONE
// Only interrupt delivery is outside the GS fixture; transfers must not raise it.
namespace ps2::hw {
void intc_raise(unsigned) { throw std::runtime_error("Unexpected GS interrupt"); }
}
#endif

namespace {
void expect(bool ok, const char *message) {
    if (!ok) throw std::runtime_error(message);
}
class Snapshot : public ps2::state::Stream {
public:
    Snapshot(bool save, std::vector<std::uint8_t> bytes = {}) : Stream(save), data(std::move(bytes)) {}
    void bytes(void *ptr, std::size_t size) override {
        if (saving()) {
            const auto *first = static_cast<const std::uint8_t *>(ptr);
            data.insert(data.end(), first, first + size);
        } else {
            expect(size <= data.size() - offset, "Truncated GS snapshot");
            std::memcpy(ptr, data.data() + offset, size);
            offset += size;
        }
    }
    std::vector<std::uint8_t> data;
    std::size_t offset = 0;
};
void begin(unsigned psm, unsigned pixels) {
    using namespace ps2::gs;
    write(0x50, (1ull << 16) | (std::uint64_t(psm) << 24));
    write(0x51, 7ull | (11ull << 16));
    write(0x52, pixels | (1ull << 32));
    write(0x53, 1);
}
}
int main() {
    try {
        using namespace ps2::gs;
        unsigned cases = 0;
        for (unsigned psm : {1u, 0x31u}) for (unsigned pixels = 1; pixels <= 40; ++pixels) {
            for (bool chunked : {false, true}) {
                render_reset();
                std::vector<std::uint8_t> expected(((pixels * 3 + 15) / 16) * 16, 0);
                for (unsigned i = 0; i < pixels; ++i) {
                    const std::uint32_t color = 0x80010203u + i * 0x0003070bu;
                    write_pixel(psm, 0, 1, 7 + i, 11, color);
                    for (unsigned c = 0; c < 3; ++c) expected[i * 3 + c] = color >> (8 * c);
                }
                begin(psm, pixels);
                std::vector<std::uint8_t> actual(expected.size() + 16, 0xcd);
                if (chunked) {
                    for (unsigned at = 0; at < expected.size(); at += 16) read_image(actual.data() + at, 1);
                } else read_image(actual.data(), expected.size() / 16);
                expect(std::equal(expected.begin(), expected.end(), actual.begin()), "24-bit transfer lost bytes at a quadword boundary");
                expect(std::all_of(actual.begin() + expected.size(), actual.end(), [](auto c) { return c == 0xcd; }), "GS readback wrote beyond output");
                std::array<std::uint8_t, 16> empty;
                empty.fill(0xcd);
                read_image(empty.data(), 1);
                expect(std::all_of(empty.begin(), empty.end(), [](auto c) { return c == 0; }), "Completed transfer replayed bytes");
                ++cases;
            }
        }
        // Six RGB pixels leave two bytes of the final pixel after the first qword.
        for (unsigned psm : {1u, 0x31u}) {
            render_reset();
            for (unsigned i = 0; i < 6; ++i) write_pixel(psm, 0, 1, 7 + i, 11, 0x123456);
            begin(psm, 6);
            std::array<std::uint8_t, 16> first{}, tail{};
            read_image(first.data(), 1);
            Snapshot saved(true);
            state(saved);
            read_image(tail.data(), 1);
            expect(tail[0] == 0x34 && tail[1] == 0x12, "Final pixel carry was lost");
            render_reset();
            Snapshot restored(false, saved.data);
            state(restored);
            tail.fill(0xcd);
            read_image(tail.data(), 1);
            expect(tail[0] == 0x34 && tail[1] == 0x12 && std::all_of(tail.begin() + 2, tail.end(), [](auto c) { return c == 0; }), "Snapshot did not restore pending readback bytes");
            begin(psm, 6);
            read_image(first.data(), 1);
            render_reset();
            tail.fill(0xcd);
            read_image(tail.data(), 1);
            expect(std::all_of(tail.begin(), tail.end(), [](auto c) { return c == 0; }), "Reset retained pending readback bytes");
            // A subsequent transfer must start cleanly as well.
            begin(psm, 1);
            tail.fill(0xcd);
            read_image(tail.data(), 1);
            expect(std::all_of(tail.begin(), tail.end(), [](auto c) { return c == 0; }), "Reset retained pending readback bytes");
            ++cases;
        }
        std::printf("PASS: %u GS24 readback cases, chunk boundaries, guards, completion, snapshot and reset\n", cases);
    } catch (const std::exception &error) {
        std::fprintf(stderr, "FAIL: %s\n", error.what());
        return 1;
    }
}
