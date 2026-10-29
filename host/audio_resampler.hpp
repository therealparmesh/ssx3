#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

namespace ps2::audio {

// Streaming stereo conversion for small clock corrections around 48 kHz.
// The 96-tap Blackman-windowed sinc retains the audible passband and rejects
// frequencies above the lowest supported output Nyquist frequency. No heap
// allocation, growing queue, or accumulating floating-point time coordinate.
class RateConverter {
public:
    static constexpr double kMinimumRatio = 0.995;
    static constexpr double kMaximumRatio = 1.005;
    static constexpr std::size_t kTaps = 96, kPhases = 256, kHistory = 128;
    static constexpr std::size_t kLookahead = kTaps / 2;
    static_assert((kHistory & (kHistory - 1)) == 0 && kHistory > kTaps);

    static void prepare() { (void)tables(); }

    static constexpr std::size_t max_output_frames(std::size_t input) {
        if (!input) return 0;
        const auto extra = input / 200 + (input % 200 != 0);
        const auto limit = std::numeric_limits<std::size_t>::max();
        return input > limit - extra - 1 ? limit : input + extra + 1;
    }

    // Ratio is output frames per input frame. Invalid arguments consume
    // nothing. The caller reserves max_output_frames(frames) output slots.
    template<class Emit>
    bool process(const std::int16_t *input, std::size_t frames, double ratio, Emit &&emit) {
        if (!std::isfinite(ratio) || ratio < kMinimumRatio || ratio > kMaximumRatio ||
            (frames && !input)) return false;
        const double step = 1.0 / ratio;
        const auto &coefficients = tables();
        for (std::size_t i = 0; i < frames; ++i) {
            const std::array<float, 2> sample{input[i * 2] / 32768.0f, input[i * 2 + 1] / 32768.0f};
            if (!started_) {
                history_.fill(sample);
                started_ = true;
            } else {
                latest_ = (latest_ + 1) & (kHistory - 1);
                ahead_ += 1.0;
            }
            history_[latest_] = sample;
            while (ahead_ >= kLookahead) {
                const auto distance = static_cast<std::size_t>(std::ceil(ahead_));
                const double fraction = distance - ahead_;
                const double phase = fraction * kPhases;
                const auto index = static_cast<std::size_t>(phase);
                const float mix = static_cast<float>(phase - index);
                float left = 0, right = 0;
                const auto center = (latest_ + kHistory - distance) & (kHistory - 1);
                for (std::size_t tap = 0; tap < kTaps; ++tap) {
                    const auto at = (center + kHistory - (kLookahead - 1) + tap) & (kHistory - 1);
                    const float a = coefficients[index][tap];
                    const float weight = a + (coefficients[index + 1][tap] - a) * mix;
                    left += history_[at][0] * weight;
                    right += history_[at][1] * weight;
                }
                emit(left, right);
                ahead_ -= step;
            }
        }
        return true;
    }

private:
    using Tables = std::array<std::array<float, kTaps>, kPhases + 1>;
    static const Tables &tables() {
        static const Tables coefficients = [] {
            Tables result{};
            constexpr double pi = 3.1415926535897932384626433832795;
            constexpr double cutoff = 0.46;
            for (std::size_t phase = 0; phase <= kPhases; ++phase) {
                const double fraction = static_cast<double>(phase) / kPhases;
                std::array<double, kTaps> weights{};
                double sum = 0;
                for (std::size_t tap = 0; tap < kTaps; ++tap) {
                    const double x = static_cast<double>(tap) - (kLookahead - 1) - fraction;
                    const double window = 0.42 + 0.5 * std::cos(pi * x / kLookahead) +
                                          0.08 * std::cos(2 * pi * x / kLookahead);
                    const double sinc = std::abs(x) < 1e-12 ? 2 * cutoff : std::sin(2 * pi * cutoff * x) / (pi * x);
                    weights[tap] = sinc * window;
                    sum += weights[tap];
                }
                for (std::size_t tap = 0; tap < kTaps; ++tap)
                    result[phase][tap] = static_cast<float>(weights[tap] / sum);
            }
            return result;
        }();
        return coefficients;
    }

    std::array<std::array<float, 2>, kHistory> history_{};
    std::size_t latest_ = 0;
    double ahead_ = 0;
    bool started_ = false;
};

// One output block of lookahead controls reconstruction peaks without hard
// clipping. A shared stereo gain ramps continuously across block boundaries;
// release is about 10 ms. Every accepted input frame is emitted once on flush.
class PeakLimiter {
public:
    static constexpr std::size_t kBlock = 32;
    static constexpr double kCeiling = 32766.0 / 32768.0;

    static constexpr std::size_t max_output_frames(std::size_t input) {
        if (!input) return 0;
        const auto extra = (kBlock - input % kBlock) % kBlock;
        const auto limit = std::numeric_limits<std::size_t>::max();
        return input > limit - extra ? limit : input + extra;
    }

    template<class Emit>
    bool push(float left, float right, Emit &&emit) {
        if (!std::isfinite(left) || !std::isfinite(right)) return false;
        incoming_[incoming_count_++] = {left, right};
        incoming_peak_ = std::max({incoming_peak_, std::abs(static_cast<double>(left)), std::abs(static_cast<double>(right))});
        maximum_peak_ = std::max(maximum_peak_, incoming_peak_);
        if (incoming_count_ == kBlock) {
            publish(incoming_peak_, emit);
            pending_.swap(incoming_);
            pending_count_ = incoming_count_;
            pending_peak_ = incoming_peak_;
            incoming_count_ = 0;
            incoming_peak_ = 0;
        }
        return true;
    }

    template<class Emit>
    void flush(Emit &&emit) {
        publish(incoming_peak_, emit);
        if (incoming_count_) {
            pending_.swap(incoming_);
            pending_count_ = incoming_count_;
            pending_peak_ = incoming_peak_;
            incoming_count_ = 0;
            incoming_peak_ = 0;
            publish(0, emit);
        }
    }

    double minimum_gain() const { return minimum_gain_; }
    double maximum_input_peak() const { return maximum_peak_; }
    std::uint64_t limited_frames() const { return limited_frames_; }

private:
    template<class Emit>
    void publish(double next_peak, Emit &emit) {
        if (!pending_count_) return;
        const double required = pending_peak_ > kCeiling ? kCeiling / pending_peak_ : 1.0;
        const double next_required = next_peak > kCeiling ? kCeiling / next_peak : 1.0;
        if (!started_) { gain_ = required; started_ = true; }
        double end = std::min(required, next_required);
        if (end > gain_) end = std::min(end, gain_ + (1.0 - gain_) * pending_count_ / 480.0);
        minimum_gain_ = std::min({minimum_gain_, gain_, end});
        for (std::size_t i = 0; i < pending_count_; ++i) {
            const double gain = gain_ + (end - gain_) * (i + 1) / pending_count_;
            emit(static_cast<float>(pending_[i][0] * gain), static_cast<float>(pending_[i][1] * gain));
            if (gain < 1.0 - 1e-8) ++limited_frames_;
        }
        gain_ = end;
        pending_count_ = 0;
        pending_peak_ = 0;
    }

    std::array<std::array<float, 2>, kBlock> pending_{}, incoming_{};
    std::size_t pending_count_ = 0, incoming_count_ = 0;
    double pending_peak_ = 0, incoming_peak_ = 0, maximum_peak_ = 0;
    double gain_ = 1.0, minimum_gain_ = 1.0;
    std::uint64_t limited_frames_ = 0;
    bool started_ = false;
};

} // namespace ps2::audio
