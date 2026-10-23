#!/bin/bash
# M1 step 3: check the walls from inside a machine (docs/m1-runbook.md).
#
# The targets are passed in, so no home-network address is written down:
#   container machine run -i -n m1-test -- env ROUTER=<ip> HOST_LAN=<ip> HOST_TAILNET=<ip> \
#     LAN_DEVICE=<ip:port> TAILNET_DEVICE=<ip:port> bash -s < tools/m1/walls-test.sh
#
# Each line shows what happened ("open" or "blocked") and what the walls should give.
#
# In a home machine (a personal assistant's sandbox, inc-home-<id>), add HOME_MACHINE=1 to the env:
# the internet and DNS are then expected to be blocked, and only Ollama open. The internet is also
# tried by address (https://1.1.1.1), so the DNS block alone can't pass the check.
#
# Traffic between machines (T70). A "blocked" TCP probe to a port nobody listens on proves nothing: a
# closed port is "blocked" too. So:
#
# OTHER_LISTENER=<ip:port> (the proof). Start a listener in the OTHER machine first, from the host (it
# stays up after `machine run` returns, and says on its log what it saw):
#   container machine run -i -u employee -n <other machine> -- bash -s <<'EOF'
#   nohup node -e 's=require("net").createServer(c=>{console.log("connection from "+c.remoteAddress);c.end("hi\n")});s.on("error",e=>{console.error("listen failed: "+e.message);process.exit(1)});s.listen(7777,"0.0.0.0",()=>console.log("listening"))' >/tmp/listener.log 2>&1 &
#   sleep 1; cat /tmp/listener.log; ss -ltn | grep ':7777 '
#   EOF
# The log must say "listening" and ss must show the port; if it says "listen failed", there is no listener
# and the check below proves nothing. Then run this script in the first machine with
# OTHER_LISTENER=<other machine's ip>:7777. TCP and ping to it must be blocked: a TCP probe that times out is
# the walls dropping it (a refusal, "refused" below, means the packet got through to a machine with nothing
# listening there, or the walls are not filtering between machines at all). Afterwards the listener's log
# (cat /tmp/listener.log in the other machine) must be empty of "connection from": that is the other half of
# the proof. The same probe without the walls' bridge filter on reads "open" and the log shows the connection.
# Stop the listener afterwards: pkill -f 'createServer' in the other machine.
#
# OTHER_MACHINE=<ip of another machine on the 192.168.64.0/24> (weaker: ports 22 and 7 may have no listener)
# adds TCP and ping to it; both must be blocked, but a closed port reads "blocked" as well.
#
# With either, the lines before them are the "still works" half: an open machine keeps its internet, DNS
# and Ollama (the first four lines), and its DHCP lease (its address is on 192.168.64.0/24); a home
# machine keeps Ollama and the lease, and still has no internet or DNS. The line "DHCP broadcast"
# shows whether a datagram sent to 255.255.255.255:67 is received by the other machine, which would
# be a channel between machines (listen there first: nc -ul 67 in the other machine, as root).
#
# Expected counts: 14 checks for the base list; +1 for either variable (the lease); +2 for OTHER_LISTENER (TCP
# and ping); +3 for OTHER_MACHINE (TCP 22, TCP 7 and ping). "N as wanted, 0 not" is the pass: 17 with
# OTHER_LISTENER alone, 18 with OTHER_MACHINE alone, 20 with both.

GATEWAY=${GATEWAY:-192.168.64.1}
: "${ROUTER:?}" "${HOST_LAN:?}" "${HOST_TAILNET:?}" "${LAN_DEVICE:?}" "${TAILNET_DEVICE:?}"

net=open
[ "${HOME_MACHINE:-}" != 1 ] || net=blocked

as_wanted=0
not=0
check() { # check <want: open|blocked> <what> <command...>
  local want=$1 what=$2 got mark
  shift 2
  if "$@" >/dev/null 2>&1; then got=open; else got=blocked; fi
  if [ "$got" = "$want" ]; then
    as_wanted=$((as_wanted + 1)) mark=ok
  else
    not=$((not + 1)) mark=WRONG
  fi
  printf '%-6s %-7s  %s (want %s)\n' "$mark" "$got" "$what" "$want"
}
tcp() { nc -z -w 3 "${1%:*}" "${1##*:}"; }
dns() { dig +short +time=2 +tries=1 "$1" @"$GATEWAY" | grep -q '^[0-9]'; }
ping1() { ping -c 1 -W 2 "$1"; }

check "$net" "internet over IPv4 (https://example.com)" curl -4 -sf --max-time 8 -o /dev/null https://example.com
check "$net" "internet by address (https://1.1.1.1, no DNS needed)" curl -4 -sk --max-time 8 -o /dev/null https://1.1.1.1
check "$net" "DNS through the gateway" dns example.com
check open "Ollama through the gateway" curl -sf --max-time 5 "http://$GATEWAY:11434/api/tags"
check blocked "internet over IPv6" curl -6 -sf --max-time 8 -o /dev/null https://example.com
check blocked "the host: SSH on the gateway" tcp "$GATEWAY:22"
check blocked "the host: AirPlay on the gateway" tcp "$GATEWAY:5000"
check blocked "the host: SSH on its LAN address" tcp "$HOST_LAN:22"
check blocked "the host: SSH on its tailnet address" tcp "$HOST_TAILNET:22"
check blocked "the router: ping" ping1 "$ROUTER"
check blocked "the router: DNS" tcp "$ROUTER:53"
check blocked "another LAN device" tcp "$LAN_DEVICE"
check blocked "another tailnet device" tcp "$TAILNET_DEVICE"
check blocked "the link-local metadata address" tcp 169.254.169.254:80
own_address() { { ip -4 -o addr show 2>/dev/null || hostname -I 2>/dev/null; } | grep -q '192\.168\.64\.'; }
listener() { # the probe to a listener started in the other machine: dropped is right, refused is not proof
  local out
  if out=$(nc -zv -w 3 "${OTHER_LISTENER%:*}" "${OTHER_LISTENER##*:}" 2>&1); then
    printf 'WRONG  open     another machine: TCP to the listener %s (want blocked: dropped, not refused)\n' "$OTHER_LISTENER"
    not=$((not + 1))
  elif printf '%s' "$out" | grep -qi 'refused'; then
    printf 'WRONG  refused  another machine: TCP to the listener %s (want blocked: dropped. A refusal came from the other machine, or nothing filters between machines)\n' "$OTHER_LISTENER"
    not=$((not + 1))
  else
    printf 'ok     blocked  another machine: TCP to the listener %s (want blocked: dropped)\n' "$OTHER_LISTENER"
    as_wanted=$((as_wanted + 1))
  fi
}
if [ -n "${OTHER_MACHINE:-}${OTHER_LISTENER:-}" ]; then
  check open "own address is on 192.168.64.0/24 (DHCP still works)" own_address
fi
if [ -n "${OTHER_LISTENER:-}" ]; then
  listener
  check blocked "another machine: ping ${OTHER_LISTENER%:*}" ping1 "${OTHER_LISTENER%:*}"
fi
if [ -n "${OTHER_MACHINE:-}" ]; then
  check blocked "another machine: TCP 22 on $OTHER_MACHINE" tcp "$OTHER_MACHINE:22"
  check blocked "another machine: TCP 7 on $OTHER_MACHINE" tcp "$OTHER_MACHINE:7"
  check blocked "another machine: ping $OTHER_MACHINE" ping1 "$OTHER_MACHINE"
fi
if [ -n "${OTHER_MACHINE:-}${OTHER_LISTENER:-}" ]; then
  printf 'hello-from-%s' "$(hostname)" | nc -u -w 1 255.255.255.255 67 2>/dev/null || true
  echo "DHCP broadcast sent to 255.255.255.255:67: look in the other machine (nc -ul 67) to see whether it arrived"
fi
echo "$as_wanted as wanted, $not not"
