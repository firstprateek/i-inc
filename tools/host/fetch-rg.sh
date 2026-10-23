#!/bin/sh
# Downloads ripgrep's Linux arm64 binary onto the host, for machines made before the employee image had it
# (tools/host/update-machine.sh copies it into them). The host has internet and a machine may have none: this
# runs on the host, once. From the checkout:
#   sh tools/host/fetch-rg.sh
# The archive is checked against the SHA-256 pinned below, which is in this repository and was read from the
# release's own .sha256 file when it was pinned. To change the version, change both lines in a pull request.
set -eu
RG_VERSION=14.1.1
RG_SHA256=c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f
dest=${RG_BIN:-$HOME/.cache/i-inc/rg}
name="ripgrep-$RG_VERSION-aarch64-unknown-linux-gnu"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
curl -fsSLO "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION/$name.tar.gz"
got=$(shasum -a 256 "$name.tar.gz" | awk '{print $1}')
[ "$got" = "$RG_SHA256" ] || { echo "the download is not the pinned ripgrep $RG_VERSION (SHA-256 $got)" >&2; exit 1; }
tar -xzf "$name.tar.gz" "$name/rg"
mkdir -p "$(dirname "$dest")"
cp "$name/rg" "$dest"
chmod 755 "$dest"
echo "ripgrep $RG_VERSION (linux arm64) is at $dest"
