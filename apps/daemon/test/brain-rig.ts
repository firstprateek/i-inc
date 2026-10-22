// A daemon with real knowledge repos and a fake sandbox for the brain's copy: scripts that would run in a
// machine run in bash here, with the machine's `/home/employee/brain` replaced by a temp folder.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeAgent, FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { defaultMachineSettings } from "../src/machines.ts";
import { realPorts } from "../src/real.ts";
import { FakeSandbox } from "./ahp/fake-acp.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

export const page = (title: string, description: string, body: string, tags: string[] = [], extra = "") =>
  `---\ntitle: ${title}\ndescription: ${description}\ntags: [${tags.join(", ")}]\nupdated: 2026-10-01\nsources: []\n${extra}---\n${body}\n`;

const dirs: string[] = [];
export function cleanRigs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export interface Run {
  employeeId: string;
  script: string;
  /** The machine named for the script, when it isn't the employee's own. */
  machine?: string | undefined;
}

/**
 * `real`: the daemon runs on real mode's ports (the ACP client, the session host) with a scripted ACP agent
 * behind them (`fake`), and the brain's scripts run in bash on a folder; any other script gets "@@ready".
 */
export async function brainRig(o: { delivered?: boolean; real?: boolean } = {}) {
  const knowledgeDir = mkdtempSync(join(tmpdir(), "i-inc-kn-"));
  const sandbox = mkdtempSync(join(tmpdir(), "i-inc-sbx-"));
  dirs.push(knowledgeDir, sandbox);
  const clock = new FakeClock();
  const logs: string[] = [];
  const runs: Run[] = [];
  const failing = { next: false };
  const local = async (
    employeeId: string,
    script: string,
    _env?: Record<string, string>,
    opts?: { machine?: string },
  ) => {
    runs.push({ employeeId, script, machine: opts?.machine });
    if (failing.next) return { code: 1, output: "boom" };
    const r = spawnSync("bash", ["-s"], { input: script, encoding: "utf8", maxBuffer: 1 << 28 });
    return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
  };
  const fake = new FakeSandbox();
  /** Whether the machines are running (a copy is never made, or removed, by starting one). */
  const machineUp = { value: true };
  const setUp = (up: boolean) => {
    machineUp.value = up;
    (feed as unknown as { upSeen: Map<string, unknown> }).upSeen.clear();
  };
  const ports = o.real
    ? realPorts({
        credentials: { "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" } },
        machine: noWalls,
        exec: async () => "",
        launch: fake.launch,
        isUp: async () => machineUp.value,
        runScript: async (employeeId, script, _env, opts) =>
          /__INC_TAR__|\.snapshot\.id|@@removed|refs\/inc\/baseline/.test(script)
            ? local(employeeId, script, {}, opts)
            : { code: 0, output: "@@ready\n" },
        log: (m) => logs.push(m),
      })
    : { agent: new FakeAgent(), harness: new FakeHarness(), machines: new FakeMachines() };
  const app = await createApp({
    log: (m) => logs.push(m),
    dbPath: ":memory:",
    knowledgeDir,
    configDir: join(knowledgeDir, "config"),
    clock,
    helper: new FakeHelper(),
    chat: new FakeChat(),
    brainHome: sandbox,
    ...ports,
  });
  seedDemo(app.deps.registry);
  app.deps.registry.addTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit"] });
  // A PA works alone in its sandbox (hiring makes this team; the demo cast was seeded without one).
  app.deps.registry.addTeam({ id: "home-pip", name: "Pip's home", members: ["pip"] });
  app.daemon.ensureKnowledge();
  const feed = app.deps.brainFeed;
  if (!o.real && o.delivered !== false) feed.deliver = local;
  if (!o.real) feed.isUp = async () => machineUp.value;
  const dirOf = (repo: string) =>
    repo === "handbook" ? join(knowledgeDir, "handbook") : join(knowledgeDir, "brains", repo);
  const git = (repo: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], {
      cwd: dirOf(repo),
      stdio: "pipe",
    });
  /** Writes files into a repo and commits them; the index follows, as it does after a real commit. */
  const commit = (repo: string, files: Record<string, string | null>, message = "pages") => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git(repo, "rm", "-q", path);
      else {
        mkdirSync(dirname(join(dirOf(repo), path)), { recursive: true });
        writeFileSync(join(dirOf(repo), path), text);
      }
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", message);
    app.deps.knowledge.onCommit?.(repo === "handbook" ? { kind: "handbook" } : { kind: "brain", id: repo });
  };
  /** Where an employee's copy is on the fake sandbox. */
  const copy = (employeeId: string, ...rest: string[]) => join(sandbox, employeeId, ...rest);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://i.inc${path}`, {
        method,
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } }),
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: tests read the API's JSON loosely.
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return {
    app,
    logs,
    machineUp,
    setUp,
    call,
    fake,
    feed,
    runs,
    failing,
    commit,
    git: (repo: string, ...a: string[]) => git(repo, ...a).toString(),
    copy,
    sandbox,
    knowledgeDir,
    clock,
  };
}
