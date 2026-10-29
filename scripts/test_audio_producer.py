#!/usr/bin/env python3
"""Run the real web audio producer against a bounded consumer without game assets."""
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
source = (root / 'host/web.cpp').read_text()
capacity = re.search(r'^constexpr std::uint32_t kAudioFrames = .*?;', source, re.M)
assert capacity
globals_ = source[source.index('struct AudioRing {'):source.index('Slot g_slots[')]
producer = source[source.index('void wait_while_paused() {'):source.index('\ndouble audio_queued_ms()')]
producer = producer.replace('usleep(', 'audio_test_sleep(')
with tempfile.TemporaryDirectory(prefix='ps2-audio-producer-') as temp:
    directory = Path(temp)
    fragment = directory / 'producer.inc'
    fragment.write_text('#include ' + json.dumps(str(root / 'host/audio_resampler.hpp')) + '\n' + capacity[0] + '\n' + globals_ + producer)
    executable = directory / 'producer-test'
    compiler = [args.cxx] if Path(args.cxx).is_file() else shlex.split(args.cxx)
    subprocess.run(compiler + ['-std=c++20', '-O2', '-pthread', '-DHOST_AUDIO_PRODUCER=' + json.dumps(str(fragment)), str(root / 'tests/audio_producer.cpp'), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True, timeout=20)
