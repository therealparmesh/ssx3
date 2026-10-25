#!/usr/bin/env python3
"""Retain selected decorative functions behind the host's visual setting."""
import argparse
from pathlib import Path


def apply(directory, addresses):
    changed = {}
    for address in addresses:
        pc = int(address, 16)
        if pc < 0 or pc > 0xFFFFFFFF or pc % 4:
            raise ValueError('Expected an aligned 32-bit function entry: ' + address)
        label = f'L_{pc:08X}:\n'
        matches = [p for p in directory.glob('unit_*.cpp') if label in p.read_text()]
        if len(matches) != 1:
            raise ValueError(f'Expected one translated entry for {pc:08X}, found {len(matches)}')
        path = matches[0]
        source = changed.get(path, path.read_text())
        gate = ('    if (!ps2::full_visual_effects()) { c.budget -= 2; '
                'c.pc = c.r[31].w[0]; return; }\n')
        if label + gate in source:
            continue
        body = source.split(label, 1)[1]
        if body.lstrip().startswith('c.budget -= 2;'):
            raise ValueError('Translate the original executable before retaining visual entry ' + address)
        source = source.replace(label, label + gate, 1)
        include = '#include "ps2/visuals.hpp"\n'
        if include not in source:
            source = include + source
        changed[path] = source
    # Validate every requested entry before replacing any generated file.
    for path, source in changed.items():
        path.write_text(source)
    return len(changed)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('addresses', nargs='+', help='hexadecimal void-function entry addresses')
    args = parser.parse_args()
    print('Updated', apply(args.directory, args.addresses), 'translation units with optional visuals')
