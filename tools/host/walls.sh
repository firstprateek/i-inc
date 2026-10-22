#!/bin/sh
# Keeps the machines' walls up (spec §5). launchd runs it as root at boot, every minute after, and
# at once when the daemon changes its list of home machines (inc.i.walls.plist). It loads the rules
# from tools/m1/pf into their anchor, keeps pf on with a reference of its own, and touches
# /var/run/i-inc-walls.ok for the daemon, which runs nothing in a machine unless the marker is under
# two minutes old. If any of that fails, the marker goes, so the daemon fails closed, and stops the
# machines it has running.
#
# Home machines (a personal assistant's sandbox, spec §7) have no internet. Apple container 1.4.1
# puts all machines on one network, so the rules (i-inc-machines.pf) name them by address, in the
# table <home_machines>. The daemon, which knows each machine's address (`container machine ls`),
# writes the addresses to /var/run/i-inc/home-machines, a directory the owner can write. This job,
# which is root, reads only lines that are plain addresses of the machines' subnet, writes them to
# /var/run/i-inc-home-machines.table (root's), and loads the rules, so the table and the rules
# arrive together. It then reads the table back from pf and writes it to /var/run/i-inc-walls.home,
# which the daemon reads: it runs nothing in a home machine whose address isn't in that file, and
# stops one that has been missing from it. A file the owner writes can only add addresses to a table
# of blocked ones, so a bad line can't open anything.
set -u
run=${I_INC_WALLS_RUN:-/var/run}
lib=${I_INC_WALLS_LIB:-/usr/local/lib/i-inc}
anchor="com.apple/010.i-inc-machines"
rules=${I_INC_WALLS_RULES:-$lib/i-inc-machines.pf}
token_file=$run/i-inc-pf.token
ok=$run/i-inc-walls.ok
home_dir=$run/i-inc
declared=$home_dir/home-machines
table=$run/i-inc-home-machines.table
ack=$run/i-inc-walls.home
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
down() {
  rm -f "$ok" "$ack"
  echo "$(now) walls down: $*"
  exit 1
}

# The home machines' addresses the daemon declared, checked line by line. A line that isn't exactly
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
if [ -L "$home_dir" ]; then
  down "$home_dir is a symbolic link"
fi
mkdir -p "$home_dir" 2>/dev/null || down "can't make $home_dir"
if [ "$(id -u)" = 0 ]; then
  owner=$(cat "$lib/owner" 2>/dev/null || true)
  case "$owner" in
    "" | *[!a-z0-9_-]* | -*) owner="" ;;
  esac
  if [ -n "$owner" ] && id "$owner" >/dev/null 2>&1; then
    chown "$owner" "$home_dir" && chmod 755 "$home_dir"
  else
    chown root "$home_dir"
    chmod 755 "$home_dir"
    echo "$(now) no owner in $lib/owner: the daemon can't declare home machines, so none will run"
  fi
fi

addresses=$(declared_addresses)
tmp_table="$table.new"
printf '%s' "$addresses" | sed '/^$/d' >"$tmp_table" || down "can't write the home machines' table"
chmod 644 "$tmp_table"
mv -f "$tmp_table" "$table" || down "can't write the home machines' table"

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
# The rules for home machines (an older rules file, loaded by hand, lacks them).
printf '%s\n' "$anchor_rules" | grep -q "from <home_machines> to any" ||
  down "the anchor has no rule for home machines"
# What pf holds must be what was declared: the table is read back, not assumed.
loaded=$(pfctl -a "$anchor" -t home_machines -T show 2>/dev/null | tr -d ' \t' | sed '/^$/d' | sort -u) ||
  down "can't read the home machines' table"
[ "$loaded" = "$(printf '%s' "$addresses" | sed '/^$/d')" ] ||
  down "the home machines' table in pf differs from the declared list"
# The rules name bridge100 and 192.168.64.0/24. If vmnet ever puts the machines' gateway on another
# interface, they'd match nothing, so that counts as down too.
gw_if=$(ifconfig | awk '/^[a-z0-9]+:/ { i = $1; sub(":", "", i) } /inet 192\.168\.64\.1 / { print i }')
[ -z "$gw_if" ] || [ "$gw_if" = bridge100 ] || down "the machines' gateway is on $gw_if, not bridge100"
# The acknowledgement for the daemon: the addresses pf is walling off as home machines, rewritten
# every run so its age says the job is alive.
printf '%s' "$loaded" | sed '/^$/d' >"$ack.new" && chmod 644 "$ack.new" && mv -f "$ack.new" "$ack" ||
  down "can't write $ack"
[ -f "$ok" ] || echo "$(now) walls up"
touch "$ok"
