#include "gs/queue.hpp"
#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <cstdio>
#include <cstring>

// Node has no DOM. Control only the browser-thread query; its actual main
// runtime identity, Wasm suspension and producer pthread remain unchanged.
#ifdef PS2_TEST_BROWSER_MAIN
extern "C" int __wrap_emscripten_is_main_browser_thread() { return PS2_TEST_BROWSER_MAIN; }
#endif

void *produce(void *) {
    emscripten_thread_sleep(80);
    const unsigned payload = 0x12345678u;
    ps2::gs::queue::render().post(ps2::gs::queue::kPresent, 17, 25, &payload, sizeof payload);
    return nullptr;
}

int main() {
    auto &ring = ps2::gs::queue::render();
    ring.start(1024);
    EM_ASM({ Module.qaTimer = false; setTimeout(() => { Module.qaTimer = true; }, 15); });
    pthread_t thread;
    if (pthread_create(&thread, nullptr, produce, nullptr)) return 2;
    const double began = emscripten_get_now();
    ring.wait_for_work(250);
    const double elapsed = emscripten_get_now() - began;
    const bool progressed = EM_ASM_INT({ return Module.qaTimer ? 1 : 0; });
    ps2::gs::queue::Header header{};
    const std::uint8_t *data = nullptr;
    const bool found = ring.peek(header, data);
    unsigned payload = 0;
    if (found && header.bytes == sizeof payload) std::memcpy(&payload, data, sizeof payload);
    if (found) ring.pop(header);
    pthread_join(thread, nullptr);
    EM_ASM({ postMessage({ type: 'queue-result', timerProgressed: !!$0, elapsed: $1,
        found: !!$2, payload: $3 >>> 0, mainRuntime: !!$4, mainBrowser: !!$5 }); },
        progressed, elapsed, found, payload, emscripten_is_main_runtime_thread(), emscripten_is_main_browser_thread());
    if (!progressed || !found || payload != 0x12345678u || header.arg0 != 17 || header.arg1 != 25 || elapsed < 45) {
        std::fprintf(stderr, "FAIL: rendering runtime blocked its event loop or lost posted work\n");
        return 1;
    }
    std::puts("PASS: rendering runtime keeps its event loop available while waiting for work");
}
