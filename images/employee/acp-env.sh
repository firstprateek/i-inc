# Sourced by the acp-* launchers. The daemon starts a session's ACP server with
#   container machine run -i -u employee -n inc-<employee> -e I_INC_CWD … -- acp-<harness>
# so the server starts in the session's folder, which is made here if it's new.
export PATH="$HOME/.local/bin:$PATH"
# Claude Code stays the version Claude's adapter carries.
export DISABLE_AUTOUPDATER=1
if [ -z "${I_INC_CWD:-}" ]; then
  echo "I_INC_CWD isn't set: the daemon passes the session's folder in it" >&2
  exit 64
fi
mkdir -p "$I_INC_CWD" && cd "$I_INC_CWD" || exit 1

# Leave a note of who this agent is, so a daemon that comes back after a crash or a deploy can find
# an agent the old one left running, and stop it (apps/daemon/src/reaper.ts). The launcher `exec`s
# the agent, so this shell's pid becomes the agent's. The file is named for the launch's token, and
# holds `pid|start time|folder`: the pid, the process's start time (a pid alone could be someone else's by then) and the folder.
if [ -n "${I_INC_AGENT:-}" ]; then
  case "$I_INC_AGENT" in *[!0-9a-f]*) ;; *)
    if [ -r "/proc/$$/stat" ]; then
      started=$(sed 's/^.*) //' "/proc/$$/stat" | cut -d' ' -f20)
    else
      started=$(ps -o lstart= -p "$$" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//')
    fi
    mkdir -p "$HOME/.inc-agents" &&
      printf '%s|%s|%s\n' "$$" "$started" "$I_INC_CWD" > "$HOME/.inc-agents/$I_INC_AGENT.pid" || true
    unset started
  ;; esac
fi
