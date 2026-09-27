#!/bin/bash
# M1 step 5 (docs/m1-runbook.md): one launcher per agent in /usr/local/bin, so the host can start
# an agent's ACP server with a single word: `container machine run -i -n m1-test -- acp-claude`.
# (`machine run` re-splits quoted arguments and doesn't put ~/.local/bin on the PATH.)
# Run it in the machine: container machine run -i -n m1-test -- bash -s < tools/m1/acp-launchers.sh
set -euo pipefail

launcher() { # launcher <name> <command...>
  local name=$1
  shift
  printf '#!/bin/sh\n# ACP server for i.inc (M1). Works in /tmp/acp-probe unless told otherwise.\nexport PATH="$HOME/.local/bin:$PATH"\nmkdir -p /tmp/acp-probe\nexec %s "$@"\n' "$*" |
    sudo tee "/usr/local/bin/$name" >/dev/null
  sudo chmod 755 "/usr/local/bin/$name"
  echo "/usr/local/bin/$name: $*"
}

launcher acp-claude claude-agent-acp
# The ACP registry starts Antigravity's server with an empty --uid.
launcher acp-antigravity '"$HOME/.local/share/agy-acp-server/agy_acp_server.par" --uid='
launcher acp-opencode opencode acp
