#!/bin/sh
# Sets a bridge's packet-filter flags (T70): sh bridge-filter.sh <bridge> <flags>, as root.
#
# macOS runs pf on frames the bridge switches between its members only when the bridge's filter flags
# say so. There is no sysctl for it (net.link.bridge has no pfil_bridge or pfil_member here: those are
# FreeBSD's), and ifconfig only shows the flags ("ipfilter enabled flags 0x2"). The kernel's bridge driver
# (xnu bsd/net/if_bridge.c, bridge_ioctl_sfilt) takes them from the BRDGSFILT driver-specific ioctl:
#   0x2 IFBF_FILT_MEMBER  run pf on the member interfaces (what makes pf see machine to machine)
#   0x4 IFBF_FILT_ONLYIP  drop frames that aren't ARP, RARP, IPv4 or IPv6 (pf can't see those)
#   0x1 IFBF_FILT_USEIPF  not supported by the kernel (it answers EINVAL)
# so this is that ioctl, through the perl that macOS ships. walls.sh reads the flags back with ifconfig,
# which does not trust this script. 0 turns the filter off (tools/m1/pf/remove.sh).
#
# The flags belong to the bridge, which vmnet makes and removes with the network: a new bridge100 starts
# at 0, and walls.sh (every minute) sets them again.
set -eu
bridge=${1:?usage: bridge-filter.sh <bridge> <flags>}
flags=${2:?usage: bridge-filter.sh <bridge> <flags>}
case "$bridge" in bridge[0-9] | bridge[0-9][0-9] | bridge[0-9][0-9][0-9]) ;; *) echo "not a bridge: $bridge" >&2; exit 64 ;; esac
case "$flags" in [0-7]) ;; *) echo "not filter flags (0 to 7): $flags" >&2; exit 64 ;; esac

perl=${I_INC_PERL:-/usr/bin/perl}
exec "$perl" -e '
use strict; use warnings;
use Socket;
my ($bridge, $flags) = @ARGV;
# struct ifdrv { char ifd_name[16]; unsigned long ifd_cmd; size_t ifd_len; void *ifd_data; } is 40 bytes
# on arm64 and x86_64, and SIOCSDRVSPEC is _IOW("i", 123, struct ifdrv).
my $SIOCSDRVSPEC = 0x8028697b;
my $BRDGSFILT    = 24;
# struct ifbrparam is one 4-byte union; the kernel refuses any other length.
my $param = pack("L", $flags);
my $drv   = pack("a16 Q Q Q", $bridge, $BRDGSFILT, length($param), unpack("Q", pack("P", $param)));
socket(my $s, AF_INET, SOCK_DGRAM, 0) or die "socket: $!\n";
ioctl($s, $SIOCSDRVSPEC, $drv) or die "BRDGSFILT $bridge $flags: $!\n";
' "$bridge" "$flags"
