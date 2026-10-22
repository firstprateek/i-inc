# Sourced by the install scripts in this folder (POSIX sh); it is not run by itself.
#
# `launchctl bootout` returns before launchd has finished dropping the service, so a `bootstrap`
# straight after it can fail with "Bootstrap failed: 5: Input/output error" and leave the service
# down (the deployer's installer did this to the daemon on the mini, 2026-10-21). launchd_reload
# waits until `launchctl print` says the service is gone, retries a bootstrap that fails that way,
# and, if it still fails and a previous plist was given, puts that back and bootstraps it, so a
# service that was running is not left down.
#
#   launchd_reload <domain> <label> <plist> [<previous plist>]
#     domain: gui/<uid> for a LaunchAgent, system for a LaunchDaemon.
#     Returns 0 when <plist> is loaded, 1 when it is not (the previous one may be, see the output).
#
# Tunables, for tests: I_INC_LAUNCHD_POLL (seconds between looks, default 0.5), I_INC_LAUNCHD_WAIT
# (looks to wait for the service to go, default 20, so about 10 s), I_INC_LAUNCHD_TRIES (bootstrap
# attempts, default 5) and I_INC_LAUNCHD_BACKOFF (seconds between attempts, default 1).

launchd_loaded() { launchctl print "$1/$2" >/dev/null 2>&1; }

# Waits for the service to be gone. Returns 1 if it is still loaded when the time is up.
launchd_wait_gone() {
  _n=0
  while launchd_loaded "$1" "$2"; do
    [ "$_n" -lt "${I_INC_LAUNCHD_WAIT:-20}" ] || return 1
    _n=$((_n + 1))
    sleep "${I_INC_LAUNCHD_POLL:-0.5}"
  done
}

# One bootstrap, tried again while launchd answers error 5 (Input/output error). Any other error
# is final: retrying a bad plist doesn't help.
launchd_bootstrap() {
  _tries=0
  while :; do
    _out=$(launchctl bootstrap "$1" "$3" 2>&1) && return 0
    _tries=$((_tries + 1))
    case "$_out" in
      *"Input/output error"* | *"Bootstrap failed: 5"*) ;;
      *) printf '%s\n' "$_out" >&2; return 1 ;;
    esac
    if [ "$_tries" -ge "${I_INC_LAUNCHD_TRIES:-5}" ]; then
      printf '%s\n' "$_out" >&2
      return 1
    fi
    echo "launchctl bootstrap $2 failed ($_out), attempt $_tries: unloading it and trying again" >&2
    launchctl bootout "$1/$2" >/dev/null 2>&1 || true
    launchd_wait_gone "$1" "$2" || true
    sleep "${I_INC_LAUNCHD_BACKOFF:-1}"
  done
}

launchd_reload() {
  _domain=$1
  _label=$2
  _plist=$3
  _previous=${4:-}
  launchctl bootout "$_domain/$_label" >/dev/null 2>&1 || true
  launchd_wait_gone "$_domain" "$_label" ||
    echo "warning: $_label is still loaded after waiting for launchd to drop it" >&2
  launchd_bootstrap "$_domain" "$_label" "$_plist" && return 0
  if [ -n "$_previous" ] && [ -s "$_previous" ]; then
    echo "could not load the new $_label: putting the previous plist back" >&2
    cp "$_previous" "$_plist"
    launchctl bootout "$_domain/$_label" >/dev/null 2>&1 || true
    launchd_wait_gone "$_domain" "$_label" || true
    if launchd_bootstrap "$_domain" "$_label" "$_plist"; then
      echo "the previous $_label is loaded again" >&2
    else
      echo "the previous $_label could not be loaded either: start it by hand with launchctl bootstrap $_domain $_plist" >&2
    fi
  fi
  return 1
}
