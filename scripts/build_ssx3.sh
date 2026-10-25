#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Reuse the checkout-local tools on machines without system CMake/Ninja.
for tool_bin in "$ROOT/../.toolchain/cmake/data/bin" "$ROOT"/../.toolchain/ninja-*.data/scripts; do
    [ ! -d "$tool_bin" ] || export PATH="$tool_bin:$PATH"
done
export EMSDK="${EMSDK:-$ROOT/tools/emsdk}"

source_path="${1:-$HOME/Downloads/SSX 3 (USA).7z}"
[ $# -eq 0 ] || shift
if [ ! -s "$source_path" ]; then
    printf 'The completed SSX 3 archive or disc image is missing: %s\n' "$source_path" >&2
    exit 1
fi
case "$source_path" in
    *.part|*.crdownload) echo 'Wait for the download to finish before building.' >&2; exit 1 ;;
esac

exec bash "$ROOT/scripts/port.sh" ssx3 "$source_path" \
    --elf-sha1 77114dfd1205eaccf1ccc18c5f9650097fa78bd8 \
    --ssx3-fast-boot --optional-visual 002E30D0 --optional-visual 002E3130 "$@"
