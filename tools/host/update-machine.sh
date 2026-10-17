#!/bin/sh
# Copies the image's launchers into an existing employee machine. A rebuilt image only reaches
# machines made after it (images/employee/README.md), and the launchers are where fixes land, such
# as acp-claude refreshing an expired sign-in. On the mini, from the checkout:
#   sh tools/host/update-machine.sh <employee id>
set -eu
id=${1:?usage: update-machine.sh <employee id>}
case "$id" in *[!a-z0-9-]*) echo "not an employee id: $id" >&2; exit 64 ;; esac
machine="inc-$id"
c=/usr/local/bin/container
img="$(cd "$(dirname "$0")/../../images/employee" && pwd)"
[ -n "$(find /var/run/i-inc-walls.ok -mmin -2 2>/dev/null)" ] || {
  echo "the walls aren't up (see tools/host), so no machine starts" >&2
  exit 1
}

# Through cat: `machine run -i` takes a pipe, but not every kind of stdin (images/employee/README.md).
put() { # put <file> <path in the machine> <mode>
  cat "$1" | $c machine run -i -u employee -n "$machine" -- sudo tee "$2" >/dev/null
  $c machine run -u employee -n "$machine" -- sudo chmod "$3" "$2" </dev/null
  echo "$machine: $2"
}
put "$img/acp-env.sh" /usr/local/lib/i-inc/acp-env.sh 644
for f in "$img"/launchers/acp-*; do put "$f" "/usr/local/bin/$(basename "$f")" 755; done
