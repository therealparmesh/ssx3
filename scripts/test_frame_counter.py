#!/usr/bin/env python3
"""Exercise actual frame storage/getters and preserve the serialized field ABI."""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--cxx', default='c++')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
source = (root / 'runtime/src/system.cpp').read_text()
storage = re.search(r'^std::atomic<std::uint64_t> g_frames\{0\};$', source, re.M)
assert storage, 'Public frame storage must be atomic'
start = source.index('void frame_state(state::Stream &s) {')
end = source.index('\n}', start) + 2
state = source[start:end]
getters = '\n'.join(re.search(r'^std::uint64_t ' + name + r'\(\) \{[^\n]*\}', source, re.M).group()
                    for name in ['frames_run', 'frame_count'])
vblank = source[source.index('void vblank() {'):source.index('\n    time_frames();')]
step = vblank.split('{', 1)[1].strip()
assert step == 'g_frames.fetch_add(1, std::memory_order_relaxed);'
assert source.count('    frame_state(s);') == 1
compiler = [args.cxx] if Path(args.cxx).is_file() else shlex.split(args.cxx)
variants = [('current', state, None),
            ('raw-atomic-state', 'void frame_state(state::Stream &s) { s.pod(g_frames); }',
             'State stream touched live atomic storage'),
            ('narrow-state', state.replace('std::uint64_t frames', 'std::uint32_t frames'),
             'Frame state width changed')]
with tempfile.TemporaryDirectory(prefix='ps2-frame-counter-') as temp:
    directory = Path(temp)
    for name, field, failure in variants:
        fragment = directory / (name + '.inc')
        fragment.write_text(storage.group() + '\n' + field + '\n' + getters +
                            '\nvoid frame_tick() { ' + step + ' }\n')
        executable = directory / name
        subprocess.run(compiler + ['-std=c++20', '-O2', '-pthread',
                       '-DFRAME_COUNTER_CODE=' + json.dumps(str(fragment)),
                       str(root / 'tests/frame_counter.cpp'), '-o', str(executable)], check=True)
        result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=15)
        if failure:
            assert result.returncode != 0 and failure in result.stderr, (name, result.stderr)
        else:
            assert result.returncode == 0, result.stderr
            print(result.stdout.strip())
print('Frame state negative controls: live atomic serialization and narrowed field rejected.')
