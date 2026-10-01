#!/bin/sh
# Installs the walls' boot job (walls.sh) as a LaunchDaemon. Run it on the mini as root, from a copy
# of the repo's tools folder: sudo sh tools/host/install-walls.sh
# Undo it: sudo launchctl bootout system/inc.i.walls, delete /Library/LaunchDaemons/inc.i.walls.plist,
# /usr/local/lib/i-inc and /var/run/i-inc-walls.ok, then sudo sh tools/m1/pf/remove.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "run it with sudo" >&2; exit 1; }

# Root owns everything the job runs, so no other user can change what runs as root.
install -d -o root -g wheel -m 755 /usr/local/lib/i-inc
install -o root -g wheel -m 644 "$here/../m1/pf/i-inc-machines.pf" /usr/local/lib/i-inc/i-inc-machines.pf
install -o root -g wheel -m 755 "$here/walls.sh" /usr/local/lib/i-inc/walls.sh
install -o root -g wheel -m 644 "$here/inc.i.walls.plist" /Library/LaunchDaemons/inc.i.walls.plist

launchctl bootout system/inc.i.walls 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/inc.i.walls.plist
sleep 2
tail -n 3 /var/log/i-inc-walls.log
if [ -f /var/run/i-inc-walls.ok ]; then echo "the walls are up, and come back at boot"; else echo "the walls are NOT up" >&2; exit 1; fi
