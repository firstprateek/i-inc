# The base image every employee machine is made from (spec §5 and §12). It grew out of M1's
# tools/m1/machine/Dockerfile and install scripts (docs/m1-findings.md). Build it on the mini:
#   container build -t local/i-inc-employee:latest images/employee
# Then try it in a throwaway machine with check.sh, as its header says.
#
# What's in it:
#   - Ubuntu 24.04 with systemd, which `container machine` boots. Only systemd-sysv provides
#     /sbin/init, and a machine won't boot without it;
#   - the user `employee`, with passwordless sudo: lenient inside the machine, hard walls outside
#     (spec §5). The daemon runs everything as `employee` (`machine run -u employee`), never as the
#     user that matches the host's;
#   - Node, pnpm, git, gh, and Docker, which starts on first use rather than at boot;
#   - the harnesses: Claude's ACP adapter, which carries Claude Code's own binary (also `claude`, for
#     signing the machine in), Antigravity's CLI and ACP server, and OpenCode, pinned to local
#     models through the relay;
#   - the launchers acp-claude, acp-antigravity and acp-opencode, one word each, because
#     `machine run` re-splits its arguments. Each makes $I_INC_CWD and starts there.
#
# No credentials: each machine signs in once at hiring, and GitHub's token arrives per session with
# `machine run -e` (m1-findings.md, "M3: credentials"). No gnome-keyring either, since nothing here
# needs one.
FROM ubuntu:24.04

# Pinned to what M1 ran on 2026-09-27 and 28, so builds repeat.
ARG NODE_VERSION=v24.21.0
ARG PNPM_VERSION=10.34.5
ARG CLAUDE_ACP_VERSION=0.81.2
ARG OPENCODE_VERSION=1.18.32
ARG AGY_ACP_VERSION=1.2.1

ENV container=container

# M1's packages, plus unzip and xz-utils for the downloads below, jq, and Docker. gh comes from
# GitHub's own apt repository, since Ubuntu's is years behind.
RUN apt-get update && \
    apt-get install -y \
      dbus systemd systemd-sysv iproute2 iputils-ping curl wget vim-tiny sudo less \
      ca-certificates git dnsutils netcat-openbsd unzip xz-utils jq docker.io && \
    install -d -m 0755 /etc/apt/keyrings && \
    curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg && \
    chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      >/etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# systemd as Apple's example sets it up. Docker's socket starts the daemon on first use, so an
# employee that never uses Docker doesn't pay for it.
RUN >/etc/machine-id && >/var/lib/dbus/machine-id && \
    systemctl set-default multi-user.target && \
    systemctl mask \
      dev-hugepages.mount \
      sys-fs-fuse-connections.mount \
      systemd-update-utmp.service \
      systemd-tmpfiles-setup.service \
      console-getty.service && \
    (systemctl disable networkd-dispatcher.service || true) && \
    systemctl disable docker.service containerd.service && \
    systemctl enable docker.socket

# Node, from nodejs.org, checked against its published SHA-256.
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') && \
    tarball="node-$NODE_VERSION-linux-$arch.tar.xz" && \
    cd /tmp && \
    curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$tarball" && \
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $tarball\$" | sha256sum -c - && \
    tar -xJf "$tarball" -C /usr/local --strip-components=1 --no-same-owner && \
    rm "$tarball"

# pnpm and the harnesses that come from npm. npm 11 runs no install scripts unless they're allowed
# (M1): OpenCode's postinstall is, and a new dependency with scripts fails the build.
RUN npm install -g --no-fund --no-audit \
      --allow-scripts=opencode-ai --strict-allow-scripts \
      "pnpm@$PNPM_VERSION" \
      "@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION" \
      "opencode-ai@$OPENCODE_VERSION" && \
    npm cache clean --force

# `claude` is the Claude Code that Claude's adapter carries, for signing the machine in once
# (`claude auth login`, tools/host/sign-in-claude.sh). Its sessions then run the same Claude Code.
RUN claude=$(find /usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp \
      -path '*claude-agent-sdk-linux-*/claude' -type f | head -1) && \
    test -n "$claude" && \
    ln -s "$claude" /usr/local/bin/claude && \
    echo 'export DISABLE_AUTOUPDATER=1' >/etc/profile.d/i-inc.sh && \
    claude --version

# git pushes to GitHub through gh, which uses the session's GH_TOKEN (docs/github-app.md).
RUN git config --system init.defaultBranch main && \
    git config --system credential.https://github.com.helper '' && \
    git config --system --add credential.https://github.com.helper '!gh auth git-credential'

# The employee. Ubuntu's image comes with an unused `ubuntu` user, which goes.
RUN userdel --remove ubuntu && \
    useradd --create-home --shell /bin/bash --groups docker employee && \
    echo 'employee ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/employee && \
    chmod 0440 /etc/sudoers.d/employee

# Named one by one: Apple's builder silently skipped a whole-directory COPY. The ls fails the build
# if they're missing.
COPY acp-env.sh /usr/local/lib/i-inc/acp-env.sh
COPY launchers/acp-claude launchers/acp-antigravity launchers/acp-opencode /usr/local/bin/
RUN chmod 755 /usr/local/bin/acp-claude /usr/local/bin/acp-antigravity /usr/local/bin/acp-opencode && \
    ls -l /usr/local/bin/acp-claude /usr/local/bin/acp-antigravity /usr/local/bin/acp-opencode
COPY opencode.json /home/employee/.config/opencode/opencode.json
RUN chown -R employee:employee /home/employee

# What installs into the employee's home: its own npm globals, and Antigravity. Google's installer
# checks the CLI against its SHA-512. The ACP server is a native binary, 999 MB unpacked.
USER employee
RUN export HOME=/home/employee && \
    mkdir -p ~/.local/bin ~/work && \
    npm config set prefix "$HOME/.local" && \
    curl -fsSL https://antigravity.google/cli/install.sh | bash && \
    zip="agy-acp-server-$AGY_ACP_VERSION-linux-arm64.zip" && \
    dir=~/.local/share/agy-acp-server && \
    mkdir -p "$dir" && \
    curl -fsSL -o "/tmp/$zip" "https://dl.google.com/agy-extensions/releases/linux/$zip" && \
    unzip -q -o "/tmp/$zip" -d "$dir" && \
    rm "/tmp/$zip" && \
    chmod +x "$dir/agy_acp_server.par"

# The machine boots /sbin/init, which must run as root.
USER root
