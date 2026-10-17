#!/bin/sh
# Installs the daemon as the owner's LaunchAgent, so real employees run whenever the mini is up. It
# listens on 127.0.0.1:7420 only: the web app sends no token yet, so it isn't served on the tailnet.
# Reach it with an SSH tunnel: ssh -L 7420:127.0.0.1:7420 <mini>, then http://127.0.0.1:7420.
# Run it on the mini as the owner, from a checkout that has run pnpm install and built apps/web:
#   sh tools/host/install-daemon.sh
# Undo it: launchctl bootout gui/$(id -u)/inc.i.daemon, and delete the plist.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
[ "$(id -u)" != 0 ] || { echo "run it as the owner, not root" >&2; exit 1; }
bun=$(command -v bun || echo /opt/homebrew/bin/bun)
[ -x "$bun" ] || { echo "no bun: brew install bun" >&2; exit 1; }
plist="$HOME/Library/LaunchAgents/inc.i.daemon.plist"
log="$HOME/Library/Logs/i-inc-daemon.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s#@BUN@#$bun#" -e "s#@REPO@#$repo#g" -e "s#@LOG@#$log#" "$here/inc.i.daemon.plist" >"$plist"
launchctl bootout "gui/$(id -u)/inc.i.daemon" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
sleep 3
tail -n 8 "$log"
