#!/bin/sh
# Installs the automatic deployer (docs/design/v1-plan.md section 5): a second LaunchAgent,
# inc.i.deployer, that deploys every green commit on main to the daemon, with a smoke test, a drain,
# a health check and a rollback. Everything runs as the owner, on the mini, with no root.
#
#   sh tools/host/install-deployer.sh                    print what it would do, change nothing
#   sh tools/host/install-deployer.sh --dry-run          the same
#   sh tools/host/install-deployer.sh --apply            do it
#   sh tools/host/install-deployer.sh --rollback-install put the old daemon plist back, remove the deployer
#
# Run it from the checkout the daemon runs from now (~/i-inc), after `git pull` there has brought in
# apps/deployer. --apply:
#   1. creates ~/i-inc-releases and seeds it with this checkout's HEAD as the first release (cloned,
#      installed and built there) and the link ~/i-inc-releases/current;
#   2. saves ~/Library/LaunchAgents/inc.i.daemon.plist as inc.i.daemon.plist.pre-deployer, then points
#      the daemon at ~/i-inc-releases/current, keeping its environment as it is;
#   3. restarts the daemon and waits for GET /api/health to report the seeded sha; if it does not,
#      puts the old plist back and stops;
#   4. installs and loads inc.i.deployer, which runs from this checkout.
# It is idempotent: run it again and it only repairs what is missing.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# launchd_reload: bootout, wait until launchd has dropped the service, then bootstrap (see launchd.sh).
# shellcheck source=/dev/null
. "$here/launchd.sh"
home=${HOME:?HOME is not set}
releases="$home/i-inc-releases"
agents="$home/Library/LaunchAgents"
dplist="$agents/inc.i.daemon.plist"
backup="$dplist.pre-deployer"
eplist="$agents/inc.i.deployer.plist"
log="$home/Library/Logs/i-inc-deployer.log"
port=${PORT:-7420}

dry=1
action=install
nochange=0
for arg in "$@"; do
  case "$arg" in
    --apply) dry=0 ;;
    --dry-run) nochange=1 ;;
    --rollback-install) action=rollback; dry=0 ;;
    -h | --help)
      sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done
[ "$nochange" = 0 ] || dry=1

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
# Prints a command, and runs it only with --apply.
run() {
  say "    \$ $*"
  [ "$dry" = 1 ] || "$@"
}

[ "$(id -u)" != 0 ] || fail "run it as the owner, not root"
uid=$(id -u)
bun=$(command -v bun || echo /opt/homebrew/bin/bun)
[ -x "$bun" ] || fail "no bun: brew install bun"

if [ "$dry" = 1 ]; then
  say "DRY RUN: nothing is changed. Add --apply to do this."
fi
say "checkout:  $repo"
say "releases:  $releases"
say "daemon:    $dplist"
say "deployer:  $eplist"
say "log:       $log"

wait_for_version() {
  want=$1
  tries=0
  while [ "$tries" -lt 45 ]; do
    got=$(curl -sf --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null |
      sed -n 's/.*"version" *: *"\([0-9a-f]*\)".*/\1/p') || got=""
    [ "$got" = "$want" ] && return 0
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

# Reloads a LaunchAgent: bootout, wait for launchd to drop it, bootstrap with retries. $3, when given,
# is the plist to put back (and load) if the new one cannot be loaded, so a running service is never
# left down. Fails then.
reload() {
  label=$1
  plist=$2
  previous=${3:-}
  if [ "$dry" = 1 ]; then
    say "    \$ launchctl bootout gui/$uid/$label"
    say "      (waits up to about 10 s until launchctl print says it is gone)"
    say "    \$ launchctl bootstrap gui/$uid $plist"
    say "      (tries again on error 5${previous:+, and puts $previous back if it still fails})"
    return 0
  fi
  launchd_reload "gui/$uid" "$label" "$plist" "$previous"
}

if [ "$action" = rollback ]; then
  say "==> putting the old daemon plist back and removing the deployer"
  [ -f "$backup" ] || fail "no $backup: nothing to restore"
  head_now=$(git -C "$repo" rev-parse HEAD)
  run launchctl bootout "gui/$uid/inc.i.deployer" 2>/dev/null || true
  run rm -f "$eplist"
  run cp "$backup" "$dplist"
  reload inc.i.daemon "$dplist" || fail "the old daemon plist would not load: see above"
  if [ "$dry" = 1 ]; then
    say "    then wait for GET /api/health to report $(printf %s "$head_now" | cut -c1-7)"
    exit 0
  fi
  if wait_for_version "$head_now"; then
    say "the daemon runs from $repo again (version $(printf %s "$head_now" | cut -c1-7))."
  else
    say "WARNING: the daemon did not report version $head_now on /api/health after the restore."
    say "See $home/Library/Logs/i-inc-daemon.log, and check $dplist."
    exit 1
  fi
  say "$releases is left in place: delete it with rm -rf when you no longer want it."
  exit 0
fi

# 0. Checks.
command -v git >/dev/null 2>&1 || fail "no git"
command -v pnpm >/dev/null 2>&1 || fail "no pnpm on PATH (the deployer installs and builds each release with it)"
command -v node >/dev/null 2>&1 || fail "no node on PATH (pnpm needs it)"
[ -f "$dplist" ] || fail "no $dplist: run tools/host/install-daemon.sh first"
[ -f "$repo/apps/deployer/src/main.ts" ] || fail "this checkout has no apps/deployer: git pull first"
head=$(git -C "$repo" rev-parse HEAD)

# 1. The releases folder, seeded with this checkout's HEAD.
say "==> 1. releases folder, seeded with $(printf %s "$head" | cut -c1-7)"
run mkdir -p "$releases" "$home/Library/Logs" "$agents"
if [ -L "$releases/current" ]; then
  say "    current already points at $(readlink "$releases/current"): nothing to seed"
else
  run env "I_INC_CHECKOUT=$repo" "I_INC_RELEASES=$releases" "$bun" "$repo/apps/deployer/src/main.ts" --seed
fi

# 2. Point the daemon at current, keeping everything else in its plist.
say "==> 2. daemon plist: point it at $releases/current (environment untouched)"
if [ ! -e "$backup" ]; then
  run cp "$dplist" "$backup"
else
  say "    $backup already exists: keeping it"
fi
new=$(mktemp)
trap 'rm -f "$new"' EXIT HUP INT TERM
# An exact edit: only a <string> that is the checkout path itself, or starts with "<checkout>/", is
# rewritten. (A bare prefix match would also hit ~/i-inc-releases, which starts with ~/i-inc.)
esc_repo=$(printf '%s' "$repo" | sed 's/[][\.*^$#]/\\&/g')
esc_rel=$(printf '%s' "$releases/current" | sed 's/[\&#]/\\&/g')
sed -e "s#<string>$esc_repo</string>#<string>$esc_rel</string>#g" \
  -e "s#<string>$esc_repo/#<string>$esc_rel/#g" "$dplist" >"$new"
if cmp -s "$dplist" "$new"; then
  say "    already points at $releases/current"
  changed=0
else
  say "    changes:"
  diff -u "$dplist" "$new" | sed 's/^/      /' || true
  changed=1
  if [ "$dry" = 1 ]; then
    say "    \$ write the edited plist shown above to $dplist"
  else
    cp "$new" "$dplist"
  fi
fi

# 3. Restart the daemon on it, and check it is the release we seeded.
say "==> 3. restart the daemon from the release and check GET /api/health reports $(printf %s "$head" | cut -c1-7)"
if [ "$changed" = 1 ] || [ "$dry" = 1 ]; then
  # If the new plist won't load, the old one is put back and loaded: the daemon is never left down.
  reload inc.i.daemon "$dplist" "$backup" || fail "the daemon would not load from the release: the old plist was put back. See $home/Library/Logs/i-inc-daemon.log"
  if [ "$dry" = 0 ]; then
    want=$(basename "$(readlink "$releases/current")")
    if wait_for_version "$want"; then
      say "    the daemon runs release $(printf %s "$want" | cut -c1-7)"
    else
      say "    the daemon did not report version $want: restoring the old plist"
      cp "$backup" "$dplist"
      reload inc.i.daemon "$dplist" || true
      fail "nothing was installed. See $home/Library/Logs/i-inc-daemon.log"
    fi
  fi
else
  say "    unchanged, not restarting"
fi

# 4. The deployer itself.
say "==> 4. the deployer LaunchAgent"
path=$(printf '%s:%s:%s:%s' "$(dirname "$bun")" "$(dirname "$(command -v pnpm)")" "$(dirname "$(command -v node)")" \
  /usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin | tr ':' '\n' | awk '!seen[$0]++' | paste -sd: -)
if [ "$dry" = 1 ]; then
  say "    would write $eplist from tools/host/inc.i.deployer.plist with:"
  say "      BUN=$bun REPO=$repo RELEASES=$releases LOG=$log"
  say "      PATH=$path"
else
  oldep=$(mktemp)
  trap 'rm -f "$new" "$oldep"' EXIT HUP INT TERM
  [ ! -f "$eplist" ] || cp "$eplist" "$oldep"
  sed -e "s#@BUN@#$bun#g" -e "s#@REPO@#$repo#g" -e "s#@RELEASES@#$releases#g" -e "s#@LOG@#$log#g" \
    -e "s#@PATH@#$path#g" "$here/inc.i.deployer.plist" >"$eplist"
fi
reload inc.i.deployer "$eplist" "${oldep:-}" || fail "the deployer would not load: see above"

say "==> done"
say "    NOTE: re-running tools/host/install-daemon.sh from a checkout older than this change resets the"
say "    daemon plist to $repo. If that happens, run this script again."
say "    watch it:   tail -f $log"
say "    deploys:    tail -n 5 $home/.i-inc/deploys.jsonl   (and My desk, under Releases)"
say "    pause it:   launchctl bootout gui/$uid/inc.i.deployer"
say "    undo it:    sh $repo/tools/host/install-deployer.sh --rollback-install"
