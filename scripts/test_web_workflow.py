#!/usr/bin/env python3
"""Exercise CLI wiring without a disc, compiler, SDK download or system service."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='ps2 web workflow ') as temporary:
    root = Path(temporary)
    scripts = root / 'scripts'
    scripts.mkdir()
    for name in ['port.sh', 'build_web.sh', 'play_ssx3.sh', 'host_ssx3.sh', 'web_config.sh']:
        shutil.copy2(source / 'scripts' / name, scripts / name)
    (root / 'web').mkdir()
    (root / 'web/shell.html').write_text('<script>const fixture = true;</script>')
    trace = root / 'trace.jsonl'
    tools = root / 'build/tools'
    tools.mkdir(parents=True)
    binaries = root / 'bin'
    binaries.mkdir()
    sdk = root / 'sdk'
    sdk.mkdir()
    (sdk / 'emsdk_env.sh').write_text(':\n')
    (scripts / 'cxx.sh').write_text('cxx_flags=()\n')
    prelude = '''import json,os,sys
from pathlib import Path
with open(os.environ['SSX3_CLI_TRACE'],'a') as output:
 output.write(json.dumps([Path(sys.argv[0]).name,*sys.argv[1:]])+'\\n')
'''

    def executable(path, body):
        path.write_text('#!' + sys.executable + '\n' + prelude + body)
        path.chmod(0o755)

    executable(tools / 'eerecomp', '''out=Path(sys.argv[sys.argv.index('--out')+1]);out.mkdir(parents=True,exist_ok=True)
(out/'generated-mode.txt').write_text('plain' if '--no-tail-calls' in sys.argv else 'tail')
''')
    executable(tools / 'vurecomp', "Path(sys.argv[2],'vectors.txt').write_text('recorded vectors')\n")
    executable(binaries / 'cmake', "out=Path(sys.argv[sys.argv.index('-B')+1]);out.mkdir(parents=True,exist_ok=True);(out/'build.ninja').touch()\n")
    executable(binaries / 'emcmake', "os.execvp(sys.argv[1],sys.argv[1:])\n")
    helpers = ['worker-runtime-bridge.js', 'game-runtime-worker.js', 'game-runtime-client.js',
               'pixel-producer.js', 'pixel-presenter-worker.js', 'readback-progress.js', 'frame-clock.js']
    executable(binaries / 'ninja', '''out=Path(sys.argv[sys.argv.index('-C')+1]);out.mkdir(parents=True,exist_ok=True)
if 'ps2web' in sys.argv:
 (out/'ps2web.html').write_text('<script>const built = true;</script>')
 for name in ['ps2web.js','ps2web.wasm','ps2web.data',*''' + repr(helpers) + ''']:
  (out/name).write_text('// built fixture')
 (out/'ps2web-worker-assets.json').write_text(json.dumps({'version':1,'files':''' + repr(helpers) + '''}))
''')
    executable(binaries / 'systemctl', '')
    executable(binaries / 'python3', '''if len(sys.argv)>1 and sys.argv[1].endswith('/serve.py'): sys.exit(0)
os.execv(sys.executable,[sys.executable,*sys.argv[1:]])
''')
    (scripts / 'disc.py').write_text(prelude + '''if sys.argv[1]=='extract':
 out=Path(sys.argv[3]);out.mkdir(parents=True,exist_ok=True)
 (out/sys.argv[4]).write_text('BOOT2 = cdrom0:\\\\SLUS_207.72;1\\n' if sys.argv[4]=='SYSTEM.CNF' else 'fixture executable')
''')
    for name in ['pnach.py', 'windows.py', 'optional_visuals.py', 'ssx3_startup.py']:
        (scripts / name).write_text(prelude + ("print('fixture')\n" if name == 'pnach.py' else ''))
    env = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ['PATH'],
               EMSDK=str(sdk), SSX3_CLI_TRACE=str(trace), XDG_CONFIG_HOME=str(root / 'config'))
    for name in ['PS2_WEB_ASYNC', 'PS2_WEB_WORKER', 'PS2_GENERATED']:
        env.pop(name, None)

    def run(*args, expected=0, overrides=None):
        result = subprocess.run(['bash', *map(str, args)], env={**env, **(overrides or {})},
                                text=True, capture_output=True, timeout=30)
        assert result.returncode == expected, result.stdout + result.stderr
        return result

    def events():
        return [json.loads(line) for line in trace.read_text().splitlines()]

    for game in ['ssx3', 'gt4']:
        (root / 'games' / game / 'vu1').mkdir(parents=True)
        (root / 'games' / game / 'disc.iso').touch()
        (root / 'games' / game / 'vu1/fixture.bin').write_bytes(b'fixture')
    run(scripts / 'port.sh', 'ssx3', root / 'games/ssx3/disc.iso', '--no-explore',
        '--ssx3-fast-boot', '--optional-visual', '002E30D0')
    normal = root / 'generated/ssx3'
    compatible = root / 'generated/ssx3-asyncify'
    assert (normal / 'generated-mode.txt').read_text() == 'tail'
    assert (compatible / 'generated-mode.txt').read_text() == 'plain'
    assert (compatible / 'vectors.txt').exists()
    for patch in ['optional_visuals.py', 'ssx3_startup.py']:
        assert {e[1] for e in events() if e[0] == patch} == {str(normal), str(compatible)}
    browser_config = next(e for e in events() if e[0] == 'cmake' and '-DPS2_WEB_WORKER=ON' in e)
    assert '-DPS2_WEB_ASYNC=asyncify' in browser_config
    assert '-DPS2_DEVELOPER_TOOLS=OFF' in browser_config
    assert '-DPS2_GENERATED=' + str(compatible) in browser_config
    build = root / 'build/web-ssx3-asyncify-worker'
    assert (build / 'ps2web.html').is_file()
    run(scripts / 'play_ssx3.sh', '8765')
    play = next(e for e in events() if e[0] == 'python3' and e[1].endswith('/serve.py'))
    assert play[2:5] == [str(build), str(root / 'games/ssx3/disc.iso'), '8765']
    deployed = root / 'build/hosted-ssx3'
    deployed.mkdir()
    (deployed / 'ps2web.html.gz').write_bytes(b'stale gzip')
    run(scripts / 'host_ssx3.sh', '8766')
    for name in ['ps2web-worker-assets.json', *helpers]:
        assert (deployed / name).read_bytes() == (build / name).read_bytes()
    assert not (deployed / 'ps2web.html.gz').exists()
    assert (deployed / 'pixel-presenter-worker.js.gz').is_file()
    assert (root / 'config/systemd/user/ssx3-web.service').is_file()
    before = len(events())
    (build / 'pixel-presenter-worker.js').unlink()
    run(scripts / 'host_ssx3.sh', expected=1)
    assert not any(e[0] == 'systemctl' for e in events()[before:]), 'Missing helper must fail before service mutation'

    before = len(events())
    run(scripts / 'port.sh', 'gt4', root / 'games/gt4/disc.iso', '--no-explore')
    generic = [e for e in events()[before:] if e[0] == 'cmake' and '-DPS2_WEB_ASYNC=jspi' in e]
    assert len(generic) == 1 and '-DPS2_WEB_WORKER=OFF' in generic[0]
    run('-c', 'set -e; source "$1"; ps2_web_config "$2" ssx3; test "$ps2_web_mode/$ps2_web_worker" = jspi/OFF',
        '_', scripts / 'web_config.sh', root, overrides={'PS2_WEB_ASYNC': 'jspi'})
    custom = str(root / 'custom generated')
    run('-c', 'set -e; source "$1"; ps2_web_config "$2" ssx3; test "$ps2_web_worker" = OFF; test "$ps2_web_generated" = "$3"',
        '_', scripts / 'web_config.sh', root, custom,
        overrides={'PS2_WEB_WORKER': 'OFF', 'PS2_GENERATED': custom})
    before = len(events())
    run(scripts / 'port.sh', 'ssx3', root / 'games/ssx3/disc.iso', '--no-explore', '--native-only',
        overrides={'PS2_WEB_ASYNC': 'invalid-unused-browser-setting'})
    assert not any(e[0] == 'emcmake' for e in events()[before:]), 'Native-only must not configure a browser build'
    for overrides in [{'PS2_WEB_ASYNC': 'bad'}, {'PS2_WEB_WORKER': 'typo'},
                      {'PS2_WEB_ASYNC': 'jspi', 'PS2_WEB_WORKER': 'ON'}]:
        run('-c', 'set -e; source "$1"; ps2_web_config "$2" ssx3', '_', scripts / 'web_config.sh', root,
            overrides=overrides, expected=2)
print('PASS: default translation/build/play/hosting agree; native code retained; both translation patches/vectors; all worker helpers and gzip; stale gzip removal; missing-helper guard; generic JSPI and explicit overrides.')
