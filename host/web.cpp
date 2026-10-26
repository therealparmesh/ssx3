#include "ps2/disc.hpp"
#include "ps2/system.hpp"
#include "ps2/warmup.hpp"

#include <emscripten.h>
#include <emscripten/threading.h>
#include <pthread.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

void register_generated_code();
void register_generated_vu();

EM_JS_DEPS(ps2web, "$stringToNewUTF8,$UTF8ToString");
EM_JS_DEPS(ps2web_frame_clock, "$ps2webFrameClock");

#ifdef PS2_WEB_SYNC_GAME_WORKERS
EM_JS_DEPS(ps2web_sync_workers, "$Asyncify");
EM_JS(void, ps2web_require_sync_worker, (), {
    if (!ENVIRONMENT_IS_PTHREAD) abort('Game execution requires a worker thread');
    // This build omits Asyncify instrumentation from generated game code.
    // Reject future async imports before any unwind starts on a game worker.
    Asyncify.handleSleep = () => abort('Unexpected asynchronous game-worker operation');
});
#else
void ps2web_require_sync_worker() {}
#endif

EM_JS(void, ps2web_fetch, (const char *url, double offset, int size, void *out, std::atomic<std::uint32_t> *state), {
    const target = UTF8ToString(url);
    const finish = (value) => {
        Atomics.store(HEAP32, state >> 2, value);
        Atomics.notify(HEAP32, state >> 2);
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    fetch(target, {signal: controller.signal, headers: {Range: 'bytes=' + offset + '-' + (offset + size - 1)}})
        .then((response) => {
            const range = new RegExp('^bytes ([0-9]+)-([0-9]+)/([0-9]+)$').exec(response.headers.get('Content-Range') || "");
            if (response.status !== 206 || !range || Number(range[1]) !== offset || Number(range[2]) !== offset + size - 1 || Number(range[3]) <= offset + size - 1) {
                // A login page or a server ignoring Range must not become
                // game data, or trigger a multi-gigabyte full-disc download.
                if (response.body) response.body.cancel().catch(() => {});
                throw new Error('invalid disc range response (status ' + response.status + ')');
            }
            return response.arrayBuffer().then((buffer) => {
                const bytes = new Uint8Array(buffer);
                if (bytes.length !== size) throw new Error('truncated disc range response');
                HEAPU8.set(bytes, out);
                finish(3);
            });
        })
        .catch((e) => {
            console.warn('disc read failed', e);
            finish(4);
        }).finally(() => clearTimeout(timeout));
});

#ifdef PS2_DEVELOPER_TOOLS
EM_JS(int, ps2web_save_program, (const char *name, const std::uint8_t *code, int size), {
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', 'vu1/' + UTF8ToString(name), false);
        xhr.send(HEAPU8.slice(code, code + size));
        return xhr.status;
    } catch (e) {
        return 0;
    }
});
#endif

EM_JS(double, ps2web_disc_size, (), { return Module.discSize || 0; });
EM_JS(char *, ps2web_state_url, (), { return Module.stateUrl ? stringToNewUTF8(new URL(Module.stateUrl, location.href).href) : 0; });
EM_JS(double, ps2web_url_size, (const char *url), {
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', UTF8ToString(url), false);
        xhr.send();
        return xhr.status === 200 ? Number(xhr.getResponseHeader('Content-Length') || 0) : 0;
    } catch (e) {
        return 0;
    }
});
EM_JS(double, ps2web_url_read, (const char *url, std::uint8_t *out, double size), {
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', UTF8ToString(url), false);
        xhr.responseType = 'arraybuffer';
        xhr.send();
        if (xhr.status !== 200) return 0;
        const bytes = new Uint8Array(xhr.response);
        HEAPU8.set(bytes.subarray(0, size), out);
        return bytes.length;
    } catch (e) {
        return 0;
    }
});
EM_JS(char *, ps2web_disc_url, (), { return stringToNewUTF8(new URL(Module.discUrl, location.href).href); });
EM_JS(void, ps2web_frame_done, (int displayed), {
    if (!Module.finishShown) {
        Module.shownWaiters = [];
        Module.finishShown = () => {
            Module.shownPending = false;
            const waiters = Module.shownWaiters;
            Module.shownWaiters = [];
            for (const resolve of waiters) resolve();
        };
    }
    // Resume at the refresh itself. A further task (including a high-priority
    // scheduler task) can be deferred an entire refresh during input handling.
    // Coalesce audio catch-up frames so an older callback cannot release a
    // new frame's wait after the refresh has already been consumed.
    if (!Module.shownPending) {
        Module.shownPending = true;
        requestAnimationFrame(Module.finishShown);
    }
    if (Module.onFrame) Module.onFrame(!!displayed);
});
EM_JS(int, ps2web_wait_capacity_safe, (double audio_ms), {
    // A full queue needs capacity, not another completed image. Near 60 Hz,
    // use the actual presentation time rather than a potentially old RAF stamp.
    if (!Module.yieldForBufferedFrames || !Module.bufferedSurface || Module.paused || Module.failed ||
        Module.stoppedForReload || Module.surfaceFrames?.length !== 3) return 0;
    const refresh = Module.surfaceClock.refreshInterval();
    if (!Number.isFinite(refresh) || Math.abs(refresh - 1000 / 60) > 0.25) return 0;
    const elapsed = performance.now() - Module.surfacePresentedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 2 * refresh) return 0;
    const remaining = refresh - elapsed % refresh;
    // The existing 40 ms gate budgets a full refresh. Charge only the
    // remaining portion while preserving that gate's post-refresh headroom.
    return audio_ms >= 40 - refresh + remaining ? 1 : 0;
});
EM_ASYNC_JS(void, ps2web_wait_shown, (int capacity_only), {
    if (capacity_only || (Module.yieldForBufferedFrames && Module.bufferedSurface && !Module.paused &&
        !Module.failed && !Module.stoppedForReload && Module.surfaceFrames?.length === 3 &&
        Math.abs(Module.surfaceClock.refreshInterval() - 1000 / 60) <= 0.25)) {
        do {
            await new Promise(resolve => { Module.surfaceYield = resolve; });
        } while (!Module.paused && !Module.failed && !Module.stoppedForReload &&
                 Module.surfaceFrames.length === 3 && Module.audioQueuedMs() >= (capacity_only ? 20 : 40));
        return;
    }
    // Fill a bounded GPU presentation queue before waiting for consumption.
    // This preserves a prepared image when command preparation straddles a refresh.
    if (Module.shownPending && (!Module.surfaceFrames || Module.surfaceFrames.length >= 2))
        await new Promise((resolve) => Module.shownWaiters.push(resolve));
});
EM_JS(void, ps2web_blit, (const std::uint32_t *rgba, int width, int height, int wide), {
    const canvas = Module.canvas;
    if (!Module.blitContext) Module.blitContext = canvas.getContext('2d');
    if (!Module.blitFrames) {
        // Readbacks can straddle a refresh even when their average rate is
        // 60 Hz. Keep a small, fixed pool and consume one completed image per
        // refresh, rather than overwriting two images before the same paint.
        Module.blitFrames = [];
        Module.blitFree = [{}, {}, {}];
        Module.blitPrimed = false;
        const clock = ps2webFrameClock();
        const present = (now) => {
            if (!Module.paused && !Module.failed) {
                if (Module.blitFrames.length >= 2) Module.blitPrimed = true;
                const frame = Module.blitPrimed && clock.due(now) && Module.blitFrames.shift();
                if (frame) {
                    clock.presented(now);
                    const ctx = Module.blitContext;
                    const across = frame.wide ? 16 : 4, down = frame.wide ? 9 : 3;
                    const scale = Math.min(canvas.width / across, canvas.height / down);
                    const w = scale * across, h = scale * down;
                    const sx = Math.max(1, Math.floor(w / frame.image.width));
                    const sy = Math.max(1, Math.floor(h / frame.image.height));
                    let source = frame.source;
                    if (sx > 1 || sy > 1) {
                        const sharpWidth = frame.image.width * sx, sharpHeight = frame.image.height * sy;
                        if (!Module.blitSharp || Module.blitSharp.width !== sharpWidth || Module.blitSharp.height !== sharpHeight)
                            Module.blitSharp = new OffscreenCanvas(sharpWidth, sharpHeight);
                        const sharp = Module.blitSharp.getContext('2d');
                        sharp.imageSmoothingEnabled = false;
                        sharp.drawImage(source, 0, 0, sharpWidth, sharpHeight);
                        source = Module.blitSharp;
                    }
                    ctx.fillStyle = '#000';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.imageSmoothingEnabled = true;
                    ctx.drawImage(source, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
                    Module.blitFree.push(frame);
                    if (Module.onPresent) Module.onPresent();
                }
            } else clock.reset();
            requestAnimationFrame(present);
        };
        requestAnimationFrame(present);
    }
    // Audio recovery and slower displays can produce frames faster than the
    // browser consumes them. Replace the oldest queued image in that case;
    // never grow memory or accumulate input latency without a bound.
    const frame = Module.blitFree.pop() || Module.blitFrames.shift();
    if (!frame.image || frame.image.width !== width || frame.image.height !== height) {
        frame.image = new ImageData(width, height);
        frame.source = new OffscreenCanvas(width, height);
    }
    frame.image.data.set(HEAPU8.subarray(rgba, rgba + width * height * 4));
    frame.source.getContext('2d').putImageData(frame.image, 0, 0);
    frame.wide = wide;
    Module.blitFrames.push(frame);
});

namespace {

constexpr std::size_t kChunk = 256u << 10;
constexpr std::uint32_t kSlots = 256;
constexpr std::uint64_t kReadAhead = 16;
constexpr std::uint32_t kAudioFrames = 1u << 14;

enum : std::uint32_t { kEmpty, kWanted, kLoading, kReady, kFailed };

struct Slot {
    std::atomic<std::uint32_t> state{kEmpty};
    std::uint64_t index = 0, used = 0;
    std::uint32_t size = 0;
    std::uint32_t attempts = 0;
    std::uint8_t *data = nullptr;
};

struct AudioRing {
    std::atomic<std::uint32_t> write{0}, read{0};
    std::uint32_t capacity = kAudioFrames;
    std::atomic<std::uint32_t> active{0};
    std::int16_t samples[kAudioFrames * 2];
};

AudioRing g_audio;
std::atomic<bool> g_paused{false};
std::atomic<std::uint32_t> g_pause_request{0}, g_pause_acknowledged{0};
Slot g_slots[kSlots];
std::uint64_t g_disc_size = 0, g_use_clock = 0, g_last_chunk = ~0ull, g_run = 0;
char *g_disc_url = nullptr;
char *g_state_url = nullptr;

Slot *find_slot(std::uint64_t index) {
    for (Slot &s : g_slots)
        if (s.state.load(std::memory_order_acquire) != kEmpty && s.index == index) return &s;
    return nullptr;
}

Slot *want(std::uint64_t index, const Slot *keep = nullptr) {
    if (index * kChunk >= g_disc_size) return nullptr;
    if (Slot *s = find_slot(index)) return s;
    Slot *victim = nullptr;
    for (Slot &s : g_slots) {
        if (&s == keep) continue;
        const std::uint32_t state = s.state.load(std::memory_order_acquire);
        if (state == kEmpty) {
            victim = &s;
            break;
        }
        if ((state == kReady || state == kFailed) && (!victim || s.used < victim->used)) victim = &s;
    }
    if (!victim) return nullptr;
    if (!victim->data) victim->data = new std::uint8_t[kChunk];
    victim->index = index;
    victim->size = static_cast<std::uint32_t>(std::min<std::uint64_t>(kChunk, g_disc_size - index * kChunk));
    victim->used = ++g_use_clock;
    victim->attempts = 0;
    victim->state.store(kWanted, std::memory_order_release);
    ps2::wake_render_thread();
    return victim;
}

void advance(std::uint64_t index) {
    if (index <= g_last_chunk && g_last_chunk - index <= kReadAhead * 4) return;
    g_run = index == g_last_chunk + 1 ? g_run + 1 : 0;
    g_last_chunk = index;
}

void read_ahead(std::uint64_t index, const Slot *keep = nullptr) {
    for (std::uint64_t k = 1; k <= std::min(g_run * 2, kReadAhead); ++k) want(index + k, keep);
}

void fail(const char *reason) {
    ps2::halt(reason);
    MAIN_THREAD_ASYNC_EM_ASM({
        if (typeof Module.onHalt === 'function') Module.onHalt(UTF8ToString($0));
    }, reason);
}

const Slot *chunk(std::uint64_t index) {
    Slot *s = want(index);
    advance(index);
    // A cache hit may be the oldest ready slot. Keep it reserved while
    // prefetch allocates other slots, until read_disc has copied its bytes.
    read_ahead(std::max(index, g_last_chunk), s);
    while (s) {
        for (std::uint32_t state = s->state.load(); state != kReady && state != kFailed; state = s->state.load())
            emscripten_futex_wait(&s->state, state, INFINITY);
        if (s->state.load() == kReady) {
            s->used = ++g_use_clock;
            return s;
        }
        if (s->attempts >= 4) break;
        usleep(100000);
        s->state.store(kWanted, std::memory_order_release);
        ps2::wake_render_thread();
    }
    fail("Could not read the game disc. Check your connection and reload.");
    return nullptr;
}

bool disc_ready(std::uint64_t offset, std::size_t size) {
    if (!size) return true;
    const std::uint64_t last = (offset + size - 1) / kChunk;
    bool ready = true;
    for (std::uint64_t index = offset / kChunk; index <= last; ++index) {
        Slot *s = want(index);
        if (s && s->state.load(std::memory_order_acquire) == kFailed) {
            if (s->attempts >= 4) {
                fail("Could not read the game disc. Check your connection and reload.");
                return false;
            }
            s->state.store(kWanted, std::memory_order_release);
            ps2::wake_render_thread();
        }
        ready = ready && s && s->state.load(std::memory_order_acquire) == kReady;
        advance(index);
    }
    read_ahead(std::max(last, g_last_chunk));
    return ready;
}

std::size_t read_disc(std::uint64_t offset, void *out, std::size_t size) {
    std::size_t done = 0;
    auto *to = static_cast<std::uint8_t *>(out);
    while (done < size && offset + done < g_disc_size) {
        const std::uint64_t at = offset + done;
        const Slot *c = chunk(at / kChunk);
        if (!c) break;
        const std::size_t within = static_cast<std::size_t>(at % kChunk);
        const std::size_t take = std::min<std::size_t>(size - done, c->size - within);
        std::memcpy(to + done, c->data + within, take);
        done += take;
    }
    return done;
}

void service_disc() {
    for (Slot &s : g_slots) {
        std::uint32_t expected = kWanted;
        if (s.state.compare_exchange_strong(expected, kLoading, std::memory_order_acq_rel)) {
            ++s.attempts;
            ps2web_fetch(g_disc_url, static_cast<double>(s.index * kChunk), static_cast<int>(s.size), s.data, &s.state);
        }
    }
}

void push_audio(const std::int16_t *samples, std::size_t frames) {
    std::uint32_t write = g_audio.write.load(std::memory_order_relaxed);
    const std::uint32_t read = g_audio.read.load(std::memory_order_acquire);
    for (std::size_t i = 0; i < frames && write - read < kAudioFrames; ++i, ++write) {
        const std::uint32_t at = (write & (kAudioFrames - 1)) * 2;
        g_audio.samples[at] = samples[i * 2];
        g_audio.samples[at + 1] = samples[i * 2 + 1];
    }
    g_audio.write.store(write, std::memory_order_release);
}

double audio_queued_ms() { return static_cast<double>(g_audio.write.load() - g_audio.read.load()) / 48.0; }

double g_next_frame = 0.0;
std::atomic<double> g_emulation_idle{0.0}, g_render_idle{0.0};

void pace() {
    ps2::post_present();
    if (g_paused.load()) {
        while (g_paused.load()) {
            g_pause_acknowledged.store(g_pause_request.load());
            usleep(10000);
        }
        g_pause_acknowledged.store(0);
        g_next_frame = 0.0;
    }
    if (g_audio.active.load()) {
        while (audio_queued_ms() > 80.0 && !g_paused.load()) usleep(1000);
        g_next_frame = 0.0;
        return;
    }
    const double period = ps2::g_options.pal ? 20.0 : 1000.0 / 59.94;
    const double now = emscripten_get_now();
    if (g_next_frame == 0.0 || now - g_next_frame > 200.0) g_next_frame = now;
    g_next_frame += period;
    if (g_next_frame > now) usleep(static_cast<useconds_t>((g_next_frame - now) * 1000.0));
}

void on_vblank() {
    const double start = emscripten_get_now();
    pace();
    g_emulation_idle.store(g_emulation_idle.load() + emscripten_get_now() - start);
}

struct Launch {
    std::vector<std::string> args;
};

void *emulate(void *data) {
    ps2web_require_sync_worker();
    // Trigger deferred Wasm compilation before the first game frame. Only
    // explicit no-op entries are called, on a worker so the page stays usable.
    // Repeated guarded entries also give optimizing compilers time to work
    // before the first game frame. No guest instructions or memory accesses run.
    ps2::warm_generated_code(262144);
    const Launch &launch = *static_cast<const Launch *>(data);
    if (!g_disc_size || !ps2::disc::open("disc", g_disc_size, read_disc, disc_ready)) {
        fail("Could not open the game disc. Check your connection and reload.");
        return nullptr;
    }
    std::uint32_t entry = 0;
    ps2::load_patches("/game/patches.txt");
    if (!ps2::load_elf("/game/core.elf", entry)) {
        fail("Could not load the game executable. Reload to try again.");
        return nullptr;
    }
    ps2::boot(entry, launch.args);
    if (g_state_url) {
        const double size = ps2web_url_size(g_state_url);
        std::vector<std::uint8_t> data(static_cast<std::size_t>(size));
        if (size <= 0 || ps2web_url_read(g_state_url, data.data(), size) != size || !ps2::load_state(data.data(), data.size())) {
            fail("Could not load the game state. Remove the state option and reload.");
            return nullptr;
        }
    }
    ps2::run();
    MAIN_THREAD_ASYNC_EM_ASM({
        if (typeof Module.onHalt === 'function')
            Module.onHalt(UTF8ToString($0));
    }, ps2::halt_reason().c_str());
    return nullptr;
}

}

extern "C" EMSCRIPTEN_KEEPALIVE void ps2web_pad(int pad, int buttons, int lx, int ly, int rx, int ry) {
    ps2::set_pad_buttons(static_cast<std::uint16_t>(buttons), pad);
    ps2::set_pad_axis(0, static_cast<std::uint8_t>(rx), pad);
    ps2::set_pad_axis(1, static_cast<std::uint8_t>(ry), pad);
    ps2::set_pad_axis(2, static_cast<std::uint8_t>(lx), pad);
    ps2::set_pad_axis(3, static_cast<std::uint8_t>(ly), pad);
}

extern "C" EMSCRIPTEN_KEEPALIVE void ps2web_pad_connected(int pad, int connected) { ps2::set_pad_connected(pad, connected != 0); }

extern "C" EMSCRIPTEN_KEEPALIVE void ps2web_pressure(int pad, int a, int b, int c, int d) {
    const int packed[4] = {a, b, c, d};
    for (int i = 0; i < 16; ++i) ps2::set_pad_pressure(i, static_cast<std::uint8_t>(static_cast<unsigned>(packed[i / 4]) >> (i % 4 * 8)), pad);
}

extern "C" EMSCRIPTEN_KEEPALIVE int ps2web_rumble(int pad) { return ps2::pad_rumble(pad); }

extern "C" EMSCRIPTEN_KEEPALIVE void ps2web_pause(int paused) {
    g_paused.store(paused != 0);
    // A rapid resume/pause must not reuse the previous acknowledgement.
    if (paused) ++g_pause_request;
}

extern "C" EMSCRIPTEN_KEEPALIVE int ps2web_pause_ready() {
    return g_paused.load() && g_pause_acknowledged.load() == g_pause_request.load();
}

extern "C" EMSCRIPTEN_KEEPALIVE int ps2web_card_pending() { return ps2::memory_card_pending(); }

extern "C" EMSCRIPTEN_KEEPALIVE void ps2web_resize(int width, int height) {
    ps2::resize_window(static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height));
}

extern "C" EMSCRIPTEN_KEEPALIVE double ps2web_gpu_ms() { return ps2::gpu_busy_ms(); }
extern "C" EMSCRIPTEN_KEEPALIVE double ps2web_frames() { return static_cast<double>(ps2::frames_run()); }
extern "C" EMSCRIPTEN_KEEPALIVE double ps2web_primitives() { return static_cast<double>(ps2::primitives_drawn()); }
extern "C" EMSCRIPTEN_KEEPALIVE void *ps2web_audio_ring() { return &g_audio; }
extern "C" EMSCRIPTEN_KEEPALIVE double ps2web_audio_queued_ms() { return audio_queued_ms(); }
extern "C" EMSCRIPTEN_KEEPALIVE double ps2web_vu_interpreted() { return static_cast<double>(ps2::vu1_interpreted_calls()); }
extern "C" EMSCRIPTEN_KEEPALIVE double ps2web_idle_ms(int which) {
    if (which == 2) return ps2::vu_thread_idle_ms();
    return which ? g_render_idle.load() : g_emulation_idle.load();
}

int main(int argc, char **argv) {
    static Launch launch;
    for (int i = 2; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--arg" && i + 1 < argc) launch.args.push_back(argv[++i]);
        else if (a == "--frames" && i + 1 < argc) ps2::g_options.max_frames = std::strtoull(argv[++i], nullptr, 10);
        else if (a == "--widescreen") ps2::g_options.widescreen = true;
        else if (a == "--press" && i + 1 < argc) {
            ps2::Press press;
            if (ps2::parse_press(argv[++i], press)) ps2::g_options.presses.push_back(press);
        }
    }
    if (launch.args.empty()) {
        std::string boot = "/game/core.elf";
        if (std::FILE *f = std::fopen("/game/boot.txt", "rb")) {
            char text[256] = {};
            const std::size_t n = std::fread(text, 1, sizeof text - 1, f);
            std::fclose(f);
            std::string line(text, n);
            line.erase(line.find_last_not_of(" \r\n\t") + 1);
            if (!line.empty()) boot = line;
        }
        launch.args.push_back(boot);
    }
    g_disc_size = static_cast<std::uint64_t>(ps2web_disc_size());
    g_disc_url = ps2web_disc_url();
    g_state_url = ps2web_state_url();
    ps2::g_options.fast_boot = EM_ASM_INT({ return Module.fastBoot ? 1 : 0; }) != 0;
    ps2::g_options.full_visual_effects = EM_ASM_INT({ return Module.fullEffects ? 1 : 0; }) != 0;
    ps2::g_options.on_vblank = on_vblank;
#ifdef PS2_DEVELOPER_TOOLS
    ps2::g_options.on_vu_program = [](const std::string &name, const std::uint8_t *code, std::size_t size) {
        static bool unsupported = false;
        if (unsupported) return;
        const int status = ps2web_save_program(name.c_str(), code, static_cast<int>(size));
        if (status == 200 || status == 201) std::fprintf(stderr, "[web] saved VU1 program %s\n", name.c_str());
        else unsupported = true;
    };
#endif
    if (!EM_ASM_INT({ return Module.noCard ? 1 : 0; })) {
        ps2::g_options.memcard_path = "/memcard/Mcd001.ps2";
        ps2::g_options.on_memcard_saved = [] { MAIN_THREAD_EM_ASM({ if (Module.ps2CardSaved) Module.ps2CardSaved(); }); };
        ps2::g_options.on_memcard_save_failed = [] { MAIN_THREAD_ASYNC_EM_ASM({ if (Module.ps2CardSaveFailed) Module.ps2CardSaveFailed(); }); };
    }
    ps2::set_audio_sink(push_audio);
    register_generated_code();
    register_generated_vu();

    ps2::init_graphics();
    const bool no_surface = EM_ASM_INT({ return Module.noSurface ? 1 : 0; });
    bool copy = EM_ASM_INT({ return Module.presentCopy ? 1 : 0; });
    bool surface = false;
    if (!copy && !no_surface) {
        ps2::WindowTarget target;
        target.kind = ps2::WindowTarget::Canvas;
        target.selector = "#canvas";
        target.width = static_cast<std::uint32_t>(EM_ASM_INT({ return Module.canvas.width; }));
        target.height = static_cast<std::uint32_t>(EM_ASM_INT({ return Module.canvas.height; }));
        surface = ps2::attach_window(target);
    }
    copy = copy || (!surface && !no_surface);
    std::fprintf(stderr, "[web] %s\n", surface ? "presenting through WebGPU" : copy ? "presenting through a 2D canvas copy" : "not presenting");

    ps2::start_render_thread();
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 16u << 20);
    if (!std::getenv("PS2_NO_VU_THREAD")) {
        ps2::start_vu_thread();
        pthread_t vu_thread;
        if (pthread_create(&vu_thread, &attr, [](void *) -> void * {
                ps2web_require_sync_worker();
                ps2::run_vu_thread();
                return nullptr;
            }, nullptr) != 0) {
            std::fprintf(stderr, "[web] cannot start the VU thread\n");
            return 1;
        }
    }
    pthread_t thread;
    if (pthread_create(&thread, &attr, emulate, &launch) != 0) {
        std::fprintf(stderr, "[web] cannot start the emulation thread\n");
        return 1;
    }
    const std::function<void(const std::uint32_t *, std::uint32_t, std::uint32_t)> blit = [](const std::uint32_t *rgba, std::uint32_t width, std::uint32_t height) {
        ps2web_blit(rgba, static_cast<int>(width), static_cast<int>(height), ps2::g_options.widescreen ? 1 : 0);
    };
    const std::function<void(const std::uint32_t *, std::uint32_t, std::uint32_t)> none;
    const std::function<void()> wait_shown = [] {
        const double start = emscripten_get_now();
        // Audio consumption clocks the EE worker. With low reserve, only
        // wait to release a full queue if the expected refresh leaves headroom.
        const double audio_ms = audio_queued_ms();
        const bool capacity_only = g_audio.active.load() && audio_ms < 40.0;
        if (capacity_only && !ps2web_wait_capacity_safe(audio_ms)) return;
        ps2web_wait_shown(capacity_only ? 1 : 0);
        g_render_idle.store(g_render_idle.load() + emscripten_get_now() - start);
    };
    for (;;) {
        service_disc();
        bool displayed = false;
        const ps2::Rendered rendered = ps2::render_pending(surface, copy ? blit : none, wait_shown, 6.0, &displayed);
        if (rendered == ps2::Rendered::presented) ps2web_frame_done(displayed);
        // Presentation already schedules a refresh wait before the next
        // image. Prepare its queued work immediately; another posted task
        // here can be delayed by input and waste that frame's render time.
        if (rendered == ps2::Rendered::busy) {
            ps2::browser_yield();
        } else if (rendered == ps2::Rendered::idle) {
            const double start = emscripten_get_now();
            ps2::wait_render_work(50);
            g_render_idle.store(g_render_idle.load() + emscripten_get_now() - start);
        }
    }
}
