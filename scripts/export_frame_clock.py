#!/usr/bin/env python3
"""Export the native presenter's same clock for the small standalone worker."""
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
start, end = '// BEGIN SHARED FRAME CLOCK', '// END SHARED FRAME CLOCK'
if source.count(start) != 1 or source.count(end) != 1:
    raise SystemExit('Expected one shared frame clock')
clock = source.split(start, 1)[1].split(end, 1)[0].strip()
prefix = '$ps2webFrameClock:'
if not clock.startswith(prefix) or not clock.endswith(','):
    raise SystemExit('Invalid shared frame clock declaration')
Path(sys.argv[2]).write_text('globalThis.ps2webFrameClock = ' + clock[len(prefix):].strip()[:-1] + ';\n')
