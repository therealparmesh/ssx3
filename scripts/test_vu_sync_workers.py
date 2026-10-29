#!/usr/bin/env python3
"""Check real VU interpretation and C++ recovery without worker Asyncify."""
import argparse
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--emxx', default=str(root / 'tools/emsdk/upstream/emscripten/em++'))
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ps2-vu-sync-') as directory:
    output = Path(directory)
    reference = None
    for protected in (False, True):
        target = output / ('protected.cjs' if protected else 'baseline.cjs')
        command = [
            args.emxx, str(root / 'tests/vu_sync_workers.cpp'), str(root / 'runtime/src/vu_micro.cpp'),
            '-I' + str(root / 'runtime/include'), '-I' + str(root / 'runtime/src'),
            '-std=c++20', '-O3', '-msimd128', '-mno-tail-call', '-fexceptions', '-pthread',
            '-sDISABLE_EXCEPTION_CATCHING=0', '-sASYNCIFY', '-sASYNCIFY_ADVISE=1',
            '-sASYNCIFY_STACK_SIZE=1048576', '-sPTHREAD_POOL_SIZE=1', '-sEXIT_RUNTIME=1',
            '-sENVIRONMENT=node', '-sALLOW_MEMORY_GROWTH=1',
            '--js-library', str(root / 'web/sync-game-workers.js'), '-o', str(target),
        ]
        if protected:
            command += ['-sASYNCIFY_REMOVE=@' + str(root / 'web/sync-game-functions.json')]
        compiled = subprocess.run(command, capture_output=True, text=True)
        if compiled.returncode:
            print(compiled.stdout + compiled.stderr)
            compiled.check_returncode()
        advice = (compiled.stdout + compiled.stderr).splitlines()
        for name in ('ps2::vu::run_fast(', 'ps2::vu::(anonymous namespace)::lower('):
            instrumented = any(line.startswith('[asyncify] ' + name) and ' can change the state ' in line for line in advice)
            assert instrumented != protected, (name, protected, 'Unexpected compiler instrumentation')
        result = subprocess.run(['node', str(target)], capture_output=True, text=True, timeout=30)
        assert result.returncode == 0 and not result.stderr, result.stdout + result.stderr
        assert result.stdout.count('STATE ') == 8 and 'PASS: synchronous VU0/VU1' in result.stdout, result.stdout
        if reference is None:
            reference = result.stdout
        assert result.stdout == reference, 'Worker state or exception recovery changed'
        rejected = subprocess.run(['node', str(target), 'async'], capture_output=True, text=True, timeout=30)
        assert rejected.returncode != 0 and 'Unexpected asynchronous VU-worker operation' in rejected.stderr, rejected.stdout + rejected.stderr
    print('PASS: uninstrumented VU0/VU1 scalar states, memory writes, branches, flags, C++ exception recovery and async-import rejection')
