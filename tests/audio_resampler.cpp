#ifdef NDEBUG
#undef NDEBUG
#endif
#include "../host/audio_resampler.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

namespace {
using Converter = ps2::audio::RateConverter;
using Limiter = ps2::audio::PeakLimiter;
constexpr double pi = 3.14159265358979323846;
bool count_allocations = false;
std::size_t allocations = 0;
using Stereo = std::array<float, 2>;

std::vector<std::int16_t> tone(double frequency, std::size_t frames = 48000) {
    std::vector<std::int16_t> input(frames * 2);
    for (std::size_t i = 0; i < frames; ++i) {
        input[i * 2] = static_cast<std::int16_t>(std::lround(16384 * std::sin(2 * pi * frequency * i / 48000)));
        input[i * 2 + 1] = static_cast<std::int16_t>(std::lround(8192 * std::cos(2 * pi * 731 * i / 48000)));
    }
    return input;
}

std::vector<Stereo> convert(const std::vector<std::int16_t> &input, double ratio, std::size_t chunk) {
    Converter converter;
    Limiter limiter;
    std::vector<Stereo> output;
    output.reserve(Converter::max_output_frames(input.size() / 2));
    const auto emit = [&](float left, float right) {
        // Include the producer's final 16-bit PCM conversion in fidelity checks.
        const auto pcm = [](float value) {
            return std::clamp(std::lround(static_cast<double>(value) * 32768.0), -32768L, 32767L) / 32768.0f;
        };
        output.push_back({pcm(left), pcm(right)});
    };
    for (std::size_t at = 0; at < input.size() / 2;) {
        const auto n = std::min(chunk, input.size() / 2 - at), before = output.size();
        assert(converter.process(input.data() + at * 2, n, ratio, [&](float l, float r) { assert(limiter.push(l, r, emit)); }));
        assert(output.size() - before <= Limiter::max_output_frames(Converter::max_output_frames(n)));
        at += n;
    }
    limiter.flush(emit);
    return output;
}

struct Response { double gain_db, snr_db; };
Response response(const std::vector<Stereo> &output, double frequency, double ratio, unsigned channel, double amplitude) {
    double ss = 0, cc = 0, sc = 0, sy = 0, cy = 0, power = 0;
    const std::size_t first = 256, last = output.size() - 256;
    for (std::size_t i = first; i < last; ++i) {
        const double theta = 2 * pi * frequency * i / (48000 * ratio);
        const double s = std::sin(theta), c = std::cos(theta), y = output[i][channel];
        ss += s * s; cc += c * c; sc += s * c; sy += s * y; cy += c * y; power += y * y;
    }
    const double det = ss * cc - sc * sc;
    const double a = (sy * cc - cy * sc) / det, b = (cy * ss - sy * sc) / det;
    double error = 0;
    for (std::size_t i = first; i < last; ++i) {
        const double theta = 2 * pi * frequency * i / (48000 * ratio);
        const double d = output[i][channel] - a * std::sin(theta) - b * std::cos(theta);
        error += d * d;
    }
    return {20 * std::log10(std::hypot(a, b) / amplitude), 10 * std::log10(power / error)};
}
}

void *operator new(std::size_t n) {
    if (count_allocations) ++allocations;
    if (void *p = std::malloc(n)) return p;
    throw std::bad_alloc();
}
void operator delete(void *p) noexcept { std::free(p); }
void operator delete(void *p, std::size_t) noexcept { std::free(p); }

int main() {
    Converter::prepare();
    assert(Converter::max_output_frames(0) == 0);
    assert(Converter::max_output_frames(200) == 202);
    assert(Converter::max_output_frames(std::numeric_limits<std::size_t>::max()) == std::numeric_limits<std::size_t>::max());
    assert(Limiter::max_output_frames(0) == 0);
    assert(Limiter::max_output_frames(1) == 32);
    assert(Limiter::max_output_frames(34) == 64);
    assert(Limiter::max_output_frames(std::numeric_limits<std::size_t>::max()) == std::numeric_limits<std::size_t>::max());
    {
        std::vector<std::int16_t> dc(8192);
        for (std::size_t i = 0; i < dc.size(); i += 2) { dc[i] = 12345; dc[i + 1] = -23456; }
        for (double ratio : {0.995, 1.0, 1.005}) {
            const auto output = convert(dc, ratio, 17);
            for (const auto &sample : output) {
                assert(std::abs(sample[0] - 12345 / 32768.0f) < 2e-6);
                assert(std::abs(sample[1] + 23456 / 32768.0f) < 2e-6);
            }
        }
    }
    double worst_gain = 0, minimum_snr = 1000;
    for (double ratio : {0.995, 0.9997, 1.0, 1.0009, 1.005}) {
        for (double frequency : {20.0, 1000.0, 8000.0, 12000.0, 18000.0, 20000.0}) {
            const auto output = convert(tone(frequency), ratio, 32);
            const auto left = response(output, frequency, ratio, 0, 0.5);
            const auto right = response(output, 731, ratio, 1, 0.25);
            worst_gain = std::max({worst_gain, std::abs(left.gain_db), std::abs(right.gain_db)});
            minimum_snr = std::min({minimum_snr, left.snr_db, right.snr_db});
            if (std::abs(left.gain_db) > 0.1 || left.snr_db < 80)
                std::printf("FAIL ratio %.6f tone %.0f gain %.6f dB SNR %.3f dB\n", ratio, frequency, left.gain_db, left.snr_db);
            assert(std::abs(left.gain_db) < 0.1 && std::abs(right.gain_db) < 0.1);
            assert(left.snr_db > 80 && right.snr_db > 80);
        }
    }
    const auto alias = convert(tone(23950), 0.995, 37);
    double energy = 0;
    for (std::size_t i = 256; i < alias.size() - 256; ++i) energy += alias[i][0] * alias[i][0];
    const double rejection = 10 * std::log10(energy / (alias.size() - 512) / 0.125);
    assert(rejection < -70);

    const auto input = tone(5317, 12000);
    for (double ratio : {0.995, 1.0, 1.005}) {
        const auto whole = convert(input, ratio, input.size() / 2);
        for (std::size_t chunk : {1u, 17u, 32u, 127u, 256u}) assert(convert(input, ratio, chunk) == whole);
    }
    {
        Converter tested, control;
        std::vector<Stereo> a, b;
        const auto emit_a = [&](float l, float r) { a.push_back({l, r}); };
        const auto emit_b = [&](float l, float r) { b.push_back({l, r}); };
        assert(tested.process(input.data(), 79, 1.001, emit_a));
        assert(control.process(input.data(), 79, 1.001, emit_b));
        for (double bad : {0.0, 0.994, 1.006, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()})
            assert(!tested.process(input.data(), 32, bad, emit_a));
        assert(!tested.process(nullptr, 1, 1.0, emit_a));
        assert(tested.process(nullptr, 0, 1.0, emit_a));
        assert(tested.process(input.data() + 158, 1000, 1.001, emit_a));
        assert(control.process(input.data() + 158, 1000, 1.001, emit_b));
        assert(a == b);
    }
    {
        Converter converter;
        Limiter limiter;
        std::vector<Stereo> output;
        output.reserve(Converter::max_output_frames(input.size() / 2));
        allocations = 0; count_allocations = true;
        const auto emit = [&](float l, float r) { output.push_back({l, r}); };
        assert(converter.process(input.data(), input.size() / 2, 1.005, [&](float l, float r) { assert(limiter.push(l, r, emit)); }));
        limiter.flush(emit);
        count_allocations = false;
        assert(allocations == 0);
    }
    {
        Limiter limiter;
        std::vector<Stereo> output, input;
        for (std::size_t i = 0; i < 537; ++i) input.push_back({0.25f, i < 64 || (i >= 160 && i < 192) ? 2.0f : 0.0f});
        const auto emit = [&](float l, float r) { output.push_back({l, r}); };
        for (const auto &sample : input) assert(limiter.push(sample[0], sample[1], emit));
        assert(!limiter.push(std::numeric_limits<float>::quiet_NaN(), 0, emit));
        assert(!limiter.push(0, std::numeric_limits<float>::infinity(), emit));
        limiter.flush(emit);
        assert(output.size() == input.size());
        assert(limiter.minimum_gain() > 0.49 && limiter.minimum_gain() < 0.51);
        assert(limiter.maximum_input_peak() == 2 && limiter.limited_frames() > 64);
        for (std::size_t i = 0; i < output.size(); ++i) {
            assert(std::abs(output[i][0]) <= Limiter::kCeiling + 1e-7);
            assert(std::abs(output[i][1]) <= Limiter::kCeiling + 1e-7);
            if (input[i][1] == 2.0f) assert(std::abs(output[i][1] - 8 * output[i][0]) < 1e-6);
            if (i) assert(std::abs(output[i][0] / .25f - output[i - 1][0] / .25f) < 1.0 / 32 + 1e-6);
        }
        // A second flush cannot duplicate the held tail.
        limiter.flush(emit); assert(output.size() == input.size());
        for (float sign : {-1.0f, 1.0f}) {
            Limiter boundary;
            std::size_t count = 0;
            const auto extreme = [&](float l, float r) { assert(std::isfinite(l) && std::isfinite(r)); assert(std::abs(l) <= Limiter::kCeiling + 1e-7); ++count; };
            for (unsigned i = 0; i < 97; ++i) assert(boundary.push(sign * std::numeric_limits<float>::max(), 0, extreme));
            boundary.flush(extreme); assert(count == 97);
        }
    }
    {
        Converter converter;
        std::vector<Stereo> output;
        const auto low = tone(1000, 32000);
        for (std::size_t at = 0; at < 32000; at += 32) {
            const double ratio = at % 64 ? 0.995 : 1.005;
            assert(converter.process(low.data() + at * 2, 32, ratio, [&](float l, float r) { output.push_back({l, r}); }));
        }
        for (std::size_t i = 257; i < output.size(); ++i)
            assert(std::abs(output[i][0] - output[i - 1][0]) < 0.0661);
    }
    std::printf("Audio conversion: passband error %.6f dB; minimum fitted-tone SNR %.2f dB; alias rejection %.2f dB. Streaming partitions, ratio changes, invalid input, fixed capacity, lookahead peak/stereo/tail/continuity checks and zero processing allocations passed.\n", worst_gain, minimum_snr, rejection);
}
