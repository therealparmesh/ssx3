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
#define MAIN_THREAD_ASYNC_EM_ASM(...) ((void)0)
namespace ps2 {
void wake_render_thread() {}
void halt(const char *message) { throw std::runtime_error(message); }
}
void usleep(unsigned) {}
void emscripten_futex_wait(void *, unsigned, double);
'''
tests = r'''
void emscripten_futex_wait(void *address, unsigned, double) {
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
    for (auto &slot : g_slots) delete[] slot.data;
    if (failures) return 1;
    std::puts("PASS: ready disc data survives read-ahead with a full cache and with every other slot loading");
}
'''
with tempfile.TemporaryDirectory(prefix='ssx3-disc-cache-') as folder:
    path = Path(folder)
    (path / 'test.cpp').write_text(header + code + tests)
    subprocess.run(shlex.split(args.cxx) + ['-std=c++17', '-O0', '-pthread', str(path / 'test.cpp'), '-o', str(path / 'test')], check=True)
    result = subprocess.run([str(path / 'test')])
    sys.exit(result.returncode)
