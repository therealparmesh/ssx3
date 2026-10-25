#include "gs/gif.hpp"
#include "gs/gs.hpp"
#include "gs/queue.hpp"
#include "gs/gpu/readback_cache.hpp"
#include "hw.hpp"
#include "iop/sio2.hpp"
#include "ps2/memory.hpp"
#include "ps2/state.hpp"
#include "ps2/system.hpp"
#include "vif.hpp"
#include "vu_micro.hpp"

#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>
#if defined(__unix__) || defined(__APPLE__)
#include <csignal>
#include <sys/resource.h>
#endif

namespace {

void expect(bool ok, const char *message) {
    if (!ok) throw std::runtime_error(message);
}

void memory_card_retries_failed_writes() {
    namespace fs = std::filesystem;
    struct Scratch {
        fs::path path = fs::temp_directory_path() / ("ps2-card-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        Scratch() { expect(fs::create_directory(path), "Could not create card test directory"); }
        ~Scratch() { std::error_code error; fs::remove_all(path, error); }
    } scratch;
    const auto directory = scratch.path / "card", hidden = scratch.path / "temporarily-unavailable";
    fs::create_directory(directory);
    const auto file = directory / "Mcd001.ps2";
    const std::vector<std::uint8_t> original(528u * 0x4000u, 0x7A);
    { std::ofstream out(file, std::ios::binary); out.write(reinterpret_cast<const char *>(original.data()), original.size()); }
    unsigned saved = 0, failures = 0;
    ps2::g_options.memcard_path = file.string();
    ps2::g_options.on_memcard_saved = [&] {
        expect(ps2::memory_card_pending(), "Card settled before notifying the host");
        ++saved;
    };
    ps2::g_options.on_memcard_save_failed = [&] { ++failures; };
    ps2::iop::sio2::reset();
    const auto command = [](std::initializer_list<std::uint8_t> bytes) {
        ps2::iop::sio2::write(0x1F808268, 0xC);
        ps2::iop::sio2::write(0x1F808200, 2u | (static_cast<std::uint32_t>(bytes.size()) << 8) | (8u << 18));
        for (auto byte : bytes) ps2::iop::sio2::write(0x1F808260, byte);
    };
    command({0x81, 0x22, 0, 0, 0, 0});
    command({0x81, 0x42, 3, 1, 2, 3});
    expect(ps2::memory_card_pending(), "Pending card writes were invisible before the quiet interval");
    fs::rename(directory, hidden);
    for (int i = 0; i < 50; ++i) ps2::iop::sio2::flush_cards();
    expect(saved == 0, "Failed card save reported success");
    expect(failures == 1, "Card write failure was not reported");
    expect(ps2::memory_card_pending(), "Failed card write lost its pending status");
    fs::rename(hidden, directory);
    for (int i = 0; i < 50; ++i) ps2::iop::sio2::flush_cards();
    expect(saved == 1, "Card write failure discarded the pending save instead of retrying");
    expect(!ps2::memory_card_pending(), "Completed card write stayed pending");
    std::vector<std::uint8_t> contents(original.size());
    { std::ifstream in(file, std::ios::binary); in.read(reinterpret_cast<char *>(contents.data()), contents.size()); expect(in.good(), "Retried card save was truncated"); }
    auto expected = original;
    expected[0] = 1; expected[1] = 2; expected[2] = 3;
    expect(contents == expected, "Retried card save lost game data");

    const auto read_card = [&] {
        expect(fs::file_size(file) == original.size(), "Card file length changed");
        std::vector<std::uint8_t> bytes(original.size());
        std::ifstream in(file, std::ios::binary);
        in.read(reinterpret_cast<char *>(bytes.data()), bytes.size());
        expect(in.good(), "Could not read the saved card");
        return bytes;
    };
    const auto backup = directory / "previous.ps2";
    fs::rename(file, backup);
    fs::create_directory(file);
    { std::ofstream sentinel(file / "keep"); sentinel << "do not remove"; }
    command({0x81, 0x22, 0, 0, 0, 0});
    command({0x81, 0x42, 1, 4});
    for (int i = 0; i < 50; ++i) ps2::iop::sio2::flush_cards();
    expect(saved == 1 && failures == 2, "Card replacement failure reported success or failed to notify");
    expect(fs::exists(file / "keep"), "Failed replacement removed the destination directory");
    expect(!fs::exists(file.string() + ".tmp"), "Failed replacement left a partial temporary card");
    fs::remove(file / "keep"); fs::remove(file); fs::rename(backup, file);
    expect(read_card() == expected, "Failed replacement changed the previous card");
    for (int i = 0; i < 50; ++i) ps2::iop::sio2::flush_cards();
    expected[0] = 4;
    expect(saved == 2 && read_card() == expected, "Card replacement was not retried correctly");

#if defined(__unix__) || defined(__APPLE__)
    command({0x81, 0x22, 0, 0, 0, 0});
    command({0x81, 0x42, 1, 9});
    {
        struct FileSizeLimit {
            struct rlimit previous{};
            using Handler = void (*)(int);
            Handler handler;
            FileSizeLimit() {
                expect(getrlimit(RLIMIT_FSIZE, &previous) == 0, "Could not read file-size limit");
                handler = std::signal(SIGXFSZ, SIG_IGN);
                auto limit = previous;
                limit.rlim_cur = 4096;
                expect(setrlimit(RLIMIT_FSIZE, &limit) == 0, "Could not set test file-size limit");
            }
            ~FileSizeLimit() { setrlimit(RLIMIT_FSIZE, &previous); std::signal(SIGXFSZ, handler); }
        } limit;
        for (int i = 0; i < 50; ++i) ps2::iop::sio2::flush_cards();
    }
    expect(saved == 2 && failures == 3, "Partial file write reported a completed save");
    expect(read_card() == expected, "Partial file write damaged the previous card");
    expect(!fs::exists(file.string() + ".tmp"), "Partial write left a temporary card");
    for (int i = 0; i < 50; ++i) ps2::iop::sio2::flush_cards();
    expected[0] = 9;
    expect(saved == 3 && read_card() == expected, "Partial card write was not retried correctly");
#endif
    const auto completed = saved;
    for (int i = 0; i < 100; ++i) ps2::iop::sio2::flush_cards();
    expect(saved == completed, "Clean card was saved again");
    ps2::g_options.on_memcard_saved = {};
    ps2::g_options.on_memcard_save_failed = {};
    ps2::g_options.memcard_path.clear();
}

void readback_cache_tracks_gpu_writes() {
    using Cache = ps2::gs::gpu::ReadbackCache;
    Cache cache;
    std::vector<std::uint8_t> input(Cache::size, 0x5A), output(Cache::page_size * 2);
    expect(!cache.copy(0, 1, output.data()), "Empty readback cache returned data");
    cache.store(0, Cache::size, input.data());
    expect(cache.copy(0, output.size(), output.data()) && output.front() == 0x5A && output.back() == 0x5A, "Completed readback was not cached");
    cache.invalidate(Cache::page_size - 1, Cache::page_size + 1);
    expect(!cache.copy(0, 1, output.data()) && !cache.copy(Cache::page_size, 1, output.data()), "Unaligned GPU write missed a touched page");
    expect(cache.copy(Cache::page_size * 2, 1, output.data()), "GPU write invalidated an unrelated page");
    cache.store(1, Cache::page_size - 1, input.data());
    expect(!cache.copy(1, 1, output.data()), "Partial readback marked an incomplete page valid");
    cache.store(0, Cache::page_size, input.data());
    expect(cache.copy(0, 1, output.data()), "Full page readback did not repair invalidation");
    cache.invalidate(Cache::size - 1, Cache::size + 1);
    expect(!cache.copy(0, 1, output.data()) && !cache.copy(Cache::size - 1, 1, output.data()), "Wrapped GPU write missed a touched page");
    expect(!cache.copy(Cache::size - 1, 2, output.data()), "Out-of-range readback was accepted");
    cache.store(0, Cache::size, input.data());
    cache.invalidate(256, Cache::size + 256ull);
    expect(!cache.copy(Cache::page_size * 2, 1, output.data()), "Full VRAM write retained cached data");
}

void feed(std::vector<std::uint32_t> words) {
    while (words.size() % 4) words.push_back(0);
    ps2::vif::transfer(1, reinterpret_cast<const std::uint8_t *>(words.data()), static_cast<std::uint32_t>(words.size() / 4));
}

void packed_colours_bypass_stmod() {
    for (const std::uint32_t mode : {1u, 2u, 3u}) {
        ps2::vif::reset();
        std::memset(ps2::g_vu1_mem, 0, 16384);
        feed({0x30000000, 1, 2, 3, 4, 0x01000101, 0x05000000 | mode, 0x6F010000, 0xFFFF});
        std::array<std::uint32_t, 4> got{};
        std::memcpy(got.data(), ps2::g_vu1_mem, 16);
        expect(got == std::array<std::uint32_t, 4>{248, 248, 248, 128}, "V4-5 colour was changed by STMOD");
        for (unsigned lane = 0; lane < 4; ++lane)
            expect(ps2::vif::read(1, 0x100 + lane * 16) == lane + 1, "V4-5 colour changed the row register");
    }
}

void mode_three_updates_row() {
    ps2::vif::reset();
    std::memset(ps2::g_vu1_mem, 0, 16384);
    feed({0x01000101, 0x05000003, 0x6C010000, 11, 22, 33, 44,
          0x05000001, 0x6C010001, 1, 2, 3, 4});
    std::array<std::uint32_t, 4> got{};
    std::memcpy(got.data(), ps2::g_vu1_mem + 16, 16);
    expect(got == std::array<std::uint32_t, 4>{12, 24, 36, 48}, "STMOD 3 did not seed the following offset unpack");
}

void contiguous_unpack_wraps_and_preserves_padding_state() {
    for (const std::uint32_t start : {0u, 1023u}) {
        ps2::vif::reset();
        std::memset(ps2::g_vu1_mem, 0xA5, 16384);
        std::vector<std::uint32_t> words{0x01000101, 0x6C000000 | start}; // NUM=0 means 256 vectors
        for (unsigned i = 0; i < 1024; ++i) words.push_back(0x12340000u + i);
        feed(words);
        for (unsigned vector = 0; vector < 1024; ++vector) {
            const unsigned offset = (vector + 1024 - start) % 1024;
            for (unsigned lane = 0; lane < 4; ++lane) {
                std::uint32_t got;
                std::memcpy(&got, ps2::g_vu1_mem + vector * 16 + lane * 4, 4);
                const auto expected = offset < 256 ? 0x12340000u + offset * 4 + lane : 0xA5A5A5A5u;
                expect(got == expected, "Contiguous unpack corrupted wrapped or untouched VU memory");
            }
        }
        expect(ps2::vif::read(1, 0x80) == 0, "Padding NOP did not update CODE");
    }
    // An interrupting NOP must still stall until FBRST clears the interrupt.
    ps2::vif::reset();
    feed({0x80000000, 0x07000012, 0, 0});
    expect(ps2::vif::stalled(1), "Interrupting NOP did not stall VIF");
    expect(ps2::vif::read(1, 0x30) == 0, "VIF ran beyond an interrupting NOP");
    ps2::vif::write(1, 0x10, 8);
    expect(ps2::vif::read(1, 0x30) == 0x12, "VIF failed to resume after interrupting NOP");
}

void clip_flags_arrive_after_four_cycles() {
    constexpr std::uint32_t lower_nop = 0x8000033C, upper_nop = 0x000002FF;
    const auto clip = [](unsigned source) { return (0xEu << 21) | (3u << 16) | (source << 11) | 0x1FFu; };
    const std::array<std::array<std::uint32_t, 2>, 8> program{{
        {lower_nop, clip(1)}, {lower_nop, clip(2)},
        {lower_nop, upper_nop}, {lower_nop, upper_nop},
        {0x38010000, upper_nop}, // FCGET vi1: first vertex's flags
        {0x38020000, upper_nop}, // FCGET vi2: second vertex's flags
        {lower_nop, upper_nop | 0x40000000u}, {lower_nop, upper_nop},
    }};
    for (const int unit : {0, 1}) {
        auto &r = ps2::vu::regs(unit);
        r = {};
        r.vf[0].w[3] = 0x3F800000;
        r.vf[1].w[0] = 0x40000000; // +2 outside the +X plane
        r.vf[2].w[0] = 0xC0000000; // -2 outside the -X plane
        r.vf[3].w[3] = 0x3F800000; // clipping extent 1
        auto *code = unit ? ps2::g_vu1_code : ps2::g_vu0_code;
        std::memset(code, 0, unit ? 16384 : 4096);
        std::memcpy(code, program.data(), sizeof program);
        ps2::vu::code_changed(unit);
        ps2::vu::run(unit, 0);
        expect(r.vi[1] == 0x1, "FCGET read the next vertex's CLIP flags a cycle early");
        expect(r.vi[2] == 0x42, "FCGET lost the second vertex's CLIP flags");
    }
}

std::array<ps2::Reg128, 2> packet(std::uint64_t value) {
    std::array<ps2::Reg128, 2> out{};
    out[0].d[0] = 1ull | (1ull << 15) | (1ull << 60); // one PACKED A+D, EOP
    out[0].d[1] = 0xE;
    out[1].d[0] = value;
    out[1].d[1] = 0x3B; // TEXA is observable without drawing pixels.
    return out;
}

class BufferState : public ps2::state::Stream {
public:
    explicit BufferState(bool saving, std::vector<std::uint8_t> contents = {}) : Stream(saving), data(std::move(contents)) { set_version(5); }
    void bytes(void *ptr, std::size_t size) override {
        if (saving()) {
            const auto *first = static_cast<const std::uint8_t *>(ptr);
            data.insert(data.end(), first, first + size);
        } else {
            if (offset + size > data.size()) throw std::runtime_error("Truncated test snapshot");
            std::memcpy(ptr, data.data() + offset, size);
            offset += size;
        }
    }
    std::vector<std::uint8_t> data;
    std::size_t offset = 0;
};

void path_three_keeps_packet_order() {
    ps2::gs::render_reset();
    ps2::gif::reset();
    const auto a = packet(0x11), b = packet(0x22), c = packet(0x33);
    std::array<ps2::Reg128, 4> stream{a[0], a[1], b[0], b[1]};
    ps2::gif::set_path3_masked(true);
    ps2::gif::transfer(3, reinterpret_cast<const std::uint8_t *>(stream.data()), 4);
    expect(ps2::gs::g_state.texa == 0, "Masked PATH3 wrote GS registers");
    BufferState saved(true);
    ps2::gif::state(saved);
    ps2::gif::set_path3_masked(false);
    expect(ps2::gs::g_state.texa == 0x11, "PATH3 ran past its first EOP boundary");
    ps2::gif::transfer(1, reinterpret_cast<const std::uint8_t *>(c.data()), 2);
    expect(ps2::gs::g_state.texa == 0x33, "PATH1 could not draw between streamed textures");
    ps2::gif::set_path3_masked(true);
    ps2::gif::set_path3_masked(false);
    expect(ps2::gs::g_state.texa == 0x22, "PATH3 lost the remaining packet");

    BufferState restored(false, saved.data);
    ps2::gif::state(restored);
    ps2::gif::set_path3_masked(false);
    expect(ps2::gs::g_state.texa == 0x11, "Snapshot lost deferred PATH3 data");
    ps2::gif::reset();
    ps2::gif::set_path3_masked(false);
    expect(ps2::gs::g_state.texa == 0x11, "GIF reset retained a deferred transfer");
}

void path_three_streams_append_and_restore(bool queued) {
    using namespace ps2;
    const auto drain = [&] {
        if (!queued) return;
        gs::queue::Header header;
        const std::uint8_t *payload;
        while (gs::queue::render().peek(header, payload)) {
            if (header.type == gs::queue::kGifReset) gif::render_reset();
            else {
                expect(header.type == gs::queue::kGif && header.arg0 == 3 && header.bytes == 32,
                       "Deferred PATH3 queued the wrong packet boundary");
                gif::render(3, payload, header.arg1);
            }
            gs::queue::render().pop(header);
        }
    };
    gs::render_reset();
    gif::reset();
    drain();
    const auto append = [](unsigned first, unsigned last) {
        std::vector<Reg128> stream;
        for (unsigned i = first; i <= last; ++i) {
            const auto p = packet(i);
            stream.insert(stream.end(), p.begin(), p.end());
        }
        gif::transfer(3, reinterpret_cast<const std::uint8_t *>(stream.data()), static_cast<std::uint32_t>(stream.size()));
    };
    const auto release = [&](unsigned expected) {
        gif::set_path3_masked(false);
        drain();
        expect(gs::g_state.texa == expected, "Deferred PATH3 reordered, repeated or skipped a streamed packet");
    };
    gif::set_path3_masked(true);
    append(1, 96);
    for (unsigned i = 1; i <= 32; ++i) release(i);
    append(97, 128); // Append with less than half the storage consumed.
    for (unsigned i = 33; i <= 96; ++i) release(i);
    append(129, 224); // Reclaim a mostly consumed prefix before appending.
    for (unsigned i = 97; i <= 120; ++i) release(i);
    BufferState saved(true);
    gif::state(saved);
    std::uint32_t unread = 0;
    std::memcpy(&unread, saved.data.data() + saved.data.size() - 104 * 32 - 4, 4);
    expect(unread == 104 * 32, "Version-5 snapshot included consumed PATH3 bytes");
    release(121);
    BufferState rewind(false, saved.data);
    gif::state(rewind); // Loading over a partially consumed queue resets its cursor.
    for (unsigned i = 121; i <= 224; ++i) release(i);
    // The queue must own its payload after the backing vector is cleared.
    gif::set_path3_masked(true);
    append(225, 225);
    gif::set_path3_masked(false);
    append(226, 226);
    drain();
    expect(gs::g_state.texa == 226, "Queued PATH3 payload changed after its source was reused");
    BufferState restored(false, saved.data);
    gif::state(restored);
    for (unsigned i = 121; i <= 224; ++i) release(i);
    release(224); // Empty queue cannot replay the final packet.
    gif::set_path3_masked(true);
    append(1, 4);
    release(1);
    gif::reset();
    drain();
    release(1); // Reset must discard the unread suffix as well as its cursor.
}

}

int main() {
    try {
        readback_cache_tracks_gpu_writes();
        packed_colours_bypass_stmod();
        mode_three_updates_row();
        contiguous_unpack_wraps_and_preserves_padding_state();
        clip_flags_arrive_after_four_cycles();
        path_three_keeps_packet_order();
        memory_card_retries_failed_writes();
        path_three_streams_append_and_restore(false);
        ps2::gs::queue::render().start(65536);
        path_three_streams_append_and_restore(true);
        std::puts("PASS: packed colours, STMOD row updates, VU CLIP latency, PATH3 ordering, snapshot and reset");
        return 0;
    } catch (const std::exception &e) {
        std::fprintf(stderr, "FAIL: %s\n", e.what());
        return 1;
    }
}
