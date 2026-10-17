#!/bin/sh
# Signs a team's sandbox in to Claude with the owner's subscription, once: every agent on the team
# then uses that sign-in (docs/architecture.md). Run it on the mini, in a terminal:
#   sh ~/i-inc/tools/host/sign-in-claude.sh <team id> [cpus] [memory]
# It makes the sandbox if it's new (default 6 CPUs and 12G, as machines.ts), and prints a link.
# Open it in a browser signed in to Claude, then paste the code it shows back here.
set -eu
id=${1:?usage: sign-in-claude.sh <team id> [cpus] [memory]}
cpus=${2:-6}
memory=${3:-12G}
case "$id" in *[!a-z0-9-]*) echo "not a team id: $id" >&2; exit 64 ;; esac
machine="inc-$id"
c=/usr/local/bin/container
# No machine starts without the walls (spec §5): the walls job keeps this marker under a minute old.
[ -n "$(find /var/run/i-inc-walls.ok -mmin -2 2>/dev/null)" ] || {
  echo "the walls aren't up (see tools/host), so no machine starts" >&2
  exit 1
}

if ! $c machine inspect "$machine" >/dev/null 2>&1; then
  $c machine create --name "$machine" --cpus "$cpus" --memory "$memory" --home-mount none local/i-inc-employee:latest
fi
# A new machine's first boot fails now and then (images/employee/README.md); the next one works.
for attempt in 1 2 3; do
  $c machine run -n "$machine" -- true </dev/null && break
  [ "$attempt" -lt 3 ] || exit 1
done
$c machine run -it -u employee -n "$machine" -- claude auth login --claudeai
$c machine run -u employee -n "$machine" -- claude auth status </dev/null | grep -E '"loggedIn"|"authMethod"'
