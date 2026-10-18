#!/bin/sh
# Installs the pinned Codex ACP adapter and CLI in an existing team sandbox. This is an owner-run
# operation on the mini; it updates only the named sandbox and requires the host walls marker.
#   sh tools/host/provision-codex.sh <team id>
set -eu

id=${1:?usage: provision-codex.sh <team id>}
case "$id" in *[!a-z0-9-]*|'') echo "not a team id: $id" >&2; exit 64 ;; esac
[ "${#id}" -le 32 ] || { echo "team id is longer than 32 characters" >&2; exit 64; }
machine="inc-$id"
c=${I_INC_CONTAINER:-/usr/local/bin/container}
walls=${I_INC_WALLS_MARKER:-/var/run/i-inc-walls.ok}
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)

[ -n "$(find "$walls" -mmin -2 -print -quit 2>/dev/null)" ] || {
  echo "the walls aren't up (see tools/host), so no machine starts" >&2
  exit 1
}
"$c" machine inspect "$machine" >/dev/null 2>&1 || {
  echo "team sandbox $machine does not exist; provision it with the reviewed employee-image flow first" >&2
  exit 1
}

# This path is intentionally limited to the selected machine. No host package manager or process
# management is used; npm writes under employee's existing ~/.local prefix.
"$c" machine run -u employee -n "$machine" -- npm install --global --no-audit --no-fund \
  --prefix /home/employee/.local \
  @agentclientprotocol/codex-acp@2.2.2 @openai/codex@0.160.1 </dev/null
"$c" machine run -u employee -n "$machine" -- mkdir -p /home/employee/.codex </dev/null

put() { # put <source file> <sandbox path> <mode>
  cat "$1" | "$c" machine run -i -u employee -n "$machine" -- sudo tee "$2" >/dev/null
  "$c" machine run -u employee -n "$machine" -- sudo chmod "$3" "$2" </dev/null
}
put "$root/images/employee/acp-env.sh" /usr/local/lib/i-inc/acp-env.sh 644
put "$root/images/employee/launchers/acp-codex" /usr/local/bin/acp-codex 755

"$c" machine run -u employee -n "$machine" -- /home/employee/.local/bin/codex-acp --version </dev/null
"$c" machine run -u employee -n "$machine" -- /home/employee/.local/bin/codex --version </dev/null
echo "$machine: Codex ACP provisioned; sign in separately with tools/host/sign-in-codex.sh"
