#!/bin/sh
# Tests for tools/host/launchd.sh against the fake launchctl in test-fakes/: the bootout-then-bootstrap
# race, retries on error 5, and putting the previous plist back so a service is never left down.
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/bin"
cp "$root/tools/host/test-fakes/launchctl" "$tmp/bin/launchctl"
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/sleep"
chmod +x "$tmp/bin/sleep"
PATH="$tmp/bin:$PATH"
export FAKE_LAUNCHCTL_DIR="$tmp/state" FAKE_LAUNCHCTL_LOG="$tmp/calls"
. "$root/tools/host/launchd.sh"

fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
reset() { rm -rf "$tmp/state" "$tmp/calls" "$tmp/fail-count"; unset FAKE_UNLOAD_POLLS FAKE_BOOTSTRAP_FAIL; : >"$tmp/calls"; }
loaded() { [ -f "$tmp/state/loaded/$1" ]; }
loaded_is() { cmp -s "$tmp/state/loaded/$1" "$2"; }
count() { grep -c "$1" "$tmp/calls" || true; }

old="$tmp/old.plist"; new="$tmp/new.plist"; live="$tmp/svc.test.plist"; broken="$tmp/broken.plist"
echo "old" >"$old"; echo "new" >"$new"; echo "BROKEN" >"$broken"

# 1. A first install: nothing to boot out.
reset
cp "$new" "$live"
if launchd_reload gui/501 svc.test "$live" 2>/dev/null && loaded svc.test; then ok "first install loads"; else bad "first install loads"; fi

# 2. A reload where launchd takes several looks to drop the service: without the wait this is the
# error 5 the deployer's installer hit; with it, one bootstrap is enough.
reset
cp "$old" "$live"; launchctl bootstrap gui/501 "$live"
cp "$new" "$live"
export FAKE_UNLOAD_POLLS=4
: >"$tmp/calls"
if launchd_reload gui/501 svc.test "$live" 2>"$tmp/err" && loaded_is svc.test "$new"; then ok "waits until the service is gone"; else bad "waits until the service is gone"; fi
[ "$(count 'launchctl bootstrap')" = 1 ] && ok "bootstrapped once, after the wait" || bad "bootstrapped once, after the wait ($(count 'launchctl bootstrap'))"
[ "$(count 'launchctl print')" -ge 4 ] && ok "polled launchctl print" || bad "polled launchctl print"

# 3. A service that stays loaded longer than the wait: it warns, and the retries unload it.
reset
cp "$old" "$live"; launchctl bootstrap gui/501 "$live"
cp "$new" "$live"
export FAKE_UNLOAD_POLLS=30
if I_INC_LAUNCHD_WAIT=3 launchd_reload gui/501 svc.test "$live" 2>"$tmp/err"; then bad "gives up on a service that never goes"; else ok "does not claim success while the old one is loaded"; fi
grep -q "still loaded" "$tmp/err" && ok "says the service is still loaded" || bad "says the service is still loaded"

# 4. Error 5 on the first two bootstraps: retried.
reset
cp "$new" "$live"
export FAKE_BOOTSTRAP_FAIL=2
if launchd_reload gui/501 svc.test "$live" 2>"$tmp/err" && loaded svc.test; then ok "retries error 5"; else bad "retries error 5"; fi
[ "$(count 'launchctl bootstrap')" = 3 ] && ok "three bootstraps" || bad "three bootstraps ($(count 'launchctl bootstrap'))"

# 5. A plist that never loads: the previous one is put back and loaded, and the call still fails.
reset
cp "$old" "$live"; launchctl bootstrap gui/501 "$live"
cp "$old" "$tmp/previous.plist"
cp "$broken" "$live"
if launchd_reload gui/501 svc.test "$live" "$tmp/previous.plist" 2>"$tmp/err"; then bad "fails when the new plist won't load"; else ok "fails when the new plist won't load"; fi
loaded svc.test && loaded_is svc.test "$old" && ok "the old service is running again" || bad "the old service is running again"
cmp -s "$live" "$old" && ok "the old plist is back on disk" || bad "the old plist is back on disk"
grep -q "previous svc.test is loaded again" "$tmp/err" && ok "says so" || bad "says so"
[ "$(count 'launchctl bootstrap')" -le 12 ] && ok "bounded retries" || bad "bounded retries"

# 5b. launchd never drops the old service: say it is still running, not that it was loaded again.
reset
cp "$old" "$live"; launchctl bootstrap gui/501 "$live"
cp "$old" "$tmp/previous.plist"
cp "$new" "$live"
export FAKE_UNLOAD_POLLS=100
if I_INC_LAUNCHD_WAIT=2 I_INC_LAUNCHD_TRIES=2 launchd_reload gui/501 svc.test "$live" "$tmp/previous.plist" 2>"$tmp/err"; then bad "fails while the old one is stuck"; else ok "fails while the old one is stuck"; fi
grep -q "never unloaded and is still running" "$tmp/err" && ! grep -q "loaded again" "$tmp/err" && ok "says the old service is still running" || bad "says the old service is still running"
unset FAKE_UNLOAD_POLLS

# 6. Without a previous plist it fails and leaves the file alone.
reset
cp "$broken" "$live"
if launchd_reload gui/501 svc.test "$live" 2>/dev/null; then bad "fails with nothing to restore"; else ok "fails with nothing to restore"; fi
cmp -s "$live" "$broken" && ok "no restore without a previous plist" || bad "no restore without a previous plist"

# 7. Other errors are final: no pointless retries.
reset
cat >"$tmp/bin/launchctl-bad" <<'FAKE'
#!/bin/sh
echo "launchctl $*" >>"$FAKE_LAUNCHCTL_LOG"
case "$1" in bootstrap) echo "Bootstrap failed: 22: Invalid argument" >&2; exit 22 ;; print) exit 1 ;; *) exit 0 ;; esac
FAKE
chmod +x "$tmp/bin/launchctl-bad"
mv "$tmp/bin/launchctl" "$tmp/bin/launchctl-good"; cp "$tmp/bin/launchctl-bad" "$tmp/bin/launchctl"
if launchd_reload gui/501 svc.test "$live" 2>/dev/null; then bad "an invalid plist is an error"; else ok "an invalid plist is an error"; fi
[ "$(count 'launchctl bootstrap')" = 1 ] && ok "no retry on other errors" || bad "no retry on other errors"
mv "$tmp/bin/launchctl-good" "$tmp/bin/launchctl"

if [ "$fails" -gt 0 ]; then echo "$fails launchd test(s) failed" >&2; exit 1; fi
echo "launchd tests passed"
