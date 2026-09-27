#!/bin/bash
# M1 step 1 (docs/m1-runbook.md): a read-only look at the host.
#
# Run it on the mini, or pipe it in from another Mac:
#   ssh <mini> 'bash -s' < tools/m1/host-check.sh
#
# It changes nothing. It prints no hostnames, account names, or LAN and tailnet addresses: a
# socket's address shows only as loopback, all interfaces, or <other>. Re-run it once machines
# exist, to compare memory, interfaces and listeners.

export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

section() { printf '\n== %s\n' "$1"; }

# Run a command for at most $1 seconds (macOS has no timeout(1)).
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }

# How many processes match a pattern.
count() { pgrep -f "$1" | wc -l | tr -d ' '; }

# Where a socket listens: loopback and "all interfaces" are shown, anything else is hidden.
scope() {
  local a=${1#[}
  a=${a%]}
  case "$a" in
    127.* | ::1 | localhost) echo "loopback" ;;
    '*' | 0.0.0.0 | ::) echo "all interfaces" ;;
    *) echo "<other>" ;;
  esac
}

section "Host"
echo "macOS:      $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
echo "model:      $(sysctl -n hw.model)"
echo "chip:       $(sysctl -n machdep.cpu.brand_string)"
echo "cores:      $(sysctl -n hw.physicalcpu) ($(sysctl -n hw.perflevel0.physicalcpu) performance," \
  "$(sysctl -n hw.perflevel1.physicalcpu) efficiency)"
echo "memory:     $(($(sysctl -n hw.memsize) / 1073741824)) GB"
df -k /System/Volumes/Data | awk 'NR == 2 {
  printf "disk:       %.0f GB free of %.0f GB (%.0f GiB free)\n", $4 * 1024 / 1e9, $2 * 1024 / 1e9, $4 / 1048576 }'
# "Memory used" as Activity Monitor counts it: app memory (anonymous minus purgeable), wired, compressed.
vm_stat | awk -v page="$(sysctl -n hw.pagesize)" '
  /^Anonymous pages/ { anon = $3 }
  /^Pages purgeable/ { purgeable = $3 }
  /^Pages wired down/ { wired = $4 }
  /^Pages occupied by compressor/ { compressed = $5 }
  END {
    gb = page / 1073741824
    printf "in use:     %.1f GB (apps %.1f, wired %.1f, compressed %.1f)\n",
      (anon - purgeable + wired + compressed) * gb, (anon - purgeable) * gb, wired * gb, compressed * gb
  }'
case "$(sysctl -n kern.memorystatus_vm_pressure_level)" in
  1) pressure=normal ;; 2) pressure=warning ;; 4) pressure=critical ;; *) pressure=unknown ;;
esac
echo "pressure:   $pressure"
echo "swap:       $(sysctl -n vm.swapusage)"
echo "load:       $(sysctl -n vm.loadavg)"
echo "hypervisor: $([ "$(sysctl -n kern.hv_support)" = 1 ] && echo available || echo missing)"
echo "interfaces: $(ifconfig -l)"

section "Ollama"
if command -v ollama >/dev/null 2>&1; then
  echo "binary:  $(command -v ollama)"
  echo "version: $(limit 10 ollama --version 2>&1 | tr '\n' ' ')"
  launchctl list | awk 'tolower($3) ~ /ollama/ { printf "launchd: %s (pid %s, last exit %s)\n", $3, $1, $2 }'
  plist=~/Library/LaunchAgents/homebrew.mxcl.ollama.plist
  if [ -f "$plist" ]; then
    keys=$(plutil -extract EnvironmentVariables xml1 -o - "$plist" 2>/dev/null |
      sed -n 's:.*<key>\(.*\)</key>.*:\1:p' | tr '\n' ' ')
    echo "service environment: ${keys:-none}"
  fi
  echo "OLLAMA_HOST in launchd: $([ -n "$(launchctl getenv OLLAMA_HOST)" ] && echo set || echo 'not set')"
  lsof -nP -a -c ollama -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u |
    while read -r addr; do echo "listens: $(scope "${addr%:*}"), port ${addr##*:}"; done
  echo "pulled:"
  limit 15 ollama list 2>&1 | sed 's/^/  /'
  echo "loaded now:"
  limit 15 ollama ps 2>&1 | sed 's/^/  /'
else
  echo "not installed"
fi

section "Colima and Docker (they should stay stopped)"
if command -v colima >/dev/null 2>&1; then
  echo "colima: $(colima version 2>/dev/null | head -1)"
  limit 15 colima list 2>&1 | sed 's/^/  /'
else
  echo "colima: not installed"
fi
if command -v docker >/dev/null 2>&1; then
  echo "docker CLI: $(docker --version)"
  echo "docker engine: $(limit 10 docker info >/dev/null 2>&1 && echo running || echo 'not reachable')"
else
  echo "docker CLI: not installed"
fi
echo "colima, lima, qemu or Docker processes: $(count 'colima|limactl|qemu-system|com\.docker|Docker\.app')"
echo "Virtualization.framework VMs running: $(count 'com\.apple\.Virtualization\.VirtualMachine')"

section "Apple container"
if command -v container >/dev/null 2>&1; then
  echo "container: $(container --version 2>&1 | head -1)"
  limit 15 container system status 2>&1 | sed 's/^/  /'
else
  echo "container: not installed"
fi
pkgutil --pkgs 2>/dev/null | grep -i container | sed 's/^/receipt: /'

section "Host services beyond loopback (the walls must block them, except Ollama and i.inc's API)"
# netstat's process column can hold spaces, so it is read from both ends: 8 fixed fields follow it.
# UDP sockets with no port, or an ephemeral one (49152 and up), are clients, not services, so they
# are left out.
listeners='
  function emit(proto, first,   n, a, port, addr, proc, i) {
    n = split($4, a, "."); port = a[n]; addr = substr($4, 1, length($4) - length(port) - 1)
    if (addr ~ /^127\./ || addr == "::1" || addr ~ /%lo0$/) return
    if (proto == "udp" && (port == "*" || port + 0 >= 49152)) return
    proc = $first; for (i = first + 1; i <= NF - 8; i++) proc = proc " " $i
    sub(/:[0-9]+$/, "", proc)
    printf "%-4s %-6s %-15s %s\n", proto, port, (addr == "*" ? "all interfaces" : "<other>"), proc
  }
  $1 ~ /^tcp/ && $6 == "LISTEN" { emit("tcp", 11) }
  $1 ~ /^udp/ && $5 == "*.*" { emit("udp", 10) }
'
{ netstat -anv -p tcp; netstat -anv -p udp; } 2>/dev/null | awk "$listeners" | sort -u | sort -k1,1 -k2,2n

section "Firewall"
echo "application firewall: $(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>&1 | sed 's/^ *//')"
echo "/etc/pf.conf, without comments:"
grep -v '^[[:space:]]*#' /etc/pf.conf | grep -v '^[[:space:]]*$' | sed 's/^/  /'
echo "/etc/pf.anchors: $(ls /etc/pf.anchors 2>/dev/null | tr '\n' ' ')"
echo "whether pf is enabled needs sudo (pfctl -s info), so step 3 checks it"
