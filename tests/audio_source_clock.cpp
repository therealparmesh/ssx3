// Independent source-clock check using a time code encoded in actual PCM.
// Post-resampling output counts are not the source clock. Keep the 50 ms
// tolerance and reject genuine video offsets and growing audio delay.
// This is an asset-free DSP/counter example, not a browser performance test.
#ifdef NDEBUG
#undef NDEBUG
#endif
#include "../host/audio_resampler.hpp"

#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>

namespace {
using ps2::audio::PeakLimiter;
using ps2::audio::RateConverter;

struct Snapshot {
    double source, read, actual, lower, upper, queued;
};
struct Range {
    double lower, upper;
};

Range difference(const Snapshot &a, const Snapshot &b, double video_ms) {
    return {video_ms - (b.upper - a.lower) / 48, video_ms - (b.lower - a.upper) / 48};
}
bool passes(Range range) { return range.lower > -50 && range.upper < 50; }

void prove_source_clock(int mode) {
    RateConverter converter;
    PeakLimiter limiter;
    std::array<std::array<std::int16_t, 2>, 16384> ring{};
    std::uint64_t source = 0, write = 0, read = 0, epoch = 0, checks = 0;
    std::uint32_t previous_tag = 0;
    bool decoded = false;
    Snapshot start{}, finish{}, delayed{};
    const double ratio = mode == 1 ? RateConverter::kMinimumRatio
                         : mode == 2 ? RateConverter::kMaximumRatio : 0.9997;
    const std::uint64_t finish_at = mode == 0 ? 14400000 : 240000;
    const auto emit = [&](float left, float right) {
        assert(write - read < ring.size());
        ring[write++ % ring.size()] = {
            static_cast<std::int16_t>(std::lround(left * 32768)),
            static_cast<std::int16_t>(std::lround(right * 32768))};
    };
    const auto packet = [&](std::uint32_t target) {
        std::array<std::int16_t, 64> input{};
        for (unsigned n = 0; n < 32; ++n) {
            const auto at = source + n;
            // Low and high time-code digits use both actual audio channels.
            input[n * 2] = static_cast<std::int16_t>(at % 16384) - 8192;
            input[n * 2 + 1] = static_cast<std::int16_t>((at / 16384) % 16) * 1024;
        }
        const double packet_ratio = mode == 3
            ? ((source / 32) % 200 < 100 ? RateConverter::kMinimumRatio : RateConverter::kMaximumRatio)
            : ratio;
        assert(converter.process(input.data(), 32, packet_ratio, [&](float left, float right) {
            assert(limiter.push(left, right, emit));
        }));
        source += 32;
        bool consumed = false;
        while (write - read >= target + 128) {
            read += 128;
            consumed = true;
        }
        if (!consumed || !read) return;
        const auto pcm = ring[(read - 1) % ring.size()];
        const int low = pcm[0] + 8192;
        const int high = static_cast<int>(std::lround(pcm[1] / 1024.0));
        // The time-code discontinuities are not linear ramps. Decode only
        // their settled interiors, after the actual reconstruction filter.
        if (low < 256 || low > 16128 || high < 0 || high > 15 ||
            std::abs(pcm[1] - high * 1024) > 1) return;
        const auto tag = static_cast<std::uint32_t>(high * 16384 + low);
        if (decoded && tag + 131072 < previous_tag) epoch += 262144;
        previous_tag = tag;
        decoded = true;
        const double actual = epoch + tag, queued = write - read;
        // Include converter lookahead, the limiter's pending block and
        // incoming partial block, and a sample of PCM rounding margin.
        // Check the bounds against time decoded from samples, not counters.
        const double lower = source - 1.0 - (RateConverter::kLookahead + 2) -
            (queued + 2 * PeakLimiter::kBlock - 1) / RateConverter::kMinimumRatio - 1;
        const double upper = source - 1.0 - (RateConverter::kLookahead - 1) -
            (queued + PeakLimiter::kBlock) / RateConverter::kMaximumRatio + 1;
        assert(actual >= lower && actual <= upper);
        ++checks;
        const Snapshot now{static_cast<double>(source), static_cast<double>(read), actual, lower, upper, queued};
        if (!start.source && source >= (mode == 0 ? 48000u : 4800u) && source % 800 == 0)
            start = now;
        if (!finish.source && source >= finish_at && source % 800 == 0) finish = now;
        if (finish.source && target > 1920 && source - finish.source >= 6400 && source % 800 == 0)
            delayed = now;
    };
    while (!finish.source && source < finish_at + 262144) packet(1920);
    assert(start.source && finish.source);
    while (!delayed.source && source < finish.source + 262144) packet(6016);
    assert(delayed.source);
    assert(limiter.minimum_gain() == 1.0);

    const double video = (finish.source - start.source) / 48;
    const double raw = video - (finish.read - start.read) / 48;
    const double actual_difference = video - (finish.actual - start.actual) / 48;
    const double fields_per_second = (finish.source - start.source) / 800 /
        ((finish.read - start.read) / 48000);
    const auto corrected = difference(start, finish, video);
    const auto bad_video = difference(start, finish, video + 100);
    const auto bad_delay = difference(finish, delayed, (delayed.source - finish.source) / 48);
    if (mode == 0) {
        assert(fields_per_second >= 59.8 && fields_per_second <= 60.2);
        assert(std::abs(raw) > 50);
    }
    assert(std::abs(actual_difference) < 5);
    assert(passes(corrected));
    assert(!passes(bad_video));
    assert(!passes(bad_delay));
    assert(checks > (mode == 0 ? 100000u : 1000u));
    std::printf("{\"mode\":%d,\"passed\":true,\"minRatio\":%.7f,\"maxRatio\":%.7f,"
                "\"pcmTagSnapshots\":%llu,\"nativeFieldsPerOutputSecond\":%.9f,"
                "\"rawOutputClockDifferenceMs\":%.6f,\"actualSourceClockDifferenceMs\":%.6f,"
                "\"sourceClockDifferenceBoundsMs\":[%.6f,%.6f],"
                "\"videoOffsetNegativeControlRejected\":true,"
                "\"bufferDelayNegativeControlRejected\":true,"
                "\"bufferDelayDifferenceBoundsMs\":[%.6f,%.6f],"
                "\"start\":[%.0f,%.0f,%.0f,%.0f],\"end\":[%.0f,%.0f,%.0f,%.0f],"
                "\"delayed\":[%.0f,%.0f,%.0f,%.0f]}\n",
                mode, mode == 3 ? RateConverter::kMinimumRatio : ratio,
                mode == 3 ? RateConverter::kMaximumRatio : ratio,
                static_cast<unsigned long long>(checks), fields_per_second, raw, actual_difference,
                corrected.lower, corrected.upper, bad_delay.lower, bad_delay.upper,
                start.source, start.read, start.actual, start.queued,
                finish.source, finish.read, finish.actual, finish.queued,
                delayed.source, delayed.read, delayed.actual, delayed.queued);
}
} // namespace

int main() {
    for (int mode = 0; mode < 4; ++mode) prove_source_clock(mode);
}
