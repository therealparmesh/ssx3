#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$ROOT/scripts/serve.py" "$ROOT/build/web-ssx3" "$ROOT/games/ssx3/disc.iso" "${1:-8620}" "${@:2}"
