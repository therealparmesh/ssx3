#!/usr/bin/env python3
"""Compile and exercise the browser host's actual C++ disc-cache implementation.

The Emscripten fetch wait is replaced with a deterministic in-memory disc. This
keeps the test asset-free while retaining the production allocation, read-ahead,
retry and copy code, rather than duplicating its cache policy in a test model.
"""
import argparse
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[1] / 'host/web.cpp')
parser.add_argument('--cxx', default=os.environ.get('CXX', 'c++'))
args = parser.parse_args()
source = args.source.read_text()
begin = source.index('constexpr std::size_t kChunk =')
end = source.index('\nvoid service_disc()', begin)
code = source[begin:end]
header = r'''
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>
#define MAIN_THREAD_ASYNC_EM_ASM(...) ((void)0)
namespace ps2 {
void wake_render_thread() {}
void halt(const char *message) { throw std::runtime_error(message); }
}
void usleep(unsigned) {}
void emscripten_futex_wait(void *, unsigned, double);
'''
tests = r'''
unsigned fetch_waits = 0;
void emscripten_futex_wait(void *address, unsigned, double) {
    ++fetch_waits;
    for (auto &slot : g_slots) if (&slot.state == address) {
        if (!slot.data) slot.data = new std::uint8_t[kChunk];
        std::memset(slot.data, static_cast<unsigned char>(slot.index), slot.size);
        slot.state.store(kReady);
        return;
    }
    throw std::runtime_error("Unknown fetch wait");
}
void fill_cache(unsigned other_state) {
    for (unsigned i = 0; i < kSlots; ++i) {
        auto &slot = g_slots[i];
        slot.state.store(other_state);
        slot.index = 1000 + i;
        slot.used = i + 2;
        slot.size = kChunk;
        slot.attempts = 0;
    }
    auto &requested = g_slots[0];
    requested.index = 200;
    requested.used = 1;
    if (!requested.data) requested.data = new std::uint8_t[kChunk];
    std::memset(requested.data, 200, kChunk);
    requested.state.store(kReady);
    g_disc_size = 4096ull * kChunk;
    g_use_clock = kSlots + 2;
    // Revisit a recently passed audio/data chunk while sequential prefetch
    // remains active further ahead on the disc.
    g_last_chunk = 210;
    g_run = 8;
}
int main() {
    unsigned failures = 0;
    for (const auto state : {kReady, kLoading}) {
        fill_cache(state);
        std::uint8_t byte = 0;
        const auto read = read_disc(200ull * kChunk + 17, &byte, 1);
        if (read != 1 || byte != 200 || g_slots[0].index != 200) {
            std::fprintf(stderr, "FAIL: read-ahead replaced requested chunk 200 with %llu; read byte %u (other slots %s)\n",
                static_cast<unsigned long long>(g_slots[0].index), byte,
                state == kReady ? "ready" : "loading");
            ++failures;
        }
        const auto *prefetched = find_slot(211);
        if ((state == kReady && (!prefetched || prefetched->state.load() != kLoading)) ||
            (state == kLoading && prefetched)) {
            std::fputs("FAIL: read-ahead did not respect available cache capacity\n", stderr);
            ++failures;
        }
    }
    // Readiness is a promise that an immediate read will not wait for HTTP.
    // With a full cache, speculative prefetch must not evict that promise.
    for (const auto state : {kReady, kLoading}) {
        fill_cache(state);
        const auto before = fetch_waits;
        if (!disc_ready(200ull * kChunk + 17, 1) || !find_slot(200) ||
            find_slot(200)->state.load() != kReady) {
            std::fputs("FAIL: readiness prefetch evicted requested disc data\n", stderr);
            ++failures;
        }
        std::uint8_t byte = 0;
        if (read_disc(200ull * kChunk + 17, &byte, 1) != 1 || byte != 200 || fetch_waits != before) {
            std::fputs("FAIL: a ready read unexpectedly waited for a network fetch\n", stderr);
            ++failures;
        }
        fill_cache(state);
        auto &second = g_slots[1];
        second.index = 201;
        second.state.store(kReady);
        if (!second.data) second.data = new std::uint8_t[kChunk];
        std::memset(second.data, 201, kChunk);
        // Make the next chunk the oldest eviction candidate during the first copy.
        second.used = 0;
        if (!disc_ready(201ull * kChunk - 1, 2) || !find_slot(200) || !find_slot(201) ||
            find_slot(200)->state.load() != kReady || find_slot(201)->state.load() != kReady) {
            std::fputs("FAIL: readiness did not preserve the complete requested range\n", stderr);
            ++failures;
        }
    }
    fill_cache(kLoading);
    if (disc_ready(201ull * kChunk - 1, 2) || !find_slot(200) ||
        find_slot(200)->state.load() != kReady) {
        std::fputs("FAIL: allocating a missing demand chunk evicted earlier ready data\n", stderr);
        ++failures;
    }
    fill_cache(kReady);
    auto &second = g_slots[1];
    second.index = 201;
    second.used = 0;
    if (!second.data) second.data = new std::uint8_t[kChunk];
    std::memset(second.data, 201, kChunk);
    std::uint8_t bytes[2] = {};
    const auto before = fetch_waits;
    if (read_disc(201ull * kChunk - 1, bytes, 2) != 2 ||
        bytes[0] != 200 || bytes[1] != 201 || fetch_waits != before) {
        std::fputs("FAIL: copying the first chunk evicted a later ready chunk in the same read\n", stderr);
        ++failures;
    }
    // A direct read larger than the cache must recycle already-copied chunks.
    fill_cache(kReady);
    g_last_chunk = ~0ull;
    g_run = 0;
    std::vector<std::uint8_t> large((kSlots + 1ull) * kChunk);
    if (read_disc(0, large.data(), large.size()) != large.size()) {
        std::fputs("FAIL: a read larger than the cache did not complete\n", stderr);
        ++failures;
    }
    for (unsigned i = 0; i <= kSlots; ++i) {
        if (large[i * kChunk] != static_cast<unsigned char>(i)) {
            std::fputs("FAIL: large streamed read returned incorrect bytes\n", stderr);
            ++failures;
            break;
        }
    }
    for (auto &slot : g_slots) delete[] slot.data;
    if (failures) return 1;
    std::puts("PASS: demand reads and readiness preserve disc data across full-cache prefetch without network waits");
}
'''
with tempfile.TemporaryDirectory(prefix='ssx3-disc-cache-') as folder:
    path = Path(folder)
    (path / 'test.cpp').write_text(header + code + tests)
    subprocess.run(shlex.split(args.cxx) + ['-std=c++17', '-O0', '-pthread', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    result = subprocess.run([str(path / 'test')])
    sys.exit(result.returncode)
