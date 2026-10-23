// A conversation with a stopped machine (T74). Machines sleep when idle, and the guard refuses to run anything in
// one that is stopped (T66/T70), so a conversation boots the machine itself, the way a ticket does, before it runs
// its first script. Real mode's wiring, the real guard (`assertRunnable`) and the real walls, with a fake `container`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@i-inc/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { seedDemo } from "../../src/demo.ts";
import { EgressWall, machineAddress } from "../../src/egress-wall.ts";
import { assertRunnable, type Exec, type MachineSettings, rootProbeScript } from "../../src/machines.ts";
import { realPorts } from "../../src/real.ts";
import { FakeSandbox } from "./fake-acp.ts";
import { until } from "./session-rig.ts";
import { type Any, TestClient, turnStarted } from "./support.ts";

let dir: string;
let machines: Map<string, { ip: string; state: "running" | "stopped" }>;
const events: string[] = [];
let sandbox: FakeSandbox;
let wallSettings: ConstructorParameters<typeof EgressWall>[0];

const listing = () =>
  [
    "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
    ...[...machines].map(
      ([name, m]) =>
        `${name.padEnd(16)} 2026-10-21 10:00:00  ${(m.state === "running" ? m.ip : "-").padEnd(14)} 2     4G      3.6G  ${m.state}`,
    ),
  ].join("\n");

/** What walls.sh does: write the acknowledgement from what the daemon declared (a look at the machines may be a moment it runs). */
function wallsJob() {
  let declared: string[] = [];
  try {
    declared = readFileSync(wallSettings.declared, "utf8").split("\n");
  } catch {
    // nothing declared yet
  }
  writeFileSync(
    wallSettings.ack,
    declared
      .filter((l) => machineAddress.test(l))
      .map((a) => `${a}\n`)
      .join(""),
  );
  const now = Date.now() / 1000;
  utimesSync(wallSettings.ack, now, now);
}

const exec: Exec = async (_bin, args, opts) => {
  if (args[1] === "ls") {
    wallsJob();
    return listing();
  }
  if (args[1] === "stop") {
    const m = machines.get(args[2] as string);
    if (m) m.state = "stopped";
    events.push(`stop ${args[2]}`);
    return "";
  }
  if (args[1] === "run") {
    const name = args[args.indexOf("-n") + 1] as string;
    if (opts?.input === rootProbeScript) return "@@checked\n";
    if (args[args.indexOf("-u") + 1] === "root") return "@@no-root\n";
    if (args.includes("true")) {
      const m = machines.get(name);
      if (!m) throw new Error("notFound: machine not found");
      m.state = "running";
      events.push(`boot ${name}`);
    }
  }
  return "";
};

const machineOf = (employeeId: string) => (employeeId === "pip" ? "inc-home-pip" : "inc-engineering");
// The settings the guard checks with: the ones real mode builds from the teams.
const guardSettings = (): MachineSettings => ({
  bin: "container",
  image: "img",
  user: "employee",
  cpus: 6,
  memory: "12G",
  machineFor: machineOf,
  homeMachine: (m) => m === "inc-home-pip",
  wall: new EgressWall(wallSettings),
});

async function rig() {
  const scripts: { employeeId: string; script: string }[] = [];
  const settings = guardSettings();
  const ports = realPorts({
    credentials: { "claude-pro": { CLAUDE_CODE_OAUTH_TOKEN: "sk-x" }, local: {} },
    machine: { ...settings, wall: settings.wall as EgressWall },
    exec,
    // The guard in front of every script and every launch, as machineScript and machineLaunch have it.
    runScript: async (employeeId, script) => {
      await assertRunnable(settings, exec, machineOf(employeeId));
      events.push(`script ${machineOf(employeeId)}`);
      scripts.push({ employeeId, script });
      return { code: 0, output: "@@ready\n" };
    },
    launch: async (r) => {
      await assertRunnable(settings, exec, machineOf(r.employeeId));
      events.push(`launch ${machineOf(r.employeeId)}`);
      return sandbox.launch(r);
    },
    log: () => {},
  });
  const base = await import("@i-inc/core/testing");
  const app = await createApp({
    dbPath: ":memory:",
    knowledgeDir: mkdtempSync(join(tmpdir(), "inc-knowledge-")),
    clock: new FakeClock(),
    ...ports,
    helper: new base.FakeHelper(),
    chat: new base.FakeChat(),
  });
  seedDemo(app.deps.registry);
  app.deps.registry.addTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit"] });
  app.deps.registry.addTeam({ id: "home-pip", name: "Home", members: ["pip"] });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://i.inc${path}`, {
        method,
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json" } }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Any };
  };
  return { app, scripts, call };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-convboot-"));
  mkdirSync(join(dir, "i-inc"));
  wallSettings = {
    declared: join(dir, "i-inc", "open-machines"),
    ack: join(dir, "i-inc-walls.open"),
    ackMaxAgeMs: 120_000,
    waitMs: 20_000,
    pollMs: 5,
  };
  machines = new Map([
    ["inc-home-pip", { ip: "192.168.64.7", state: "stopped" }],
    ["inc-engineering", { ip: "192.168.64.8", state: "stopped" }],
  ]);
  events.length = 0;
  sandbox = new FakeSandbox();
  wallsJob(); // the walls job has been running: a fresh acknowledgement
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const say = async (app: Awaited<ReturnType<typeof rig>>["app"], c: Any, text: string) => {
  const client = new TestClient(app.ahp.host);
  await client.init(["ahp-root://", c.ahpSession, c.ahpChat]);
  client.dispatch(c.ahpChat, turnStarted(text, "t1"));
  await until(() => app.ahp.host.chatState(c.ahpChat)?.turns.length === 1, 8000);
  return app.ahp.host.chatState(c.ahpChat)?.turns[0];
};

describe.each([
  { who: "a PA's stopped home machine", employeeId: "pip", machine: "inc-home-pip" },
  { who: "a stopped team machine", employeeId: "ada", machine: "inc-engineering" },
])("a conversation with $who", ({ employeeId, machine }) => {
  it("boots the machine first, then makes its copy and runs the first turn", async () => {
    const { app, scripts, call } = await rig();
    const made = await call("POST", "/api/conversations", { employeeId });
    // Before T74 this was a 502: "<machine> isn't running, so nothing is run in it".
    expect(made.status).toBe(201);
    const c = made.body.conversation;
    expect(machines.get(machine)?.state).toBe("running");
    // The boot (and the walls' look at it) comes before the first script and the launch.
    expect(events.indexOf(`boot ${machine}`)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(`boot ${machine}`)).toBeLessThan(events.indexOf(`script ${machine}`));
    expect(events.indexOf(`script ${machine}`)).toBeLessThan(events.indexOf(`launch ${machine}`));
    expect(scripts[0]?.script).toContain(`mkdir -p '/home/employee/work/conv-${c.id}'`);
    const turn = await say(app, c, "plain hello");
    expect(turn?.state).toBe("complete");
    // A PA's machine was shut in (declared closed) before anything ran; a team's was let out.
    const declared = readFileSync(wallSettings.declared, "utf8");
    expect(declared.includes("192.168.64.7")).toBe(false);
    if (machine === "inc-engineering") expect(declared).toContain("192.168.64.8");
  });

  it("says the sandbox is starting, instead of failing, when the machine went to sleep after the agent's settings were known", async () => {
    const { app, call } = await rig();
    const first = (await call("POST", "/api/conversations", { employeeId })).body.conversation;
    expect((await say(app, first, "hello")).state).toBe("complete");
    // The machine sleeps (nothing live): stopped, and forgotten as awake.
    await app.deps.machines.stop?.(employeeId);
    (app.daemon as unknown as { awake: Set<string> }).awake.delete(employeeId);
    expect(machines.get(machine)?.state).toBe("stopped");
    events.length = 0;

    const made = await call("POST", "/api/conversations", { employeeId });
    expect(made.status).toBe(201);
    // Made at once, nothing run in the stopped machine yet.
    expect(machines.get(machine)?.state).toBe("stopped");
    expect(events).toEqual([]);
    const turn = await say(app, made.body.conversation, "wake up");
    expect(turn?.state).toBe("complete");
    const label = employeeId === "pip" ? "Pip's sandbox" : "the engineering sandbox";
    expect(JSON.stringify(turn?.responseParts)).toContain(`Starting ${label}…`);
    expect(machines.get(machine)?.state).toBe("running");
    expect(events.indexOf(`boot ${machine}`)).toBeLessThan(events.indexOf(`script ${machine}`));
    expect(app.ahp.host.chatState(made.body.conversation.ahpChat)?.activity).toBeUndefined();
  });
});
