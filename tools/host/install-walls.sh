#!/bin/sh
# Installs the walls' boot job (walls.sh) as a LaunchDaemon. Run it on the mini as root, from a copy
# of the repo's tools folder: sudo sh tools/host/install-walls.sh
# It records the account that ran sudo as the owner: walls.sh makes /var/run/i-inc for that account,
# and the daemon writes its list of home machines there (see walls.sh).
# It also installs inc.i.restart, a restart on the 1st of each month at 05:15.
# Undo it: sudo launchctl bootout system/inc.i.walls, delete /Library/LaunchDaemons/inc.i.walls.plist,
# /usr/local/lib/i-inc, /var/run/i-inc and /var/run/i-inc-walls.*, then sudo sh tools/m1/pf/remove.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# launchd_reload waits for launchd to drop a job before bootstrapping it again (launchd.sh).
. "$here/launchd.sh"
[ "$(id -u)" = 0 ] || { echo "run it with sudo" >&2; exit 1; }
owner=${SUDO_USER:-}
case "$owner" in
  "" | root | *[!A-Za-z0-9._-]* | -*) echo "run it with sudo from the owner's own account (SUDO_USER is '${owner}')" >&2; exit 1 ;;
esac
id "$owner" >/dev/null 2>&1 || { echo "no account $owner" >&2; exit 1; }

# What the jobs were before, put back if a new plist will not load.
prev_dir=$(mktemp -d)
trap 'rm -rf "$prev_dir"' EXIT HUP INT TERM
for label in inc.i.walls inc.i.restart; do
  : >"$prev_dir/$label"
  [ ! -f "/Library/LaunchDaemons/$label.plist" ] || cp "/Library/LaunchDaemons/$label.plist" "$prev_dir/$label"
done

# Root owns everything the job runs, so no other user can change what runs as root.
install -d -o root -g wheel -m 755 /usr/local/lib/i-inc
install -o root -g wheel -m 644 "$here/../m1/pf/i-inc-machines.pf" /usr/local/lib/i-inc/i-inc-machines.pf
printf '%s\n' "$owner" >/usr/local/lib/i-inc/owner
chown root:wheel /usr/local/lib/i-inc/owner && chmod 644 /usr/local/lib/i-inc/owner
install -o root -g wheel -m 755 "$here/walls.sh" /usr/local/lib/i-inc/walls.sh
install -o root -g wheel -m 644 "$here/inc.i.walls.plist" /Library/LaunchDaemons/inc.i.walls.plist
# And a monthly restart, for the macOS uptime bug that ran the mini out of ports (inc.i.restart.plist).
install -o root -g wheel -m 644 "$here/inc.i.restart.plist" /Library/LaunchDaemons/inc.i.restart.plist
launchd_reload system inc.i.restart /Library/LaunchDaemons/inc.i.restart.plist "$prev_dir/inc.i.restart" || exit 1

launchd_reload system inc.i.walls /Library/LaunchDaemons/inc.i.walls.plist "$prev_dir/inc.i.walls" || exit 1
sleep 2
tail -n 3 /var/log/i-inc-walls.log
if [ -f /var/run/i-inc-walls.ok ]; then
  echo "the walls are up, and come back at boot"
  held=$(grep -c . /var/run/i-inc-walls.home 2>/dev/null || true)
  echo "home machines the walls hold now: ${held:-0} (a home machine is walled once the daemon has declared it: docs/handoff.md)"
else echo "the walls are NOT up" >&2; exit 1; fi
