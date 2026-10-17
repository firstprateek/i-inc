#!/bin/sh
# Signs a team's sandbox in to Antigravity (Google AI Pro) once: every agent on the team then uses
# that sign-in (docs/architecture.md, docs/m1-findings.md step 5). Run it on the mini, in a terminal:
#   sh ~/i-inc/tools/host/sign-in-antigravity.sh <team id> [cpus] [memory]
# Antigravity's ACP server prints a Google sign-in link whose callback is 127.0.0.1:<port> inside the
# sandbox. Open the link in a browser, sign in, copy the failed http://127.0.0.1:<port>/?code=… address
# the browser lands on, and paste it here; this script delivers it inside the sandbox with curl.
set -eu
id=${1:?usage: sign-in-antigravity.sh <team id> [cpus] [memory]}
cpus=${2:-6}
memory=${3:-12G}
case "$id" in *[!a-z0-9-]*) echo "not a team id: $id" >&2; exit 64 ;; esac
machine="inc-$id"
c=/usr/local/bin/container
# No machine starts without the walls (spec §5): the walls job keeps this marker under a minute old.
[ -n "$(find /var/run/i-inc-walls.ok -mmin -2 2>/dev/null)" ] || {
  echo "the walls aren't up (see tools/host), so no machine starts" >&2
  exit 1
}

if ! $c machine inspect "$machine" >/dev/null 2>&1; then
  $c machine create --name "$machine" --cpus "$cpus" --memory "$memory" --home-mount none local/i-inc-employee:latest
fi
for attempt in 1 2 3; do
  $c machine run -n "$machine" -- true </dev/null && break
  [ "$attempt" -lt 3 ] || exit 1
done

node --input-type=module - "$machine" 3<&0 <<'EOF'
import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const machine = process.argv[2];
const c = "/usr/local/bin/container";
const cwd = "/tmp/sign-in";
const child = spawn(c, ["machine", "run", "-i", "-u", "employee", "-n", machine, "-e", `I_INC_CWD=${cwd}`, "--", "acp-antigravity"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  } catch {}
});

let asked = false;
const tty = createInterface({ input: createReadStream("", { fd: 3 }) });
createInterface({ input: child.stderr }).on("line", (line) => {
  if (!/https:\/\//.test(line)) return;
  console.log(`\n${line}\n`);
  if (asked) return;
  asked = true;
  console.log("Sign in at the link above, then paste the http://127.0.0.1:<port>/?code=… URL the browser redirected to:");
  tty.once("line", (raw) => {
    const url = raw.trim();
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) {
      console.error("expected an http://127.0.0.1:<port>/… callback URL");
      process.exit(64);
    }
    execFileSync(
      c,
      ["machine", "run", "-i", "-u", "employee", "-n", machine, "-e", "CALLBACK_URL", "--", "bash", "-s"],
      {
        env: { ...process.env, CALLBACK_URL: url },
        input: 'curl -fsS -- "$CALLBACK_URL" >/dev/null\n',
        stdio: ["pipe", "ignore", "inherit"],
      },
    );
  });
});

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "i.inc sign-in", version: "0.1.0" },
});
if (init.error) {
  console.error("initialize failed:", init.error);
  process.exit(1);
}

let created = await request("session/new", { cwd, mcpServers: [] });
if (created.error?.code === -32000) {
  const auth = await request("authenticate", { methodId: "oauth-personal" });
  if (auth.error) {
    console.error("authenticate failed:", auth.error);
    process.exit(1);
  }
  created = await request("session/new", { cwd, mcpServers: [] });
}
if (created.error) {
  console.error("session/new failed:", created.error);
  process.exit(1);
}
console.log(`${machine}: signed in to Antigravity (session ${created.result?.sessionId})`);
child.stdin.end();
child.stdout.destroy();
child.stderr.destroy();
child.kill();
process.exit(0);
EOF

$c machine run -u employee -n "$machine" -- pkill -f antigravity-acp </dev/null 2>/dev/null || true
$c machine run -u employee -n "$machine" -- ls -l /home/employee/.gemini/antigravity-acp/acp_token.json </dev/null

