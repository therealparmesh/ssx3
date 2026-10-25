#!/usr/bin/env python3
"""Exercise runtime VU compilation with optimized, minified Wasm exports."""
import argparse
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--emxx', default=str(root / 'tools/emsdk/upstream/emscripten/em++'))
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ps2-vu-jit-') as directory:
    output = Path(directory)
    subprocess.run([
        args.emxx, str(root / 'tests/vu_jit_web.cpp'),
        str(root / 'runtime/src/vu_jit_web.cpp'), str(root / 'runtime/src/vu_jit.cpp'),
        '-I' + str(root / 'runtime/include'), '-I' + str(root / 'runtime/src'),
        '-std=c++20', '-O3', '-msimd128', '-pthread', '--no-entry',
        '-sMODULARIZE=1', '-sENVIRONMENT=node', '-sPTHREAD_POOL_SIZE=1',
        '-sEXPORTED_RUNTIME_METHODS=PThread',
        '-sALLOW_TABLE_GROWTH=1', '-o', str(output / 'fixture.cjs'),
    ], check=True)
    runner = output / 'run.cjs'
    runner.write_text('''
const assert = require('node:assert/strict');
require('./fixture.cjs')().then(module => {
 try {
  for (const name of ['mac','status','clip','force_mac','efu','kick','top','itop','interpret'])
    assert.equal(typeof module['_ps2jit_' + name], 'function', name);
  assert.equal(module._run_vu_jit_fixture(), 0, 'Runtime VU compilation or execution failed');
  assert.equal(module._run_vu_jit_worker_fixture(), 0, 'Worker VU compilation or execution failed');
  console.log('PASS: optimized Wasm VU compilation, helper imports and end-delay execution on host and worker');
 } finally { module.PThread.terminateAllThreads(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
''')
    subprocess.run(['node', str(runner)], check=True)
