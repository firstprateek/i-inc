// The daemon restarts the container service by itself to clear a stuck machine name (T73). A fake `container`
// that fails to boot with "hostname(s) already exist" until the service is restarted; fake clocks (nothing here
// waits for real time).
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartupError } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRecoveryStore, RESTART_WINDOW_MS } from "../src/container-recovery.ts";
import { machineScript } from "../src/harness.ts";
import {
  AppleMachines,
  assertRunnable,
  defaultMachineSettings,
  type Exec,
  type MachineSettings,
} from "../src/machines.ts";
import { scriptEnded, scriptStarted, scriptsRunning } from "../src/proc.ts";
import { upExec } from "./up.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

const LISTING = [
  "NAME             CREATED  IP             CPUS  MEMORY  DISK  STATE",
  "inc-engineering  -        192.168.64.2   6     12G     3G    stopped",
  "inc-pip          -        192.168.64.3   2     4G      1G    running",
].join("\n");
const STALE =
  'failed to boot container machine (cause: "exists: "hostname(s) already exist: ["inc-engineering.machine."]"")';

interface Rig {
  m: AppleMachines;
  calls: string[];
  push: ReturnType<typeof vi.fn>;
  booted: string[];
  done: ReturnType<typeof vi.fn>;
  store: MemoryRecoveryStore;
  rec: ReturnType<AppleMachines["enableRecovery"]>;
  state: {
    busy: boolean;
    fixed: boolean;
    staysStuck: boolean;
    failStart: boolean;
    serviceUp: boolean;
    onIdleCheck?: () => void;
    holdScript?: Promise<void>;
    t: number;
    sleeps: number;
  };
  /** Called at every sleep, before the clock moves. */
  onSleep: { fn: () => void };
  /** Held `system stop` (resolved by `releaseStop`) when set. */
  gateStop: { hold?: Promise<void> };
}

function rig(settings: MachineSettings = noWalls, store = new MemoryRecoveryStore(), t0 = 1_000_000): Rig {
  const calls: string[] = [];
  const state: Rig["state"] = {
    busy: false,
    fixed: false,
    staysStuck: false,
    failStart: false,
    serviceUp: true,
    t: t0,
    sleeps: 0,
  };
  const onSleep = { fn: () => {} };
  const gateStop: Rig["gateStop"] = {};
  const exec: Exec = async (_bin, args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line === "system stop") {
      await gateStop.hold;
      state.serviceUp = false;
      return "";
    }
    if (line === "system start") {
      if (state.failStart) throw new Error("start failed");
      state.serviceUp = true;
      if (!state.staysStuck) state.fixed = true;
      return "";
    }
    if (line.includes("bash -s")) await state.holdScript;
    if (!state.serviceUp) throw new Error("connection refused: is the container service running?");
    if (args[0] === "machine" && args[1] === "ls")
      return LISTING.replace(
        "inc-engineering  -        192.168.64.2   6     12G     3G    stopped",
        "inc-engineering  -        192.168.64.2   6     12G     3G    running",
      );
    if (args[0] === "machine" && args[1] === "run" && args.includes("inc-engineering")) {
      if (!state.fixed) throw new Error(STALE);
    }
    return "";
  };
  // Its own settings: the recovery sets the gate on them.
  const m = new AppleMachines(
    { ...settings },
    exec,
    async (ms) => {
      onSleep.fn();
      state.sleeps++;
      state.t += ms;
    },
    () => state.t,
  );
  const push = vi.fn(async () => {});
  const booted: string[] = [];
  const done = vi.fn();
  const rec = m.enableRecovery({
    idle: async () => {
      state.onIdleCheck?.();
      return !state.busy;
    },
    booted: (id) => booted.push(id),
    done,
    push,
    store,
  });
  return { m, calls, push, booted, done, store, rec, state, onSleep, gateStop };
}

const systemCalls = (r: Rig) => r.calls.filter((c) => c.startsWith("system "));

describe("a stuck machine name: the container service is restarted once everything is idle", () => {
  it("restarts the service, stops the machines first, and boots the machine again", async () => {
    const r = rig();
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    // The ticket says why it waits.
    expect(r.m.sandboxFault("engineering")?.waiting).toContain("container service");
    await r.rec.settled();

    const stopAt = r.calls.indexOf("system stop");
    const startAt = r.calls.indexOf("system start");
    expect(stopAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(stopAt);
    // Every running machine is stopped first (inc-pip is running in the listing), then the API is polled.
    expect(r.calls.indexOf("machine stop inc-pip")).toBeGreaterThan(-1);
    expect(r.calls.indexOf("machine stop inc-pip")).toBeLessThan(stopAt);
    expect(r.calls.slice(startAt + 1).some((c) => c === "machine ls")).toBe(true);
    // The original boot is tried again, after the restart.
    expect(r.calls.slice(startAt).some((c) => c.startsWith("machine run -n inc-engineering"))).toBe(true);
    expect(r.booted).toEqual(["engineering"]);
    expect(r.m.running()).toContain("engineering");
    expect(r.m.sandboxFault("engineering")).toBeUndefined();
    expect(r.done).toHaveBeenCalled();
    expect(r.push).not.toHaveBeenCalled();
    // The record Setup > Sandboxes shows.
    const [event] = r.m.serviceEvents();
    expect(event?.kind).toBe("restarted");
    expect(event?.text).toMatch(
      /^restarted the container service at \d\d:\d\d to clear a stuck machine name/,
    );
    expect(r.store.load().events).toHaveLength(1);
  });

  it("waits while work is running, shows why, kills nothing, then restarts", async () => {
    const r = rig();
    r.state.busy = true;
    r.onSleep.fn = () => {
      // Nothing was touched while busy.
      expect(systemCalls(r)).toEqual([]);
      expect(r.calls.filter((c) => c.startsWith("machine stop")).length).toBe(1); // the failed boot's own `machine stop`
      if (r.state.sleeps === 6)
        expect(r.m.sandboxFault("engineering")?.waiting).toContain("waiting for other work");
      if (r.state.sleeps >= 6) r.state.busy = false;
    };
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(systemCalls(r)).toEqual(["system stop", "system start"]);
    expect(r.state.sleeps).toBeGreaterThanOrEqual(6);
    expect(r.m.running()).toContain("engineering");
  });

  it("does not hold a deploy back while it only waits, but does once it cuts machines off", async () => {
    const r = rig();
    r.state.busy = true;
    const seen: boolean[] = [];
    r.onSleep.fn = () => {
      seen.push(r.rec.active);
      if (r.state.sleeps >= 3) r.state.busy = false;
    };
    let release = () => {};
    r.gateStop.hold = new Promise<void>((res) => {
      release = res;
    });
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    expect(r.rec.active).toBe(false); // waiting for the machines to go idle: a deploy may go ahead
    await vi.waitFor(() => expect(r.calls).toContain("system stop"));
    expect(r.rec.active).toBe(true); // the deployer's drain (/api/health busy) waits for this
    expect(seen.every((a) => a === false)).toBe(true);
    release();
    await r.rec.settled();
    expect(r.rec.active).toBe(false);
  });

  it("never restarts while busy: after ten minutes it gives up without touching anything, and says so", async () => {
    const r = rig();
    r.state.busy = true;
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(systemCalls(r)).toEqual([]);
    expect(r.state.t - 1_000_000).toBeGreaterThanOrEqual(10 * 60_000);
    expect(r.m.serviceEvents()[0]?.kind).toBe("gave-up-busy");
    // The window was not used up: the next failed boot, once idle, restarts.
    r.state.busy = false;
    r.state.t += 60_000;
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(systemCalls(r)).toEqual(["system stop", "system start"]);
  });

  it("does not start when the daemon is leaving", async () => {
    const r = rig();
    r.state.busy = true;
    r.onSleep.fn = () => r.m.closeRecovery();
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(systemCalls(r)).toEqual([]);
    // Leaving is not "kept busy for ten minutes".
    expect(r.m.serviceEvents()).toEqual([]);
  });

  it("does not stop anything when the daemon starts leaving during the last look at the machines", async () => {
    const r = rig();
    let looks = 0;
    r.state.onIdleCheck = () => {
      if (++looks === 2) r.m.closeRecovery(); // the second look, the one that takes the lock
    };
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(systemCalls(r)).toEqual([]);
    expect(r.calls.filter((c) => c === "machine stop inc-pip")).toEqual([]);
    expect(r.store.load().inProgress).toBeUndefined();
    expect(r.rec.active).toBe(false);
  });

  it("waits for a script, sign-in probe or callback this provider is running", async () => {
    const r = rig();
    let release = () => {};
    r.state.holdScript = new Promise<void>((res) => {
      release = res;
    });
    const running = r.m.runIn("inc-pip", "true");
    await vi.waitFor(() => expect(r.calls.some((c) => c.includes("bash -s"))).toBe(true));
    r.onSleep.fn = () => {
      expect(systemCalls(r)).toEqual([]);
      if (r.state.sleeps >= 3) release();
    };
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    await running;
    expect(systemCalls(r)).toEqual(["system stop", "system start"]);
  });

  it("refuses every new launch, on any machine, while the service restarts", async () => {
    const r = rig();
    let release = () => {};
    r.gateStop.hold = new Promise<void>((res) => {
      release = res;
    });
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await vi.waitFor(() => expect(r.calls).toContain("system stop"));
    const before = r.calls.length;
    // Another team's boot, a script and a launch's check all wait, with a reason, and run nothing.
    await expect(r.m.ensureUp("pip")).rejects.toThrow(/being restarted/);
    await expect(r.m.ensureUp("pip")).rejects.toBeInstanceOf(StartupError);
    await expect(
      assertRunnable((r.m as unknown as { s: MachineSettings }).s, async () => "", "inc-pip"),
    ).rejects.toBeInstanceOf(StartupError);
    expect(r.m.sandboxFault("pip")?.waiting).toContain("restarted");
    expect(r.calls.slice(before)).toEqual([]);
    release();
    await r.rec.settled();
    expect(r.m.sandboxFault("pip")).toBeUndefined();
    await expect(r.m.ensureUp("pip")).resolves.toBeUndefined();
  });
});

describe("the walls come back before anything launches", () => {
  let dir: string;
  let marker: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "walls-"));
    marker = join(dir, "walls.ok");
    writeFileSync(marker, "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("holds launches until the walls marker is newer than the restart", async () => {
    // The fake clock is the real one, so file times and the daemon's time compare.
    const r = rig({ ...noWalls, wallsMarker: marker }, new MemoryRecoveryStore(), Date.now());
    let bootsBeforeMarker = -1;
    r.onSleep.fn = () => {
      if (!r.calls.includes("system start") || bootsBeforeMarker >= 0) return;
      // The restart is done and the marker is older than it: nothing may launch, and the boot is not tried.
      expect(r.rec.gate()).toContain("walls job");
      bootsBeforeMarker = r.calls
        .slice(r.calls.indexOf("system start"))
        .filter((c) => c.startsWith("machine run")).length;
      void r.m.ensureUp("pip").then(
        () => expect.unreachable("a launch got through"),
        (e) => expect(e).toBeInstanceOf(StartupError),
      );
      // walls.sh runs: the marker is touched, after the restart.
      const later = (r.state.t + 10_000) / 1000;
      utimesSync(marker, later, later);
    };
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(bootsBeforeMarker).toBe(0);
    expect(r.rec.gate()).toBeNull();
    expect(r.booted).toEqual(["engineering"]);
  });

  it("an old marker is not enough, and a walls job that never answers is told to the owner", async () => {
    const r = rig({ ...noWalls, wallsMarker: marker }, new MemoryRecoveryStore(), Date.now());
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(r.booted).toEqual([]);
    expect(r.rec.gate()).toContain("walls job");
    expect(r.m.serviceEvents()[0]?.kind).toBe("walls-late");
    expect(r.push).toHaveBeenCalledTimes(1);
    // The marker arrives later: the gate lifts by itself and the next boot works.
    const later = (r.state.t + 10_000) / 1000;
    utimesSync(marker, later, later);
    expect(r.rec.gate()).toBeNull();
    r.state.t += 60_000;
    await expect(r.m.ensureUp("engineering")).resolves.toBeUndefined();
  });

  it("also wants the acknowledgement of the new walls to be newer", async () => {
    const ack = join(dir, "walls.open");
    writeFileSync(ack, "");
    const r = rig(
      { ...noWalls, wallsMarker: marker, wall: { s: { ack } } as never },
      new MemoryRecoveryStore(),
      Date.now(),
    );
    r.onSleep.fn = () => {
      if (!r.calls.includes("system start")) return;
      const later = (r.state.t + 10_000) / 1000;
      utimesSync(marker, later, later); // the marker is new, the acknowledgement is not
    };
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(r.rec.gate()).toContain("walls job");
    expect(r.booted).toEqual([]);
  });
});

describe("at most one restart in thirty minutes", () => {
  it("a second failure inside the window goes to the owner with a push, and nothing restarts again", async () => {
    const r = rig();
    r.state.staysStuck = true; // the restart does not help
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(systemCalls(r)).toEqual(["system stop", "system start"]);
    // The retry failed: today's message, the owner's push, the record.
    const fault = r.m.sandboxFault("engineering");
    expect(fault?.waiting).toBe(
      "the engineering sandbox can't start (restart the container service on the Mac mini)",
    );
    expect(r.push).toHaveBeenCalledTimes(1);
    expect(r.push.mock.calls[0]?.[0]).toMatchObject({ url: "#/setup/sandboxes" });
    expect(r.m.serviceEvents().map((e) => e.kind)).toEqual(["not-fixed", "restarted"]);

    // Tickets keep trying with their backoff: no more restarts, no more pushes.
    for (let i = 0; i < 4; i++) {
      r.state.t += 10 * 60_000 - 1;
      if (r.state.t - 1_000_000 >= RESTART_WINDOW_MS) break;
      await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
      await r.rec.settled();
    }
    expect(systemCalls(r)).toEqual(["system stop", "system start"]);
    expect(r.push).toHaveBeenCalledTimes(1);

    // After the window, one more try is allowed.
    r.state.t += RESTART_WINDOW_MS;
    r.state.staysStuck = false;
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(systemCalls(r)).toHaveLength(4);
    expect(r.m.running()).toContain("engineering");
  });

  it("remembers the window across a daemon restart", async () => {
    const store = new MemoryRecoveryStore();
    const first = rig(noWalls, store);
    await expect(first.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await first.rec.settled();
    expect(systemCalls(first)).toHaveLength(2);

    // A new daemon (a deploy) ten minutes later, and the name is stuck again.
    const second = rig(noWalls, store, first.state.t + 10 * 60_000);
    await expect(second.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await second.rec.settled();
    expect(systemCalls(second)).toEqual([]);
    expect(second.push).toHaveBeenCalledTimes(1);
  });

  it("a restart that itself fails goes to the owner with a push and tickets are told what to run", async () => {
    // `system start` fails.
    const failing = rig();
    failing.state.failStart = true;
    await expect(failing.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await failing.rec.settled();
    expect(failing.m.serviceEvents()[0]?.kind).toBe("restart-failed");
    expect(failing.m.serviceEvents()[0]?.text).toContain("container system stop && container system start");
    expect(failing.push).toHaveBeenCalledTimes(1);
  });
});

describe("without the recovery nothing changes", () => {
  it("keeps today's message and never touches the service", async () => {
    const calls: string[] = [];
    const exec: Exec = async (_b, args) => {
      calls.push(args.join(" "));
      if (args[1] === "run") throw new Error(STALE);
      return "";
    };
    const m = new AppleMachines(
      noWalls,
      exec,
      async () => {},
      () => 1_000,
    );
    await expect(m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    expect(m.sandboxFault("engineering")?.waiting).toContain("restart the container service on the Mac mini");
    expect(calls.some((c) => c.startsWith("system"))).toBe(false);
  });
});

describe("a restart the last daemon didn't finish", () => {
  it("records that a restart is under way before the service is stopped, and clears it after", async () => {
    const r = rig();
    let release = () => {};
    r.gateStop.hold = new Promise<void>((res) => {
      release = res;
    });
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await vi.waitFor(() => expect(r.calls).toContain("system stop"));
    // A daemon that dies here leaves this behind for the next one.
    expect(r.store.load().inProgress).toBe(true);
    release();
    await r.rec.settled();
    expect(r.store.load().inProgress).toBe(false);
  });

  it("a new daemon finds the service stopped, starts it, and holds launches until the walls have run", async () => {
    const store = new MemoryRecoveryStore({ events: [], inProgress: true });
    const r = rig(noWalls, store);
    r.state.serviceUp = false; // the last daemon died between `system stop` and `system start`
    const checking = r.m.checkService();
    // Before the first launch: nothing starts while the service is being looked at.
    const early = r.m.ensureUp("pip");
    expect(r.rec.active).toBe(true);
    await expect(early).rejects.toThrow(/checked/);
    await checking;
    expect(r.calls.filter((c) => c.startsWith("system "))).toEqual(["system start"]);
    expect(store.load().inProgress).toBe(false);
    expect(r.m.serviceEvents()[0]?.kind).toBe("resumed");
    expect(r.m.serviceEvents()[0]?.text).toContain("died in the middle");
    expect(r.rec.active).toBe(false);
    expect(r.done).toHaveBeenCalled();
    await expect(r.m.ensureUp("pip")).resolves.toBeUndefined();
  });

  it("a new daemon that finds the service up but a restart on record takes it as finished", async () => {
    const store = new MemoryRecoveryStore({ events: [], inProgress: true });
    const r = rig(noWalls, store);
    await r.m.checkService();
    expect(systemCalls(r)).toEqual([]);
    expect(store.load().inProgress).toBe(false);
    expect(store.load().restartedAt).toBeDefined();
    expect(r.m.serviceEvents()[0]?.text).toContain("finished a restart");
  });

  it("starts a stopped service even inside the 30-minute window of an earlier restart", async () => {
    const store = new MemoryRecoveryStore({
      events: [],
      inProgress: true,
      lastAttemptAt: 1_000_000 - 60_000,
    });
    const r = rig(noWalls, store);
    r.state.serviceUp = false;
    await r.m.checkService();
    expect(systemCalls(r)).toEqual(["system start"]);
    expect(r.m.serviceEvents()[0]?.kind).toBe("resumed");
  });

  it("a healthy service is left alone", async () => {
    const r = rig();
    await r.m.checkService();
    expect(systemCalls(r)).toEqual([]);
    expect(r.m.serviceEvents()).toEqual([]);
    expect(r.rec.gate()).toBeNull();
  });

  it("holds launches until the walls marker is newer than the start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "walls-"));
    try {
      const marker = join(dir, "walls.ok");
      writeFileSync(marker, "");
      const r = rig({ ...noWalls, wallsMarker: marker }, new MemoryRecoveryStore(), Date.now());
      r.state.serviceUp = false;
      r.onSleep.fn = () => {
        if (!r.calls.includes("system start")) return;
        expect(r.rec.gate()).toContain("walls job");
        const later = (r.state.t + 10_000) / 1000;
        utimesSync(marker, later, later);
      };
      await r.m.checkService();
      expect(r.rec.gate()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a service that can't be started goes to the owner with a push", async () => {
    const r = rig();
    r.state.serviceUp = false;
    r.state.failStart = true;
    await r.m.checkService();
    expect(r.m.serviceEvents()[0]?.kind).toBe("restart-failed");
    expect(r.m.serviceEvents()[0]?.text).toContain("container system start");
    expect(r.push).toHaveBeenCalledTimes(1);
  });
});

describe("one-off scripts and launcher updates count as work for the idle check", () => {
  it("waits for a script running in a machine", async () => {
    const r = rig();
    scriptStarted();
    let ended = false;
    r.onSleep.fn = () => {
      expect(systemCalls(r)).toEqual([]);
      if (r.state.sleeps >= 4 && !ended) {
        ended = true;
        scriptEnded();
      }
    };
    try {
      await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
      await r.rec.settled();
    } finally {
      if (!ended) scriptEnded();
    }
    expect(systemCalls(r)).toEqual(["system stop", "system start"]);
    expect(r.state.sleeps).toBeGreaterThanOrEqual(4);
  });

  it("waits for a launcher update", async () => {
    const r = rig();
    const busy = (r.m as unknown as { launcherBusy: Set<string> }).launcherBusy;
    busy.add("inc-engineering");
    r.onSleep.fn = () => {
      expect(systemCalls(r)).toEqual([]);
      if (r.state.sleeps >= 3) busy.clear();
    };
    await expect(r.m.ensureUp("engineering")).rejects.toBeInstanceOf(StartupError);
    await r.rec.settled();
    expect(systemCalls(r)).toEqual(["system stop", "system start"]);
  });
});

describe("machineScript counts as work while it runs", () => {
  it("is counted from the start of the script to its end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "script-"));
    try {
      const bin = join(dir, "container");
      writeFileSync(bin, `#!/bin/sh\nwhile [ ! -e ${dir}/go ]; do sleep 0.02; done\n`);
      chmodSync(bin, 0o755);
      const before = scriptsRunning();
      const run = machineScript({ ...noWalls, bin }, upExec())("ada", "true");
      await vi.waitFor(() => expect(scriptsRunning()).toBe(before + 1));
      writeFileSync(join(dir, "go"), "");
      await run;
      expect(scriptsRunning()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
