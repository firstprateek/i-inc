#!/bin/sh
# Isolated shell regression tests for Codex host helpers. The fake container only records argv.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/bin"
touch "$tmp/walls"
cat >"$tmp/bin/container" <<'FAKE'
#!/bin/sh
printf '<%s>' "$@" >>"$I_INC_TEST_LOG"
printf '\n' >>"$I_INC_TEST_LOG"
if [ "$1" = machine ] && [ "$2" = inspect ]; then
  [ "${I_INC_TEST_MACHINE_EXISTS:-true}" = true ]
  exit $?
fi
case " $* " in
  *" sudo tee "*) cat >/dev/null ;;
  *"/home/employee/.local/bin/codex login status "*) printf '%s\n' "${I_INC_TEST_LOGIN_STATUS:-Not logged in}" ;;
  *" codex-acp --version "*) echo '@agentclientprotocol/codex-acp 2.2.2' ;;
  *" codex --version "*) echo 'codex-cli 0.160.1' ;;
esac
FAKE
chmod +x "$tmp/bin/container"
export I_INC_CONTAINER="$tmp/bin/container"
export I_INC_WALLS_MARKER="$tmp/walls"
export I_INC_TEST_LOG="$tmp/calls"

sh "$root/tools/host/provision-codex.sh" demo-team >/dev/null
grep -Fq 'ARG CODEX_ACP_VERSION=2.2.2' "$root/images/employee/Dockerfile" || {
  echo "image adapter pin does not match the provision helper" >&2; exit 1;
}
grep -Fq 'ARG CODEX_CLI_VERSION=0.160.1' "$root/images/employee/Dockerfile" || {
  echo "image CLI pin does not match the provision helper" >&2; exit 1;
}
grep -Fq '<machine><run><-u><employee><-n><inc-demo-team>' "$tmp/calls" || {
  echo "provision did not target the selected sandbox" >&2; exit 1;
}
if grep -Fq '<-n><inc-other-team>' "$tmp/calls"; then
  echo "provision reached another machine" >&2; exit 1
fi
grep -Fq '@agentclientprotocol/codex-acp@2.2.2' "$tmp/calls" || {
  echo "provision did not pin the ACP adapter" >&2; exit 1;
}
grep -Fq '@openai/codex@0.160.1' "$tmp/calls" || {
  echo "provision did not pin the matching Codex CLI" >&2; exit 1;
}

: >"$tmp/calls"
if sh "$root/tools/host/provision-codex.sh" 'bad;name' >/dev/null 2>&1; then
  echo "invalid team id was accepted" >&2; exit 1
fi
[ ! -s "$tmp/calls" ] || { echo "invalid id reached the container" >&2; exit 1; }

rm "$tmp/walls"
if sh "$root/tools/host/codex-status.sh" demo-team >/dev/null 2>&1; then
  echo "missing walls marker was accepted" >&2; exit 1
fi
[ ! -s "$tmp/calls" ] || { echo "missing walls marker reached the container" >&2; exit 1; }
touch "$tmp/walls"
touch -t 200001010000 "$tmp/walls"
if sh "$root/tools/host/provision-codex.sh" demo-team >/dev/null 2>&1; then
  echo "stale walls marker was accepted" >&2; exit 1
fi
[ ! -s "$tmp/calls" ] || { echo "stale walls marker reached the container" >&2; exit 1; }
touch "$tmp/walls"

export I_INC_TEST_MACHINE_EXISTS=false
if sh "$root/tools/host/sign-in-codex.sh" demo-team >/dev/null 2>&1; then
  echo "sign-in accepted a missing machine" >&2; exit 1
fi
export I_INC_TEST_MACHINE_EXISTS=true

export I_INC_TEST_LOGIN_STATUS='Logged in using ChatGPT'
status=$(sh "$root/tools/host/codex-status.sh" demo-team)
[ "$status" = true ] || { echo "signed-in Codex status was not boolean true" >&2; exit 1; }
grep -Fxq '<machine><run><-u><employee><-n><inc-demo-team><--></home/employee/.local/bin/codex><login><status>' "$tmp/calls" || {
  echo "status did not invoke the pinned Codex CLI with exact argv" >&2; exit 1;
}
export I_INC_TEST_LOGIN_STATUS='Not logged in'
status=$(sh "$root/tools/host/codex-status.sh" demo-team)
[ "$status" = false ] || { echo "signed-out Codex status was not boolean false" >&2; exit 1; }

: >"$tmp/calls"
sh "$root/tools/host/sign-in-codex.sh" demo-team >/dev/null
grep -Fxq '<machine><run><-it><-u><employee><-n><inc-demo-team><--></home/employee/.local/bin/codex><login><--device-auth>' "$tmp/calls" || {
  echo "sign-in did not invoke the pinned Codex CLI with exact argv" >&2; exit 1;
}

echo "Codex host helper regressions passed"
