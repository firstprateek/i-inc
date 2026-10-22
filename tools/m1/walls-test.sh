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
# OTHER_MACHINE=<ip of another machine on the 192.168.64.0/24> adds TCP and ping to it (start another
# machine first and read its address in `container machine ls`); both must be blocked. This is the
# check that traffic between two machines on the bridge reaches pf at all: until it has passed on the
# mini, nothing here may be said to wall machines off from each other. The line "DHCP broadcast"
# shows whether a datagram sent to 255.255.255.255:67 is received by the other machine, which would
# be a channel between machines (listen there first: nc -ul 67 in the other machine, as root).

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
if [ -n "${OTHER_MACHINE:-}" ]; then
  check blocked "another machine: TCP 22 on $OTHER_MACHINE" tcp "$OTHER_MACHINE:22"
  check blocked "another machine: TCP 7 on $OTHER_MACHINE" tcp "$OTHER_MACHINE:7"
  check blocked "another machine: ping $OTHER_MACHINE" ping1 "$OTHER_MACHINE"
  printf 'hello-from-%s' "$(hostname)" | nc -u -w 1 255.255.255.255 67 2>/dev/null || true
  echo "DHCP broadcast sent to 255.255.255.255:67: look in the other machine (nc -ul 67) to see whether it arrived"
fi
echo "$as_wanted as wanted, $not not"
