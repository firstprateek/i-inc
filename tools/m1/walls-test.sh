#!/bin/bash
# M1 step 3: check the walls from inside a machine (docs/m1-runbook.md).
#
# The targets are passed in, so no home-network address is written down:
#   container machine run -i -n m1-test -- env ROUTER=<ip> HOST_LAN=<ip> HOST_TAILNET=<ip> \
#     LAN_DEVICE=<ip:port> TAILNET_DEVICE=<ip:port> bash -s < tools/m1/walls-test.sh
#
# Each line shows what happened ("open" or "blocked") and what the walls should give.

GATEWAY=${GATEWAY:-192.168.64.1}
: "${ROUTER:?}" "${HOST_LAN:?}" "${HOST_TAILNET:?}" "${LAN_DEVICE:?}" "${TAILNET_DEVICE:?}"

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

check open "internet over IPv4 (https://example.com)" curl -4 -sf --max-time 8 -o /dev/null https://example.com
check open "DNS through the gateway" dns example.com
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
echo "$as_wanted as wanted, $not not"
