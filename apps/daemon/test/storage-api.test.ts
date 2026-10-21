// GET /api/storage, PUT /api/storage/settings, POST /api/storage/cleanup (contract C23), and the
// daemon's own pass cleaning a machine that is up and idle just before it would stop it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent, FakeChat, FakeClock, FakeHarness, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { type MachineOps, Storage } from "../src/storage.ts";
import { refunds, testApp } from "./setup.ts";

const DAY_MIN = 24 * 60;

function ops(over: Partial<MachineOps> & { scripts?: string[]; state?: "running" | "stopped" } = {}) {
  const scripts = over.scripts ?? [];
  const out: MachineOps = {
    machineFor: () => "inc-engineering",
    listMachines: async () => [
      { name: "inc-engineering", state: over.state ?? "running", diskBytes: 5_000_000_000 },
    ],
    runIn: async (_m, script) => {
      scripts.push(script);
      return "@@df 1000000 400000\n@@df-after 1000000 400000\n@@done";
    },
    ...over,
  };
  return { ops: out, scripts };
}

/** Puts a Storage over fake machine operations into the app, the way createApp does for the real ones. */
function withOps(app: Awaited<ReturnType<typeof testApp>>, machineOps: MachineOps) {
  app.deps.registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit", "quinn"] });
  const home = mkdtempSync(join(tmpdir(), "i-inc-storage-api-"));
  const storage = new Storage({
    db: app.db,
    clock: app.clock,
    registry: app.deps.registry,
    tickets: app.deps.tickets,
    events: app.deps.store,
    paths: { home, dbPath: join(home, "i-inc.db"), knowledgeDir: join(home, "knowledge") },
    ops: machineOps,
    machineBusy: (m) => app.daemon.machineBusy(m),
    hostBusy: () => app.daemon.busy(),
    ticketActive: (id) => app.daemon.isRunning(id),
    footprint: () => app.daemon.footprint(),
    trim: false,
  });
  app.deps.storage = storage;
  app.daemon.storage = storage;
  return storage;
}

describe("GET /api/storage", () => {
  it("reports each machine, the host and the daemon's memory", async () => {
    const app = await testApp();
    withOps(app, ops().ops);
    const { status, body } = await app.call("GET", "/api/storage");
    expect(status).toBe(200);
    expect(body.settings).toMatchObject({
      sandboxCleanupDays: 3,
      transcriptCompactDays: 30,
      diskWarnPct: 80,
    });
    expect(body.defaults.sandboxCleanupDays).toBe(3);
    expect(body.machines).toEqual([
      expect.objectContaining({
        team: "engineering",
        machine: "inc-engineering",
        state: "running",
        diskBytes: 5_000_000_000,
        fs: null,
        lastCleanup: null,
        freedBytesTotal: 0,
      }),
    ]);
    expect(body.host.db.bytes).toBeGreaterThanOrEqual(0);
    expect(body.host).toHaveProperty("knowledgeBytes");
    expect(body.host.imageLimits).toEqual({ perRequest: 6, bytesEach: 10 * 1024 * 1024, perTicket: 24 });
    expect(body.host.rows.images).toMatchObject({ count: 0, bytes: 0, largestTicket: null });
    expect(body.memory.rssBytes).toBeGreaterThan(0);
    expect(body.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(body.memory.structures).toMatchObject({ daemonRunning: 0, daemonSessions: 0, sessionsActive: 0 });
  });

  it("measures the images the owner uploaded, and doesn't touch them", async () => {
    const app = await testApp();
    withOps(app, ops().ops);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const t = app.deps.tickets.create({ ...refunds, type: "fix", effort: "low" }, 1, [
      { name: "a.png", mime: "image/png", data: png },
      { name: "b.png", mime: "image/png", data: png },
    ]);
    const { body } = await app.call("GET", "/api/storage");
    expect(body.host.rows.images).toEqual({
      count: 2,
      bytes: png.length * 2,
      largestTicket: { ticket: t.id, bytes: png.length * 2 },
    });
    await app.deps.storage?.cleanupNow({ dryRun: false });
    expect(app.deps.tickets.attachments(t.id)).toHaveLength(2);
  });

  it("shows a daemon without machines as having no machine data", async () => {
    const app = await testApp();
    const { body } = await app.call("GET", "/api/storage");
    expect(body.machines).toEqual([]);
  });
});

describe("PUT /api/storage/settings", () => {
  it("saves valid settings and refuses the rest", async () => {
    const app = await testApp();
    const ok = await app.call("PUT", "/api/storage/settings", { sandboxCleanupDays: 5, logKeep: 3 });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ sandboxCleanupDays: 5, logKeep: 3, cacheCapGb: 2 });
    expect((await app.call("GET", "/api/storage")).body.settings.sandboxCleanupDays).toBe(5);

    for (const bad of [{ sandboxCleanupDays: "3" }, { logKeep: 0 }, { diskWarnPct: 120 }, { nope: 1 }]) {
      const r = await app.call("PUT", "/api/storage/settings", bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toEqual(expect.any(String));
    }
    expect((await app.call("GET", "/api/storage")).body.settings.sandboxCleanupDays).toBe(5);
  });
});

describe("POST /api/storage/cleanup", () => {
  it("is a dry run unless the body says otherwise", async () => {
    const app = await testApp();
    const { ops: machineOps, scripts } = ops();
    withOps(app, machineOps);
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    app.clock.advance(5 * DAY_MIN);

    const dry = await app.call("POST", "/api/storage/cleanup", {});
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.machines[0]).toMatchObject({ machine: "inc-engineering", status: "dry-run" });
    expect(dry.body.host.dryRun).toBe(true);
    expect(scripts.at(-1)).toContain("DRY=1");

    const real = await app.call("POST", "/api/storage/cleanup", { dryRun: false });
    expect(real.body.dryRun).toBe(false);
    expect(real.body.machines[0]).toMatchObject({ status: "cleaned" });
    expect(scripts.at(-1)).toContain("DRY=0");
    expect(scripts.at(-1)).toContain("for id in 1; do");

    expect((await app.call("POST", "/api/storage/cleanup", { dryRun: "no" })).status).toBe(400);
  });

  it("never starts a machine that is stopped", async () => {
    const app = await testApp();
    const { ops: machineOps, scripts } = ops({ state: "stopped" });
    withOps(app, machineOps);
    const r = await app.call("POST", "/api/storage/cleanup", { dryRun: false });
    expect(r.body.machines[0]).toMatchObject({ status: "skipped" });
    expect(scripts).toEqual([]);
  });
});

describe("the API needs the login", () => {
  it("refuses all three routes without the token", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      knowledgeDir: mkdtempSync(join(tmpdir(), "i-inc-knowledge-")),
      clock: new FakeClock(),
      agent: new FakeAgent(),
      harness: new FakeHarness(),
      helper: new FakeHelper(),
      chat: new FakeChat(),
      machines: new FakeMachines(),
      token: "secret",
    });
    for (const [method, path] of [
      ["GET", "/api/storage"],
      ["PUT", "/api/storage/settings"],
      ["POST", "/api/storage/cleanup"],
    ] as const) {
      const res = await app.handle(
        new Request(`http://i.inc${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
      expect(res.status).toBe(401);
    }
    const ok = await app.handle(
      new Request("http://i.inc/api/storage", { headers: { authorization: "Bearer secret" } }),
    );
    expect(ok.status).toBe(200);
  });
});

describe("the daemon's pass", () => {
  /** Waits for the background cleanup and the tick that follows it. */
  const settle = async (app: Awaited<ReturnType<typeof testApp>>) => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    await app.daemon.idle();
  };

  it("cleans a machine that is up and idle before it stops it, once, however many employees it has awake", async () => {
    const app = await testApp();
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { ops: machineOps, scripts } = ops({
      runIn: async (_m, script) => {
        scripts.push(script);
        await hold;
        return "@@df 1000000 400000\n@@df-after 1000000 400000\n@@done";
      },
    });
    withOps(app, machineOps);
    const machines = app.deps.machines as unknown as { stopped: string[] };

    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.daemon.tick();
    await settle(app);

    // The machine is being cleaned, so its last employee isn't stopped, and it is held.
    expect(scripts).toHaveLength(1);
    expect(machines.stopped).not.toContain("ada");
    expect(app.deps.storage?.holding("inc-engineering")).toBe(true);
    await app.daemon.tick();
    expect(scripts).toHaveLength(1);

    release();
    await settle(app);
    // Cleaning is over: the next pass (the cleanup asks for one) stops the employees' machines.
    expect(machines.stopped.sort()).toEqual(["ada", "kit", "quinn"]);
    expect(app.deps.storage?.holding("inc-engineering")).toBe(false);
    expect(scripts).toHaveLength(1);
  });

  it("does not clean again within the hour, and stops machines at once", async () => {
    const app = await testApp();
    const { ops: machineOps, scripts } = ops();
    withOps(app, machineOps);
    const machines = app.deps.machines as unknown as { stopped: string[] };
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.daemon.tick();
    await settle(app);
    expect(scripts).toHaveLength(1);
    expect(machines.stopped).toHaveLength(3);
  });

  it("counts a machine as busy while a session or a running ticket is in it", async () => {
    const app = await testApp();
    withOps(app, ops().ops);
    expect(await app.daemon.machineBusy("inc-engineering")).toBe(false);
    const sessions = (app.daemon as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set("1", { employeeId: "kit", controller: new AbortController() });
    expect(await app.daemon.machineBusy("inc-engineering")).toBe(true);
    expect(await app.daemon.machineBusy("inc-design")).toBe(false);
    sessions.clear();

    app.agent.on({ stage: "build" }, { kind: "hang" });
    await app.call("POST", "/api/tickets", refunds);
    for (let i = 0; i < 200 && app.daemon.footprint().daemonSessions === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(await app.daemon.machineBusy("inc-engineering")).toBe(true);
    expect(app.daemon.interrupt("1", "ada")).toBe(true);
    await app.daemon.idle();
  });
});

describe("a cleanup holds its machine", () => {
  const wait = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setImmediate(r));
  };

  it("makes a new ticket's session wait for the cleanup, says why, and then goes ahead", async () => {
    const app = await testApp();
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const events: string[] = [];
    const { ops: machineOps } = ops({
      runIn: async () => {
        events.push("cleanup-started");
        await hold;
        events.push("cleanup-ended");
        return "@@df 1000000 400000\n@@df-after 1000000 400000\n@@done";
      },
    });
    const storage = withOps(app, machineOps);
    const machines = app.deps.machines as unknown as { started: string[] };
    const realEnsure = app.deps.machines.ensureUp.bind(app.deps.machines);
    app.deps.machines.ensureUp = async (id) => {
      events.push(`start-${id}`);
      return realEnsure(id);
    };

    storage.startClean("inc-engineering", () => {});
    expect(storage.holding("inc-engineering")).toBe(true);
    await wait(() => events.includes("cleanup-started"));

    // A ticket is filed now: its builder's machine is the one being cleaned.
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.tick();
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    expect(machines.started).toEqual([]);
    expect(events).toEqual(["cleanup-started"]);
    // The ticket shows why it waits.
    expect(app.daemon.waiting).toEqual([
      { ticketId: "1", reason: "its sandbox is being cleaned up and starts again in a moment" },
    ]);

    release();
    await app.daemon.idle();
    expect(events.indexOf("cleanup-ended")).toBeLessThan(events.indexOf("start-ada"));
    expect(machines.started).toContain("ada");
    expect(storage.holding("inc-engineering")).toBe(false);
    expect((await app.call("GET", "/api/tickets/1")).body.ticket.status).toBe("ready");
    expect(app.daemon.footprint().daemonHolds).toBe(0);
  });

  it("gives up with a reason, not a failure, when the cleanup lasts too long", async () => {
    vi.useFakeTimers();
    try {
      const app = await testApp();
      const storage = withOps(app, ops().ops);
      const lock = storage as unknown as { lock(m: string): boolean; unlock(m: string): void };
      lock.lock("inc-engineering");
      const waiting = storage.untilFree("inc-engineering", 1000);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await waiting).toBe(false);
      const second = storage.untilFree("inc-engineering", 60_000);
      lock.unlock("inc-engineering");
      expect(await second).toBe(true);
      expect(await storage.untilFree("inc-engineering", 1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks the machine's use again, and the ticket list, right before the delete step", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    app.clock.advance(5 * DAY_MIN);
    const { ops: machineOps, scripts } = ops();
    const storage = withOps(app, machineOps);
    // Idle at the first look, in use by the time the ticket list has been read.
    let looks = 0;
    (storage as unknown as { d: { machineBusy: () => Promise<boolean> } }).d.machineBusy = async () =>
      ++looks > 1;
    const r = await storage.cleanMachine("inc-engineering", { manual: true });
    expect(r).toMatchObject({ status: "skipped", reason: "the machine came into use" });
    expect(looks).toBe(2);
    expect(scripts).toEqual([]);
    expect(storage.holding("inc-engineering")).toBe(false);
  });

  it("refuses a second cleanup while one runs, and always lets go of the lock", async () => {
    const app = await testApp();
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const { ops: machineOps } = ops({
      runIn: async () => {
        await hold;
        return "@@done";
      },
    });
    const storage = withOps(app, machineOps);
    const first = storage.cleanMachine("inc-engineering", { manual: true });
    await wait(() => storage.holding("inc-engineering"));
    expect(await storage.cleanMachine("inc-engineering", { manual: true })).toMatchObject({
      status: "skipped",
      reason: "a cleanup is already running",
    });
    release();
    expect((await first).status).toBe("cleaned");
    expect(storage.holding("inc-engineering")).toBe(false);
  });
});

describe("what counts as busy", () => {
  it("includes a tracked turn, a registered source and a running ticket, as GET /api/health will", async () => {
    const app = await testApp();
    expect(app.daemon.busy()).toBe(false);
    let release: () => void = () => {};
    const turn = app.daemon.track(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    expect(app.daemon.busy()).toBe(true);
    release();
    await turn;
    expect(app.daemon.busy()).toBe(false);
    let open = true;
    app.daemon.onBusy(() => open);
    expect(app.daemon.busy()).toBe(true);
    open = false;
    expect(app.daemon.busy()).toBe(false);
    app.agent.on({ stage: "build" }, { kind: "hang" });
    await app.call("POST", "/api/tickets", refunds);
    for (let i = 0; i < 100 && !app.daemon.busy(); i++) await new Promise((r) => setImmediate(r));
    expect(app.daemon.busy()).toBe(true);
    for (let i = 0; i < 200 && app.daemon.footprint().daemonSessions === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(app.daemon.interrupt("1", "ada")).toBe(true);
    await app.daemon.idle();
  });
});
