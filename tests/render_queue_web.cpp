#include "queue.hpp"
#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <atomic>
#include <cstdio>
#include <stdexcept>

std::atomic<std::uint32_t> armed{0};

EM_JS(void, hold_old_wakes, (std::atomic<std::uint32_t> *ready), {
    Module.queueWaitOriginal = Atomics.waitAsync;
    Module.queueWaitHeld = 0;
    Module.queueWaitRefreshes = 0;
    globalThis.requestAnimationFrame = () => ++Module.queueWaitRefreshes;
    globalThis.cancelAnimationFrame = () => {};
    Atomics.waitAsync = function(array, index, seen, timeout) {
        const result = Module.queueWaitOriginal.apply(this, arguments);
        if (result.async && timeout === 50) {
            ++Module.queueWaitHeld;
            Atomics.store(HEAP32, ready >> 2, 1);
            Atomics.notify(HEAP32, ready >> 2);
            return {async: true, value: new Promise(() => {})};
        }
        return result;
    };
    Module.queueWaitDeadline = setTimeout(() => {
        console.error('FAIL: native producer wake timed out with old wake paths withheld');
        Module._emscripten_force_exit(1);
    }, 5000);
});

EM_JS(int, finish_wake_test, (), {
    clearTimeout(Module.queueWaitDeadline);
    Atomics.waitAsync = Module.queueWaitOriginal;
    return Module.queueWaitHeld === 2 && Module.queueWaitRefreshes === 2 &&
           Module.renderWorkWake === undefined;
});

void *produce(void *wake_only) {
    while (!armed.load()) emscripten_futex_wait(&armed, 0, 100);
    if (wake_only) ps2::gs::queue::render().wake();
    else ps2::gs::queue::render().post(ps2::gs::queue::kVblank, 0x1234, 0, nullptr, 0);
    return nullptr;
}

int main() {
    try {
        auto &queue = ps2::gs::queue::render();
        queue.start(1024);
        hold_old_wakes(&armed);
        for (int wake_only = 0; wake_only < 2; ++wake_only) {
            armed.store(0);
            pthread_t worker;
            if (pthread_create(&worker, nullptr, produce, wake_only ? &queue : nullptr)) throw std::runtime_error("Cannot start producer");
            queue.wait_for_work(50);
            ps2::gs::queue::Header header;
            const std::uint8_t *payload = nullptr;
            const bool got = queue.peek(header, payload);
            if (!wake_only && (!got || header.type != ps2::gs::queue::kVblank || header.arg0 != 0x1234))
                throw std::runtime_error("Producer wake lost its queued command");
            if (wake_only && got) throw std::runtime_error("Explicit wake invented a queued command");
            if (got) queue.pop(header);
            pthread_join(worker, nullptr);
        }
        if (!finish_wake_test()) throw std::runtime_error("Old wake paths ran or producer callback was not retired");
        std::puts("PASS: actual Wasm producer wakes the renderer with native promise and RAF withheld; post/wake, command integrity and callback retirement pass");
    } catch (const std::exception &error) {
        std::fprintf(stderr, "FAIL: %s\n", error.what());
        emscripten_force_exit(1);
    }
}
