#!/bin/sh
# Installs the Ollama relay (tools/m1/ollama-forward.mjs) as the owner's LaunchAgent, so it comes
# back after a reboot. Run it on the mini as the owner, not root: sh tools/host/install-relay.sh
# Undo it: launchctl bootout gui/$(id -u)/inc.i.ollama-relay, and delete the plist.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" != 0 ] || { echo "run it as the owner, not root" >&2; exit 1; }
node=$(command -v node || echo /opt/homebrew/bin/node)
dir="$HOME/Library/Application Support/i-inc"
plist="$HOME/Library/LaunchAgents/inc.i.ollama-relay.plist"
log="$HOME/Library/Logs/i-inc-ollama-relay.log"

mkdir -p "$dir" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$here/../m1/ollama-forward.mjs" "$dir/ollama-relay.mjs"
sed -e "s#@NODE@#$node#" -e "s#@SCRIPT@#$dir/ollama-relay.mjs#" -e "s#@LOG@#$log#" \
  "$here/inc.i.ollama-relay.plist" >"$plist"

launchctl bootout "gui/$(id -u)/inc.i.ollama-relay" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
sleep 2
tail -n 2 "$log"
