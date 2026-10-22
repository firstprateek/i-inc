#!/bin/sh
# M1 step 3: take the machines' walls down again, undoing tools/m1/pf/apply.sh.
# Run it on the host as root: sudo sh tools/m1/pf/remove.sh
set -eu

anchor="com.apple/010.i-inc-machines"
token_file=/var/run/i-inc-pf.token
here=$(cd "$(dirname "$0")" && pwd)

# Give the bridge its filter flags back (T70): walls.sh set bridge100's to 0x6 so that pf sees frames
# between machines, and with the rules gone nothing should still be asking the bridge to run pf. The
# walls job (inc.i.walls) would set them again within a minute: bootout the job first
# (sudo launchctl bootout system/inc.i.walls), or this undoes nothing for long.
if ifconfig bridge100 >/dev/null 2>&1; then
  if [ -f /usr/local/lib/i-inc/bridge-filter.sh ]; then helper=/usr/local/lib/i-inc/bridge-filter.sh
  else helper="$here/../../host/bridge-filter.sh"; fi
  sh "$helper" bridge100 0 && echo "bridge100's filter flags are back to 0" ||
    echo "could not clear bridge100's filter flags (sh $helper bridge100 0)" >&2
fi
rm -f /var/run/i-inc-walls.ok

pfctl -a "$anchor" -F all
rm -f /var/run/i-inc-open-machines.table /var/run/i-inc-walls.open
# Give back our reference; pf stays on if other services (such as vmnet's NAT) still hold one.
if [ -s "$token_file" ]; then
  pfctl -X "$(cat "$token_file")"
  rm -f "$token_file"
fi
pfctl -s info 2>/dev/null | head -1
