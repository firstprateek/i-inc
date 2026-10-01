#!/bin/sh
# Keeps the machines' walls up (spec §5). launchd runs it as root at boot and every minute after
# (inc.i.walls.plist). It loads the rules from tools/m1/pf into their anchor, keeps pf on with a
# reference of its own, and touches /var/run/i-inc-walls.ok for the daemon, which runs nothing in a
# machine unless the marker is under two minutes old. If any of that fails, the marker goes, so the
# daemon fails closed, and stops the machines it has running.
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
# The rules name bridge100 and 192.168.64.0/24. If vmnet ever puts the machines' gateway on another
# interface, they'd match nothing, so that counts as down too.
gw_if=$(ifconfig | awk '/^[a-z0-9]+:/ { i = $1; sub(":", "", i) } /inet 192\.168\.64\.1 / { print i }')
[ -z "$gw_if" ] || [ "$gw_if" = bridge100 ] || down "the machines' gateway is on $gw_if, not bridge100"
[ -f "$ok" ] || echo "$(now) walls up"
touch "$ok"
