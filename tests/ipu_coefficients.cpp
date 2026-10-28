// Test the internal parser directly, with the preceding implementation as
// an oracle. Other IPU fixtures exercise FIFO commands, output and state files.
#include "../runtime/src/ipu/ipu.cpp"
#include <array>
#include <stdexcept>

unsigned dma_pulls=0, dma_remaining=0;
namespace ps2::dmac {
void reset() {}
bool ipu_pull(std::uint8_t *out) {
    ++dma_pulls;
    if (!dma_remaining) return false;
    --dma_remaining;
    for(unsigned i=0;i<16;++i)out[i]=static_cast<std::uint8_t>(i*37+19);
    return true;
}
bool ipu_push(const std::uint8_t *) { return false; }
}
namespace ps2::hw { void intc_raise(unsigned) {} }
namespace ps2::ipu {
namespace {
bool reference_coefficient(const DctLookup &l, int &run, int &level) {
    std::size_t avail;
    const DctEntry &e = l.entries[peek_soft(l.bits, avail)];
    if (!e.length) {
        if (avail < l.bits) throw NeedData{};
        throw BadCode{};
    }
    if (e.length > avail) throw NeedData{};
    g_bit += e.length;
    if (e.run == kEscape) {
        run = static_cast<int>(get(6));
        if (mpeg1()) {
            int v = static_cast<int>(get(8));
            if (v == 0) v = static_cast<int>(get(8));
            else if (v == 128) v = static_cast<int>(get(8)) - 256;
            else if (v > 128) v -= 256;
            level = v;
        } else {
            const int v = static_cast<int>(get(12));
            level = v & 0x800 ? v - 0x1000 : v;
        }
        return true;
    }
    run = e.run;
    level = get(1) ? -e.level : e.level;
    return true;
}

bool reference(const DctLookup &l,int &run,int &level,unsigned eob_bits) {
    if(eob_bits && peek(eob_bits)==(eob_bits==4?6u:2u)) {skip(eob_bits);return false;}
    return reference_coefficient(l,run,level);
}
struct Result {
    int status=0, run=73, level=91;
    std::size_t bit=0, bytes=0;
    unsigned pulls=0, remaining=0;
    bool operator==(const Result &) const = default;
};
Result read(bool optimized,const DctLookup &l,const std::array<std::uint8_t,16> &input,
            unsigned bytes,unsigned bit,unsigned eob_bits,bool mpeg,unsigned refill) {
    g_in.assign(input.begin(),input.begin()+bytes);g_bit=bit;g_ctrl=mpeg?0x800000u:0;
    dma_pulls=0;dma_remaining=refill;Result r;
    try {r.status=(optimized?read_coefficient(l,r.run,r.level,eob_bits):reference(l,r.run,r.level,eob_bits))?1:0;}
    catch(const NeedData &) {r.status=2;}
    catch(const BadCode &) {r.status=3;}
    r.bit=g_bit;r.bytes=g_in.size();r.pulls=dma_pulls;r.remaining=dma_remaining;
    return r;
}
std::uint64_t cases=0,hash=1469598103934665603ull;
void check(const DctLookup &l,const std::array<std::uint8_t,16> &input,unsigned bytes,
           unsigned bit,unsigned eob_bits,bool mpeg,unsigned refill) {
    const auto old=read(false,l,input,bytes,bit,eob_bits,mpeg,refill);
    const auto now=read(true,l,input,bytes,bit,eob_bits,mpeg,refill);
    if(!(old==now)) {
        std::fprintf(stderr,"Mismatch case %llu: status %d/%d run %d/%d level %d/%d bit %zu/%zu pulls %u/%u\n",
          static_cast<unsigned long long>(cases),old.status,now.status,old.run,now.run,old.level,now.level,old.bit,now.bit,old.pulls,now.pulls);
        throw std::runtime_error("Coefficient parsing changed");
    }
    for(auto value:{std::uint64_t(now.status),std::uint64_t(now.run),std::uint64_t(now.level),std::uint64_t(now.bit),std::uint64_t(now.bytes),std::uint64_t(now.pulls),std::uint64_t(now.remaining)})hash=(hash^value)*1099511628211ull;
    ++cases;
}
void run_cases() {
    for(unsigned table=0;table<2;++table) {
        const auto &l=table?tables().dct1:tables().dct0;
        for(unsigned prefix=0;prefix<65536;++prefix)
            for(unsigned alignment=0;alignment<8;++alignment) {
                std::array<std::uint8_t,16> input{};
                const std::uint64_t tail=(alignment&1)?0xF3A59687ull:0x035A6978ull;
                const std::uint64_t bits=((std::uint64_t(prefix)<<48)|(tail<<16))>>alignment;
                for(unsigned i=0;i<8;++i)input[i]=static_cast<std::uint8_t>(bits>>(56-8*i));
                for(unsigned eob:{0u,table?4u:2u})check(l,input,16,alignment,eob,alignment&2,0);
            }
        std::uint32_t seed=0x91E10DA5u;
        for(unsigned pattern=0;pattern<4096;++pattern) {
            std::array<std::uint8_t,16> input{};
            for(auto &v:input){seed^=seed<<13;seed^=seed>>17;seed^=seed<<5;v=static_cast<std::uint8_t>(seed>>24);}
            for(unsigned available=0;available<=32;++available)
                for(unsigned eob:{0u,table?4u:2u})
                    for(unsigned refill=0;refill<2;++refill)check(l,input,8,64-available,eob,seed&1,refill);
        }
    }
}
}
}
int main() {
    try {
        ps2::ipu::run_cases();
        std::printf("PASS: %llu coefficient look-ahead cases, hash %016llX\n",
          static_cast<unsigned long long>(ps2::ipu::cases),static_cast<unsigned long long>(ps2::ipu::hash));
    }catch(const std::exception &e){std::fprintf(stderr,"FAIL: %s\n",e.what());return 1;}
}
