// Sandbox cleanup and storage reporting, against a fake `container` CLI and fake machine
// operations. No real machine, and no real home folder, is ever touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppleMachines, defaultMachineSettings, type Exec } from "../src/machines.ts";
import { type MachineOps, Storage } from "../src/storage.ts";
import { storageSettings } from "../src/storage-settings.ts";
import { refunds, testApp } from "./setup.ts";

const GB = 1024 ** 3;
const DAY_MIN = 24 * 60;

type App = Awaited<ReturnType<typeof testApp>>;

/** Machine operations that record the scripts they are given and answer with `output`. */
function fakeOps(
  o: {
    state?: "running" | "stopped";
    output?: string | ((script: string) => string);
    hold?: Promise<void>;
  } = {},
) {
  const scripts: string[] = [];
  const ops: MachineOps = {
    machineFor: () => "inc-engineering",
    listMachines: async () => [
      { name: "inc-engineering", state: o.state ?? "running", diskBytes: Math.round(20.4 * GB) },
    ],
    runIn: async (_machine, script) => {
      scripts.push(script);
      await o.hold;
      const out = o.output ?? "@@df 20971520 8388608\n@@df-after 20971520 8388608\n@@done";
      return typeof out === "function" ? out(script) : out;
    },
  };
  return { ops, scripts };
}

/** A storage over the app's database, with the app's tickets and a team of the demo employees. */
function storageFor(
  app: App,
  ops: MachineOps | undefined,
  extra: Partial<ConstructorParameters<typeof Storage>[0]> = {},
) {
  app.deps.registry.setTeam({ id: "engineering", name: "Engineering", members: ["ada", "kit", "quinn"] });
  const push = { send: vi.fn(async () => {}) };
  const logs: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "i-inc-storage-home-"));
  const storage = new Storage({
    db: app.db,
    clock: app.clock,
    registry: app.deps.registry,
    tickets: app.deps.tickets,
    events: app.deps.store,
    paths: { home, dbPath: join(home, "i-inc.db"), knowledgeDir: join(home, "knowledge") },
    ...(ops ? { ops } : {}),
    push,
    log: (m) => logs.push(m),
    machineBusy: async () => false,
    hostBusy: () => false,
    ticketActive: () => false,
    footprint: () => ({}),
    trim: false,
    ...extra,
  });
  return { storage, push, logs, home };
}

/** Files a ticket, lets the team finish it, and has the owner approve it: closed and merged. */
async function closeTicket(app: App) {
  await app.call("POST", "/api/tickets", refunds);
  await app.daemon.idle();
  const res = await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
  expect(res.status).toBe(200);
  await app.daemon.idle();
  expect((await app.call("GET", "/api/tickets/1")).body.ticket.status).toBe("done");
}

describe("cleaning a machine", () => {
  it("removes a ticket's copies only after the days it is kept, and only in a machine that is up", async () => {
    const app = await testApp();
    await closeTicket(app);
    const { ops, scripts } = fakeOps();
    const { storage } = storageFor(app, ops);

    // Just closed: nothing is old enough, so the script is given no ticket.
    let r = await storage.cleanMachine("inc-engineering", { manual: true });
    expect(r.status).toBe("cleaned");
    expect(scripts[0]).not.toContain("for id in");

    // Four days on, the ticket's copies are named in the script, with the guard for unpushed work.
    app.clock.advance(4 * DAY_MIN);
    r = await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[1]).toContain("for id in 1; do");
    expect(scripts[1]).toContain("DRY=0");
    // The ticket merged: that may release uncommitted noise after a fresh fetch, never unpushed commits.
    expect(scripts[1]).toContain("MERGED=' 1 '");
    expect(scripts[1]).toContain("AGED='  '");

    // Past unpushedKeepDays (30), it is aged: the owner's own setting lets unpushed work go.
    app.clock.advance(27 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[2]).toContain("AGED=' 1 '");
  });

  it("never removes anything for a ticket that isn't over, or for a team that never touched it", async () => {
    const app = await testApp();
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle(); // ready for the owner, not closed
    const { ops, scripts } = fakeOps();
    const { storage } = storageFor(app, ops);
    app.clock.advance(30 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[0]).not.toContain("for id in");

    const other = fakeOps();
    const { storage: elsewhere } = storageFor(app, {
      ...other.ops,
      machineFor: () => "inc-design",
    });
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    app.clock.advance(30 * DAY_MIN);
    await elsewhere.cleanMachine("inc-engineering", { manual: true });
    // Every employee of the ticket works in inc-design here, so inc-engineering holds no copy.
    expect(other.scripts[0]).not.toContain("for id in");
  });

  it("waits for the days in the settings", async () => {
    const app = await testApp();
    await closeTicket(app);
    const { ops, scripts } = fakeOps();
    const { storage } = storageFor(app, ops);
    expect(storage.update({ sandboxCleanupDays: 7 })).toMatchObject({ settings: { sandboxCleanupDays: 7 } });
    app.clock.advance(5 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[0]).not.toContain("for id in");
    app.clock.advance(3 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[1]).toContain("for id in 1; do");
  });

  it("turns off with 0 days", async () => {
    const app = await testApp();
    await closeTicket(app);
    const { ops, scripts } = fakeOps();
    const { storage } = storageFor(app, ops);
    storage.update({ sandboxCleanupDays: 0 });
    app.clock.advance(10 * DAY_MIN);
    expect(storage.due("inc-engineering")).toBe(false);
    const r = await storage.cleanMachine("inc-engineering");
    expect(r).toMatchObject({ status: "skipped", reason: "sandbox cleanup is off" });
    expect(scripts).toEqual([]);
  });

  it("does nothing to a machine that isn't running", async () => {
    const app = await testApp();
    await closeTicket(app);
    const { ops, scripts } = fakeOps({ state: "stopped" });
    const { storage } = storageFor(app, ops);
    app.clock.advance(4 * DAY_MIN);
    const r = await storage.cleanMachine("inc-engineering", { manual: true });
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("isn't running");
    expect(scripts).toEqual([]);
  });

  it("does nothing while a session or a ticket is using the machine", async () => {
    const app = await testApp();
    await closeTicket(app);
    const { ops, scripts } = fakeOps();
    const { storage } = storageFor(app, ops, { machineBusy: async () => true });
    app.clock.advance(4 * DAY_MIN);
    const r = await storage.cleanMachine("inc-engineering", { manual: true });
    expect(r).toMatchObject({ status: "skipped", reason: "the machine is in use" });
    expect(scripts).toEqual([]);
  });

  it("runs at most once an hour per machine", async () => {
    const app = await testApp();
    const { ops, scripts } = fakeOps();
    const { storage } = storageFor(app, ops);
    expect(storage.due("inc-engineering")).toBe(true);
    await storage.cleanMachine("inc-engineering");
    expect(scripts).toHaveLength(1);
    expect(storage.due("inc-engineering")).toBe(false);
    expect(await storage.cleanMachine("inc-engineering")).toMatchObject({
      status: "skipped",
      reason: "cleaned less than an hour ago",
    });
    app.clock.advance(61);
    expect(storage.due("inc-engineering")).toBe(true);
    await storage.cleanMachine("inc-engineering");
    expect(scripts).toHaveLength(2);
  });

  it("remembers the hour across a restart", async () => {
    const app = await testApp();
    const { ops } = fakeOps();
    const first = storageFor(app, ops);
    await first.storage.cleanMachine("inc-engineering");
    const second = storageFor(app, ops);
    expect(second.storage.due("inc-engineering")).toBe(false);
  });

  it("logs one summary line, and keeps what was freed", async () => {
    const app = await testApp();
    await closeTicket(app);
    const out = [
      "@@df 20971520 8388608",
      "@@removed 1 2097152",
      "@@kept 7 unpushed",
      "@@cache pip 524288",
      "@@pnpm-store 262144",
      "@@docker 131072",
      "@@df-after 20971520 5376000",
      "@@done",
    ].join("\n");
    const { ops } = fakeOps({ output: out });
    const { storage, logs } = storageFor(app, ops);
    app.clock.advance(4 * DAY_MIN);
    const r = await storage.cleanMachine("inc-engineering", { manual: true });

    expect(r.status).toBe("cleaned");
    expect(r.freed).toEqual({
      worktrees: 2 * GB,
      "cache:pip": 0.5 * GB,
      "pnpm-store": 0.25 * GB,
      docker: 0.125 * GB,
    });
    const lines = logs.filter((l) => l.startsWith("[storage] inc-engineering"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("freed 2.9 GB");
    expect(lines[0]).toContain("worktrees 2.0 GB");
    expect(lines[0]).toContain("kept 1 (unpushed)");
    expect(lines[0]).toContain("disk 26% of 20.0 GB");

    const report = await storage.report();
    const m = report.machines.find((x) => x.machine === "inc-engineering");
    expect(m).toMatchObject({
      state: "running",
      diskBytes: Math.round(20.4 * GB),
      freedBytesTotal: r.freedBytes,
      lastCleanup: { status: "cleaned", tickets: 1, kept: [{ ticket: "7", reason: "unpushed" }] },
      fs: { percent: 26 },
    });
  });

  it("changes nothing in a dry run, and doesn't count it", async () => {
    const app = await testApp();
    await closeTicket(app);
    const { ops, scripts } = fakeOps();
    const { storage, logs } = storageFor(app, ops);
    app.clock.advance(4 * DAY_MIN);
    const r = await storage.cleanMachine("inc-engineering", { dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(scripts[0]).toContain("DRY=1");
    expect(logs).toEqual([]);
    expect(storage.due("inc-engineering")).toBe(true);
    expect((await storage.report()).machines[0]?.lastCleanup).toBeNull();
  });

  it("fails cleanly when the script doesn't finish, or the machine errors", async () => {
    const app = await testApp();
    const cut = storageFor(app, fakeOps({ output: "@@df 1 1\n@@removed 1 5" }).ops);
    expect(await cut.storage.cleanMachine("inc-engineering")).toMatchObject({ status: "failed" });

    const broken = fakeOps().ops;
    broken.runIn = async () => {
      throw new Error("machine went away");
    };
    const b = storageFor(app, broken);
    expect(await b.storage.cleanMachine("inc-engineering", { manual: true })).toMatchObject({
      status: "failed",
      reason: "machine went away",
    });
    expect(b.logs.at(-1)).toContain("cleanup failed: machine went away");
    expect((await b.storage.report()).machines[0]?.lastCleanup).toMatchObject({ status: "failed" });
  });

  it("holds a ticket's copies while the ticket is running", async () => {
    const app = await testApp();
    await closeTicket(app);
    const { ops, scripts } = fakeOps();
    const { storage } = storageFor(app, ops, { ticketActive: () => true });
    app.clock.advance(10 * DAY_MIN);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(scripts[0]).not.toContain("for id in");
  });
});

describe("the disk warning", () => {
  const full = (pct: number) => `@@df 100000 ${pct * 1000}\n@@df-after 100000 ${pct * 1000}\n@@done`;

  it("pushes once when a machine passes 80%, and again no sooner than a day later", async () => {
    const app = await testApp();
    const state = { pct: 85 };
    const { ops } = fakeOps({ output: () => full(state.pct) });
    const { storage, push } = storageFor(app, ops);

    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(push.send).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sandbox engineering is 85% full", url: "#/setup/sandboxes" }),
    );

    app.clock.advance(120);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(push.send).toHaveBeenCalledTimes(1);

    app.clock.advance(24 * 60);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(push.send).toHaveBeenCalledTimes(2);
  });

  it("stays quiet under the level, warns again after a dip, and follows the setting", async () => {
    const app = await testApp();
    const state = { pct: 70 };
    const { ops } = fakeOps({ output: () => full(state.pct) });
    const { storage, push } = storageFor(app, ops);
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(push.send).not.toHaveBeenCalled();

    storage.update({ diskWarnPct: 60 });
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(push.send).toHaveBeenCalledTimes(1);

    // Back well under the level, then over it again: it counts as new.
    state.pct = 40;
    await storage.cleanMachine("inc-engineering", { manual: true });
    state.pct = 75;
    await storage.cleanMachine("inc-engineering", { manual: true });
    expect(push.send).toHaveBeenCalledTimes(2);
  });

  it("does not let a failing push break the cleanup", async () => {
    const app = await testApp();
    const { ops } = fakeOps({ output: full(90) });
    const { storage, push, logs } = storageFor(app, ops);
    push.send.mockRejectedValueOnce(new Error("push is down"));
    const r = await storage.cleanMachine("inc-engineering", { manual: true });
    expect(r.status).toBe("cleaned");
    expect(logs.some((l) => l.includes("couldn't push"))).toBe(true);
  });
});

describe("storage settings", () => {
  it("are saved, shown with their defaults, and refused when out of range", async () => {
    const app = await testApp();
    const { storage } = storageFor(app, undefined);
    expect(storage.settings()).toMatchObject({
      sandboxCleanupDays: 3,
      transcriptCompactDays: 30,
      logKeep: 5,
    });
    expect(storage.update({ sandboxCleanupDays: 5, dockerPrune: false })).toEqual({
      settings: expect.objectContaining({ sandboxCleanupDays: 5, dockerPrune: false, logKeep: 5 }),
    });
    expect(storage.update({ sandboxCleanupDays: -1 })).toEqual({
      error: "sandboxCleanupDays must be a whole number from 0 to 365",
    });
    expect(storage.update({ sandboxCleanupDays: 1.5 })).toHaveProperty("error");
    expect(storage.update({ nope: 1 })).toEqual({ error: "no such setting: nope" });
    expect(storage.update({ dockerPrune: "yes" })).toHaveProperty("error");
    expect(storage.update(["x"])).toHaveProperty("error");
    // Keys that only exist on every object are not settings.
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(storage.update(JSON.parse(`{"${key}": 1}`))).toEqual({ error: `no such setting: ${key}` });
    }
    // Unpushed work must wait longer than finished work, in either direction of change.
    expect(storage.update({ unpushedKeepDays: 5 })).toHaveProperty("error");
    expect(storage.update({ unpushedKeepDays: 3 })).toHaveProperty("error");
    expect(storage.update({ unpushedKeepDays: 6 })).toHaveProperty("settings");
    expect(storage.update({ sandboxCleanupDays: 6 })).toEqual({
      error: expect.stringContaining("unpushedKeepDays must be more than sandboxCleanupDays"),
    });
    expect(storage.update({ sandboxCleanupDays: 6, unpushedKeepDays: 7 })).toHaveProperty("settings");
    // Off is allowed whatever the other says.
    expect(storage.update({ sandboxCleanupDays: 0, unpushedKeepDays: 1 })).toHaveProperty("settings");
    storage.update({ sandboxCleanupDays: 5, unpushedKeepDays: 30 });
    // A refused update changes nothing.
    expect(storage.settings()).toMatchObject({ sandboxCleanupDays: 5, unpushedKeepDays: 30 });
    const report = await storage.report();
    expect(report.defaults.sandboxCleanupDays).toBe(3);
    expect(report.settings.sandboxCleanupDays).toBe(5);
  });
});

describe("saved settings that break the rule", () => {
  it("are read with unpushed work still waiting longer than finished work", () => {
    expect(storageSettings({ sandboxCleanupDays: 10, unpushedKeepDays: 5 })).toMatchObject({
      sandboxCleanupDays: 10,
      unpushedKeepDays: 11,
    });
    expect(storageSettings({ sandboxCleanupDays: 0, unpushedKeepDays: 1 }).unpushedKeepDays).toBe(1);
    // Inherited names are not saved values.
    expect(storageSettings(Object.create({ logKeep: 9 }) as never).logKeep).toBe(5);
  });
});

describe("the machine provider's side", () => {
  const listing = (state: string) =>
    [
      "NAME             CREATED              IP             CPUS  MEMORY  DISK   STATE    DEFAULT",
      `inc-engineering  2026-09-28 20:46:19  192.168.64.22  6     12G     20.4G  ${state}`,
      "inc-design       2026-09-28 20:46:19  192.168.64.23  6     12G     812M   stopped",
    ].join("\n");
  const { wallsMarker: _w, ...noWalls } = defaultMachineSettings;

  it("reads each machine's disk from the listing, stopped or not", async () => {
    const exec: Exec = async () => listing("running");
    const m = new AppleMachines(noWalls, exec);
    expect(await m.listMachines()).toEqual([
      { name: "inc-engineering", state: "running", diskBytes: Math.round(20.4 * GB) },
      { name: "inc-design", state: "stopped", diskBytes: 812 * 1024 ** 2 },
    ]);
  });

  it("never boots a machine to run a script", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_bin, args) => {
      calls.push(args);
      return listing("stopped");
    };
    const m = new AppleMachines(noWalls, exec);
    await expect(m.runIn("inc-engineering", "echo hi")).rejects.toThrow("isn't running");
    await expect(m.runIn("inc-missing", "echo hi")).rejects.toThrow("isn't running");
    expect(calls.every((a) => a[0] === "machine" && a[1] === "ls")).toBe(true);
  });

  it("sends the script on stdin to a running machine, as the employee user", async () => {
    const calls: { args: string[]; input?: string | undefined }[] = [];
    const exec: Exec = async (_bin, args, opts) => {
      calls.push({ args, input: opts?.input });
      return args[1] === "ls" ? listing("running") : "@@done";
    };
    const m = new AppleMachines(noWalls, exec);
    expect(await m.runIn("inc-engineering", "echo hi")).toBe("@@done");
    expect(calls[1]).toEqual({
      args: ["machine", "run", "-i", "-u", "employee", "-n", "inc-engineering", "--", "bash", "-s"],
      input: "echo hi",
    });
    await expect(m.runIn("engineering; rm -rf /", "x")).rejects.toThrow("not a machine name");
  });

  it("refuses to run when the walls are down", async () => {
    const m = new AppleMachines({ ...noWalls, wallsMarker: "/nonexistent/walls" }, async () =>
      listing("running"),
    );
    await expect(m.runIn("inc-engineering", "echo hi")).rejects.toThrow("the walls aren't up");
  });
});
