#!/usr/bin/env python3
"""Compare real Wasm SIMD inverse transforms with the previous scalar transform."""
import argparse
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--emxx', default=str(root / 'tools/emsdk/upstream/emscripten/em++'))
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ps2-ipu-idct-') as directory:
    target = Path(directory) / 'fixture.cjs'
    subprocess.run([
        args.emxx, str(root / 'tests/ipu_idct.cpp'), '-I' + str(root / 'runtime/src'),
        '-std=c++20', '-O3', '-DPS2_TEST_WASM_SIMD', '-msimd128', '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1',
        '-o', str(target),
    ], check=True)
    result = subprocess.run(['node', str(target)], capture_output=True, text=True, timeout=60)
    text = result.stdout + result.stderr
    assert result.returncode == 0 and 'PASS: 64934 exact inverse transforms' in text and 'FAIL:' not in text, text
    print(text.strip())
