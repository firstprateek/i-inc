#!/bin/sh
# Tests for tools/host/walls.sh (the home machines' table, its checks and its acknowledgement) with a
# fake pfctl and ifconfig. Nothing here touches pf: the paths are all inside a temp folder.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/bin"

cat >"$tmp/bin/pfctl" <<'FAKE'
#!/bin/sh
# Keeps what was loaded in $FAKE_PF, and answers what walls.sh asks.
mkdir -p "$FAKE_PF"
anchor="" ; mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    -a) anchor=$2; shift ;;
    -f) mode=load; file=$2; shift ;;
    -E) echo "Token : 4242"; exit 0 ;;
    -t) shift ;;
    -T) mode=table-$2; shift ;;
    -s) mode=show-$2; shift ;;
  esac
  shift
done
case "$mode" in
  load)
    [ -z "${FAKE_PF_FAIL_LOAD:-}" ] || { echo "$file:1: syntax error"; exit 1; }
    t=$(sed -n 's/^table <home_machines>.*file "\(.*\)".*/\1/p' "$file")
    [ -z "$t" ] || [ -f "$t" ] || { echo "cannot load \"$t\": No such file or directory"; exit 1; }
    cp "$file" "$FAKE_PF/rules"
    if [ -n "$t" ]; then cp "$t" "$FAKE_PF/table"; else : >"$FAKE_PF/table"; fi
    ;;
  show-info) [ -n "${FAKE_PF_OFF:-}" ] || echo "Status: Enabled for 0 days" ;;
  show-rules) grep -E '^(pass|block)' "$FAKE_PF/rules" ;;
  table-show)
    if [ -n "${FAKE_PF_TABLE:-}" ]; then printf '   %s\n' $FAKE_PF_TABLE; else sed 's/^/   /' "$FAKE_PF/table"; fi
    ;;
esac
FAKE
cat >"$tmp/bin/ifconfig" <<'FAKE'
#!/bin/sh
[ $# -eq 0 ] || exit 0
printf '%s: flags=8863<UP>\n\tinet 192.168.64.1 netmask 0xffffff00\n' "${FAKE_GW_IF:-bridge100}"
FAKE
chmod +x "$tmp/bin/pfctl" "$tmp/bin/ifconfig"
PATH="$tmp/bin:$PATH"

run="$tmp/run"; lib="$tmp/lib"
export FAKE_PF="$tmp/pf" I_INC_WALLS_RUN="$run" I_INC_WALLS_LIB="$lib" I_INC_WALLS_RULES="$tmp/rules.pf"
declared="$run/i-inc/home-machines"
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
fresh() {
  rm -rf "$run" "$lib" "$FAKE_PF"
  mkdir -p "$run" "$lib"
  unset FAKE_PF_FAIL_LOAD FAKE_PF_OFF FAKE_PF_TABLE FAKE_GW_IF
  sed "s#/var/run/i-inc-home-machines.table#$run/i-inc-home-machines.table#" "$root/tools/m1/pf/i-inc-machines.pf" >"$tmp/rules.pf"
}
walls() { sh "$root/tools/host/walls.sh" >"$tmp/out" 2>&1; }
declare_lines() { mkdir -p "$run/i-inc"; printf '%s\n' "$@" >"$declared"; }
same() { [ "$(cat "$1" 2>/dev/null)" = "$2" ]; }

fresh
walls && [ -f "$run/i-inc-walls.ok" ] && ok "up with nothing declared" || bad "up with nothing declared"
[ -f "$run/i-inc-walls.home" ] && [ ! -s "$run/i-inc-walls.home" ] && ok "empty acknowledgement" || bad "empty acknowledgement"

fresh
declare_lines 192.168.64.12 192.168.64.7 192.168.64.12
walls && ok "up with two machines declared" || bad "up with two machines declared"
same "$run/i-inc-home-machines.table" "$(printf '192.168.64.12\n192.168.64.7')" && ok "the table is sorted and unique" || bad "the table is sorted and unique"
same "$run/i-inc-walls.home" "$(printf '192.168.64.12\n192.168.64.7')" && ok "the acknowledgement is what pf holds" || bad "the acknowledgement is what pf holds"

fresh
declare_lines 192.168.64.1 192.168.64.0 192.168.64.255 192.168.64.256 192.168.64.010 10.0.0.5 192.168.65.4 \
  "192.168.64.9 extra" "192.168.64.9;reboot" '$(touch /tmp/x)' "" 192.168.64.20
walls && ok "up with junk declared" || bad "up with junk declared"
same "$run/i-inc-home-machines.table" "192.168.64.20" && ok "only a plain machine address is taken" || bad "only a plain machine address is taken ($(cat "$run/i-inc-home-machines.table"))"
grep -q "were not machine addresses" "$tmp/out" && ok "says it ignored lines" || bad "says it ignored lines"

fresh
mkdir -p "$run/i-inc"; printf '192.168.64.30\n' >"$tmp/elsewhere"; ln -s "$tmp/elsewhere" "$declared"
walls && same "$run/i-inc-home-machines.table" "" && ok "a symlink is not read" || bad "a symlink is not read"

fresh
mkdir -p "$tmp/other"; ln -s "$tmp/other" "$run/i-inc"
if walls; then bad "a symlinked folder drops the walls"; else ok "a symlinked folder drops the walls"; fi
[ ! -f "$run/i-inc-walls.ok" ] || bad "no marker when the folder is a symlink"

fresh
sed '/<home_machines>/d' "$root/tools/m1/pf/i-inc-machines.pf" | sed "s#/var/run/i-inc-home-machines.table#x#" >"$tmp/rules.pf"
walls || true
[ ! -f "$run/i-inc-walls.ok" ] && grep -q "no rule for home machines" "$tmp/out" && ok "rules without the home block drop the marker" || bad "rules without the home block drop the marker"

fresh
walls; [ -f "$run/i-inc-walls.ok" ] || bad "setup"
(export FAKE_PF_FAIL_LOAD=1; walls) || true
[ ! -f "$run/i-inc-walls.ok" ] && [ ! -f "$run/i-inc-walls.home" ] && ok "a failed load drops the marker and the acknowledgement" || bad "a failed load drops the marker and the acknowledgement"
walls && [ -f "$run/i-inc-walls.ok" ] && [ -f "$run/i-inc-walls.home" ] && ok "and the next good run restores them" || bad "and the next good run restores them"

fresh
declare_lines 192.168.64.5
(export FAKE_PF_TABLE="192.168.64.6"; walls) || true
[ ! -f "$run/i-inc-walls.ok" ] && grep -q "differs from the declared list" "$tmp/out" && ok "a table that isn't what was declared drops the marker" || bad "a table that isn't what was declared drops the marker"

fresh
(export FAKE_GW_IF=bridge101; walls) || true
[ ! -f "$run/i-inc-walls.ok" ] && ok "a gateway on another interface drops the marker" || bad "a gateway on another interface drops the marker"

fresh
(export FAKE_PF_OFF=1; walls) || true
[ ! -f "$run/i-inc-walls.ok" ] && ok "pf off drops the marker" || bad "pf off drops the marker"

# The table file in the real rules is the one walls.sh writes, and the subnet it accepts is the rules'.
grep -q 'file "/var/run/i-inc-home-machines.table"' "$root/tools/m1/pf/i-inc-machines.pf" && ok "the rules read the table walls.sh writes" || bad "the rules read the table walls.sh writes"
grep -q 'machines    = "192.168.64.0/24"' "$root/tools/m1/pf/i-inc-machines.pf" && grep -q '192\\.168\\.64\\\.' "$root/tools/host/walls.sh" && ok "walls.sh and the rules agree on the subnet" || bad "walls.sh and the rules agree on the subnet"

if [ "$fails" -gt 0 ]; then echo "$fails walls test(s) failed" >&2; exit 1; fi
echo "walls tests passed"
