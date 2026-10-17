#!/bin/bash
# Checks a machine made from the employee image, as the daemon will use it. On the mini:
#   container machine create --name inc-imagecheck --cpus 4 --memory 6G --home-mount none \
#     local/i-inc-employee:latest
#   container machine run -i -u employee -n inc-imagecheck -- bash -s < images/employee/check.sh
#   container machine delete inc-imagecheck
# It needs no credentials: each harness only has to answer ACP's initialize.
set -uo pipefail
failed=0
pass() { echo "✓ $*"; }
fail() {
  echo "✗ $*"
  failed=1
}
# Runs a command with no stdin, so it can't eat the rest of this script (M1), and reports its first
# line of output.
try() {
  local what=$1 out
  shift
  if out=$("$@" </dev/null 2>&1); then pass "$what: $(head -1 <<<"$out")"; else fail "$what: $(tail -1 <<<"$out")"; fi
}

[ "$(id -un)" = employee ] && pass "runs as employee" || fail "runs as $(id -un)"
[ "$HOME" = /home/employee ] && pass "HOME is /home/employee" || fail "HOME is $HOME"
sudo -n true </dev/null 2>/dev/null && pass "sudo needs no password" || fail "sudo asks for a password"
[ ! -e "$HOME/.claude/.credentials.json" ] && [ ! -e "$HOME/.gemini/antigravity-acp" ] &&
  pass "no credentials in the image" || fail "credentials in the image"

try node node --version
try pnpm pnpm --version
try git git --version
try gh gh --version
try "Claude's ACP adapter" node -p \
  'require("/usr/local/lib/node_modules/@agentclientprotocol/claude-agent-acp/package.json").version'
try opencode opencode --version
try "the Antigravity CLI" "$HOME/.local/bin/agy" --version
try "Claude Code, for the sign-in" claude --version
# It exits 1 when signed out, so its output is read first (pipefail would count that as a failure).
status=$(claude auth status </dev/null 2>/dev/null || true)
if grep -q '"loggedIn": false' <<<"$status"; then
  pass "Claude isn't signed in yet: once per machine, with tools/host/sign-in-claude.sh"
else
  fail "Claude is signed in already, in the image"
fi
[ -x "$HOME/.local/share/agy-acp-server/agy_acp_server.par" ] &&
  pass "Antigravity's ACP server is there" || fail "Antigravity's ACP server is missing"

[ "$(git config --get-all credential.https://github.com.helper | tail -1)" = '!gh auth git-credential' ] &&
  pass "git pushes to GitHub through gh" || fail "git's credential helper for GitHub isn't gh"
[ "$(npm config get prefix)" = "$HOME/.local" ] &&
  pass "npm -g installs into ~/.local, without sudo" || fail "npm's prefix is $(npm config get prefix)"

models=$(opencode models </dev/null 2>/dev/null)
if [ -n "$models" ] && ! grep -qv '^ollama/' <<<"$models"; then
  pass "OpenCode offers only local models: $(tr '\n' ' ' <<<"$models")"
else
  fail "OpenCode offers more than local models: $(tr '\n' ' ' <<<"$models" | cut -c1-200)"
fi

if systemctl is-active --quiet docker.service; then fail "dockerd started at boot"; else pass "dockerd waits for first use"; fi
try "Docker, started by its socket" docker version --format '{{.Server.Version}}'

# Each launcher must make its folder, start there, and answer initialize.
for launcher in acp-claude acp-antigravity acp-opencode; do
  dir="$HOME/work/imagecheck-$launcher"
  node - "$launcher" "$dir" <<'JS'
const { spawn } = require("node:child_process");
const { readlinkSync } = require("node:fs");
const [launcher, dir] = process.argv.slice(2);
const child = spawn(launcher, [], { env: { ...process.env, I_INC_CWD: dir } });
const started = Date.now();
let out = "";
const done = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗"} ${launcher}: ${msg}`);
  child.kill();
  process.exit(ok ? 0 : 1);
};
const timer = setTimeout(() => done(false, `no answer to initialize in 90 s ${out.slice(0, 200)}`), 90_000);
child.stdout.on("data", (chunk) => {
  out += chunk;
  for (const line of out.split("\n")) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== 1) continue;
    clearTimeout(timer);
    if (msg.error) return done(false, JSON.stringify(msg.error));
    let cwd = "?";
    try {
      cwd = readlinkSync(`/proc/${child.pid}/cwd`);
    } catch {}
    const auth = (msg.result.authMethods ?? []).map((m) => m.id).join(", ") || "none";
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (cwd !== dir) return done(false, `started in ${cwd}, not ${dir}`);
    return done(true, `ACP ${msg.result.protocolVersion} in ${secs} s, in its folder; sign-in: ${auth}`);
  }
});
child.on("exit", (code) => done(false, `exited with ${code} before answering`));
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
);
JS
  [ $? -eq 0 ] || failed=1
done

exit $failed
