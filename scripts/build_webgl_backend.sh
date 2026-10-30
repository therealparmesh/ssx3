#!/bin/sh
# Build the asset-free upstream-backed GS fixtures, never the game.
set -eu
backend_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backend_output=${1:-"$backend_root/build/webgl-backend"}
mkdir -p "$backend_output"
backend_output=$(CDPATH= cd -- "$backend_output" && pwd)
python3 "$backend_root/scripts/prepare_webgl_backend.py" "$backend_output/upstream"
"${EMCMAKE:-emcmake}" "${CMAKE:-cmake}" -S "$backend_root/tests/webgl_backend" \
    -B "$backend_output/compiler" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DWEBGL_UPSTREAM="$backend_output/upstream"
"${CMAKE:-cmake}" --build "$backend_output/compiler" --parallel "${WEBGL_BUILD_JOBS:-2}"
for fixture in population readback restore export; do
    cp "$backend_output/compiler/$fixture.js" "$backend_output/$fixture.js"
    cp "$backend_output/compiler/$fixture.wasm" "$backend_output/$fixture.wasm"
done
cp "$backend_root/runtime/src/gs/webgl/ordered_raster.js" "$backend_output/ordered_raster.js"
cp "$backend_root/runtime/src/gs/webgl/ordered_raster.frag" "$backend_output/kernel.frag"
cp "$backend_root/tests/webgl_backend/index.html" "$backend_output/index.html"
mkdir -p "$backend_output/licenses"
cp "$backend_output/upstream/licenses/"*.txt "$backend_output/licenses/"
printf 'Asset-free backend fixtures: %s\n' "$backend_output"
