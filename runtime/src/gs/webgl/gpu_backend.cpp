#include "../gpu/gpu.hpp"
#include "app_shared/AppConfig.h"
#include "gs/GSH_OpenGL/GSH_OpenGL.h"
#include "register_stream.hpp"
#include <GLES3/gl3.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <limits>
#include <memory>
#include <stdexcept>
#include <thread>

fs::path CAppConfig::GetBasePath() const { return "/tmp"; }
extern const char kGsWebglKernel[];
extern "C" int ps2_webgl_prepare_context();
extern "C" void ps2_webgl_resize_context(int, int);

namespace ps2::gs::gpu {
namespace {
constexpr std::size_t words = kMemorySize / 4;
constexpr std::uint32_t stateMagic = 0x334c4757, clutMagic = 0x314c4357;
class Backend final : public CGSH_OpenGL {
  public:
    Backend() : CGSH_OpenGL(false) {}
    void close() { ReleaseImpl(); }
    void sync() {
        SyncMemoryCache();
        // Internal clean-cache lookups need no driver query. Public exports
        // still report a pending GL failure before returning caller data.
        if (glGetError())
            throw std::runtime_error("WebGL VRAM export GL error");
    }
    void restore() { WriteBackMemoryCache(); }
    void show(const DisplaySource &src, unsigned w, unsigned h) {
        SetPresentationParams({w, h, CGSHandler::PRESENTATION_MODE_FILL});
        DrainPendingCalls();
        DISPLAY_INFO d{};
        d.width = w;
        d.height = h;
        auto &l = d.layers[0];
        l.enabled = true;
        l.width = w;
        l.height = h;
        l.bufPtr = src.fbp * 256;
        l.bufWidth = src.fbw * 64;
        l.psm = src.psm;
        FlipImpl(d);
        m_flipped = false;
    }
    void save(std::vector<std::uint32_t> &vram, std::vector<std::uint32_t> &clut) {
        vram.resize(words);
        std::memcpy(vram.data(), GetRam(), kMemorySize);
        vram.insert(vram.end(), {stateMagic, 1, 7});
        for (unsigned i = 0; i < 128; i++) {
            auto v = GetRegisters()[i];
            vram.push_back(v);
            vram.push_back(v >> 32);
        }
        vram.insert(vram.end(),
                    {m_trxCtx.nSize, m_trxCtx.nRealSize, m_trxCtx.nRRX, m_trxCtx.nRRY, m_trxCtx.write24Carried,
                     std::uint32_t(m_trxCtx.write24Carry[0]) | (std::uint32_t(m_trxCtx.write24Carry[1]) << 8) |
                         (std::uint32_t(m_trxCtx.write24Carry[2]) << 16),
                     std::uint32_t(m_trxCtx.nDirty)});
        clut.assign(512, 0);
        const auto mode = (g_state.prmodecont & 1) ? g_state.prim : g_state.prmode;
        const bool sixteen = ((g_state.ctx[(mode >> 9) & 1].tex0 >> 51) & 15) != 0;
        for (unsigned i = 0; i < (sixteen ? 512u : 256u); i++)
            clut[i] = sixteen ? m_pCLUT[i] : std::uint32_t(m_pCLUT[i]) | (std::uint32_t(m_pCLUT[i + 256]) << 16);
        clut.insert(clut.end(), {clutMagic, 1});
        for (unsigned i = 0; i < 512; i++)
            clut.push_back(m_pCLUT[i]);
    }
    void load(const std::vector<std::uint32_t> &vram, std::uint32_t scale, const std::vector<std::uint32_t> &clut) {
        if (!scale || scale > 8 || vram.size() < words * scale * scale || clut.size() < 512)
            throw std::invalid_argument("Invalid WebGL GS snapshot");
        const bool tagged = scale == 1 && vram.size() > words && vram[words] == stateMagic;
        if (!tagged && vram.size() != words * scale * scale)
            throw std::invalid_argument("Unrecognized WebGL GS snapshot payload");
        if (tagged && (vram.size() != words + 3 + 256 + 7 || vram[words + 1] != 1 || vram[words + 2] != 7 ||
                       vram[words + 3 + 256 + 4] > 2))
            throw std::invalid_argument("Unsupported WebGL GS snapshot metadata");
        if (clut.size() > 512 && (clut.size() != 1026 || clut[512] != clutMagic || clut[513] != 1))
            throw std::invalid_argument("Unsupported WebGL CLUT snapshot");
        if (clut.size() == 1026)
            for (unsigned i = 514; i < 1026; i++)
                if (clut[i] > 65535)
                    throw std::invalid_argument("Invalid physical CLUT entry");
        Reset();
        DrainPendingCalls();
        if (scale == 1)
            std::memcpy(GetRam(), vram.data(), kMemorySize);
        else
            for (std::size_t i = 0; i < words; i++)
                std::memcpy(GetRam() + i * 4, &vram[i * scale * scale], 4);
        if (tagged) {
            auto at = words + 3;
            for (unsigned i = 0; i < 128; i++, at += 2)
                GetRegisters()[i] = vram[at] | (std::uint64_t(vram[at + 1]) << 32);
            m_trxCtx.nSize = vram[at++];
            m_trxCtx.nRealSize = vram[at++];
            m_trxCtx.nRRX = vram[at++];
            m_trxCtx.nRRY = vram[at++];
            m_trxCtx.write24Carried = vram[at++];
            auto carry = vram[at++];
            for (unsigned i = 0; i < 3; i++)
                m_trxCtx.write24Carry[i] = carry >> (8 * i);
            m_trxCtx.nDirty = vram[at] != 0;
        }
        if (clut.size() == 1026)
            for (unsigned i = 0; i < 512; i++)
                m_pCLUT[i] = clut[514 + i];
        else {
            const auto mode = (g_state.prmodecont & 1) ? g_state.prim : g_state.prmode;
            const bool sixteen = ((g_state.ctx[(mode >> 9) & 1].tex0 >> 51) & 15) != 0;
            for (unsigned i = 0; i < (sixteen ? 512u : 256u); i++) {
                if (sixteen)
                    m_pCLUT[i] = clut[i];
                else {
                    m_pCLUT[i] = clut[i];
                    m_pCLUT[i + 256] = clut[i] >> 16;
                }
            }
        }
        restore();
    }
    bool transferring() const { return m_trxCtx.nSize != 0; }

  protected:
    void PresentBackbuffer() override {}
};
std::unique_ptr<Backend> backend;
webgl::RegisterStream registers;
Mode currentMode = Mode::off;
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE context = 0;
std::thread::id owner;
unsigned queued = 0;
bool workSinceYield = false;
std::vector<std::uint32_t> pending;
unsigned pendingWidth = 0, pendingHeight = 0;
void check() {
    if (!backend || std::this_thread::get_id() != owner)
        throw std::runtime_error("WebGL GS called outside its rendering owner");
}
void drain() {
    check();
    backend->DrainPendingCalls();
    queued = 0;
}
void emit(std::uint8_t id, std::uint64_t value) {
    backend->WriteRegister({id, value});
    workSinceYield = true;
    if (++queued >= 8192)
        drain();
}
} // namespace
Mode mode() { return currentMode; }
bool init(Mode wanted) {
    if (wanted == Mode::off)
        return true;
    if (backend)
        return true;
    if (!ps2_webgl_prepare_context())
        return false;
    EmscriptenWebGLContextAttributes a;
    emscripten_webgl_init_context_attributes(&a);
    a.majorVersion = 2;
    a.alpha = false;
    a.antialias = false;
    a.preserveDrawingBuffer = true;
    context = emscripten_webgl_create_context("!ps2-webgl", &a);
    if (context <= 0)
        return false;
    if (emscripten_webgl_make_context_current(context) != EMSCRIPTEN_RESULT_SUCCESS) {
        emscripten_webgl_destroy_context(context);
        context = 0;
        return false;
    }
    owner = std::this_thread::get_id();
    EM_ASM(
        {
            Module.orderedKernelSource = UTF8ToString($0);
            Module.orderedRasterEnabled = true;
        },
        kGsWebglKernel);
    try {
        backend = std::make_unique<Backend>();
        backend->Initialize();
        backend->Reset();
        drain();
        backend->SetSMODE2(0);
        drain();
        registers.invalidate();
        currentMode = wanted;
        EM_ASM({ Module.ps2GpuBackend = 'webgl'; });
        return true;
    } catch (const std::exception &e) {
        std::fprintf(stderr, "[webgl] initialization failed: %s\n", e.what());
        if (backend)
            backend->close();
        backend.reset();
        emscripten_webgl_destroy_context(context);
        context = 0;
        return false;
    }
}
void draw(const State &s, const Vertex *v, int count) {
    check();
    if (&s != &g_state)
        registers.invalidate();
    registers.draw(s, v, count, g_setup_generation, emit);
}
void image_begin(const State &s) {
    check();
    registers.image_begin(s, emit);
}
void image_data(const std::uint8_t *data, std::size_t bytes) {
    if (!bytes)
        return;
    drain();
    if (!backend->transferring())
        throw std::runtime_error("WebGL image transfer has no active native context");
    if (bytes > std::numeric_limits<std::uint32_t>::max())
        throw std::invalid_argument("Oversized WebGL image packet");
    backend->FeedImageData(data, bytes);
    workSinceYield = true;
    drain();
}
void local_copy(const State &s) {
    drain();
    const auto b = s.bitbltbuf, p = s.trxpos, r = s.trxreg;
    const unsigned sbp = b & 0x3fff, sbw = (b >> 16) & 63, sp = (b >> 24) & 63, dbp = (b >> 32) & 0x3fff,
                   dbw = (b >> 48) & 63, dp = (b >> 56) & 63;
    if (sp == dp && sp != PSMCT24 && backend->HasCachedCopySurface(sbp * 256, sbw * 64, sp) &&
        backend->HasCachedCopySurface(dbp * 256, dbw * 64, dp)) {
        registers.local_copy(s, emit);
        drain();
    } else {
        backend->sync();
        std::memcpy(ps2::gs::memory(), backend->GetRam(), kMemorySize);
        const unsigned w = r & 0xfff, h = (r >> 32) & 0xfff, sx = p & 0x7ff, sy = (p >> 16) & 0x7ff,
                       dx = (p >> 32) & 0x7ff, dy = (p >> 48) & 0x7ff;
        std::vector<std::uint32_t> pixels(std::size_t(w) * h);
        for (unsigned y = 0; y < h; y++)
            for (unsigned x = 0; x < w; x++)
                pixels[y * w + x] = read_pixel(sp, sbp, sbw, (sx + x) & 2047, (sy + y) & 2047);
        for (unsigned y = 0; y < h; y++)
            for (unsigned x = 0; x < w; x++)
                write_pixel(dp, dbp, dbw, (dx + x) & 2047, (dy + y) & 2047, pixels[y * w + x]);
        std::memcpy(backend->GetRam(), ps2::gs::memory(), kMemorySize);
        backend->restore();
        workSinceYield = true;
    }
    registers.invalidate();
}
void load_clut(std::uint64_t tex0, std::uint64_t texclut) {
    check();
    registers.load_clut(tex0, texclut, emit);
}
void flush() {
    drain();
    backend->Finish(false);
    drain();
}
bool flush_pending() {
    drain();
    // WebGL calls do not suspend on a WebGPU completion promise. Report work
    // so the host takes its bounded browser-yield path between GIF packets,
    // including when a complete frame fits inside one render slice.
    const bool submitted = workSinceYield;
    workSinceYield = false;
    return submitted;
}
void texflush() {
    check();
    registers.texflush(emit);
}
void wait_idle() {
    flush();
    glFinish();
}
void download(std::uint8_t *memory, std::uint32_t offset, std::uint32_t bytes, std::uint32_t prefetch) {
    if (offset > kMemorySize || bytes > kMemorySize - offset || !memory)
        throw std::invalid_argument("Invalid WebGL VRAM download");
    if (!bytes)
        return;
    drain();
    backend->sync();
    const auto first = prefetch < kMemorySize ? std::min(offset, prefetch) & ~8191u : 0u;
    const auto end =
        prefetch < kMemorySize ? std::min(kMemorySize, std::max(offset + bytes, first + (1u << 20))) : kMemorySize;
    std::memcpy(memory + first, backend->GetRam() + first, end - first);
}
void read_state(std::vector<std::uint32_t> &vram, std::uint32_t &scale, std::vector<std::uint32_t> &clut) {
    drain();
    backend->sync();
    backend->save(vram, clut);
    scale = 1;
}
void write_state(const std::vector<std::uint32_t> &vram, std::uint32_t scale, const std::vector<std::uint32_t> &clut) {
    drain();
    backend->load(vram, scale, clut);
    registers.invalidate();
    pending.clear();
}
bool display(const DisplaySource &src, std::vector<std::uint32_t> &rgba, std::uint32_t &width, std::uint32_t &height) {
    drain();
    if (!src.width || !src.height || !src.fbw || src.width > 2048 || src.height > 2048)
        return false;
    width = src.width;
    height = src.height;
    rgba.resize(std::size_t(width) * height);
    const unsigned physical = src.halved ? (height + 1) / 2 : height;
    if (src.width + src.dbx > src.fbw * 64 || src.dby + physical > 1024) {
        download(ps2::gs::memory());
        for (unsigned y = 0; y < height; y++)
            for (unsigned x = 0; x < width; x++) {
                auto c = read_pixel(src.psm, src.fbp, src.fbw, src.dbx + x, src.dby + (src.halved ? y / 2 : y));
                if (src.psm == PSMCT16 || src.psm == PSMCT16S)
                    c = ((c & 31) << 3) | ((c & 0x3e0) << 6) | ((c & 0x7c00) << 9);
                rgba[std::size_t(y) * width + x] = c | 0xff000000;
            }
    } else {
        ps2_webgl_resize_context(width + src.dbx, physical + src.dby);
        backend->show(src, width + src.dbx, physical + src.dby);
        std::vector<std::uint32_t> raw(std::size_t(width) * physical);
        glReadPixels(src.dbx, 0, width, physical, GL_RGBA, GL_UNSIGNED_BYTE, raw.data());
        if (glGetError())
            throw std::runtime_error("WebGL display readback failed");
        for (unsigned y = 0; y < height; y++)
            for (unsigned x = 0; x < width; x++)
                rgba[std::size_t(y) * width + x] =
                    raw[std::size_t(physical - 1 - (src.halved ? y / 2 : y)) * width + x] | 0xff000000;
    }
    pending.clear();
    return true;
}
bool display_async(const DisplaySource &src, std::vector<std::uint32_t> &rgba, std::uint32_t &width,
                   std::uint32_t &height) {
    std::vector<std::uint32_t> next;
    unsigned w = 0, h = 0;
    // display() clears pending only for explicit synchronous clients.
    auto old = std::move(pending);
    const auto ow = pendingWidth, oh = pendingHeight;
    if (!display(src, next, w, h)) {
        pending = std::move(old);
        return false;
    }
    pending = std::move(next);
    pendingWidth = w;
    pendingHeight = h;
    if (old.empty())
        return false;
    rgba = std::move(old);
    width = ow;
    height = oh;
    return true;
}
bool attach_surface(const SurfaceTarget &) { return false; }
void resize_surface(std::uint32_t, std::uint32_t) {}
bool has_surface() { return false; }
bool present(const DisplaySource &) { return false; }
double busy_ms() { return 0; }
void stats() {
    if (backend) {
        const auto p = backend->GetDrawProfile();
        std::fprintf(stderr, "[webgl] passes=%llu vertices=%llu\n", p.passes, p.vertices);
    }
}
} // namespace ps2::gs::gpu
