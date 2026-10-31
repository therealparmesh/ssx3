#!/bin/sh
# Build only the asset-free CPU reference and WebGL verification page.
set -eu
raster_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
raster_output=${1:-"$raster_root/build/webgl-ordered"}
raster_compiler=${EMXX:-em++}
mkdir -p "$raster_output"
"$raster_compiler" -std=c++20 -O3 -fexceptions -ffunction-sections -fdata-sections \
    -I "$raster_root/runtime/src" -I "$raster_root/runtime/include" \
    "$raster_root/tests/webgl_ordered/reference.cpp" \
    "$raster_root/runtime/src/gs/gs.cpp" "$raster_root/runtime/src/gs/raster.cpp" \
    -sMODULARIZE=1 -sEXPORT_NAME=createReference \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_reference \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32 \
    -sALLOW_MEMORY_GROWTH=1 -sDISABLE_EXCEPTION_CATCHING=0 \
    -o "$raster_output/reference.js"
cp "$raster_root/tests/webgl_ordered/index.html" "$raster_output/index.html"
cp "$raster_root/tests/webgl_ordered/verify.js" "$raster_output/verify.js"
cp "$raster_root/runtime/src/gs/webgl/ordered_raster.frag" "$raster_output/kernel.frag"
printf 'Asset-free WebGL fixture: %s\n' "$raster_output"

cp "$raster_root/runtime/src/gs/webgl/ordered_raster.js" "$raster_output/ordered_raster.js"

mkdir -p "$raster_output/mips"
cp "$raster_root/tests/webgl_mips/"*.html "$raster_root/tests/webgl_mips/"*.js "$raster_output/mips/"
