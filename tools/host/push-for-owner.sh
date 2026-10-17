#!/bin/sh
# Pushes a ticket's reviewed work to main with the owner's own git sign-in, for the changes the bot
# isn't allowed to push: GitHub refuses the bot any change to .github/workflows (docs/github-app.md),
# which keeps the repo's secrets out of agents' reach. Run it on your Mac:
#   sh tools/host/push-for-owner.sh <mini> <team> <ticket id> <your clone of the repo>
# It pulls the ticket's commits out of the team's sandbox as a git bundle, shows them, and pushes
# them to main. Then OK the ticket on the board: the gates find the work on main and go on to CI.
set -eu
mini=${1:?usage: push-for-owner.sh <mini> <team> <ticket id> <clone>}
team=${2:?team}
ticket=${3:?ticket id}
clone=${4:?your clone of the repo}
case "$team$ticket" in *[!a-z0-9-]*) echo "not a team or ticket id" >&2; exit 64 ;; esac
bundle=$(mktemp)
trap 'rm -f "$bundle"' EXIT

ssh "$mini" "cat | /usr/local/bin/container machine run -i -u employee -n inc-$team -- bash -s" >"$bundle" <<SCRIPT
set -e
cd /home/employee/work/inc-$ticket
git fetch --quiet origin main
git rebase --quiet origin/main >&2
git bundle create - origin/main..HEAD
SCRIPT

cd "$clone"
git fetch --quiet origin main
git fetch --quiet "$bundle" HEAD
echo "These go to main:"
git log --oneline origin/main..FETCH_HEAD
git diff --stat origin/main FETCH_HEAD
printf "Push them? [y/N] "
read -r yes
[ "$yes" = y ] || { echo "not pushed"; exit 1; }
git push origin FETCH_HEAD:main
