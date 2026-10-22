#!/bin/sh
# Keeps the machines' walls up (spec §5). launchd runs it as root at boot, every minute after, and
# at once when the daemon changes its list of open machines (inc.i.walls.plist). It loads the rules
# from tools/m1/pf into their anchor, keeps pf on with a reference of its own, and touches
# /var/run/i-inc-walls.ok for the daemon, which runs nothing in a machine unless the marker is under
# two minutes old. If any of that fails, the marker goes, so the daemon fails closed, and stops the
# machines it has running.
#
# Closed unless opened (i-inc-machines.pf). Apple container 1.4.1 puts all machines on one network,
# so the rules name the machines that may reach the internet, in the table <open_machines>, and
# every other address (a personal assistant's sandbox, a machine nobody declared) is shut in. The
# daemon, which knows each machine's address (`container machine ls`), writes the addresses of the
# running engineers' machines to /var/run/i-inc/open-machines, a folder the owner can write. This job,
# which is root, reads only lines that are plain addresses of the machines' subnet, writes them to
# /var/run/i-inc-open-machines.table (root's), and loads the rules, which read that file, so the table
# and the rules arrive together. It reads the table back from pf and writes it to
# /var/run/i-inc-walls.open, which the daemon reads: it runs nothing in a machine whose address
# isn't in that file, and stops a PA's sandbox whose address is. The first time this job runs with
# the new rules is when that file first exists; until then the daemon treats the walls as the old
# ones (engineers' machines as before, PA sandboxes refused).
# A bad line in the owner's file can only open an address in the machines' subnet, and the daemon
# checks every address it launches into against what pf holds. An address that leaves the table has
# its connections killed (pfctl -k), since pf keeps the state of a connection a rule once passed.
set -u
run=${I_INC_WALLS_RUN:-/var/run}
lib=${I_INC_WALLS_LIB:-/usr/local/lib/i-inc}
anchor="com.apple/010.i-inc-machines"
rules=${I_INC_WALLS_RULES:-$lib/i-inc-machines.pf}
token_file=$run/i-inc-pf.token
ok=$run/i-inc-walls.ok
decl_dir=$run/i-inc
declared=$decl_dir/open-machines
table=$run/i-inc-open-machines.table
ack=$run/i-inc-walls.open
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
down() {
  rm -f "$ok" "$ack"
  echo "$(now) walls down: $*"
  exit 1
}

# The open machines' addresses the daemon declared, checked line by line. A line that isn't exactly
# an address of 192.168.64.0/24 (not the network's, the gateway's or the broadcast address) is dropped.
declared_addresses() {
  [ -f "$declared" ] && [ ! -L "$declared" ] || return 0
  head -n 64 "$declared" | cut -c1-20 | awk '
    /^192\.168\.64\.([2-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$/ { print; next }
    { bad++ }
    END { if (bad) print bad " line(s) in the declared list were not machine addresses and were ignored" > "/dev/stderr" }
  ' | sort -u
}

# The folder the daemon writes its list in: the owner's, recreated here because /var/run is cleared
# at boot. The owner is the account that ran install-walls.sh with sudo.
if [ -L "$decl_dir" ]; then
  down "$decl_dir is a symbolic link"
fi
mkdir -p "$decl_dir" 2>/dev/null || down "can't make $decl_dir"
if [ "$(id -u)" = 0 ]; then
  owner=$(cat "$lib/owner" 2>/dev/null || true)
  case "$owner" in
    "" | *[!A-Za-z0-9._-]* | -*) owner="" ;;
  esac
  if [ -n "$owner" ] && id "$owner" >/dev/null 2>&1; then
    chown "$owner" "$decl_dir" && chmod 755 "$decl_dir"
  else
    chown root "$decl_dir"
    chmod 755 "$decl_dir"
    echo "$(now) no owner in $lib/owner: the daemon can't declare machines, so none gets the internet"
  fi
fi

addresses=$(declared_addresses)
# What was open before, for the addresses that have just left it.
previous=""
[ ! -f "$table" ] || [ -L "$table" ] || previous=$(sed '/^$/d' "$table" | sort -u)
tmp_table="$table.new"
printf '%s' "$addresses" | sed '/^$/d' >"$tmp_table" || down "can't write the open machines' table"
chmod 644 "$tmp_table"
mv -f "$tmp_table" "$table" || down "can't write the open machines' table"

# Reloading swaps the anchor's rules (and the table) at once and keeps existing connections' state.
out=$(pfctl -a "$anchor" -f "$rules" 2>&1) || down "the rules didn't load: $out"
# Our own reference keeps pf on even if another service releases its own. A token left from before
# a reboot means nothing, so pf being off always gets a fresh one.
if [ ! -s "$token_file" ] || ! pfctl -s info 2>/dev/null | grep -q "Status: Enabled"; then
  pfctl -E 2>&1 | awk '/^Token/ {print $3}' >"$token_file"
fi
ifconfig pflog0 >/dev/null 2>&1 || ifconfig pflog0 create

pfctl -s info 2>/dev/null | grep -q "Status: Enabled" || down "pf is off"
anchor_rules=$(pfctl -a "$anchor" -s rules 2>/dev/null)
printf '%s\n' "$anchor_rules" | grep -q "block return in" || down "the anchor is empty"
# The rule that lets machines out only if they are in the table (an older rules file, loaded by
# hand, lets every machine out).
printf '%s\n' "$anchor_rules" | grep -q "from <open_machines> to any" ||
  down "the anchor has no rule for the open machines"
# What pf holds must be what was declared: the table is read back, not assumed.
loaded=$(pfctl -a "$anchor" -t open_machines -T show 2>/dev/null | tr -d ' \t' | sed '/^$/d' | sort -u) ||
  down "can't read the open machines' table"
[ "$loaded" = "$(printf '%s' "$addresses" | sed '/^$/d')" ] ||
  down "the open machines' table in pf differs from the declared list"
# A machine that has left the table (stopped, or its address now belongs to a PA's sandbox) keeps no
# connection that was passed while it was in.
for ip in $previous; do
  printf '%s\n' "$loaded" | grep -qx "$ip" && continue
  pfctl -k "$ip" >/dev/null 2>&1
  pfctl -k 0.0.0.0/0 -k "$ip" >/dev/null 2>&1
  echo "$(now) $ip is no longer open: its connections are killed"
done
# The rules name bridge100 and 192.168.64.0/24. If vmnet ever puts the machines' gateway on another
# interface, they'd match nothing, so that counts as down too.
gw_if=$(ifconfig | awk '/^[a-z0-9]+:/ { i = $1; sub(":", "", i) } /inet 192\.168\.64\.1 / { print i }')
[ -z "$gw_if" ] || [ "$gw_if" = bridge100 ] || down "the machines' gateway is on $gw_if, not bridge100"
# The acknowledgement for the daemon: the addresses pf lets out, rewritten
# every run so its age says the job is alive.
printf '%s' "$loaded" | sed '/^$/d' >"$ack.new" && chmod 644 "$ack.new" && mv -f "$ack.new" "$ack" ||
  down "can't write $ack"
[ -f "$ok" ] || echo "$(now) walls up"
touch "$ok"
