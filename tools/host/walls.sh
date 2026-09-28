#!/bin/sh
# Keeps the machines' walls up (spec §5). launchd runs it as root at boot and every minute after
# (inc.i.walls.plist). It loads the rules from tools/m1/pf into their anchor, keeps pf on with a
# reference of its own, and leaves /var/run/i-inc-walls.ok for the daemon, which boots no machine
# without it. If any of that fails, the marker goes, so the daemon fails closed.
set -u
anchor="com.apple/010.i-inc-machines"
rules=/usr/local/lib/i-inc/i-inc-machines.pf
token_file=/var/run/i-inc-pf.token
ok=/var/run/i-inc-walls.ok
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
down() {
  rm -f "$ok"
  echo "$(now) walls down: $*"
  exit 1
}

# Reloading swaps the anchor's rules at once and keeps existing connections' state.
out=$(pfctl -a "$anchor" -f "$rules" 2>&1) || down "the rules didn't load: $out"
# Our own reference keeps pf on even if another service releases its own. A token left from before
# a reboot means nothing, so pf being off always gets a fresh one.
if [ ! -s "$token_file" ] || ! pfctl -s info 2>/dev/null | grep -q "Status: Enabled"; then
  pfctl -E 2>&1 | awk '/^Token/ {print $3}' >"$token_file"
fi
ifconfig pflog0 >/dev/null 2>&1 || ifconfig pflog0 create

pfctl -s info 2>/dev/null | grep -q "Status: Enabled" || down "pf is off"
pfctl -a "$anchor" -s rules 2>/dev/null | grep -q "block return in" || down "the anchor is empty"
[ -f "$ok" ] || echo "$(now) walls up"
touch "$ok"
