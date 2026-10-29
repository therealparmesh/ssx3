#include "ipu/idct.hpp"
#include <array>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#if defined(PS2_TEST_WASM_SIMD) && !defined(__wasm_simd128__)
#error The Wasm fixture must exercise SIMD.
#endif

// Frozen scalar transform from candidate d8df1e3, with the original basis layout.
void scalar(const int *in, std::int16_t *out, const double (&c)[8][8]) {
    double rows[8][8];
    for (int v = 0; v < 8; ++v)
        for (int x = 0; x < 8; ++x) {
            double s = 0;
            for (int u = 0; u < 8; ++u) s += c[x][u] * in[v * 8 + u];
            rows[v][x] = s;
        }
    for (int y = 0; y < 8; ++y)
        for (int x = 0; x < 8; ++x) {
            double s = 0;
            for (int v = 0; v < 8; ++v) s += c[y][v] * rows[v][x];
            out[y * 8 + x] = static_cast<std::int16_t>(std::clamp(static_cast<int>(std::floor(s + 0.5)), -256, 255));
        }
}

struct Basis { double pad; double frequency[8][8]; };
struct Coefficients { int pad; std::array<int, 64> values; };

int main(int argc, char **argv) {
    // Both structures deliberately offset SIMD inputs from 16-byte alignment.
    alignas(16) Basis basis{};
    double original[8][8];
    for (int x = 0; x < 8; ++x)
        for (int u = 0; u < 8; ++u)
            basis.frequency[u][x] = original[x][u] =
                (u ? 0.5 : 0.5 / std::sqrt(2.0)) * std::cos((2*x+1)*u*3.14159265358979323846/16.0);

    std::uint32_t seed = 0x31415926u;
    unsigned cases = 0;
    std::uint64_t hash = 1469598103934665603ull;
    // Use the full state, avoiding short low-bit cycles in generated masks.
    const auto random = [&] {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        return seed;
    };
    const auto check = [&](const std::array<int, 64> &coefficients) {
        alignas(16) Coefficients input{12345, coefficients};
        alignas(16) std::int16_t actual[68];
        std::int16_t expected[64];
        std::fill(std::begin(actual), std::end(actual), 12345);
        scalar(coefficients.data(), expected, original);
        ps2::ipu::detail::inverse_dct(input.values.data(), actual + 1, basis.frequency);
        if (input.pad != 12345 || input.values != coefficients || actual[0] != 12345 ||
            actual[65] != 12345 || actual[66] != 12345 || actual[67] != 12345) {
            std::fprintf(stderr, "Input or output sentinel changed in case %u\n", cases);
            std::exit(1);
        }
        for (int i = 0; i < 64; ++i) {
            if (actual[i + 1] != expected[i]) {
                std::fprintf(stderr, "Mismatch case %u sample %d: %d != %d\n", cases, i, actual[i + 1], expected[i]);
                std::exit(1);
            }
            hash = (hash ^ static_cast<std::uint16_t>(actual[i + 1])) * 1099511628211ull;
        }
        ++cases;
    };

    std::array<int, 64> coefficients{};
    check(coefficients);
    for (int dc = -2048; dc <= 2047; ++dc) {
        coefficients.fill(0);
        coefficients[0] = dc;
        check(coefficients);
    }
    for (int at = 0; at < 64; ++at)
        for (int value : {-2048, -2047, -1024, -255, -1, 1, 255, 1024, 2047}) {
            coefficients.fill(0);
            coefficients[at] = value;
            check(coefficients);
        }
    for (int value : {-2048, -1, 0, 1, 2047}) {
        coefficients.fill(value);
        check(coefficients);
    }
    for (unsigned k = 0; k < 60000; ++k) {
        for (auto &value : coefficients)
            value = (k & 1) && random() % 8 ? 0 : static_cast<int>(random() % 4096) - 2048;
        check(coefficients);
    }
    for (unsigned mask = 0; mask < 256; ++mask) {
        coefficients.fill(0);
        for (unsigned v = 0; v < 8; ++v)
            if (mask & (1u << v))
                for (unsigned u = 0; u < 8; ++u) coefficients[v * 8 + u] = static_cast<int>(random() % 4096) - 2048;
        check(coefficients);
    }
    std::printf("PASS: %u exact inverse transforms, %u samples, hash=%016llX\n", cases, cases * 64,
                static_cast<unsigned long long>(hash));
    if (argc < 2 || std::strcmp(argv[1], "--benchmark")) return 0;

    alignas(16) std::int16_t output[64];
    volatile std::int32_t sink = 0;
    std::array<std::array<int, 64>, 64> blocks{};
    for (auto &block : blocks)
        for (auto &value : block) value = random() % 4 ? 0 : static_cast<int>(random() % 4096) - 2048;
    const auto benchmark = [&](bool candidate) {
        const auto start = std::chrono::steady_clock::now();
        for (int i = 0; i < 200000; ++i) {
            if (candidate) ps2::ipu::detail::inverse_dct(blocks[i % 64].data(), output, basis.frequency);
            else scalar(blocks[i % 64].data(), output, original);
            int sum = 0;
            for (int k = 0; k < 64; ++k) sum += output[k];
            sink = sum;
        }
        return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    };
    for (int kind = 0; kind < 3; ++kind) {
        if (kind == 1)
            for (auto &block : blocks) {
                block.fill(0);
                block[0] = static_cast<int>(random() % 2048);
                block[1] = static_cast<int>(random() % 256) - 128;
                block[63] = 1;
            }
        if (kind == 2)
            for (auto &block : blocks)
                for (auto &value : block) value = static_cast<int>(random() % 4096) - 2048;
        benchmark(false);
        benchmark(true);
        double previous[5], candidate[5];
        for (int i = 0; i < 5; ++i) {
            if (i & 1) { candidate[i] = benchmark(true); previous[i] = benchmark(false); }
            else { previous[i] = benchmark(false); candidate[i] = benchmark(true); }
        }
        std::sort(previous, previous + 5);
        std::sort(candidate, candidate + 5);
        std::printf("BENCH kind=%d scalar_ms=%.3f candidate_ms=%.3f speedup=%.3f sink=%d\n", kind,
                    previous[2], candidate[2], previous[2] / candidate[2], static_cast<int>(sink));
    }
}
