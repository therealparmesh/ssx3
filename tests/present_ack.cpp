#include "gs/gs.hpp"
#include "ps2/system.hpp"
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <mutex>
#include <thread>

namespace {
bool worker_can_continue_during_wait(bool surface) {
    std::mutex mutex;
    std::condition_variable changed;
    bool queued = false, finished = false;
    std::thread emulation([&] {
        ps2::gs::post_present();
        ps2::gs::post_present();
        { std::lock_guard lock(mutex); queued = true; }
        changed.notify_one();
        // The third post is throttled until the renderer acknowledges a field.
        ps2::gs::post_present();
        { std::lock_guard lock(mutex); finished = true; }
        changed.notify_one();
    });
    { std::unique_lock lock(mutex); changed.wait(lock, [&] { return queued; }); }
    bool during_wait = false;
    const auto before_present = [&] {
        std::unique_lock lock(mutex);
        during_wait = changed.wait_for(lock, std::chrono::milliseconds(250), [&] { return finished; });
    };
    ps2::render_pending(surface, {}, before_present, 1000);
    emulation.join();
    // Retire the two remaining posts before testing the other presentation path.
    ps2::render_pending(false, {}, {}, 1000);
    ps2::render_pending(false, {}, {}, 1000);
    return during_wait;
}
}
int main() {
    ps2::gs::init();
    ps2::gs::start_thread();
    const bool copy = worker_can_continue_during_wait(false);
    const bool surface = worker_can_continue_during_wait(true);
    std::printf("Prepared-copy acknowledgement: copy worker advanced=%d; surface worker advanced=%d\n", copy, surface);
    if (!copy || surface) return 1;
    return 0;
}
