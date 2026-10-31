#!/usr/bin/env python3
"""Check actual web pacing and reject both known pause/resume regressions."""
import argparse
import json
from pathlib import Path
import shlex
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--cxx', default='c++')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
source = (root / 'host/web.cpp').read_text()
fixed = '''        while (g_paused.load() || audio_queued_ms() > g_audio_target_frames / 48.0) {
            if (g_paused.load()) wait_while_paused();
            else usleep(1000);
        }'''
old = '        while (audio_queued_ms() > g_audio_target_frames / 48.0 && !g_paused.load()) usleep(1000);'
assert source.count(fixed) == 1

def fragment(text):
    wait = text[text.index('void wait_while_paused() {'):text.index('\nvoid configure_audio_reserve')]
    queue = text[text.index('double audio_queued_ms() {'):text.index('\ndouble g_next_frame')]
    pace = text[text.index('void pace() {'):text.index('\nvoid on_vblank')]
    reserve = text[text.index('void configure_audio_reserve'):text.index('\nvoid push_audio')]
    return (wait + '\n' + reserve + '\n' + queue + '\n' + pace).replace('usleep(', 'audio_test_sleep(')

variants = [('current', source, None),
            ('fixed-80ms-ceiling', source.replace(fixed, fixed.replace('g_audio_target_frames / 48.0', '80.0')),
             'Configured audio reserve bypassed'),
            ('old-pause-escape', source.replace(fixed, old), 'Pause escaped without acknowledgement'),
            ('missing-budget-recheck', source.replace(fixed, old + '\n        if (g_paused.load()) wait_while_paused();'),
             'Resume bypassed audio budget')]
compiler = [args.cxx] if Path(args.cxx).is_file() else shlex.split(args.cxx)
with tempfile.TemporaryDirectory(prefix='ps2-audio-pacing-') as temp:
    directory = Path(temp)
    for name, text, failure in variants:
        include = directory / (name + '.inc')
        include.write_text(fragment(text))
        executable = directory / name
        subprocess.run(compiler + ['-std=c++20', '-O2', '-pthread',
                       '-DHOST_AUDIO_PACING=' + json.dumps(str(include)),
                       str(root / 'tests/audio_pacing.cpp'), '-o', str(executable)], check=True)
        result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=15)
        if failure:
            assert result.returncode != 0 and failure in result.stderr, (name, result.stderr)
        else:
            assert result.returncode == 0, result.stderr
            print(result.stdout.strip())
print('Native pacing negative controls: fixed80ms ceiling, pause escape and skipped resume budget rejected.')
