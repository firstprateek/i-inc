#!/bin/sh
# Creates qwen3-8b-32k, the model a personal assistant's OpenCode uses: qwen3:8b with a 32,768-token window
# (tools/host/qwen3-8b-32k.Modelfile). Safe to run again: it does nothing when the model is already there
# with that window. Run it on the host, where Ollama is, from the checkout:
#   sh tools/host/ollama-pa-model.sh
# The model shares qwen3:8b's weights, so it costs no disk. The Ollama relay (tools/m1/ollama-forward.mjs) serves
# any model that /api/tags lists, so the new one is reachable from the machines within 30 seconds.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
name=${PA_MODEL:-qwen3-8b-32k}
base=qwen3:8b
want=32768
ollama=$(command -v ollama || echo /usr/local/bin/ollama)
[ -x "$ollama" ] || { echo "no ollama on this host" >&2; exit 1; }
"$ollama" list >/dev/null 2>&1 || { echo "ollama is not running (open the app, or: ollama serve)" >&2; exit 1; }

have=$("$ollama" show "$name" --parameters 2>/dev/null | awk '$1 == "num_ctx" { print $2 }' || true)
if [ "$have" = "$want" ]; then
  echo "$name is there already, with num_ctx $want"
  exit 0
fi
"$ollama" list | awk 'NR > 1 { print $1 }' | grep -qx "$base" ||
  { echo "$base isn't installed: run  ollama pull $base  first" >&2; exit 1; }
"$ollama" create "$name" -f "$here/qwen3-8b-32k.Modelfile"
echo "$name is made. Check: $ollama show $name --parameters  (num_ctx $want)"
