// The container service's stuck machine names, cleared by the daemon itself (T73).
//
// Apple container 1.4.1 sometimes keeps a machine's hostname after the machine is stopped, and the next boot
// fails with `hostname(s) already exist: ["inc-engineering.machine."]`. Retrying the machine does not help;
// restarting the service (`container system stop && container system start`) always has. That restart is
// user-level and needs no sudo, but it stops every machine, so it runs only when nothing is working in any of
// them, and at most once in thirty minutes. If it did not fix the name, the old "needs you" message stands and
// the owner gets a push.
//
// The order, once a boot has failed that way (machines.ts calls `request`):
//   1. waiting  - the ticket or conversation that failed is told why it waits ("waiting for other work to
//                 finish, then restarting the container service"). Nothing is killed: up to ten minutes for
//                 every machine to be idle (no ticket session, conversation turn, harness script or storage
//                 cleanup, and no boot or stop under way).
//   2. restart  - from here `gate()` is set and every new launch is refused (assertWalls reads it). All running
//                 machines are stopped, then `container system stop`, `container system start`, and the API
//                 server is polled (`container machine ls`) until it answers.
//   3. walls    - the restart recreates bridge100 with filter flags 0, and walls.sh (root, every minute)
//                 sets them again and re-applies the rules. Until it has run since the restart, `gate()` stays
//                 set: the walls marker (/var/run/i-inc-walls.ok, which walls.sh touches only after it has
//                 checked the rules, the table and bridge100's filter flags in the same run) and, when the new
//                 walls are installed, the acknowledgement (/var/run/i-inc-walls.open) must both be newer than
//                 the restart. This version of walls.sh has no separate bridge-filter acknowledgement: the
//                 marker is that check. A machine booted afterwards is also waited for by `EgressWall.verify`
//                 (its address must be in the acknowledgement), which needs a walls run after the boot.
//   4. retry    - the failed boots are tried again. If a name is still stuck, that is the second failure
//                 inside the window: the owner is told, and nothing restarts again for thirty minutes.
import { statSync } from "node:fs";
import type { Id, ServiceEvent, ServiceEventKind } from "@i-inc/core";

/** At most one automatic restart in this long. */
export const RESTART_WINDOW_MS = 30 * 60_000;
/** How long a restart waits for every machine to go idle before it gives up (and tries again at the next failed boot). */
export const IDLE_WAIT_MS = 10 * 60_000;

/** What survives a daemon restart (a deploy restarts the daemon often): the window and the events. */
export interface RecoveryState {
  /** When the last automatic restart began (wall time), for the thirty-minute window. */
  lastAttemptAt?: number;
  /** When the last one finished and the API server answered: the walls marker must be newer than this. */
  restartedAt?: number;
  events: ServiceEvent[];
  /**
   * Set before `container system stop`, cleared once the service answers again. A daemon that finds it set at
   * startup (the last one died mid-restart: a deploy, a crash) finishes the job.
   */
  inProgress?: boolean;
}

export interface RecoveryStore {
  load(): RecoveryState;
  save(state: RecoveryState): void;
}

export class MemoryRecoveryStore implements RecoveryStore {
  constructor(private state: RecoveryState = { events: [] }) {}
  load(): RecoveryState {
    return structuredClone(this.state);
  }
  save(state: RecoveryState): void {
    this.state = structuredClone(state);
  }
}

/** What the recovery needs from its surroundings. */
export interface RecoveryOptions {
  /** Runs `container ...` (the machine layer's exec, which has a limit on every command). */
  run: (args: string[], timeoutMs?: number) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  /** Wall time, for events and the window. */
  now: () => number;
  /** A clock that never steps, for the waits. */
  mono: () => number;
  log?: (msg: string) => void;
  /** Nothing is working in any machine (no ticket session, conversation turn, harness script or cleanup). */
  idle: () => boolean | Promise<boolean>;
  /** Gracefully stops every running machine. */
  stopMachines: () => Promise<string[]>;
  /** Forgets a machine's boot backoff, so the next boot is tried at once. */
  forget: (machine: string) => void;
  /** The original boot again, by the employee whose boot failed. Must go through the same checks as any launch. */
  retry: (employeeId: Id) => Promise<void>;
  /** A machine the retry booted: the daemon records it as awake so its idle sweep stops it later. */
  booted?: (employeeId: Id) => void;
  /** Everything finished (or gave up): the daemon looks at its waiting tickets again. */
  done?: () => void;
  /** A message for the owner's phone. */
  push?: (n: { title: string; body: string; url: string; tag: string }) => Promise<void>;
  store?: RecoveryStore;
  /** The walls job's marker, and the acknowledgement it rewrites each run (absent with the old walls). */
  wallsMarker?: string;
  wallsAck?: () => string | undefined;
  /** Whether the daemon is stopping (a deploy): nothing starts. */
  stopping?: () => boolean;
  timing?: Partial<RecoveryTiming>;
}

export interface RecoveryTiming {
  windowMs: number;
  idleWaitMs: number;
  idlePollMs: number;
  commandMs: number;
  apiWaitMs: number;
  apiPollMs: number;
  wallsWaitMs: number;
  wallsPollMs: number;
}

const defaultTiming: RecoveryTiming = {
  windowMs: RESTART_WINDOW_MS,
  idleWaitMs: IDLE_WAIT_MS,
  idlePollMs: 5_000,
  commandMs: 2 * 60_000,
  apiWaitMs: 2 * 60_000,
  apiPollMs: 2_000,
  // walls.sh runs every minute.
  wallsWaitMs: 5 * 60_000,
  wallsPollMs: 2_000,
};

type Phase = "idle" | "checking" | "waiting" | "restarting" | "walls" | "retrying";

export const OWNER_FIX = "container system stop && container system start";

/** "14:02", in the daemon host's own time. */
export const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

export class ServiceRecovery {
  private phase: Phase = "idle";
  private since = 0;
  private closed = false;
  /** The machines that failed to boot, and the employees whose boots to try again. */
  private readonly requesters = new Map<string, Set<Id>>();
  private job: Promise<void> = Promise.resolve();
  private state: RecoveryState;
  private readonly t: RecoveryTiming;
  /** Failures already told to the owner (machine@attempt), so a ticket that retries does not push each time. */
  private readonly told = new Set<string>();

  constructor(private readonly o: RecoveryOptions) {
    this.t = { ...defaultTiming, ...o.timing };
    this.state = o.store?.load() ?? { events: [] };
  }

  /** The daemon is leaving: nothing new starts. */
  close(): void {
    this.closed = true;
  }

  /**
   * The recovery is cutting machines off (restarting, waiting for the walls, retrying): the deployer waits for it
   * (/api/health). Waiting for the machines to go idle is not that: a deploy may go ahead then.
   */
  get active(): boolean {
    return (
      this.phase === "checking" ||
      this.phase === "restarting" ||
      this.phase === "walls" ||
      this.phase === "retrying"
    );
  }

  /** Resolves when the run in progress (if any) is over. */
  settled(): Promise<void> {
    return this.job;
  }

  events(): ServiceEvent[] {
    return [...this.state.events].reverse();
  }

  /**
   * Why no new launch may start now, or null. Set while the service is being restarted, and after it until
   * walls.sh has confirmed the walls since the restart.
   */
  gate(): string | null {
    if (this.phase === "checking") {
      return "the container service is being checked on the Mac mini; machines start in a moment";
    }
    if (this.phase === "restarting") {
      return "the container service is being restarted on the Mac mini; machines start again in a minute or two";
    }
    const at = this.state.restartedAt;
    if (at !== undefined && !this.wallsNewerThan(at)) {
      return "the container service was just restarted; machines start once the walls job has confirmed the walls again (within a minute)";
    }
    return null;
  }

  /**
   * Why a machine waits, while this recovery has it: the machine that failed with a stuck name, until the
   * restart is done. Null when the recovery has nothing to do with it.
   */
  waitingFor(machine: string): { reason: string; waiting: string; since: number } | null {
    if (!this.requesters.has(machine)) return null;
    if (this.phase !== "waiting" && this.phase !== "restarting" && this.phase !== "walls") return null;
    const team = machine.replace(/^inc-/, "");
    const next =
      this.phase === "waiting"
        ? "waiting for other work to finish, then the container service is restarted on the Mac mini"
        : "the container service is being restarted on the Mac mini";
    return {
      reason: `container-apiserver still holds the machine's hostname from an earlier boot: ${next}`,
      waiting: `the ${team} sandbox can't start: ${next}`,
      since: this.since,
    };
  }

  /**
   * A boot failed with a stuck hostname. Returns true when the daemon takes it from here (the caller reports
   * that the machine waits), false when it must fall back to asking the owner: a restart already happened
   * inside the window and the name is still stuck. Safe to call again for a machine already waiting.
   */
  request(machine: string, employeeId?: Id): boolean {
    if (this.closed || this.o.stopping?.()) return false;
    const joining = this.phase === "waiting" || this.phase === "restarting" || this.phase === "walls";
    if (!joining && this.attemptsExhausted()) {
      this.notFixed(machine);
      return false;
    }
    const who = this.requesters.get(machine) ?? new Set<Id>();
    if (employeeId) who.add(employeeId);
    this.requesters.set(machine, who);
    if (this.phase === "idle") {
      this.phase = "waiting";
      this.since = this.o.now();
      this.o.log?.(
        `[container] ${machine} won't boot (its hostname is still held): waiting for the machines to go idle, then the container service is restarted`,
      );
      this.job = this.run().finally(() => {
        this.phase = "idle";
        this.requesters.clear();
        this.o.done?.();
      });
    }
    return true;
  }

  /** The window: a restart began less than thirty minutes ago. */
  private attemptsExhausted(): boolean {
    const last = this.state.lastAttemptAt;
    if (last === undefined) return false;
    const age = this.o.now() - last;
    // A clock that was set back must not make the window last for ever.
    return age < this.t.windowMs && age > -this.t.windowMs;
  }

  /**
   * Whether walls.sh has run since `at`: its marker (touched only after it checked the rules, the table and
   * bridge100's filter flags in that run) and, with the new walls installed, its acknowledgement are both newer.
   */
  private wallsNewerThan(at: number): boolean {
    const marker = this.o.wallsMarker;
    if (marker) {
      try {
        if (!(statSync(marker).mtimeMs > at)) return false;
      } catch {
        return false;
      }
    }
    const ack = this.o.wallsAck?.();
    if (ack) {
      try {
        if (!(statSync(ack).mtimeMs > at)) return false;
      } catch {
        // No acknowledgement: the old walls, which the marker alone speaks for.
      }
    }
    return true;
  }

  private save(): void {
    this.state.events = this.state.events.slice(-20);
    try {
      this.o.store?.save(this.state);
    } catch (err) {
      this.o.log?.(`[container] couldn't save the restart record: ${err}`);
    }
  }

  private record(kind: ServiceEventKind, text: string, machine?: string): void {
    this.state.events.push({ at: this.o.now(), kind, text, ...(machine ? { machine } : {}) });
    this.save();
    this.o.log?.(`[container] ${text}`);
  }

  private async tell(tag: string, title: string, body: string): Promise<void> {
    try {
      await this.o.push?.({ title, body, url: "#/setup/sandboxes", tag });
    } catch (err) {
      this.o.log?.(`[container] couldn't send the push: ${err}`);
    }
  }

  /** A stuck name after a restart inside the window: the old message stands, and the owner is told once. */
  private notFixed(machine: string): void {
    const key = `${machine}@${this.state.lastAttemptAt}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    const at = this.state.lastAttemptAt ?? this.o.now();
    const text = `restarted the container service at ${clockTime(at)}, but ${machine} still can't start (its hostname is still held); restart it by hand: ${OWNER_FIX}`;
    this.record("not-fixed", text, machine);
    void this.tell("container-service", "A sandbox is stuck", text);
  }

  /**
   * At startup, before the first launch (the gate is set at once): the service must answer. If it doesn't, the
   * last daemon died between `system stop` and `system start`, or it crashed: it is started. If an interrupted
   * restart is on record and the service answers, the restart is taken as done. Either way bridge100 may be new, so
   * launches wait for the walls job as after any restart.
   */
  startup(): Promise<void> {
    if (this.phase !== "idle") return this.job;
    this.phase = "checking";
    this.job = this.check().finally(() => {
      this.phase = "idle";
      this.o.done?.();
    });
    return this.job;
  }

  private async check(): Promise<void> {
    try {
      let up = true;
      try {
        await this.o.run(["machine", "ls"], 30_000);
      } catch {
        up = false;
      }
      const interrupted = this.state.inProgress === true;
      if (up && !interrupted) return;
      if (!up) {
        await this.o.run(["system", "start"], this.t.commandMs);
        await this.untilApi();
      }
      this.state.inProgress = false;
      this.state.restartedAt = this.o.now();
      this.record(
        "resumed",
        up
          ? `finished a restart of the container service that the last daemon didn't (at ${clockTime(this.state.restartedAt)})`
          : `started the container service at ${clockTime(this.state.restartedAt)}: it wasn't running when the daemon started${interrupted ? " (the last daemon died in the middle of restarting it)" : ""}`,
      );
      this.phase = "walls";
      if (!(await this.untilWalls())) {
        this.record(
          "walls-late",
          "the walls job hasn't confirmed the walls since the container service was started, so nothing starts yet (see /var/log/i-inc-walls.log on the Mac mini)",
        );
        void this.tell(
          "container-service",
          "The walls need a look",
          "The container service was started, but the walls job hasn't confirmed the walls since. Nothing starts until it does.",
        );
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const text = `the container service isn't running and the daemon couldn't start it: ${why}. On the Mac mini run: container system start`;
      this.record("restart-failed", text);
      void this.tell("container-service", "The container service needs you", text);
    }
  }

  private async run(): Promise<void> {
    try {
      const idle = await this.untilIdle();
      // The daemon is leaving: that is not "kept busy", and nothing is stopped.
      if (idle === "closed") return;
      if (idle === "timeout") {
        const names = [...this.requesters.keys()].join(", ");
        this.record(
          "gave-up-busy",
          `didn't restart the container service for a stuck machine name (${names}): work kept the machines busy for ${Math.round(this.t.idleWaitMs / 60_000)} minutes; it tries again at the next failed boot`,
        );
        return;
      }
      // Looked at once more, right before the service is touched: a close during the last check is respected.
      if (this.closed || this.o.stopping?.()) return;
      this.phase = "restarting";
      this.state.lastAttemptAt = this.o.now();
      // Durable before the service is stopped: a daemon that dies from here on leaves it for the next one to finish.
      this.state.inProgress = true;
      this.save();
      await this.restart();
      if (this.closed) return;
      this.state.inProgress = false;
      this.state.restartedAt = this.o.now();
      const names = [...this.requesters.keys()];
      this.record(
        "restarted",
        `restarted the container service at ${clockTime(this.state.restartedAt)} to clear a stuck machine name (${names.join(", ")})`,
        names[0],
      );
      this.phase = "walls";
      if (!(await this.untilWalls())) {
        this.record(
          "walls-late",
          "the walls job hasn't confirmed the walls since the container service was restarted, so nothing starts yet (see /var/log/i-inc-walls.log on the Mac mini)",
        );
        void this.tell(
          "container-service",
          "The walls need a look",
          "The container service was restarted, but the walls job hasn't confirmed the walls since. Nothing starts until it does.",
        );
        for (const machine of this.requesters.keys()) this.o.forget(machine);
        return;
      }
      this.phase = "retrying";
      for (const [machine, who] of this.requesters) {
        this.o.forget(machine);
        for (const id of who) {
          try {
            await this.o.retry(id);
            this.o.booted?.(id);
          } catch (err) {
            this.o.log?.(
              `[container] ${machine} didn't boot after the restart: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const names = [...this.requesters.keys()].join(", ");
      const text = `couldn't restart the container service for a stuck machine name (${names}): ${why}. On the Mac mini run: ${OWNER_FIX}`;
      this.record("restart-failed", text);
      void this.tell("container-service", "The container service needs you", text);
      for (const machine of this.requesters.keys()) this.o.forget(machine);
    }
  }

  /** Waits for every machine to be idle; "timeout" after the limit, "closed" if the daemon leaves. Nothing is cut short. */
  private async untilIdle(): Promise<"idle" | "timeout" | "closed"> {
    const deadline = this.o.mono() + this.t.idleWaitMs;
    for (;;) {
      if (this.closed || this.o.stopping?.()) return "closed";
      if (await this.o.idle()) {
        // Take the lock, then look once more: a launch that slipped in before it was set shows now.
        this.phase = "restarting";
        if (await this.o.idle()) return "idle";
        this.phase = "waiting";
      }
      if (this.o.mono() >= deadline) return "timeout";
      await this.o.sleep(this.t.idlePollMs);
    }
  }

  private async restart(): Promise<void> {
    try {
      await this.o.stopMachines();
    } catch (err) {
      // `system stop` stops them anyway.
      this.o.log?.(`[container] couldn't stop every machine first: ${err}`);
    }
    await this.o.run(["system", "stop"], this.t.commandMs);
    await this.o.run(["system", "start"], this.t.commandMs);
    await this.untilApi();
  }

  /** Polls `container machine ls` until the API server answers; throws after the limit. */
  private async untilApi(): Promise<void> {
    const deadline = this.o.mono() + this.t.apiWaitMs;
    for (;;) {
      try {
        await this.o.run(["machine", "ls"], 30_000);
        return;
      } catch (err) {
        if (this.o.mono() >= deadline) {
          throw new Error(
            `the container service did not answer within ${Math.round(this.t.apiWaitMs / 1000)} s after it was started (${err instanceof Error ? err.message : err})`,
          );
        }
      }
      await this.o.sleep(this.t.apiPollMs);
    }
  }

  private async untilWalls(): Promise<boolean> {
    const deadline = this.o.mono() + this.t.wallsWaitMs;
    for (;;) {
      if (this.gate() === null) return true;
      if (this.closed || this.o.mono() >= deadline) return false;
      await this.o.sleep(this.t.wallsPollMs);
    }
  }
}
