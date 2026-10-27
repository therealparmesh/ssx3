#!/usr/bin/env python3
"""Verify synchronous game-worker exports against real Asyncify and C++ EH."""
import argparse
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--emxx', default=str(root / 'tools/emsdk/upstream/emscripten/em++'))
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ps2-sync-workers-') as directory:
    output = Path(directory)
    for fixed in (False, True):
        target = output / ('fixed.cjs' if fixed else 'baseline.cjs')
        command = [
            args.emxx, str(root / 'tests/sync_game_workers.cpp'), '-O2',
            '-fexceptions', '-pthread', '-sASYNCIFY', '-sDISABLE_EXCEPTION_CATCHING=0',
            '-sPTHREAD_POOL_SIZE=1', '-sEXIT_RUNTIME=1', '-sENVIRONMENT=node',
            '-sEXPORTED_FUNCTIONS=_main,_inner', '-o', str(target),
        ]
        if fixed:
            command += ['--js-library', str(root / 'web/sync-game-workers.js')]
        subprocess.run(command, check=True)
        result = subprocess.run(['node', str(target)], capture_output=True, text=True, timeout=30)
        text = result.stdout + result.stderr
        if fixed:
            assert result.returncode == 0 and 'PASS: synchronous worker exports' in text and 'FAIL:' not in text, text
            print(text.strip())
        else:
            assert result.returncode == 1 and 'FAIL: depth=1 ' in text, text
            print('Baseline correctly retained unnecessary worker export tracking')
