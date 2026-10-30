#!/usr/bin/env python3
"""Prepare pinned, checksum-verified upstream sources for the WebGL experiment."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

root = Path(__file__).resolve().parent.parent
fixture = root / 'tests/webgl_backend'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory', type=Path)
args = parser.parse_args()
destination = args.directory.resolve()
lock = fixture / 'sources.lock.json'
patch = fixture / 'upstream.patch'
identity = hashlib.sha256(lock.read_bytes() + patch.read_bytes() + (fixture / "normalize.json").read_bytes()).hexdigest()
marker = destination / '.prepared.json'
if marker.exists():
    prepared = json.loads(marker.read_text())
    if prepared['identity'] != identity:
        raise SystemExit('Pinned inputs changed; use a fresh output directory.')
    for name, digest in prepared['sourceFiles'].items():
        if not (destination / name).is_file() or hashlib.sha256((destination / name).read_bytes()).hexdigest() != digest:
            raise SystemExit(f'Prepared source changed: {name}; use a fresh output directory.')
    actual_files = {str(path.relative_to(destination)) for tree in ('play', 'licenses') for path in (destination / tree).rglob('*') if path.is_file()}
    if actual_files != set(prepared['sourceFiles']):
        raise SystemExit('Prepared source file set changed; use a fresh output directory.')
    if not (destination / 'licenses').is_dir():
        raise SystemExit('Prepared licenses are missing; use a fresh output directory.')
    print(f'Prepared sources verified: {destination}')
    raise SystemExit(0)

destination.mkdir(parents=True, exist_ok=True)
cache = destination / 'archives'
cache.mkdir(exist_ok=True)
for source in json.loads(lock.read_text()):
    archive = cache / (source['name'] + '.tar.gz')
    if not archive.exists():
        with urllib.request.urlopen(source['url'], timeout=60) as response:
            payload = response.read()
        if hashlib.sha256(payload).hexdigest() != source['sha256']:
            raise SystemExit(f'Upstream checksum mismatch: {source["name"]}')
        archive.write_bytes(payload)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != source['sha256']:
        raise SystemExit(f'Cached archive checksum mismatch: {archive}')
    target = destination / source['directory']
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f'Incomplete preparation contains files at {target}; use a fresh output directory.')
    target.mkdir(parents=True, exist_ok=True)
    # GitHub archives have one enclosing directory. The data filter rejects
    # traversal, device nodes and links escaping the generated source tree.
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            parts = Path(member.name).parts
            if len(parts) < 2:
                continue
            member.name = str(Path(*parts[1:]))
            tar.extract(member, target, filter='data')
    print(f'Verified {source["name"]} {source["revision"]}', flush=True)

for name in json.loads((fixture / 'normalize.json').read_text()):
    path = destination / name
    path.write_text(path.read_text())
subprocess.run(['git', 'apply', '--check', str(patch)], cwd=destination, check=True)
subprocess.run(['git', 'apply', str(patch)], cwd=destination, check=True)

licenses = destination / 'licenses'
licenses.mkdir(exist_ok=True)
for name, source in {
    'Play.txt': 'play/License.txt',
    'Framework.txt': 'play/deps/Framework/License.txt',
    'CodeGen.txt': 'play/deps/CodeGen/License.txt',
    'filesystem.txt': 'play/deps/Dependencies/ghc_filesystem/LICENSE',
    'zstd.txt': 'play/deps/Dependencies/zstd/LICENSE',
    'zlib.txt': 'play/deps/Dependencies/zlib/LICENSE',
}.items():
    shutil.copyfile(destination / source, licenses / name)
source_files = {str(path.relative_to(destination)): hashlib.sha256(path.read_bytes()).hexdigest()
                for tree in ('play', 'licenses') for path in (destination / tree).rglob('*') if path.is_file()}
marker.write_text(json.dumps({'identity': identity, 'sourceFiles': source_files}, indent=2) + '\n')
print(f'Prepared sources: {destination}')
