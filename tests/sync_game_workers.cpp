#include <emscripten.h>
#include <pthread.h>
#include <atomic>
#include <cstdio>
#include <functional>

std::atomic<int> done{0};
int depth = -1, sum = 0, caught = 0, cleaned = 0;
struct Scope { ~Scope() { ++cleaned; } };
extern "C" EMSCRIPTEN_KEEPALIVE int inner(int value) { if (value % 11 == 0) throw -value - 1; return value * 3 + 1; }
EM_JS(void, require_sync_worker, (), {
    if (!ENVIRONMENT_IS_PTHREAD) abort('Game execution requires a worker thread');
    Asyncify.handleSleep = () => abort('Unexpected asynchronous game-worker operation');
});
EM_JS(int, reenter, (int value), { return Module._inner(value); });
void *work(void *) {
    require_sync_worker();
    depth = EM_ASM_INT({ return Asyncify.exportCallStack.length; });
    std::function<int(int)> leaf = [](int value) {
        Scope scope;
        if (value % 7 == 0) throw value;
        return reenter(value);
    };
    for (int i = 0; i < 10000; ++i) {
        try { sum += leaf(i); }
        catch (int value) { sum += value; ++caught; }
    }
    done.store(1);
    return nullptr;
}
int main() {
    pthread_t thread;
    if (pthread_create(&thread, nullptr, work, nullptr)) return 2;
    unsigned sleeps = 0;
    // Exercise real main-thread Asyncify suspension while the worker performs
    // reentrant JS/Wasm calls and legacy C++ exception handling.
    do { emscripten_sleep(1); ++sleeps; } while (!done.load());
    pthread_join(thread, nullptr);
    int expected = 0, exceptions = 0;
    for (int i = 0; i < 10000; ++i) {
        expected += i % 7 == 0 ? i : i % 11 == 0 ? -i - 1 : i * 3 + 1;
        exceptions += i % 7 == 0 || i % 11 == 0;
    }
    if (depth != 0 || sum != expected || caught != exceptions || cleaned != 10000 || !sleeps) {
        std::fprintf(stderr, "FAIL: depth=%d sum=%d/%d caught=%d/%d sleeps=%u\n", depth, sum, expected, caught, exceptions, sleeps);
        emscripten_force_exit(1);
    }
    std::puts("PASS: synchronous worker exports, 10000 reentrant calls, nested legacy C++ catches, RAII cleanup and main-thread suspension");
}
