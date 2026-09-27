#!/bin/sh
# M1 step 7 (docs/m1-runbook.md): the host's power draw, idle and busy, for My desk's electricity
# estimate. Run it on the host as root: sudo sh tools/m1/power.sh
#
# It samples 10 s idle, then waits for /tmp/m1/busy.flag, which whoever starts the busy load
# creates (a machine burning its CPUs while a local model generates), and samples 15 s more.
# powermetrics reports the chip's power (CPU, GPU and neural engine), not the whole Mac at the
# wall, which also feeds memory, storage, the fan and the power supply's losses.
set -eu

flag=/tmp/m1/busy.flag
rm -f "$flag"

sample() { # sample <seconds>: the average combined power over that many one-second samples
  powermetrics --samplers cpu_power,gpu_power -i 1000 -n "$1" 2>/dev/null |
    awk '/Combined Power/ { sum += $(NF-1); n++ }
      END { printf "%.1f W, the average of %d one-second samples", sum / n / 1000, n }'
}

echo "idle: $(sample 10)"
echo "waiting for a busy load ($flag)..."
i=0
while [ ! -e "$flag" ] && [ "$i" -lt 300 ]; do
  sleep 1
  i=$((i + 1))
done
echo "busy: $(sample 15)"
rm -f "$flag"
