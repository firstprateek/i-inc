// A local daemon for the end-to-end run of shipping a conversation's work (T62b), under Bun, in a scratch HOME:
//
//   pnpm --filter @i-inc/web build
//   HOME=$(mktemp -d) PORT=7461 bun apps/daemon/scripts/e2e-ship-server.ts
//
// It is the real daemon (API, AHP host, session host, the ticket pipeline and its real harness) in real mode,
// with nothing real behind it: the sandbox's scripts run in bash against real git (local bare repos stand in
// for GitHub, folders under $HOME/world/work for the machine), the conversations' agent is the scripted ACP
// fake, tickets' agents are the core's FakeAgent (reviews wait at a gate the run opens), and GitHub's pull
// request API is an in-memory fake. Two projects: Duet (owner-merges) and Notes (direct).
// Control, for the run only: POST /__e2e {"op": "write"|"checks"|"gate"|"prs"|"git", ...}
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { Agent, SessionRequest } from "@i-inc/core";
import { FakeAgent, FakeChat, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import type { WsData } from "../src/ahp/transport.ts";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import type { PullRequests } from "../src/github.ts";
import type { RunScript } from "../src/harness.ts";
import { defaultMachineSettings } from "../src/machines.ts";
import { realPorts } from "../src/real.ts";
import { FakeSandbox } from "../test/ahp/fake-acp.ts";
import { FakePrs } from "../test/ship-rig.ts";

const home = process.env.HOME;
if (!home || home.includes(".i-inc") || home === process.env.REAL_HOME)
  throw new Error("set HOME to a scratch folder");
const port = Number(process.env.PORT ?? 7461);
const web = join(import.meta.dir, "../../web/dist");
const log = (m: string) => console.log(new Date().toISOString(), m);

// ── the world: two projects' remotes, and the machine's work folder ──
const world = mkdtempSync(join(home, "world-"));
const work = join(world, "work");
mkdirSync(work, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();
const origins: Record<string, string> = {};
for (const [name, files] of Object.entries({
  duet: {
    "README.md": "duet\n",
    ".github/workflows/ci.yml": "name: ci\n",
    "src/app.ts": "export const app = 1;\n",
  },
  notes: { "README.md": "notes\n", "src/notes.ts": "export const notes = [];\n" },
})) {
  const seed = join(world, `${name}-seed`);
  git(world, "init", "-q", "-b", "main", seed);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=o", "-c", "user.email=o@example.invalid", "commit", "-q", "-m", "base");
  origins[name] = join(world, `${name}.git`);
  git(world, "clone", "-q", "--bare", seed, origins[name]);
}
const originOf = (repo: string) => origins[repo.split("/")[1] ?? ""] ?? "";

const runScript: RunScript = (_employee, script, extra = {}) => {
  if (script.includes("gh auth login")) return Promise.resolve({ code: 0, output: "@@signed-in\n" });
  if (script.includes(".inc-agents")) return Promise.resolve({ code: 0, output: "" });
  let s = script.replaceAll("/home/employee/work", work);
  for (const [name, path] of Object.entries(origins))
    s = s.replaceAll(`https://github.com/acme/${name}.git`, path);
  return new Promise((resolve) => {
    const child = spawn("bash", ["-s"], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
    child.stdin.end(s);
  });
};

// Tickets' agents: the core's scripted one, with reviews held at a gate until the run opens it.
const fake = new FakeAgent();
const gate = { open: false, waiters: [] as (() => void)[] };
const agent: Agent = {
  async run(req: SessionRequest) {
    if (req.stage === "review" && !gate.open) await new Promise<void>((r) => gate.waiters.push(r));
    return fake.run(req);
  },
};

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;
const sandbox = new FakeSandbox();
const prs = new FakePrs(originOf);
const ports = realPorts({
  credentials: { "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } },
  machine: noWalls,
  exec: async () => "",
  launch: sandbox.launch,
  runScript,
  github: {
    tokens: { token: async () => "ghs_e2e_token" },
    slug: "i-inc-bot",
    prs: prs as unknown as PullRequests,
  },
  identity: async (e) => ({ name: `${e.name} (i.inc)`, email: "1+i-inc-bot[bot]@users.noreply.github.com" }),
  ci: async () => ({ ok: true }),
  log,
});
const knowledgeDir = mkdtempSync(join(tmpdir(), "i-inc-e2e-knowledge-"));
const app = await createApp({
  dbPath: ":memory:",
  knowledgeDir,
  configDir: join(knowledgeDir, "config"),
  clock: { now: () => Date.now() },
  hosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  log,
  ...ports,
  machines: new FakeMachines(),
  agent,
  helper: new FakeHelper(),
  chat: new FakeChat(),
});
seedDemo(app.deps.registry);
for (const p of app.deps.registry.projects()) app.deps.registry.removeProject(p.id);
app.deps.registry.addProject({
  id: "Duet",
  repo: "acme/duet",
  checks: ["true"],
  mode: "owner-merges",
  protectedPaths: [".github/"],
});
app.deps.registry.addProject({ id: "Notes", repo: "acme/notes", checks: ["true"], mode: "direct" });
app.ahp.transport.start();
const backend = app.ahp.backend as { start?: () => void };
backend.start?.();

async function control(req: Request): Promise<Response> {
  // biome-ignore lint/suspicious/noExplicitAny: the run's own control messages
  const b = (await req.json()) as Record<string, any>;
  if (b.op === "write") {
    const file = join(work, `conv-${b.conversation}`, b.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, b.text);
    return Response.json({ ok: true });
  }
  if (b.op === "checks") {
    prs.checkState = b.checks;
    return Response.json({ ok: true });
  }
  if (b.op === "gate") {
    gate.open = b.open === true;
    if (gate.open) for (const w of gate.waiters.splice(0)) w();
    return Response.json({ ok: true });
  }
  if (b.op === "prs") return Response.json({ prs: prs.prs, calls: prs.calls });
  if (b.op === "git") return Response.json({ out: git(world, "--git-dir", originOf(b.repo), ...b.args) });
  return Response.json({ error: "unknown op" }, { status: 400 });
}

async function serveWeb(req: Request): Promise<Response> {
  const path = normalize(new URL(req.url).pathname).replace(/^(\.\.[/\\])+/, "");
  const file = Bun.file(join(web, path === "/" ? "index.html" : path));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(web, "index.html")));
}

Bun.serve<WsData>({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  fetch: (req, server) => {
    const path = new URL(req.url).pathname;
    if (path === "/__e2e" && req.method === "POST") return control(req);
    if (app.ahp.transport.matches(req)) {
      const g = app.ahp.transport.guard(req);
      if ("refusal" in g) return g.refusal;
      if (server.upgrade(req, { data: g.data })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    return path.startsWith("/api/") || !existsSync(web) ? app.handle(req) : serveWeb(req);
  },
  websocket: app.ahp.transport.websocket,
});
console.log(`ready: shipping e2e daemon on http://127.0.0.1:${port} (home ${home})`);
