#!/bin/bash
# M1 step 4 (docs/m1-runbook.md): install Google's Antigravity CLI (`agy`) and its ACP server in a
# machine.
#
# Gemini CLI stopped serving Google AI Pro accounts on 2026-06-18, and the subscription now works
# through Antigravity. Run this in the machine, as the machine's user:
#   container machine run -i -n m1-test -- bash -s < tools/m1/install-antigravity.sh
# Then sign in once, interactively. agy prints a link and takes the code back when it thinks it's
# in a remote session, hence SSH_CONNECTION:
#   container machine run -it -n m1-test -- env SSH_CONNECTION=machine ~/.local/bin/agy
#
# No keyring is needed. Older reports say agy keeps its sign-in only in a Secret Service keyring on
# Linux, but 1.2.12 keeps it in ~/.gemini/antigravity-cli/antigravity-oauth-token (mode 0600, with
# a refresh token). M1 first installed gnome-keyring for this, and it pulls in ~90 desktop packages.
set -euo pipefail

ACP_VERSION=1.2.1
export PATH="$HOME/.local/bin:$PATH"

# The installer imports Gemini CLI's settings. The old ones set up an API key, so they stay out.
if [ -d ~/.gemini ]; then mv ~/.gemini ~/.gemini-cli-old; fi

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends unzip

echo "== the Antigravity CLI (Google's installer checks the download against its SHA-512)"
curl -fsSL https://antigravity.google/cli/install.sh | bash

echo "== its ACP server, $ACP_VERSION (a native binary, 999 MB unpacked)"
zip="agy-acp-server-$ACP_VERSION-linux-arm64.zip"
dir=~/.local/share/agy-acp-server
mkdir -p "$dir"
curl -fsSL -o "/tmp/$zip" "https://dl.google.com/agy-extensions/releases/linux/$zip"
unzip -q -o "/tmp/$zip" -d "$dir"
rm -f "/tmp/$zip"
chmod +x "$dir/agy_acp_server.par"

echo "== installed"
echo "agy: $(agy --version 2>&1 | head -1)"
echo "ACP server: $dir ($(du -sh "$dir" | cut -f1))"
