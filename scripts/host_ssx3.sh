#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8621}"
DEPLOY="$ROOT/build/hosted-ssx3"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/ssx3-web.service"

[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 1024 && PORT < 65536 )) || { echo 'Choose a port between 1025 and 65535.' >&2; exit 1; }
[ -f "$ROOT/games/ssx3/disc.iso" ] || { echo 'Build SSX 3 first; the disc image is missing.' >&2; exit 1; }
for asset in ps2web.html ps2web.js ps2web.wasm ps2web.data; do
    [ -s "$ROOT/build/web-ssx3/$asset" ] || { echo "Build SSX 3 first; $asset is missing." >&2; exit 1; }
done
if [ -e "$UNIT" ] && ! grep -q '^# Managed by ssx3-wasm/scripts/host_ssx3.sh$' "$UNIT"; then
    echo "An existing service at $UNIT is not managed by this project." >&2
    exit 1
fi

# Publish only player assets. Build objects, test snapshots and development
# recordings never enter the served directory.
mkdir -p "$DEPLOY" "$UNIT_DIR"
for asset in ps2web.html ps2web.js ps2web.wasm ps2web.data ps2web.js.gz ps2web.wasm.gz ps2web.data.gz; do
    [ ! -f "$ROOT/build/web-ssx3/$asset" ] || cp "$ROOT/build/web-ssx3/$asset" "$DEPLOY/$asset"
done
cat > "$UNIT" <<EOF
# Managed by ssx3-wasm/scripts/host_ssx3.sh
[Unit]
Description=SSX 3 browser player
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 "$ROOT/scripts/serve.py" "$DEPLOY" "$ROOT/games/ssx3/disc.iso" $PORT
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now ssx3-web.service
systemctl --user restart ssx3-web.service
printf 'Player running at http://127.0.0.1:%s/\n' "$PORT"
