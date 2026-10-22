// Restart and crash recovery (T63 audit, group 2): a graceful stop leaves tickets resumable, and the
// pieces a restart depends on stay consistent.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fold } from "@i-inc/core";
import { FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { AcpAgent, type AgentProcess } from "../src/acp.ts";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { AppleMachines, defaultMachineSettings } from "../src/machines.ts";
import { refunds, testApp } from "./setup.ts";

type Json = Record<string, unknown>;

/** An ACP server that starts a session and then never answers the prompt; it exits when its stdin ends. */
function silentAgentProcess(): AgentProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit: (c: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exit = r;
  });
  let buf = "";
  stdin.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Json;
      buf = buf.slice(i + 1);
      const reply = (r: Json) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...r })}\n`);
      if (m.method === "initialize") reply({ id: m.id, result: { protocolVersion: 1 } });
      if (m.method === "session/new") {
        reply({
          id: m.id,
          result: { sessionId: "s1", modes: { availableModes: [{ id: "bypassPermissions" }] } },
        });
      }
      if (m.method === "session/set_mode") reply({ id: m.id, result: {} });
    }
  });
  stdin.on("end", () => setTimeout(() => exit(0), 5));
  return { stdin, stdout, stderr, kill: () => exit(null), exited };
}

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting");
};

describe("2.1 a graceful stop mid-session", () => {
  for (const onStuck of ["switch", "escalate"] as const) {
    it(`leaves the ticket running and resumable (onStuck: ${onStuck})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "i-inc-recovery-"));
      const path = join(dir, "t.db");
      const clock = new FakeClock();
      const agent = new AcpAgent({
        launch: () => silentAgentProcess(),
        credentials: () => ({}),
        cwdFor: (id) => `/home/employee/work/inc-${id}`,
        now: () => clock.now(),
      });
      const first = await createApp({
        dbPath: path,
        knowledgeDir: join(dir, "k"),
        configDir: join(dir, "c"),
        clock,
        agent,
        harness: new FakeHarness(),
        helper: new FakeHelper(),
        chat: new FakeChat(),
        machines: new FakeMachines(),
      });
      seedDemo(first.deps.registry);
      for (const e of first.deps.registry.employees()) {
        first.deps.registry.hire({ ...e, switchRules: { ...e.switchRules, onStuck } });
      }
      first.daemon.ensureKnowledge();
      first.deps.tickets.create(
        { title: "Refunds", project: "Duet", type: "fix", effort: "low", doneWhen: ["x"], assignee: "ada" },
        clock.now(),
      );
      void first.daemon.tick();
      await until(async () =>
        (await first.deps.store.read("1")).some((e) => e.type === "session-started" && e.stage === "build"),
      );
      // Let the prompt reach the server, then what main.ts does on SIGTERM.
      await new Promise((r) => setTimeout(r, 50));
      await agent.shutdown(30);
      await first.daemon.idle();

      const types = (await first.deps.store.read("1")).map((e) => e.type);
      expect(types).not.toContain("failed");
      expect(types).not.toContain("engine-switched");
      expect(types).not.toContain("needs-you");
      expect(types).not.toContain("session-interrupted");
      expect(fold(await first.deps.store.read("1")).status).toBe("running");
      first.db.close();

      // The next daemon start picks it up and finishes it.
      const second = await testApp(path);
      await second.daemon.tick();
      await second.daemon.idle();
      const t = (await second.call("GET", "/api/tickets/1")).body.ticket;
      expect(t.status).toBe("ready");
      expect(second.agent.callsFor("ada", "build")).toHaveLength(1);
    });
  }
});

// The defaults, without the walls' marker, which exists only on the mini.
const { wallsMarker: _w, ...noWalls } = defaultMachineSettings;

const listing = (...rows: string[]) =>
  ["NAME  STATE  IP  CPUS  MEMORY", ...rows.map((r) => `${r}`)].join("\n");

describe("2.2 machines serialise boot and stop per machine", () => {
  it("two employees of one team starting together boot the machine once, and both are tracked", async () => {
    const calls: string[] = [];
    const exec = async (_b: string, args: string[]) => {
      calls.push(args.slice(0, 3).join(" "));
      await new Promise((r) => setTimeout(r, 20)); // a boot takes time
      return "";
    };
    const m = new AppleMachines({ ...noWalls, machineFor: () => "inc-eng" }, exec, async () => {});
    await Promise.all([m.ensureUp("ada"), m.ensureUp("kit")]);
    expect(calls.filter((c) => c.startsWith("machine run"))).toHaveLength(1);
    expect(m.running().sort()).toEqual(["ada", "kit"]);

    // Kit is done; Ada still works there, so the machine stays up.
    await m.stop("kit");
    expect(calls.filter((c) => c.startsWith("machine stop"))).toHaveLength(0);
    await m.stop("ada");
    expect(calls.filter((c) => c.startsWith("machine stop"))).toHaveLength(1);
  });

  it("a stop waits for a boot of the same machine, and runs after it", async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exec = async (_b: string, args: string[]) => {
      const what = args.slice(0, 2).join(" ");
      events.push(`start ${what}`);
      if (what === "machine run") await gate;
      events.push(`end ${what}`);
      return "";
    };
    const m = new AppleMachines({ ...noWalls, machineFor: () => "inc-eng" }, exec, async () => {});
    const boot = m.ensureUp("ada");
    const other = m.ensureUp("kit");
    const stopping = m.stop("kit");
    await new Promise((r) => setTimeout(r, 10));
    // Kit's stop is queued behind the boot, so no `machine stop` has started.
    expect(events).toEqual(["start machine run"]);
    release();
    await Promise.all([boot, other, stopping]);
    // Kit's stop released only Kit: Ada works in the machine, so it is still up, and booted once.
    expect(events).toEqual(["start machine run", "end machine run"]);
    expect(m.running()).toEqual(["ada"]);
  });

  it("a failed boot recovery's machine stop cannot land in the middle of another start", async () => {
    const order: string[] = [];
    let boots = 0;
    const exec = async (_b: string, args: string[]) => {
      const what = args.slice(0, 2).join(" ");
      order.push(what);
      if (what === "machine run") {
        boots++;
        await new Promise((r) => setTimeout(r, 10));
        // The first boot fails once (not the flaky message), so the recovery stops and boots again.
        if (boots === 1) throw new Error("boom");
      }
      return "";
    };
    const m = new AppleMachines({ ...noWalls, machineFor: () => "inc-eng" }, exec, async () => {});
    await Promise.all([m.ensureUp("ada"), m.ensureUp("kit")]);
    // run (fails), stop, run: one recovery for both, and no stop after the successful boot.
    expect(order).toEqual(["machine run", "machine stop", "machine run"]);
    expect(m.running().sort()).toEqual(["ada", "kit"]);
  });
});

describe("2.7 machines left running by an earlier daemon", () => {
  it("adopts the running ones, so stop() takes them down", async () => {
    const calls: string[][] = [];
    const exec = async (_b: string, args: string[]) => {
      calls.push(args);
      return args[1] === "ls"
        ? listing("inc-eng  running  192.168.64.5  4  8G", "inc-ops  stopped  -  4  8G")
        : "";
    };
    const m = new AppleMachines(
      { ...noWalls, machineFor: (id: string) => (id === "zed" ? "inc-ops" : "inc-eng") },
      exec,
      async () => {},
    );
    // Before: a fresh daemon knows nothing, so stop() does nothing.
    await m.stop("ada");
    expect(calls.filter((c) => c[1] === "stop")).toHaveLength(0);

    expect(await m.adopt(["ada", "kit", "zed"])).toEqual(["ada", "kit"]);
    expect(m.running().sort()).toEqual(["ada", "kit"]);
    await m.stop("ada");
    expect(calls.filter((c) => c[1] === "stop")).toHaveLength(0); // kit is still there
    await m.stop("kit");
    expect(calls.filter((c) => c[1] === "stop")).toEqual([["machine", "stop", "inc-eng"]]);
  });

  it("the daemon's idle sweep stops an adopted machine nothing uses", async () => {
    const app = await testApp();
    const machines = app.deps.machines as unknown as { leftRunning: string[]; stopped: string[] };
    machines.leftRunning.push("ada", "kit");
    expect((await app.daemon.adoptRunning()).sort()).toEqual(["ada", "kit"]);
    await app.daemon.tick();
    expect(machines.stopped.sort()).toEqual(["ada", "kit"]);
    // (A machine nobody started is not asked to stop.)
    await app.daemon.tick();
    expect(machines.stopped).toHaveLength(2);
  });
});

describe("2.2 the idle sweep looks again before each stop", () => {
  it("does not stop an employee who started work while an earlier stop was running", async () => {
    const app = await testApp();
    const fake = app.deps.machines as unknown as {
      stopped: string[];
      stop: (id: string) => Promise<void>;
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let stopping = "";
    const original = fake.stop.bind(fake);
    fake.stop = async (id: string) => {
      stopping ||= id;
      if (id === "ada") await gate;
      await original(id);
    };
    app.daemon.noteAwake("ada");
    app.daemon.noteAwake("quinn");
    const pass = app.daemon.tick();
    await until(async () => stopping === "ada");
    // Quinn's ticket starts while Ada's machine is being stopped; its session stays open.
    app.agent.on({ employee: "quinn" }, { kind: "hang" });
    app.deps.tickets.create(
      { title: "Chore", project: "Duet", type: "chore", effort: "low", doneWhen: ["x"], assignee: "quinn" },
      app.clock.now(),
    );
    app.daemon.run("1");
    await until(async () => app.agent.callsFor("quinn").length > 0);
    release();
    await pass;
    expect(fake.stopped).toContain("ada");
    expect(fake.stopped).not.toContain("quinn");
    app.daemon.interrupt("1", "quinn");
    await app.daemon.idle();
  });
});
