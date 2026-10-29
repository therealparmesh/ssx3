#!/bin/bash
# Builds the web version of a recompiled game into build/web-<game>.
# usage: scripts/build_web.sh <game folder under games/> [emsdk dir]
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
game=${1:-gt4}
emsdk=${2:-${EMSDK:-$here/tools/emsdk}}
mode=${PS2_WEB_ASYNC:-jspi}
worker=${PS2_WEB_WORKER:-OFF}
case "$mode" in jspi|asyncify) ;; *) echo 'PS2_WEB_ASYNC must be jspi or asyncify' >&2; exit 2 ;; esac
suffix=""
[ "$mode" = jspi ] || suffix="-asyncify"
case "$worker" in ON|on|TRUE|true|YES|yes|1) worker=ON; suffix="$suffix-worker" ;; *) worker=OFF ;; esac
out="$here/build/web-$game$suffix"
generated_suffix=""
if [ "$mode" = asyncify ]; then generated_suffix="-asyncify"; fi
generated=${PS2_GENERATED:-$here/generated/$game$generated_suffix}
boot=$(sed -n 's/^BOOT2 *= *//p' "$here/games/$game/disc/SYSTEM.CNF" | tr -d '\r')
elf=$(ls "$here/games/$game/patched/"* 2>/dev/null | head -1)
[ -n "$elf" ] || elf="$here/games/$game/core.elf"
if [ ! -f "$elf" ]; then
    name=${boot#*\\}
    elf="$here/games/$game/disc/${name%;*}"
fi
mkdir -p "$out"
printf '%s\n' "$boot" > "$out/boot.txt"
source "$emsdk/emsdk_env.sh" > /dev/null 2>&1
emcmake cmake -S "$here" -B "$out" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DPS2_WEB_ASYNC="$mode" -DPS2_WEB_WORKER="$worker" \
    -DPS2_GENERATED="$generated" -DPS2_WEB_ELF="$elf" -DPS2_WEB_BOOT_FILE="$out/boot.txt" \
    -DPS2_WEB_PATCHES="$([ -f "$here/games/$game/patches.txt" ] && echo "$here/games/$game/patches.txt")"
ninja -C "$out" ps2web
# The HTML minifier can leave invalid inline JavaScript in an otherwise
# successful link. Reject that build before creating distributable assets.
node - "$here/web/shell.html" "$out/ps2web.html" <<'JS'
const fs = require('node:fs'), vm = require('node:vm');
for (const file of process.argv.slice(2)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
        new vm.Script(match[1], { filename: file });
}
JS
assets=(ps2web.wasm ps2web.data ps2web.js)
if [ "$worker" = ON ]; then
    for asset in worker-runtime-bridge.js game-runtime-worker.js game-runtime-client.js pixel-producer.js pixel-presenter-worker.js readback-progress.js frame-clock.js; do
        node --check "$out/$asset"
        assets+=("$asset")
    done
fi
for asset in "${assets[@]}"; do gzip -knf9 "$out/$asset"; done
printf 'built %s/ps2web.html; serve it with scripts/serve.py %q %q\n' "$out" "build/web-$game$suffix" "games/$game/disc.iso"
