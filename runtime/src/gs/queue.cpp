#include "queue.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstring>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/threading.h>
#elif defined(__linux__)
#include <ctime>
#include <linux/futex.h>
#include <sys/syscall.h>
#include <unistd.h>
#else
#include <chrono>
#include <thread>
#endif

namespace ps2::gs::queue {

namespace {

constexpr std::uint64_t align16(std::uint64_t n) { return (n + 15) & ~15ull; }

Ring g_render, g_vu;
thread_local Role g_role = Role::Emulation;

#if defined(__linux__) && !defined(__EMSCRIPTEN__)
void futex_wait(std::atomic<std::uint32_t> &word, std::uint32_t seen, int timeout_ms) {
    timespec limit{timeout_ms / 1000, static_cast<long>(timeout_ms % 1000) * 1000000L};
    syscall(SYS_futex, reinterpret_cast<std::uint32_t *>(&word), FUTEX_WAIT_PRIVATE, seen, timeout_ms < 0 ? nullptr : &limit, nullptr, 0);
}

void futex_wake(std::atomic<std::uint32_t> &word) { syscall(SYS_futex, reinterpret_cast<std::uint32_t *>(&word), FUTEX_WAKE_PRIVATE, INT_MAX, nullptr, nullptr, 0); }
#endif

}

#ifdef __EMSCRIPTEN__
EM_ASYNC_JS(void, ps2_wait_async, (std::atomic<std::uint32_t> *word, std::uint32_t seen, int timeout_ms), {
    const result = Atomics.waitAsync(HEAP32, word >> 2, seen, timeout_ms);
    if (result.async) await new Promise((resolve) => {
        let finished = false, refresh = 0;
        const finish = () => {
            if (finished) return;
            finished = true;
            cancelAnimationFrame(refresh);
            if (Module.renderWorkWake === wake) Module.renderWorkWake = undefined;
            resolve();
        };
        const wake = address => {
            if ((address >>> 0) === (word >>> 0) &&
                (Atomics.load(HEAP32, word >> 2) >>> 0) !== (seen >>> 0)) finish();
        };
        Module.renderWorkWake = wake;
        const check = () => {
            if (finished) return;
            // A worker can post work while the browser delays the wait's
            // promise until its timeout. Observe the shared predicate at the
            // refresh too, before that delay drains the presentation queue.
            if ((Atomics.load(HEAP32, word >> 2) >>> 0) !== (seen >>> 0)) finish();
            else refresh = requestAnimationFrame(check);
        };
        refresh = requestAnimationFrame(check);
        result.value.then(finish);
    });
});

void post_render_wake(std::atomic<std::uint32_t> *word) {
    // A browser may defer the waitAsync promise past the next presentation.
    // Post a separate wake when the producer actually makes work available.
    MAIN_THREAD_ASYNC_EM_ASM({
        const wake = Module.renderWorkWake;
        if (wake) wake($0);
    }, word);
}
#endif

void wait(std::atomic<std::uint32_t> &value, std::uint32_t seen) {
#ifdef __EMSCRIPTEN__
    emscripten_futex_wait(&value, seen, INFINITY);
#elif defined(__linux__)
    futex_wait(value, seen, -1);
#else
    value.wait(seen);
#endif
}

void notify(std::atomic<std::uint32_t> &value) {
#ifdef __EMSCRIPTEN__
    emscripten_futex_wake(&value, INT_MAX);
#elif defined(__linux__)
    futex_wake(value);
#else
    value.notify_all();
#endif
}

Ring &render() { return g_render; }
Ring &vu() { return g_vu; }
Role &role() { return g_role; }

Ring &outbox() {
    if (g_role == Role::Emulation && g_vu.active()) return g_vu;
    return g_render;
}

bool active() { return g_render.active(); }
bool vu_active() { return g_vu.active(); }

void post(Type type, std::uint32_t arg0, std::uint32_t arg1, const void *data, std::uint32_t bytes) { outbox().post(type, arg0, arg1, data, bytes); }

void Ring::start(std::size_t capacity) {
    buffer_ = std::make_unique<std::uint8_t[]>(capacity);
    capacity_ = capacity;
}

void Ring::post(Type type, std::uint32_t arg0, std::uint32_t arg1, const void *data, std::uint32_t bytes) {
    const std::uint64_t need = sizeof(Header) + align16(bytes);
    std::uint64_t head = head_.load(std::memory_order_relaxed);
    for (;;) {
        const std::uint64_t pos = head % capacity_;
        const std::uint64_t pad = pos + need > capacity_ ? capacity_ - pos : 0;
        const std::uint32_t seen = freed_.load(std::memory_order_acquire);
        if (head + pad + need - tail_.load(std::memory_order_acquire) <= capacity_) {
            if (pad) {
                const Header wrap{kWrap, 0, 0, 0};
                std::memcpy(buffer_.get() + pos, &wrap, sizeof wrap);
                head += pad;
            }
            break;
        }
        producer_waiting_.store(1);
        if (head + pad + need - tail_.load() > capacity_) wait(freed_, seen);
    }
    std::uint8_t *at = buffer_.get() + head % capacity_;
    const Header h{type, bytes, arg0, arg1};
    std::memcpy(at, &h, sizeof h);
    if (bytes) std::memcpy(at + sizeof h, data, bytes);
    head_.store(head + need, std::memory_order_release);
    posted_.fetch_add(1);
    if (consumer_waiting_.exchange(0)) {
        notify(posted_);
#ifdef __EMSCRIPTEN__
        if (this == &g_render) post_render_wake(&posted_);
#endif
    }
}

bool Ring::peek(Header &header, const std::uint8_t *&payload) {
    std::uint64_t tail = tail_.load(std::memory_order_relaxed);
    const std::uint64_t head = head_.load(std::memory_order_acquire);
    while (tail != head) {
        const std::uint64_t pos = tail % capacity_;
        std::memcpy(&header, buffer_.get() + pos, sizeof header);
        if (header.type != kWrap) {
            payload = buffer_.get() + pos + sizeof header;
            return true;
        }
        tail += capacity_ - pos;
        tail_.store(tail, std::memory_order_release);
    }
    return false;
}

void Ring::pop(const Header &header) {
    tail_.store(tail_.load(std::memory_order_relaxed) + sizeof(Header) + align16(header.bytes), std::memory_order_release);
    freed_.fetch_add(1);
    if (producer_waiting_.exchange(0)) notify(freed_);
}

void Ring::wake() {
    posted_.fetch_add(1);
    if (consumer_waiting_.exchange(0)) {
        notify(posted_);
#ifdef __EMSCRIPTEN__
        if (this == &g_render) post_render_wake(&posted_);
#endif
    }
}

void Ring::wait_for_work(int timeout_ms) {
    const std::uint32_t seen = posted_.load();
    consumer_waiting_.store(1);
    if (head_.load() != tail_.load()) {
        consumer_waiting_.store(0);
        return;
    }
#ifdef __EMSCRIPTEN__
    if (emscripten_is_main_browser_thread()) ps2_wait_async(&posted_, seen, timeout_ms);
    else emscripten_futex_wait(&posted_, seen, timeout_ms);
#elif defined(__linux__)
    futex_wait(posted_, seen, timeout_ms);
#else
    (void)seen;
    std::this_thread::sleep_for(std::chrono::milliseconds(std::min(timeout_ms, 1)));
#endif
}

}
