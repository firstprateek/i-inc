#!/bin/bash
# M1 step 4 (docs/m1-runbook.md): install Google's Antigravity CLI (`agy`) and its ACP server in a
# machine, with the keyring agy needs to keep a sign-in on Linux.
#
# Gemini CLI stopped serving Google AI Pro accounts on 2026-06-18, and the subscription now works
# through Antigravity. Run this in the machine, as the machine's user:
#   container machine run -i -n m1-test -- bash -s < tools/m1/install-antigravity.sh
#
# agy keeps its sign-in only in a Secret Service keyring (org.freedesktop.secrets on D-Bus). A
# machine has no desktop session, so `with-keyring` runs a command inside a private D-Bus session
# with an unlocked gnome-keyring: `with-keyring agy`, or `with-keyring <the ACP server>`.
set -euo pipefail

ACP_VERSION=1.2.1
export PATH="$HOME/.local/bin:$PATH"

# The installer imports Gemini CLI's settings. The old ones set up an API key, so they stay out.
if [ -d ~/.gemini ]; then mv ~/.gemini ~/.gemini-cli-old; fi

echo "== a Secret Service keyring"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends gnome-keyring libsecret-tools unzip
mkdir -p ~/.local/bin
cat >~/.local/bin/with-keyring <<'SH'
#!/bin/sh
# Run a command inside a private D-Bus session with an unlocked gnome-keyring, so tools that keep
# secrets in the Secret Service (agy) can do so in a machine with no desktop session. The keyring
# has an empty password: like ~/.claude/.credentials.json, only file permissions protect it.
exec dbus-run-session -- sh -c 'printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null && exec "$@"' with-keyring "$@"
SH
chmod +x ~/.local/bin/with-keyring

echo "== the Antigravity CLI (Google's installer checks the download against its SHA-512)"
curl -fsSL https://antigravity.google/cli/install.sh | bash

echo "== its ACP server, $ACP_VERSION"
zip="agy-acp-server-$ACP_VERSION-linux-arm64.zip"
dir=~/.local/share/agy-acp-server
mkdir -p "$dir"
curl -fsSL -o "/tmp/$zip" "https://dl.google.com/agy-extensions/releases/linux/$zip"
unzip -q -o "/tmp/$zip" -d "$dir"
rm -f "/tmp/$zip"
chmod +x "$dir/agy_acp_server.par"

echo "== installed"
echo "agy: $(agy --version 2>&1 | head -1)"
echo "ACP server: $dir ($(du -sh "$dir" | cut -f1)); it starts with: $(head -c 48 "$dir/agy_acp_server.par" | tr -c '[:print:]' '.')"
echo "keyring kept across sessions: $(with-keyring sh -c 'printf ok | secret-tool store --label=i.inc-probe i-inc probe' &&
  with-keyring secret-tool lookup i-inc probe && with-keyring secret-tool clear i-inc probe)"
