// Restart and crash recovery (T63 audit, group 2): a graceful stop leaves tickets resumable, and the
// pieces a restart depends on stay consistent.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { fold } from "@i-inc/core";
import { FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it, vi } from "vitest";
import { AcpAgent, type AgentProcess } from "../src/acp.ts";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { AppleMachines, defaultMachineSettings } from "../src/machines.ts";
import { Storage } from "../src/storage.ts";
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

describe("6.3 the daemon redacts and caps whatever an agent says", () => {
  it("keeps a token and a wall of text out of the failed event", async () => {
    const app = await testApp();
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`;
    // A reason from any agent: onStuck fail → the ticket's failed reason is what the API serves.
    for (const e of app.deps.registry.employees()) {
      app.deps.registry.hire({
        ...e,
        engines: { ...e.engines, fallbacks: [] },
        switchRules: { ...e.switchRules, onStuck: "escalate" },
      });
    }
    app.agent.on(
      { employee: "ada", duty: "plan" },
      { kind: "stuck", reason: `it broke with ${secret} ${"y".repeat(3000)}` },
    );
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const needs = (await app.deps.store.read("1")).find((e) => e.type === "needs-you");
    const reason = needs?.type === "needs-you" && needs.ask.kind === "stuck" ? needs.ask.reason : "";
    expect(reason).toContain("it broke with [redacted]");
    expect(reason).not.toContain(secret);
    expect(reason.length).toBeLessThan(600);
  });
});

describe("2.8 a follow-up and its dedupe row are one write", () => {
  it("files nothing when the dedupe row can't be written, so the next pass can't file it twice", async () => {
    const app = await testApp();
    const followUps = {
      type: "follow-ups" as const,
      at: app.clock.now(),
      employeeId: "ada",
      tickets: [
        {
          title: "Test refunds across months",
          doneWhen: ["a test"],
          type: "chore" as const,
          effort: "low" as const,
          reason: "only same-month refunds are tested",
        },
      ],
    };
    await app.call("POST", "/api/tickets", { ...refunds });
    await app.daemon.idle();
    const before = app.deps.tickets.all().length;
    const run = app.deps.db.run.bind(app.deps.db);
    let broken = true;
    app.deps.db.run = (sql, ...params) => {
      if (broken && sql.includes("INTO knowledge_applied") && String(params[0]).startsWith("followup:")) {
        throw new Error("disk full");
      }
      return run(sql, ...params);
    };
    expect(() => app.daemon.fileFollowUps("1", [followUps])).toThrow("disk full");
    // Rolled back: no ticket, and no proposal, was left behind.
    expect(app.deps.tickets.all().length).toBe(before);

    broken = false;
    app.daemon.fileFollowUps("1", [followUps]);
    app.daemon.fileFollowUps("1", [followUps]);
    expect(app.deps.tickets.all().length).toBe(before + 1);
  });
});

const GB = 1024 ** 3;
const DAY_MIN = 24 * 60;

/** A storage over the app's (in-memory) database, with a home folder, a push and a disk we can fill. */
function storageFor(
  app: Awaited<ReturnType<typeof testApp>>,
  extra: Partial<ConstructorParameters<typeof Storage>[0]> = {},
) {
  const home = mkdtempSync(join(tmpdir(), "i-inc-storage-home-"));
  const push = { send: vi.fn(async () => {}) };
  const logs: string[] = [];
  const state = { busy: false, free: (500 * GB) as number | null };
  const storage = new Storage({
    db: app.db,
    clock: app.clock,
    registry: app.deps.registry,
    tickets: app.deps.tickets,
    events: app.deps.store,
    paths: { home, dbPath: join(home, "i-inc.db"), knowledgeDir: join(home, "knowledge") },
    push,
    log: (m) => logs.push(m),
    machineBusy: async () => false,
    hostBusy: () => state.busy,
    ticketActive: () => false,
    footprint: () => ({}),
    freeBytes: () => state.free,
    trim: false,
    ...extra,
  });
  return { storage, push, logs, home, state };
}

describe("2.6 a daily copy of the database", () => {
  it("copies the database once a day, when idle, under the name the prune keeps 30 days of", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const { storage, home, state } = storageFor(app);

    // Busy: no copy.
    state.busy = true;
    expect((await storage.maintainHost({ manual: true })).backup).toEqual({ skipped: "busy" });
    expect(readdirSync(home).filter((n) => n.includes("autobak"))).toEqual([]);

    state.busy = false;
    const first = await storage.maintainHost({ manual: true });
    expect(first.backup).toEqual({ made: "i-inc.db.autobak-2026-09-27" });
    // It is a whole database: the ticket's events are in it.
    const copy = new DatabaseSync(join(home, "i-inc.db.autobak-2026-09-27"));
    const events = copy.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    copy.close();
    expect(events.n).toBeGreaterThan(5);
    expect(readdirSync(home).some((n) => n.endsWith(".partial"))).toBe(false);

    // Same day: nothing new. Next day: another.
    expect((await storage.maintainHost({ manual: true })).backup).toEqual({
      skipped: "today's copy is there",
    });
    app.clock.advance(DAY_MIN);
    expect((await storage.maintainHost({ manual: true })).backup).toEqual({
      made: "i-inc.db.autobak-2026-09-28",
    });
  });

  it("does not copy when the disk has no room for it", async () => {
    const app = await testApp();
    const { storage, home, state } = storageFor(app);
    state.free = 1;
    expect((await storage.maintainHost({ manual: true })).backup).toEqual({
      skipped: "not enough free disk for a copy",
    });
    expect(readdirSync(home).filter((n) => n.includes("autobak"))).toEqual([]);
  });
});

describe("2.6 the integrity check at startup", () => {
  it("is silent on a healthy database", async () => {
    const app = await testApp();
    const { storage, push, logs } = storageFor(app);
    expect(await storage.checkIntegrity()).toEqual([]);
    expect(push.send).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("logs loudly and pushes the owner when it fails, and the daemon goes on", async () => {
    const app = await testApp();
    const { storage, push, logs } = storageFor(app);
    const all = app.db.all.bind(app.db);
    app.db.all = ((sql: string, ...params: never[]) =>
      sql.startsWith("PRAGMA quick_check")
        ? [{ quick_check: "row 7 missing from index events_ticket" }]
        : all(sql, ...params)) as typeof app.db.all;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const found = await storage.checkIntegrity();
    error.mockRestore();
    expect(found).toEqual(["row 7 missing from index events_ticket"]);
    expect(logs.join("\n")).toContain("DATABASE INTEGRITY CHECK FAILED");
    expect(push.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The database failed its integrity check" }),
    );
    // Still serving: the API answers and a ticket still runs.
    app.db.all = all;
    expect((await app.call("GET", "/api/board")).status).toBe(200);
  });
});

describe("2.6 the low-disk gate", () => {
  it("does not start new tickets while the host has under 5 GB free, says why on the ticket, and starts them once there is room", async () => {
    const app = await testApp();
    const { storage, state } = storageFor(app);
    app.daemon.storage = storage;
    state.free = 2 * GB;
    expect(storage.lowDisk()).toContain("2.0 GB free, 5 GB needed");

    const created = await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    const id = created.body.ticket?.id ?? "1";
    expect(await app.deps.store.read(id)).toEqual([]);
    const card = (await app.call("GET", `/api/tickets/${id}`)).body.ticket;
    expect(JSON.stringify(card)).toContain("nearly full");

    state.free = 50 * GB;
    expect(storage.lowDisk()).toBeNull();
    await app.daemon.tick();
    await app.daemon.idle();
    expect((await app.call("GET", `/api/tickets/${id}`)).body.ticket.status).toBe("ready");
  });

  it("does not hold a ticket that was running when the daemon restarted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-lowdisk-"));
    const path = join(dir, "t.db");
    const first = await testApp(path);
    first.agent.on({ stage: "build" }, { kind: "crash" });
    await first.call("POST", "/api/tickets", refunds);
    await first.daemon.idle();
    expect((await first.call("GET", "/api/tickets/1")).body.ticket.status).toBe("running");
    first.db.close();

    const second = await testApp(path);
    const { storage, state } = storageFor(second);
    second.daemon.storage = storage;
    state.free = 1 * GB;
    // A new ticket waits; the one that was running goes on.
    await second.call("POST", "/api/tickets", { ...refunds, title: "Another" });
    await second.daemon.tick();
    await second.daemon.idle();
    expect((await second.call("GET", "/api/tickets/1")).body.ticket.status).toBe("ready");
    expect(await second.deps.store.read("2")).toEqual([]);
  });

  it("is configurable, and off at 0", async () => {
    const app = await testApp();
    const { storage, state } = storageFor(app);
    state.free = 8 * GB;
    expect(storage.lowDisk()).toBeNull();
    expect(storage.update({ minFreeGb: 10 })).toMatchObject({ settings: { minFreeGb: 10 } });
    expect(storage.lowDisk()).toContain("10 GB needed");
    storage.update({ minFreeGb: 0 });
    state.free = 1;
    expect(storage.lowDisk()).toBeNull();
  });

  it("an unknown free size (an in-memory database) never gates", async () => {
    const app = await testApp();
    const { storage, state } = storageFor(app);
    state.free = null;
    expect(storage.lowDisk()).toBeNull();
  });
});

describe("2.6 storage.maintain survives a full disk", () => {
  it("logs a failed save instead of rejecting", async () => {
    const app = await testApp();
    const machines = [{ name: "inc-eng", state: "stopped" as const, diskBytes: 5 * GB }];
    const { storage, logs } = storageFor(app, {
      ops: {
        machineFor: () => "inc-eng",
        listMachines: async () => machines,
        runIn: async () => "",
      },
    });
    const run = app.db.run.bind(app.db);
    app.db.run = ((sql: string, ...params: never[]) => {
      if (sql.includes("INTO storage_state") && String(params[0]).startsWith("machine:")) {
        throw new Error("database or disk is full");
      }
      return run(sql, ...params);
    }) as typeof app.db.run;
    await expect(storage.maintain()).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("couldn't save inc-eng's state: database or disk is full");
  });
});
