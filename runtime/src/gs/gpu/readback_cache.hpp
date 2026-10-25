#pragma once

#include <array>
#include <cstdint>
#include <cstring>
#include <vector>

namespace ps2::gs::gpu {

// GPU commands invalidate every touched VRAM page before a read can use it.
// Only a completed readback may populate the cache; partial pages stay invalid.
class ReadbackCache {
public:
    static constexpr std::uint32_t size = 4u << 20, page_size = 8192;

    void clear() { valid_.fill(false); }

    void invalidate(std::uint64_t first, std::uint64_t end) {
        if (end <= first) return;
        if (end - first >= size) { clear(); return; }
        for (std::uint64_t page = first / page_size; page <= (end - 1) / page_size; ++page)
            valid_[page % valid_.size()] = false;
    }

    bool copy(std::uint32_t offset, std::uint32_t bytes, void *out) const {
        if (!bytes || offset >= size || bytes > size - offset || data_.empty()) return false;
        for (std::uint32_t page = offset / page_size; page <= (offset + bytes - 1) / page_size; ++page)
            if (!valid_[page]) return false;
        std::memcpy(out, data_.data() + offset, bytes);
        return true;
    }

    void store(std::uint32_t offset, std::uint32_t bytes, const void *data) {
        if (!bytes || offset >= size || bytes > size - offset) return;
        if (data_.empty()) data_.resize(size);
        std::memcpy(data_.data() + offset, data, bytes);
        for (std::uint32_t page = (offset + page_size - 1) / page_size; page < (offset + bytes) / page_size; ++page)
            valid_[page] = true;
    }

private:
    std::array<bool, size / page_size> valid_{};
    std::vector<std::uint8_t> data_;
};

}
