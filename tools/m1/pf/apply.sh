#!/bin/sh
# M1 step 3: load the machines' walls (i-inc-machines.pf) and turn on pf and its log.
# Run it on the host as root: sudo sh tools/m1/pf/apply.sh [rules-file]
# Undo it with tools/m1/pf/remove.sh.
set -eu

anchor="com.apple/010.i-inc-machines"
rules="${1:-$(dirname "$0")/i-inc-machines.pf}"
token_file=/var/run/i-inc-pf.token

echo "== pf before"
pfctl -s info 2>/dev/null | head -1
echo "anchors under com.apple: $(pfctl -a com.apple -s Anchors 2>/dev/null | tr '\n' ' ')"

echo "== check the rules, then load them into $anchor"
pfctl -a "$anchor" -n -f "$rules"
pfctl -a "$anchor" -f "$rules"

# Enable pf with a reference of our own, so another service releasing its reference can't turn
# it off under the machines. remove.sh gives the reference back.
if [ ! -s "$token_file" ]; then
  pfctl -E 2>&1 | awk '/^Token/ {print $3}' >"$token_file"
fi
echo "pf reference token saved in $token_file"

# pflog0 receives the rules' log entries; read it with: tcpdump -n -e -ttt -i pflog0
ifconfig pflog0 >/dev/null 2>&1 || ifconfig pflog0 create

echo "== pf after"
pfctl -s info 2>/dev/null | head -1
pfctl -a "$anchor" -s rules
