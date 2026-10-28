#!/usr/bin/env python3
"""Verify counted and uncounted concurrent VU interpretation in a real fixture."""
import re
import subprocess
import sys

fixture = sys.argv[1]
outputs = []
for mode in ['uncounted', 'count']:
    result = subprocess.run([fixture, mode], text=True, capture_output=True,
                            check=True, timeout=30)
    outputs.append(result.stdout)
    if mode == 'uncounted':
        assert not result.stderr, result.stderr
    else:
        counts = [tuple(map(int, match)) for match in re.findall(
            r'\[vu1\] (\d+) calls, (\d+) instructions', result.stderr)]
        assert [call for call, total in counts] == [20000, 40000], result.stderr
        # Preserve the existing diagnostic convention: the end-delay return
        # precedes the loop increment, and the sample precedes its own call.
        assert counts[-1] == (40000, 39999 * 63), result.stderr
assert outputs[0] == outputs[1] and 'PASS:' in outputs[0], outputs
print('PASS: concurrent counters retain exact totals and disabled counting stays quiet')
