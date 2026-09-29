#!/bin/sh
# Saves an account's Claude token in ~/.config/i-inc/credentials.json (config.ts) without showing
# it. Make the token with `claude setup-token`: a model-only token, not a full sign-in (spec §5).
# Then, on the mini: sh tools/host/add-claude-token.sh <account id>
# The daemon reads the file at start, so restart it afterwards (the script says how).
set -eu
account=${1:?usage: add-claude-token.sh <account id>}
dir="$HOME/.config/i-inc"
file="$dir/credentials.json"
umask 077
mkdir -p "$dir"
chmod 700 "$dir"

# From a terminal it asks with echo off; from a pipe (a password manager, say) it just reads.
token=
if [ -t 0 ]; then
  printf "Paste the token from claude setup-token (it won't show), then press Enter: "
  trap 'stty echo' EXIT INT TERM
  stty -echo
  IFS= read -r token || true
  stty echo
  echo
else
  IFS= read -r token || true
fi
case "$token" in
  sk-ant-*) ;;
  *) echo "that doesn't look like a Claude token" >&2; exit 1 ;;
esac

[ -f "$file" ] || echo '{}' >"$file"
# The token goes to jq through its environment, not its command line.
T="$token" /usr/bin/jq --arg a "$account" '.[$a] = ((.[$a] // {}) + {CLAUDE_CODE_OAUTH_TOKEN: env.T})' \
  "$file" >"$file.new"
mv "$file.new" "$file"
chmod 600 "$file"
echo "saved for account $account. Restart the daemon: launchctl kickstart -k gui/$(id -u)/inc.i.daemon"
