// Check the production counter/getters/state field without a game image.
#include "../runtime/include/ps2/state.hpp"
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <type_traits>
#include <vector>
namespace state = ps2::state;
#include FRAME_COUNTER_CODE
static_assert(std::is_same_v<decltype(g_frames), std::atomic<std::uint64_t>>,
              "Cross-thread frame storage must be atomic");
void expect(bool condition, const char *message) {
    if (!condition) { std::fprintf(stderr, "%s\n", message); std::exit(1); }
}
struct Bytes : state::Stream {
    std::vector<std::uint8_t> data;
    std::size_t offset = 0;
    explicit Bytes(bool saving) : Stream(saving) {}
    void bytes(void *value, std::size_t size) override {
        expect(value != static_cast<void *>(&g_frames), "State stream touched live atomic storage");
        if (saving()) {
            const auto *first = static_cast<const std::uint8_t *>(value);
            data.insert(data.end(), first, first + size);
        } else {
            expect(offset + size <= data.size(), "State field overread");
            std::memcpy(value, data.data() + offset, size);
        }
        offset += size;
    }
};
int main() {
    const std::uint64_t values[] = {0, 1, 0xffffffffULL, 0x100000000ULL,
                                   0x20000000000001ULL, UINT64_MAX};
    for (auto value : values) {
        g_frames.store(value);
        Bytes writer(true); frame_state(writer);
        expect(writer.data.size() == sizeof(value), "Frame state width changed");
        expect(std::memcmp(writer.data.data(), &value, sizeof(value)) == 0,
               "Legacy frame state bytes changed");
        g_frames.store(17);
        Bytes reader(false); reader.data = writer.data; frame_state(reader);
        expect(reader.offset == sizeof(value), "Frame state read width changed");
        expect(frames_run() == value && frame_count() == value, "Restored frame not visible to getters");
    }
    constexpr std::uint64_t start = 0xffffffffULL - 100000, count = 200000;
    g_frames.store(start);
    std::atomic<bool> go{false}, done{false};
    std::thread observer([&] {
        while (!go.load(std::memory_order_acquire)) {}
        auto previous = start;
        do {
            const auto current = frames_run();
            expect(current >= previous && current <= start + count, "Torn or backwards frame observation");
            const auto profile = frame_count();
            expect(profile >= current && profile <= start + count, "Profiling frame observation regressed");
            previous = current;
        } while (!done.load(std::memory_order_acquire));
    });
    go.store(true, std::memory_order_release);
    for (std::uint64_t i = 0; i < count; ++i) frame_tick();
    done.store(true, std::memory_order_release); observer.join();
    expect(frames_run() == start + count, "Frame increments lost");
    std::puts("Frame counter: concurrent getters,32-bit rollover and legacy64-bit state round-trip passed.");
}
