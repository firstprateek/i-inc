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

# ripgrep (`rg`) for a machine made before the image had it: a Linux arm64 binary that tools/host/fetch-rg.sh
# downloaded on the host (RG_BIN overrides where it is). It is copied only where `rg` is missing, so a
# machine from a rebuilt image keeps its own. No rebuild and no recreate: the machine is not even restarted.
rg_bin=${RG_BIN:-$HOME/.cache/i-inc/rg}

# As root with `-u root`, not as the employee with sudo: a personal assistant's sandbox has its user's sudo
# taken away (apps/daemon/src/machines.ts), and this works the same in every machine.
# Through cat: `machine run -i` takes a pipe, but not every kind of stdin (images/employee/README.md).
put() { # put <file> <path in the machine> <mode>
  cat "$1" | $c machine run -i -u root -n "$machine" -- tee "$2" >/dev/null
  $c machine run -u root -n "$machine" -- chmod "$3" "$2" </dev/null
  echo "$machine: $2"
}
put "$img/acp-env.sh" /usr/local/lib/i-inc/acp-env.sh 644
for f in "$img"/launchers/acp-*; do put "$f" "/usr/local/bin/$(basename "$f")" 755; done
$c machine run -u employee -n "$machine" -- mkdir -p /home/employee/.claude </dev/null
cat "$img/claude-settings.json" | $c machine run -i -u employee -n "$machine" -- tee /home/employee/.claude/settings.json >/dev/null
echo "$machine: /home/employee/.claude/settings.json"
# OpenCode's config (the local models and their context window, T71).
$c machine run -u employee -n "$machine" -- mkdir -p /home/employee/.config/opencode </dev/null
cat "$img/opencode.json" | $c machine run -i -u employee -n "$machine" -- tee /home/employee/.config/opencode/opencode.json >/dev/null
echo "$machine: /home/employee/.config/opencode/opencode.json"
if $c machine run -u employee -n "$machine" -- sh -c 'command -v rg >/dev/null 2>&1' </dev/null; then
  echo "$machine: rg is already there"
elif [ -x "$rg_bin" ]; then
  put "$rg_bin" /usr/local/bin/rg 755
else
  echo "$machine: no rg here, and no $rg_bin to copy: run tools/host/fetch-rg.sh first" >&2
fi
