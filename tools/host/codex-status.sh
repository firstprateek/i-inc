#!/bin/sh
# Prints only whether the named team sandbox has a usable Codex login: true or false.
#   sh tools/host/codex-status.sh <team id>
set -eu

id=${1:?usage: codex-status.sh <team id>}
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
  echo "team sandbox $machine does not exist" >&2
  exit 1
}

# Keep the CLI's human-readable identity output in memory; status is intentionally just a boolean.
status=$("$c" machine run -u employee -n "$machine" -- \
  /home/employee/.local/bin/codex login status 2>&1 || true)
if printf '%s\n' "$status" | grep -Eiq '^Logged in using (ChatGPT|API key|workload identity)'; then
  echo true
elif printf '%s\n' "$status" | grep -Eiq 'not logged in|no authentication detected'; then
  echo false
else
  echo "could not read Codex sign-in status" >&2
  exit 1
fi
