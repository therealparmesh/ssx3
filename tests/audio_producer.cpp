#ifdef NDEBUG
#undef NDEBUG
#endif
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <future>
#include <limits>
#include <thread>

std::atomic<unsigned> sleeps{0};
void audio_test_sleep(unsigned microseconds) {
    ++sleeps;
    std::this_thread::sleep_for(std::chrono::microseconds(microseconds));
}
#include HOST_AUDIO_PRODUCER

template<class Predicate> void await(Predicate predicate) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (!predicate()) {
        assert(std::chrono::steady_clock::now() < deadline);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void reset() {
    g_audio.write = 0; g_audio.read = 0; g_audio.active = 1;
    g_audio_converter = ps2::audio::RateConverter{};
    g_audio_limiter = ps2::audio::PeakLimiter{};
    g_audio_source_frames = g_audio_output_frames = g_audio_clipped_frames = g_audio_capacity_waits = 0;
    g_audio_ratio = 1; g_audio_peak_deviation = 0;
    for (auto &value : g_audio_rate_stats) value = 0;
    g_paused = false; g_pause_request = 0; g_pause_acknowledged = 0; sleeps = 0;
}

int main() {
    using namespace std::chrono_literals;
    ps2::audio::RateConverter::prepare();
    std::int16_t input[64];
    for (unsigned i = 0; i < 32; ++i) { input[i * 2] = 12345; input[i * 2 + 1] = -23456; }
    reset();
    g_audio.write = kAudioFrames;
    auto writer = std::async(std::launch::async, [&] { push_audio(input, 32); });
    await([] { return sleeps.load() > 0; });
    assert(g_audio_rate_stats[0].load() == 0);
    g_pause_request = 7; g_paused = true;
    await([] { return g_pause_acknowledged.load() == 7; });
    g_audio.read = 63;
    assert(writer.wait_for(20ms) == std::future_status::timeout);
    assert(g_audio_rate_stats[0].load() == 0);
    g_paused = false;
    await([] { return g_pause_acknowledged.load() == 0; });
    // A near-full ring must reserve the entire possible two-block output.
    assert(writer.wait_for(20ms) == std::future_status::timeout);
    assert(g_audio_rate_stats[0].load() == 0);
    g_audio.read = 64;
    assert(writer.wait_for(3s) == std::future_status::ready);
    writer.get();
    assert(g_audio_source_frames == 32 && g_audio_capacity_waits == 1);
    assert(g_audio_clipped_frames == 0 && g_pause_acknowledged.load() == 0);

    reset();
    const std::uint32_t origin = std::numeric_limits<std::uint32_t>::max() - 15;
    g_audio.write = origin; g_audio.read = origin;
    std::uint64_t consumed = 0;
    for (unsigned batch = 0; batch < 1200; ++batch) {
        push_audio(input, 32);
        auto read = g_audio.read.load();
        const auto write = g_audio.write.load();
        assert(write - read <= kAudioFrames);
        while (read != write) {
            const auto at = (read & (kAudioFrames - 1)) * 2;
            assert(g_audio.samples[at] == 12345 && g_audio.samples[at + 1] == -23456);
            ++read; ++consumed;
        }
        g_audio.read.store(read);
    }
    assert(g_audio_source_frames == 38400 && g_audio_output_frames == consumed);
    assert(consumed > 38000 && consumed < 38600);
    assert(g_audio.write.load() == static_cast<std::uint32_t>(origin + consumed));
    assert(g_audio_capacity_waits == 0 && g_audio_clipped_frames == 0);
    std::puts("Audio producer: full/63/64-slot admission, paused backpressure acknowledgement, exact source admission, stereo PCM, repeated ring wrap and32-bit counter rollover passed.");
}
