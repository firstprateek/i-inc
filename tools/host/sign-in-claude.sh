#!/bin/sh
# Signs an employee's machine in to Claude with the owner's subscription, once, at hiring (spec §5).
# Run it on the mini, in a terminal, before hiring the employee:
#   sh ~/i-inc/tools/host/sign-in-claude.sh <employee id>
# It makes the machine if it's new, with the daemon's settings (machines.ts), and prints a link.
# Open it in a browser signed in to Claude, then paste the code it shows back here.
set -eu
id=${1:?usage: sign-in-claude.sh <employee id>}
case "$id" in *[!a-z0-9-]*) echo "not an employee id: $id" >&2; exit 64 ;; esac
machine="inc-$id"
c=/usr/local/bin/container

if ! $c machine inspect "$machine" >/dev/null 2>&1; then
  $c machine create --name "$machine" --cpus 4 --memory 6G --home-mount none local/i-inc-employee:latest
fi
# A new machine's first boot fails now and then (images/employee/README.md); the next one works.
for attempt in 1 2 3; do
  $c machine run -n "$machine" -- true </dev/null && break
  [ "$attempt" -lt 3 ] || exit 1
done
$c machine run -it -u employee -n "$machine" -- claude auth login --claudeai
$c machine run -u employee -n "$machine" -- claude auth status </dev/null | grep -E '"loggedIn"|"authMethod"'
