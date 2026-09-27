# M1's machine image (docs/m1-runbook.md, step 2): Ubuntu 24.04 with systemd, after the example in
# Apple container's docs/container-machine.md. Differences from that example:
#   - no openssh-server: machines are driven with `container machine run`, so nothing listens;
#   - no unminimize: man pages and docs aren't needed. Without it, /sbin/init only comes from
#     systemd-sysv, so that's installed explicitly (a machine won't boot without /sbin/init);
#   - git, ca-certificates, dnsutils and netcat-openbsd, for the work and for step 3's wall tests.
#
# Build it on the host: container build -t local/m1-machine:ubuntu-24.04 tools/m1/machine
FROM ubuntu:24.04

ENV container=container

RUN apt-get update && \
    apt-get install -y \
      dbus systemd systemd-sysv iproute2 iputils-ping net-tools curl wget vim-tiny sudo \
      ca-certificates git dnsutils netcat-openbsd && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN >/etc/machine-id
RUN >/var/lib/dbus/machine-id

RUN systemctl set-default multi-user.target
RUN systemctl mask \
      dev-hugepages.mount \
      sys-fs-fuse-connections.mount \
      systemd-update-utmp.service \
      systemd-tmpfiles-setup.service \
      console-getty.service
RUN systemctl disable networkd-dispatcher.service || true
