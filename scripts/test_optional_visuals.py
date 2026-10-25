#!/usr/bin/env python3
"""Check both execution paths of the actual generated visual-function gate."""
import argparse
from pathlib import Path
import subprocess
import tempfile

from optional_visuals import apply


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cxx', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='ps2-visuals-') as temporary:
    directory = Path(temporary)
    source = directory / 'unit_0000.cpp'
    source.write_text('''#include "ps2/cpu.hpp"
bool enabled = false;
namespace ps2 { bool full_visual_effects() noexcept { return enabled; } }
void entry(ps2::Cpu &c) {
L_002E30D0:
    c.r[2].w[0] = 17;
    c.budget -= 7;
    c.pc = c.r[31].w[0];
}
int main() {
    ps2::Cpu c{};
    c.r[31].w[0] = 0x12340; c.budget = 100;
    entry(c);
    if (c.pc != 0x12340 || c.budget != 98 || c.r[2].w[0] != 0) return 1;
    enabled = true; c.budget = 100;
    entry(c);
    if (c.pc != 0x12340 || c.budget != 93 || c.r[2].w[0] != 17) return 2;
}
''')
    assert apply(directory, ['002E30D0']) == 1
    expected = source.read_text()
    assert apply(directory, ['002E30D0']) == 0
    assert source.read_text() == expected
    try:
        apply(directory, ['002E30D0', '002E3130'])
        raise AssertionError('A missing entry was accepted')
    except ValueError:
        pass
    assert source.read_text() == expected
    executable = directory / 'visuals-test'
    subprocess.run([args.cxx, '-std=c++20', '-I', str(root / 'runtime/include'), str(source), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
print('PASS: performance return, original body, idempotency and missing-entry protection')
