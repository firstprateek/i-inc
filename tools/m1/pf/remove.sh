#!/bin/sh
# M1 step 3: take the machines' walls down again, undoing tools/m1/pf/apply.sh.
# Run it on the host as root: sudo sh tools/m1/pf/remove.sh
set -eu

anchor="com.apple/010.i-inc-machines"
token_file=/var/run/i-inc-pf.token

pfctl -a "$anchor" -F all
# Give back our reference; pf stays on if other services (such as vmnet's NAT) still hold one.
if [ -s "$token_file" ]; then
  pfctl -X "$(cat "$token_file")"
  rm -f "$token_file"
fi
pfctl -s info 2>/dev/null | head -1
