// Node IPU fixture: the test supplies and drains FIFO data directly. DMA
// channels remain disabled; native tests also exercise the real controller.
#include "dmac.hpp"
#include "hw.hpp"
namespace ps2::dmac {
void reset() {}
bool ipu_pull(std::uint8_t *) { return false; }
bool ipu_push(const std::uint8_t *) { return false; }
}
namespace ps2::hw {
void intc_raise(unsigned) {}
}
