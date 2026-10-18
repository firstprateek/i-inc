#!/bin/sh
# Signs the named team sandbox into Codex with the owner's ChatGPT account. Run on the mini in a
# terminal after provisioning. Device-code auth must be enabled for Codex in ChatGPT security
# settings. The code is single-use: enter it only at the official device page, never share it.
#   sh tools/host/sign-in-codex.sh <team id>
set -eu

id=${1:?usage: sign-in-codex.sh <team id>}
case "$id" in *[!a-z0-9-]*|'') echo "not a team id: $id" >&2; exit 64 ;; esac
[ "${#id}" -le 32 ] || { echo "team id is longer than 32 characters" >&2; exit 64; }
machine="inc-$id"
c=${I_INC_CONTAINER:-/usr/local/bin/container}
walls=${I_INC_WALLS_MARKER:-/var/run/i-inc-walls.ok}
[ -n "$(find "$walls" -mmin -2 -print -quit 2>/dev/null)" ] || {
  echo "the walls aren't up (see tools/host), so no machine starts" >&2
  exit 1
}
"$c" machine inspect "$machine" >/dev/null 2>&1 || {
  echo "team sandbox $machine does not exist; run tools/host/provision-codex.sh first" >&2
  exit 1
}

"$c" machine run -it -u employee -n "$machine" -- sh -c \
  'PATH=/home/employee/.local/bin:$PATH exec codex login --device-auth'
sh "$(dirname "$0")/codex-status.sh" "$id"
