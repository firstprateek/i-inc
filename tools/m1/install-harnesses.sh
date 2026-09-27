#!/bin/bash
# M1 step 4 (docs/m1-runbook.md): install the harnesses and their ACP adapters inside a machine.
# Run it in the machine, as the machine's user:
#   container machine run -i -n m1-test -- bash -s < tools/m1/install-harnesses.sh
#
# Versions are pinned to what was current on 2026-09-27, so the result is repeatable:
#   - Node.js LTS, from nodejs.org, checked against its published SHA-256;
#   - Claude Code, with Anthropic's native installer (into ~/.local/bin);
#   - the Claude ACP adapter (claude-agent-acp), Gemini CLI (`gemini --acp`) and OpenCode
#     (`opencode acp`), from npm, into ~/.local so no sudo is needed.
set -euo pipefail

NODE_VERSION=v24.21.0
CLAUDE_ACP_VERSION=0.81.2
GEMINI_VERSION=0.61.0
OPENCODE_VERSION=1.18.32

export PATH="$HOME/.local/bin:$PATH"

echo "== Node.js $NODE_VERSION"
command -v xz >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq xz-utils; }
tarball="node-$NODE_VERSION-linux-arm64.tar.xz"
cd /tmp
curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/$tarball"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $tarball\$" | sha256sum -c -
sudo tar -xJf "$tarball" -C /usr/local --strip-components=1
rm -f "$tarball"
npm config set prefix "$HOME/.local"

echo "== Claude Code"
curl -fsSL https://claude.ai/install.sh | bash

echo "== ACP adapter for Claude, Gemini CLI and OpenCode"
npm install -g --no-fund --no-audit \
  "@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION" \
  "@google/gemini-cli@$GEMINI_VERSION" \
  "opencode-ai@$OPENCODE_VERSION"

echo "== OpenCode's local engine: Ollama, through the relay on the machines' gateway"
mkdir -p ~/.config/opencode
cat >~/.config/opencode/opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3:8b",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama on the host",
      "options": { "baseURL": "http://192.168.64.1:11434/v1" },
      "models": {
        "qwen3:8b": { "name": "qwen3 8B" },
        "qwen2.5-coder:14b": { "name": "qwen2.5-coder 14B" }
      }
    }
  }
}
JSON

echo "== installed"
echo "node $(node --version), npm $(npm --version)"
echo "claude $(claude --version)"
echo "claude-agent-acp: $(command -v claude-agent-acp)"
echo "gemini $(gemini --version)"
echo "opencode $(opencode --version)"
