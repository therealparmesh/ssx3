#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/web_config.sh"
ps2_web_config "$ROOT" ssx3
[ -s "$ps2_web_out/ps2web.html" ] || { echo "Build SSX 3 first; $ps2_web_out/ps2web.html is missing." >&2; exit 1; }
exec python3 "$ROOT/scripts/serve.py" "$ps2_web_out" "$ROOT/games/ssx3/disc.iso" "${1:-8620}" "${@:2}"
