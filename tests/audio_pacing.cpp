// Exercise the actual web pacing functions without a game or browser.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <future>
#include <thread>

using useconds_t = unsigned;
struct Ring { std::atomic<unsigned> write{5000}, read{0}, active{1}; } g_audio;
std::atomic<bool> g_paused{false};
std::atomic<unsigned> g_pause_request{0}, g_pause_acknowledged{0}, sleeps{0};
double g_next_frame = 0;
double g_audio_target_frames = 1920;
namespace ps2 {
struct { bool pal = false; } g_options;
void post_present() {}
}
double emscripten_get_now() { return 1; }
void audio_test_sleep(unsigned microseconds) {
    ++sleeps;
    std::this_thread::sleep_for(std::chrono::microseconds(microseconds));
}
#include HOST_AUDIO_PACING

void expect(bool condition, const char *message) {
    if (!condition) { std::fprintf(stderr, "%s\n", message); std::exit(1); }
}
void test_budget(bool surface) {
    using namespace std::chrono_literals;
    configure_audio_reserve(surface);
    const unsigned target = surface ? 3072 : 1920;
    expect(g_audio_target_frames == target, "Wrong presentation-path reserve");
    g_audio.write = target + 48; g_audio.read = 0; g_audio.active = 1;
    g_paused = false; sleeps = 0;
    auto work = std::async(std::launch::async, [] { pace(); });
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (!sleeps.load() && work.wait_for(0ms) != std::future_status::ready) {
        expect(std::chrono::steady_clock::now() < deadline, "Reserve fixture timed out");
        std::this_thread::sleep_for(1ms);
    }
    expect(work.wait_for(20ms) == std::future_status::timeout, "Configured audio reserve bypassed");
    g_audio.read = 48; // Exactly the path's reserve remains.
    expect(work.wait_for(3s) == std::future_status::ready, "Reserve boundary did not release pacing");
    work.get();
}
void test_pause(bool drain_while_paused, bool surface) {
    using namespace std::chrono_literals;
    configure_audio_reserve(surface);
    g_audio.write = 5000; g_audio.read = 0; g_audio.active = 1;
    g_paused = false; g_pause_request = 0; g_pause_acknowledged = 0; sleeps = 0;
    g_next_frame = 123;
    auto work = std::async(std::launch::async, [] { pace(); });
    const auto await = [&](auto predicate) {
        const auto deadline = std::chrono::steady_clock::now() + 3s;
        while (!predicate()) {
            expect(std::chrono::steady_clock::now() < deadline, "Pacing fixture timed out");
            std::this_thread::sleep_for(1ms);
        }
    };
    await([] { return sleeps.load() > 0; });
    g_pause_request = 9; g_paused = true;
    await([&] { return g_pause_acknowledged.load() == 9 || work.wait_for(0ms) == std::future_status::ready; });
    expect(g_pause_acknowledged.load() == 9, "Pause escaped without acknowledgement");
    if (drain_while_paused) g_audio.read = 5000;
    expect(work.wait_for(20ms) == std::future_status::timeout, "Paused native field continued");
    g_paused = false;
    await([] { return g_pause_acknowledged.load() == 0; });
    if (!drain_while_paused) {
        expect(work.wait_for(20ms) == std::future_status::timeout, "Resume bypassed audio budget");
        g_audio.read = 5000 - static_cast<unsigned>(g_audio_target_frames);
    }
    expect(work.wait_for(3s) == std::future_status::ready, "Pacing did not resume");
    work.get();
    expect(g_next_frame == 0, "Audio pacing retained a wall-clock deadline");
}
int main() {
    for (bool surface : {false, true}) {
        test_budget(surface);
        test_pause(false, surface);
        test_pause(true, surface);
    }
    std::puts("Native audio pacing: copy40ms/surface64ms reserve boundaries, pause acknowledgement, frozen field, and post-resume budget passed.");
}
