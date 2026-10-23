#!/bin/sh
# Downloads ripgrep's Linux arm64 binary onto the host, for machines made before the employee image had it
# (tools/host/update-machine.sh copies it into them). The host has internet and a machine may have none: this
# runs on the host, once, and again only to change RG_VERSION. From the checkout:
#   sh tools/host/fetch-rg.sh
# The release's own SHA-256 file is checked before anything is kept.
set -eu
RG_VERSION=${RG_VERSION:-14.1.1}
dest=${RG_BIN:-$HOME/.cache/i-inc/rg}
name="ripgrep-$RG_VERSION-aarch64-unknown-linux-gnu"
base="https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
curl -fsSLO "$base/$name.tar.gz"
curl -fsSL "$base/$name.tar.gz.sha256" -o expected
want=$(awk '{print $1}' expected)
got=$(shasum -a 256 "$name.tar.gz" | awk '{print $1}')
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "the download does not match its published SHA-256" >&2; exit 1; }
tar -xzf "$name.tar.gz" "$name/rg"
mkdir -p "$(dirname "$dest")"
cp "$name/rg" "$dest"
chmod 755 "$dest"
echo "ripgrep $RG_VERSION (linux arm64) is at $dest"
