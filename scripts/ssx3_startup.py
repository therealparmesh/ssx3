#!/usr/bin/env python3
"""Add optional SSX 3 USA startup skips to an original, verified translation.

Advance the legal screen through its own expiry handler, and clear only the
front-end movie queue before it allocates a player. No simulated button presses,
profile selection, memory-card writes, or generic movie-decoder bypasses.
"""
import argparse
from pathlib import Path

HOOKS = {
    '00187CCC': (
        '    set32(c.r[2], ld32((c.r[16].w[0] + 72u)));',
        '    if (ps2::fast_boot() && ld32(c.r[16].w[0] + 72u) < 239u) st32(c.r[16].w[0] + 72u, 239u);\n'),
    '001A27A0': (
        '    set32(c.r[29], c.r[29].w[0] - 144u);',
        '    if (ps2::fast_boot()) st32(c.r[28].w[0] - 5924u, 0u);\n'),
}

def apply(directory):
    changed = {}
    for address, (expected, hook) in HOOKS.items():
        label = f'L_{address}:\n'
        matches = [p for p in directory.glob('unit_*.cpp') if label in p.read_text()]
        if len(matches) != 1:
            raise ValueError('Expected one SSX 3 USA startup entry: ' + address)
        path = matches[0]
        source = changed.get(path, path.read_text())
        if label + hook in source:
            continue
        if label + expected not in source:
            raise ValueError('Unexpected SSX 3 startup instructions: ' + address)
        source = source.replace(label, label + hook, 1)
        include = '#include "ps2/startup.hpp"\n'
        if include not in source:
            source = include + source
        changed[path] = source
    for path, source in changed.items():
        path.write_text(source)
    return len(changed)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    print('Updated', apply(args.directory), 'translation units with optional SSX 3 startup skips')
