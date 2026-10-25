#!/usr/bin/env python3
"""Compile the actual generated startup hooks and check their bounded effects."""
import argparse
from pathlib import Path
import subprocess
import tempfile
from ssx3_startup import apply

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--cxx', required=True)
args = p.parse_args()
root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='ssx3-startup-') as temporary:
    d = Path(temporary)
    source = d / 'unit_0000.cpp'
    source.write_text('''#include "ps2/cpu.hpp"
#include <cstdint>
bool enabled=false;
namespace ps2 { bool fast_boot() noexcept { return enabled; } }
std::uint32_t counter=0, movie_mask=7, other=0x1234, writes=0;
std::uint32_t ld32(std::uint32_t a) { return a==0x1048 ? counter : movie_mask; }
void st32(std::uint32_t a,std::uint32_t v) { ++writes; if(a==0x1048)counter=v; else if(a==0x2000-5924)movie_mask=v; else other=0; }
void set32(ps2::Reg128 &r,std::uint32_t v){r.w[0]=v;}
void legal(ps2::Cpu &c) {
L_00187CCC:
    set32(c.r[2], ld32((c.r[16].w[0] + 72u)));
    ++counter;
}
void movies(ps2::Cpu &c) {
L_001A27A0:
    set32(c.r[29], c.r[29].w[0] - 144u);
    c.r[2].w[0]=movie_mask;
}
int main(){
    ps2::Cpu c{}; c.r[16].w[0]=0x1000; c.r[28].w[0]=0x2000;
    legal(c); movies(c);
    if(counter!=1 || movie_mask!=7 || writes || other!=0x1234)return 1;
    enabled=true; legal(c); movies(c);
    if(counter!=240 || c.r[2].w[0] || movie_mask || writes!=2 || other!=0x1234)return 2;
    legal(c); if(counter!=241 || writes!=2)return 3;
}
''')
    assert apply(d) == 1
    expected = source.read_text()
    assert apply(d) == 0 and source.read_text() == expected
    source.write_text(expected.replace('L_001A27A0:', 'L_001A27A4:').replace('    if (ps2::fast_boot() && ld32(c.r[16].w[0] + 72u) < 239u) st32(c.r[16].w[0] + 72u, 239u);\n',''))
    before=source.read_text()
    try:
        apply(d)
        raise AssertionError('Missing entry accepted')
    except ValueError:
        pass
    assert source.read_text()==before
    source.write_text(expected)
    exe=d/'test'
    subprocess.run([args.cxx,'-std=c++20','-I',str(root/'runtime/include'),str(source),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
print('PASS: original behavior, legal expiry, movie queue only, idempotence, all-entry validation')
