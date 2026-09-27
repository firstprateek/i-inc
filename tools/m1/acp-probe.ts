// M1 step 5 (docs/m1-runbook.md): drive an agent inside a machine over ACP, from the host.
//
// It starts the agent's ACP server in the machine through `container machine run -i` (see
// tools/m1/acp-launchers.sh), speaks JSON-RPC over its stdio, and:
//   1. sends initialize, session/new and a short prompt that needs tools;
//   2. switches to the agent's bypass mode if it offers one, and approves every
//      session/request_permission itself;
//   3. prints the stream, with every tool call;
//   4. notes whether Claude's rate-limit info comes through (a usage_update whose _meta has
//      "_claude/rateLimit"), and any other _meta that mentions rate limits.
// It offers the agent no file or terminal access on the host, so the agent works in its machine.
//
// Run it on the host (Node 22.6+ runs .ts directly):
//   node tools/m1/acp-probe.ts <claude|antigravity|opencode> [machine]
//     [--prompt-file <file on the host>] [--cwd <directory in the machine>] [--label <name>]
// With --prompt-file it runs a real stage (step 6) instead of the built-in check.
// Every message is also written to /tmp/m1/acp-<agent>[-<label>].jsonl.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;

const launchers: Record<string, string> = {
  claude: "acp-claude",
  antigravity: "acp-antigravity",
  opencode: "acp-opencode",
};
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const agent = args[0] ?? "";
const machine = args[1] && !args[1].startsWith("--") ? args[1] : "m1-test";
const launcher = launchers[agent];
if (!launcher) {
  console.error(
    "usage: node tools/m1/acp-probe.ts <claude|antigravity|opencode> [machine] " +
      "[--prompt-file file] [--cwd dir] [--label name]",
  );
  process.exit(2);
}

const promptFile = flag("prompt-file");
const PROMPT = promptFile
  ? readFileSync(promptFile, "utf8").trim()
  : "In the current directory, create a file named hello.txt that contains the word hi, " +
    "then run `ls -l` and tell me in one sentence what you see.";
const CWD = flag("cwd") ?? "/tmp/acp-probe";
const label = flag("label");
// Long enough for a person to finish a sign-in, if the agent asks for one.
const TIMEOUT_MS = 15 * 60_000;

mkdirSync("/tmp/m1", { recursive: true });
const transcript = createWriteStream(`/tmp/m1/acp-${agent}${label ? `-${label}` : ""}.jsonl`);
const started = Date.now();
const say = (line: string) =>
  console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${line}`);

const child = spawn("/usr/local/bin/container", ["machine", "run", "-i", "-n", machine, "--", launcher], {
  stdio: ["pipe", "pipe", "pipe"],
});

const counts = { toolCalls: 0, permissions: 0, usageUpdates: 0, rateLimits: 0 };
let reply = "";
let nextId = 1;
const pending = new Map<number, (message: Json) => void>();

function send(message: Json): void {
  const line = JSON.stringify({ jsonrpc: "2.0", ...message });
  transcript.write(`> ${line}\n`);
  child.stdin.write(`${line}\n`);
}

function request(method: string, params: Json): Promise<Json> {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function short(value: unknown, max = 140): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function findRateLimits(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Json).flatMap(([key, inner]) =>
    /rate.?limit/i.test(key)
      ? [`${path}${key} = ${short(inner, 300)}`]
      : findRateLimits(inner, `${path}${key}.`),
  );
}

function onUpdate(params: Json): void {
  const update = (params.update ?? {}) as Json;
  const kind = String(update.sessionUpdate);
  for (const found of findRateLimits(update)) {
    counts.rateLimits++;
    say(`RATE LIMIT  ${found}`);
  }
  switch (kind) {
    case "agent_message_chunk": {
      const content = update.content as Json | undefined;
      if (content?.type === "text") reply += String(content.text);
      return;
    }
    case "agent_thought_chunk":
      return;
    case "tool_call":
      counts.toolCalls++;
      say(
        `tool call   ${short(update.title)} [${update.kind ?? "?"}] ${update.status ?? ""} ${short(update.rawInput ?? "", 100)}`,
      );
      return;
    case "tool_call_update":
      if (update.status) say(`tool update ${short(update.title ?? update.toolCallId)} → ${update.status}`);
      return;
    case "usage_update":
      counts.usageUpdates++;
      say(`usage       used ${short(update.used)} of ${short(update.size)}`);
      return;
    default:
      say(`update      ${kind}`);
  }
}

function approve(message: Json): void {
  const params = (message.params ?? {}) as Json;
  const options = (params.options ?? []) as Json[];
  const choice =
    options.find((option) => option.kind === "allow_always") ??
    options.find((option) => option.kind === "allow_once") ??
    options[0];
  counts.permissions++;
  say(`permission  ${short((params.toolCall as Json | undefined)?.title)}: approved "${choice?.name}"`);
  send({ id: message.id, result: { outcome: { outcome: "selected", optionId: choice?.optionId } } });
}

createInterface({ input: child.stdout }).on("line", (line) => {
  transcript.write(`< ${line}\n`);
  let message: Json;
  try {
    message = JSON.parse(line);
  } catch {
    say(`not JSON    ${short(line)}`);
    return;
  }
  const id = message.id as number | undefined;
  if (id !== undefined && ("result" in message || "error" in message)) {
    pending.get(id)?.(message);
    pending.delete(id);
  } else if (message.method === "session/update") {
    onUpdate((message.params ?? {}) as Json);
  } else if (message.method === "session/request_permission") {
    approve(message);
  } else if (id !== undefined) {
    say(`refused     ${message.method} (the probe offers the agent nothing on the host)`);
    send({ id, error: { code: -32601, message: `not offered: ${message.method}` } });
  } else {
    say(`notice      ${message.method} ${short(message.params ?? "", 100)}`);
  }
});
createInterface({ input: child.stderr }).on("line", (line) => {
  transcript.write(`! ${line}\n`);
  // A sign-in link, if the agent prints one, is the one line from stderr worth seeing, in full.
  if (/https:\/\//.test(line)) say(`stderr      ${line}`);
});
child.on("exit", (code) => say(`agent exited (${code})`));

function check(response: Json, step: string): Json {
  if (response.error) {
    say(`${step} failed: ${short(response.error, 400)}`);
    process.exit(1);
  }
  return (response.result ?? {}) as Json;
}

async function main(): Promise<void> {
  say(`starting ${launcher} in ${machine}`);
  const init = check(
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "i.inc M1 acp-probe", version: "0.1.0" },
    }),
    "initialize",
  );
  say(`initialize  protocol ${init.protocolVersion}, agent ${short(init.agentInfo ?? "(unnamed)")}`);
  say(`            capabilities ${short(init.agentCapabilities)}, auth ${short(init.authMethods ?? [])}`);

  const newSession = { cwd: CWD, mcpServers: [] };
  let created = await request("session/new", newSession);
  const authMethods = ((init.authMethods ?? []) as Json[]).map((method) => String(method.id));
  if ((created.error as Json | undefined)?.code === -32000 && authMethods.length > 0) {
    // "Authentication required": pick a method the way a client would, then try again.
    const methodId = authMethods.find((id) => id === "oauth-personal") ?? authMethods[0];
    say(`authenticate ${methodId} (from ${authMethods.join(", ")})`);
    check(await request("authenticate", { methodId }), "authenticate");
    created = await request("session/new", newSession);
  }
  const session = check(created, "session/new");
  const sessionId = String(session.sessionId);
  const modes = (((session.modes as Json | undefined)?.availableModes ?? []) as Json[]).map((mode) =>
    String(mode.id),
  );
  say(`session/new ${sessionId}, modes [${modes.join(", ")}]`);
  if (session.configOptions) say(`            config options ${short(session.configOptions, 300)}`);

  const bypass = modes.find((mode) => /bypass|yolo|allow.?all|full.?access|dangerous/i.test(mode));
  if (bypass) {
    check(await request("session/set_mode", { sessionId, modeId: bypass }), "session/set_mode");
    say(`set_mode    ${bypass}`);
  } else {
    say("set_mode    no bypass mode offered; the probe approves every permission request instead");
  }

  say(`prompt      ${short(PROMPT.replace(/\s+/g, " "), 300)}`);
  const result = check(
    await request("session/prompt", { sessionId, prompt: [{ type: "text", text: PROMPT }] }),
    "session/prompt",
  );
  say(`reply       ${promptFile ? reply.trim() : short(reply.trim(), 400)}`);
  say(
    `done        stop reason ${result.stopReason}; ${counts.toolCalls} tool calls, ${counts.permissions} permission requests,`,
  );
  say(`            ${counts.usageUpdates} usage updates, ${counts.rateLimits} rate-limit entries`);
  child.stdin.end();
  setTimeout(() => child.kill(), 3000).unref();
}

setTimeout(() => {
  say(`timed out after ${TIMEOUT_MS / 1000}s`);
  child.kill();
  process.exit(1);
}, TIMEOUT_MS).unref();

main().catch((error: unknown) => {
  say(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  child.kill();
  process.exit(1);
});
