#!/usr/bin/env python3
"""Exercise the real producer-to-main Wasm queue wake without game assets."""
import argparse
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--emxx', default=str(root / 'tools/emsdk/upstream/emscripten/em++'))
parser.add_argument('--queue-source', type=Path, default=root / 'runtime/src/gs/queue.cpp')
parser.add_argument('--expect-timeout', action='store_true', help='Verify the preceding queue implementation as a negative control')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ps2-render-queue-') as directory:
    target = Path(directory) / 'fixture.cjs'
    subprocess.run([
        args.emxx, str(root / 'tests/render_queue_web.cpp'), str(args.queue_source),
        '-I' + str(root / 'runtime/src/gs'), '-std=c++20', '-O2', '-fexceptions',
        '-pthread', '-sASYNCIFY', '-sPTHREAD_POOL_SIZE=1', '-sDISABLE_EXCEPTION_CATCHING=0',
        '-sEXIT_RUNTIME=1', '-sENVIRONMENT=node',
        '-sEXPORTED_FUNCTIONS=_main,_emscripten_force_exit',
        # Select the browser-main wait branch on Node's main runtime thread;
        # SDK worker detection and proxy delivery remain real and unchanged.
        '-Demscripten_is_main_browser_thread=emscripten_is_main_runtime_thread',
        '-o', str(target),
    ], check=True)
    result = subprocess.run(['node', str(target)], capture_output=True, text=True, timeout=20)
    text = result.stdout + result.stderr
    if args.expect_timeout:
        assert result.returncode == 1 and 'FAIL: native producer wake timed out' in text, text
        print('Baseline correctly times out with native-promise and RAF delivery withheld')
    else:
        assert result.returncode == 0 and 'PASS: actual Wasm producer wakes' in text and 'FAIL:' not in text, text
        print(result.stdout.strip())
