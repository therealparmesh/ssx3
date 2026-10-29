#!/usr/bin/env python3
"""Run the real IPU FIFO/state/streaming regression code in Wasm."""
import argparse
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--emxx', default=str(root / 'tools/emsdk/upstream/emscripten/em++'))
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ps2-ipu-streaming-') as directory:
    target = Path(directory) / 'fixture.cjs'
    subprocess.run([
        args.emxx, str(root / 'tests/ipu.cpp'), str(root / 'tests/ipu_disabled_dma.cpp'),
        str(root / 'runtime/src/ipu/ipu.cpp'), '-I' + str(root / 'runtime/include'),
        '-I' + str(root / 'runtime/src'), '-std=c++20', '-O3', '-msimd128',
        '-mno-tail-call', '-fexceptions', '-pthread', '-sASYNCIFY',
        '-sASYNCIFY_STACK_SIZE=1048576', '-sDISABLE_EXCEPTION_CATCHING=0',
        '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', '-o', str(target),
    ], check=True)
    result = subprocess.run(['node', str(target)], capture_output=True, text=True, timeout=30)
    text = result.stdout + result.stderr
    assert result.returncode == 0 and 'PASS: IPU unaligned FDEC' in text and 'FAIL:' not in text, text
    print(result.stdout.strip())
