#!/bin/sh
# M1 step 3: record, for a while, what the walls let through and turn away (pflog0), and the names
# the machines look up (DNS on bridge100). Pf logs addresses; the DNS log turns them into domains.
# Run it on the host as root: sudo sh tools/m1/pf/capture.sh [seconds]
set -eu

seconds="${1:-120}"
out=/tmp/m1
mkdir -p "$out"

perl -e 'alarm shift; exec @ARGV' "$seconds" tcpdump -n -e -ttt -l -i pflog0 >"$out/pflog.txt" 2>&1 &
perl -e 'alarm shift; exec @ARGV' "$seconds" tcpdump -n -l -i bridge100 udp port 53 >"$out/dns.txt" 2>&1 &
echo "recording for $seconds s into $out/pflog.txt and $out/dns.txt"
wait || true
chmod a+r "$out"/pflog.txt "$out"/dns.txt
echo "pf log entries: $(grep -c 'rule' "$out/pflog.txt" || true)"
echo "DNS lookups: $(grep -cE ' (A|AAAA)\? ' "$out/dns.txt" || true)"
