#!/usr/bin/env python3
"""Exercise rendering-runtime wait selection using actual Wasm/pthreads on Node."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--emxx', default=str(root / 'tools/emsdk/upstream/emscripten/em++'))
parser.add_argument('--queue-source', type=Path, default=root / 'runtime/src/gs/queue.cpp')
parser.add_argument('--expect-worker-block', action='store_true', help='Check the preceding implementation as a negative control')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='ps2-render-runtime-wait-') as directory:
    output = Path(directory)
    pre = output / 'pre.js'
    pre.write_text("""Module.yieldForBufferedFrames=true;
globalThis.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),16);
globalThis.cancelAnimationFrame=clearTimeout;
if(!ENVIRONMENT_IS_PTHREAD){
  const deadline=setTimeout(()=>{console.error('FAIL: queue wait timed out');process.exit(1)},5000);
  globalThis.postMessage=value=>{clearTimeout(deadline);console.log('QUEUE_RESULT '+JSON.stringify(value))};
}
""")
    modes = ('worker',) if args.expect_worker_block else ('browser', 'worker')
    for mode in modes:
        target = output / (mode + '.cjs')
        command = [
            args.emxx, str(root / 'tests/renderer_runtime_wait.cpp'),
            str(args.queue_source), '-I' + str(root / 'runtime/src'), '-I' + str(root / 'runtime/src/gs'),
            '-std=c++20', '-O2', '-pthread', '-DPS2_RENDER_PROXY_WAKE',
            '-fexceptions', '-sASYNCIFY', '-sDISABLE_EXCEPTION_CATCHING=0',
            '-sASYNCIFY_STACK_SIZE=1048576', '-sPTHREAD_POOL_SIZE=1',
            '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', '--pre-js', str(pre),
            '--js-library', str(root / 'web/sync-game-workers.js'), '-o', str(target),
        ]
        command += ['-DPS2_TEST_BROWSER_MAIN=' + ('1' if mode == 'browser' else '0'),
                    '-Wl,--wrap=emscripten_is_main_browser_thread']
        subprocess.run(command, check=True)
        result = subprocess.run(['node', str(target)], capture_output=True, text=True, timeout=30)
        text = result.stdout + result.stderr
        expected = 1 if args.expect_worker_block else 0
        assert result.returncode == expected, {'code': result.returncode, 'output': text}
        assert ('FAIL: rendering runtime blocked' if args.expect_worker_block else 'PASS: rendering runtime') in text, text
        records = [json.loads(line.removeprefix('QUEUE_RESULT '))
                   for line in result.stdout.splitlines() if line.startswith('QUEUE_RESULT ')]
        assert len(records) == 1, text
        record = records[0]
        assert record['timerProgressed'] == (not args.expect_worker_block), record
        assert record['found'] and record['mainRuntime'], record
        assert record['mainBrowser'] == (mode == 'browser'), record
        assert record['payload'] == 0x12345678 and record['elapsed'] >= 45, record
        print(mode + ': ' + result.stdout.strip())
