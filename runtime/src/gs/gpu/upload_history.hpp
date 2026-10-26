#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace ps2::gs::gpu {

// Admission is a hint: a missed history entry only delays caching an upload.
// Cache lookup must still compare all bytes before reusing GPU data. Keep the
// history bounded without allocating nodes or clearing thousands at once.
template <std::size_t Buckets = 16384>
class UploadHistory {
    static_assert(Buckets && !(Buckets & (Buckets - 1)));
    struct Bucket {
        std::array<std::uint64_t, 4> keys{};
        std::uint8_t count = 0, next = 0;
    };
    std::array<Bucket, Buckets> buckets_{};

public:
    bool seen_before(std::uint64_t key) {
        auto &bucket = buckets_[(key ^ (key >> 32)) & (Buckets - 1)];
        for (std::size_t i = 0; i < bucket.count; ++i)
            if (bucket.keys[i] == key) return true;
        if (bucket.count < bucket.keys.size()) bucket.keys[bucket.count++] = key;
        else {
            bucket.keys[bucket.next] = key;
            bucket.next = (bucket.next + 1) % bucket.keys.size();
        }
        return false;
    }
};

}
