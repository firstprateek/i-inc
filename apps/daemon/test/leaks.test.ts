// The daemon's long-lived structures (T52, item 5): maps keyed by ticket, session or employee, the
// live-event listeners, and the machine provider's per-machine maps. A thousand simulated tickets go
// through their lifecycle with the core's fakes, and each structure must be back at its baseline
// size when they are over. A leak shows here as a number that stays above zero.
import { StartupError } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { AppleMachines, defaultMachineSettings, type Exec } from "../src/machines.ts";
import { refunds, testApp } from "./setup.ts";

const TICKETS = 1000;

type App = Awaited<ReturnType<typeof testApp>>;

/** Lets queued promise callbacks and timers run. */
const turn = () => new Promise<void>((r) => setImmediate(r));

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await turn();
  }
  throw new Error(`never happened: ${what}`);
}

const sizes = (app: App) => app.daemon.footprint();

describe("a thousand tickets", () => {
  it("leave every long-lived structure at its baseline", async () => {
    const app = await testApp();
    const { daemon, agent, deps, clock } = app;
    const machines = deps.machines as unknown as {
      bootFailures: Map<string, Error>;
    };
    const baseline = sizes(app);
    expect(baseline).toMatchObject({
      daemonRunning: 0,
      daemonSessions: 0,
      daemonAwake: 0,
      sessionsActive: 0,
      liveListeners: 0,
    });

    // Ticks come from the batches below (a tick after every ticket would make this a minutes-long
    // test, since each one reads every ticket); the real tick is put back to settle each batch.
    const realTick = daemon.tick.bind(daemon);
    const quiet = () => {
      (daemon as unknown as { tick: () => Promise<void> }).tick = async () => {};
    };
    const settle = async () => {
      delete (daemon as unknown as { tick?: unknown }).tick;
      clock.advance(10);
      machines.bootFailures.clear();
      await realTick();
      await daemon.idle();
      quiet();
    };
    quiet();

    const ids: string[] = [];
    let peakRunning = 0;
    for (let i = 1; i <= TICKETS; i++) {
      const assignee = i % 10 === 2 ? "kit" : "ada";
      const t = deps.tickets.create(
        { ...refunds, type: "fix", title: `Ticket ${i}`, effort: "low", assignee, doneWhen: ["it works"] },
        clock.now(),
      );
      ids.push(t.id);
      if (i % 10 === 0) {
        // The owner interrupts a running session: the session map must let go of it.
        agent.on({ ticket: t.id, stage: "build" }, { kind: "hang" });
        daemon.run(t.id);
        await until(() => daemon.footprint().daemonSessions > 0, "a session starts");
        peakRunning = Math.max(peakRunning, daemon.footprint().daemonSessions);
        expect(daemon.interrupt(t.id, "ada")).toBe(true);
        await daemon.idle();
        daemon.run(t.id);
      } else if (i % 10 === 1) {
        // A session that crashes with the daemon still up.
        agent.on({ ticket: t.id, stage: "build" }, { kind: "crash" });
        daemon.run(t.id);
      } else if (i % 10 === 2) {
        // A sandbox that can't start: the ticket waits, with a reason and a time.
        machines.bootFailures.set("kit", new StartupError("sandbox can't start", clock.now() + 60_000));
        daemon.run(t.id);
        await daemon.idle();
        expect(daemon.waiting.some((w) => w.ticketId === t.id)).toBe(true);
        machines.bootFailures.clear();
        daemon.run(t.id);
      } else {
        daemon.run(t.id);
      }
      await daemon.idle();
      if (i % 100 === 0) await settle();
    }
    expect(peakRunning).toBeGreaterThan(0);

    // Every ticket gets to the owner, then the owner approves them all.
    for (let round = 0; round < 3; round++) await settle();
    const board = (await app.call("GET", "/api/board")).body.tickets as { id: string; status: string }[];
    expect(board).toHaveLength(TICKETS);
    for (const b of board.filter((x) => x.status === "ready")) {
      const r = await app.call("POST", `/api/tickets/${b.id}/decide`, { decision: "approve" });
      expect(r.status).toBe(200);
      await daemon.idle();
    }
    for (let round = 0; round < 3; round++) await settle();
    delete (daemon as unknown as { tick?: unknown }).tick;
    await daemon.tick();
    await daemon.idle();

    const done = (await app.call("GET", "/api/board")).body.tickets.filter(
      (x: { status: string }) => x.status === "done",
    ).length;
    expect(done).toBeGreaterThan(TICKETS * 0.8);

    const after = sizes(app);
    expect(after).toEqual(baseline);
    expect(daemon.waiting.filter((w) => !ids.includes(w.ticketId))).toEqual([]);
  }, 600_000);

  it("leave no listener behind when live-event clients come and go", async () => {
    const app = await testApp();
    const open: { ac: AbortController; res: Response }[] = [];
    for (let i = 0; i < TICKETS; i++) {
      const ac = new AbortController();
      const res = await app.handle(new Request("http://i.inc/api/events", { signal: ac.signal }));
      open.push({ ac, res });
    }
    expect(app.daemon.footprint().liveListeners).toBe(2 * TICKETS);
    // Half hang up, half cancel their stream: both ways let go.
    for (const [i, c] of open.entries()) {
      if (i % 2) c.ac.abort();
      else await c.res.body?.cancel();
    }
    expect(app.daemon.footprint().liveListeners).toBe(0);
  });
});

describe("the machine provider's maps", () => {
  const { wallsMarker: _w, ...noWalls } = defaultMachineSettings;

  it("return to nothing as machines stop and boot failures clear", async () => {
    let failing = false;
    const exec: Exec = async (_bin, args) => {
      if (args[1] === "run" && failing) throw new Error("Operation not supported by device");
      return "";
    };
    const m = new AppleMachines(
      { ...noWalls, machineFor: (id) => `inc-team${id.length % 5}` },
      exec,
      async () => {},
    );
    expect(m.footprint()).toEqual({ machinesUp: 0, signedInCache: 0, faults: 0, attempts: 0, lastLogged: 0 });

    for (let i = 0; i < TICKETS; i++) {
      const id = `emp${i}`.slice(0, 32);
      await m.ensureUp(id);
      await m.stop(id);
    }
    expect(m.footprint().machinesUp).toBe(0);

    // A machine that fails to boot is held in backoff; a good boot afterwards clears all of it.
    failing = true;
    await m.ensureUp("late").catch(() => {});
    expect(m.footprint().faults).toBe(1);
    failing = false;
    await m.retrySandbox("team4", { cpus: 1, memory: "1G" });
    expect(m.footprint()).toMatchObject({ faults: 0, attempts: 0, lastLogged: 0 });
  });
});
