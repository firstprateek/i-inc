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
