#!/usr/bin/env python3
"""Stage asset-free presenter checks without compiling the game or runtime."""
from pathlib import Path
import shutil
import subprocess
import sys

source = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else source / 'build/webgl-presenter'
output.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, str(source / 'scripts/export_frame_clock.py'),
                str(source / 'web/frame-presentation.js'), str(output / 'frame-clock.js')], check=True)
shutil.copy2(source / 'web/webgl-gpu-presenter.js', output / 'presenter.js')
shutil.copy2(source / 'tests/webgl_presenter/fixture.html', output / 'fixture.html')
shutil.copy2(source / 'tests/webgl_presenter/capture.js', output / 'capture.js')
print(f'Asset-free presenter fixture: {output}')
