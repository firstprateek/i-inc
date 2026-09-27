#!/bin/bash
# M1 step 6 (docs/m1-runbook.md): assemble the resume brief for the second engine, from what the
# first one left in the machine: the ticket, the plan, the progress notes, `git log`, and the last
# error. Run it on the host:
#   bash tools/m1/step6/brief.sh [machine] > /tmp/m1/build-prompt.md
set -euo pipefail

machine=${1:-m1-test}
here=$(dirname "$0")
inside() { /usr/local/bin/container machine run -i -n "$machine" -- bash -l -s; }

cat <<'INTRO'
You are a Senior Engineer at i.inc, continuing a ticket on the owner's project Duet. Another
engineer did the Plan stage in an earlier session, which has ended: all you have is this brief and
the files it names. You work inside your own Linux machine, where you can run anything.

INTRO
cat "$here/ticket-1.md"
echo
echo "## Resume brief"
echo
echo "### The plan (~/work/inc-1/plan.md)"
echo 'cat ~/work/inc-1/plan.md' | inside
echo
echo "### Progress notes (~/work/inc-1/notes.md)"
echo 'cat ~/work/inc-1/notes.md' | inside
echo
echo "### git log and status on the branch (~/work/duet)"
echo '```'
echo 'cd ~/work/duet && git branch --show-current && git log --oneline -5 && git status --short' | inside
echo '```'
echo
echo "### Last error"
echo "None."
echo
cat "$here/build-steps.md"
