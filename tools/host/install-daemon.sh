#!/bin/sh
# Installs the daemon as the owner's LaunchAgent, so real employees run whenever the mini is up. It
# listens on 127.0.0.1:7420; `tailscale serve --bg --https=8443 http://127.0.0.1:7420` puts it on
# the tailnet, behind the login token in ~/.config/i-inc/web-token. An SSH tunnel works too:
# ssh -L 7420:127.0.0.1:7420 <mini>, then http://127.0.0.1:7420.
# Run it on the mini as the owner, from a checkout that has run pnpm install and built apps/web:
#   sh tools/host/install-daemon.sh
# Undo it: launchctl bootout gui/$(id -u)/inc.i.daemon, and delete the plist.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# launchd_reload waits for launchd to drop a service before bootstrapping it, and puts the previous
# plist back if the new one will not load (launchd.sh).
# shellcheck source=/dev/null
. "$here/launchd.sh"
# Once the deployer is installed (tools/host/install-deployer.sh) the daemon runs from the release
# the deployer last switched to, not from this checkout: keep it there.
if [ -L "$HOME/i-inc-releases/current" ]; then
  repo="$HOME/i-inc-releases/current"
  echo "the deployer is installed: the daemon stays on $repo"
fi
[ "$(id -u)" != 0 ] || { echo "run it as the owner, not root" >&2; exit 1; }
bun=$(command -v bun || echo /opt/homebrew/bin/bun)
[ -x "$bun" ] || { echo "no bun: brew install bun" >&2; exit 1; }
plist="$HOME/Library/LaunchAgents/inc.i.daemon.plist"
log="$HOME/Library/Logs/i-inc-daemon.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Apple's container service doesn't start by itself after a restart (found 2026-10-17), and every
# team's sandbox needs it, so it starts at login.
cplist="$HOME/Library/LaunchAgents/inc.i.container.plist"
prev=$(mktemp)
trap 'rm -f "$prev"' EXIT HUP INT TERM
[ ! -f "$cplist" ] || cp "$cplist" "$prev"
sed -e "s#@LOG@#$HOME/Library/Logs/i-inc-container.log#" "$here/inc.i.container.plist" >"$cplist"
launchd_reload "gui/$(id -u)" inc.i.container "$cplist" "$prev" || exit 1

# The daemon also answers as the mini's tailnet name on 8443, where `tailscale serve` puts it (port
# 443 is Duet's). Everyone else on the tailnet meets the login (~/.config/i-inc/web-token).
ts=$(/usr/local/bin/tailscale status --json 2>/dev/null | /usr/bin/jq -r '.Self.DNSName // empty' | sed 's/\.$//')
hosts=${ts:+$ts:8443,$ts}
# Whatever plist the daemon had is put back if the new one won't load, so it is never left down.
: >"$prev"
[ ! -f "$plist" ] || cp "$plist" "$prev"
sed -e "s#@BUN@#$bun#" -e "s#@REPO@#$repo#g" -e "s#@LOG@#$log#" -e "s#@HOSTS@#$hosts#" \
  "$here/inc.i.daemon.plist" >"$plist"
launchd_reload "gui/$(id -u)" inc.i.daemon "$plist" "$prev" || exit 1
sleep 3
tail -n 8 "$log"
