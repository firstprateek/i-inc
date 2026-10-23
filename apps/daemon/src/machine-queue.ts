// One queue per machine for every `container` command that targets it (T75).
//
// Why: Apple `container` 1.4.1 leaves its API server holding a machine's hostname when `machine stop M` and
// `machine run -n M …` are issued at the same moment. Every later boot then fails with `hostname(s) already
// exist: ["M.machine."]` until `container system stop && container system start`. `machine run` boots a
// stopped machine, and the daemon runs it from many places (scripts, probes, sweeps, boots), so a stop could
// land beside any of them. Now no stop is ever issued while another command for the same machine is, and
// nothing is issued while a stop is.
//
// Three kinds of hold, in one first-come queue per machine:
//   use     a `machine run` (a script, a probe, a launched agent's session). Many at once. A long-lived one
//           (an agent's session) holds its lease until the session ends.
//   serial  a boot, create, adoption or anything else that changes what is up. One at a time, beside uses.
//   stop    a `machine stop`. Alone: it waits for every lease to end (a bounded wait; after that it gives up,
//           without killing anything) and keeps new work back while it waits and while it runs.
// A hold granted in turn never overtakes an earlier one, so a stop is not starved by a stream of uses.

export type HoldKind = "use" | "serial" | "stop";

/** Ends a hold; `result` is what the history shows ("ok", or why it failed). Calling it again does nothing. */
export type Release = (result?: string) => void;

/** The most a stop waits for leases to end before it gives up (milliseconds). */
export const DEFAULT_LEASE_WAIT_MS = 30_000;

/** How many of a machine's latest operations are kept for the log when a hostname is stuck. */
export const HISTORY_LEN = 5;

/** A stop gave up: a lease outlasted its wait, or the daemon is shutting down. The machine was not touched. */
export class MachineBusy extends Error {
  constructor(
    readonly machine: string,
    message: string,
  ) {
    super(message);
    this.name = "MachineBusy";
  }
}

/** A script or a launch was asked of a machine that isn't running. Nothing was started: `machine run` would boot it. */
export class MachineNotRunning extends Error {
  constructor(readonly machine: string) {
    super(`${machine} isn't running, so nothing is run in it`);
    this.name = "MachineNotRunning";
  }
}

export interface QueueOp {
  kind: HoldKind;
  label: string;
  /** Wall time (ms) the operation was granted. */
  at: number;
  /** When it ended; absent while it runs. */
  endedAt?: number;
  /** How it ended: "ok", or the error's message. */
  result?: string;
}

export interface QueueOptions {
  /** How long a stop waits for leases (default {@link DEFAULT_LEASE_WAIT_MS}). */
  leaseWaitMs?: number;
  /** Wall clock, for the history. */
  now?: () => number;
  /** Starts a timer and returns what cancels it; a test drives it by hand. */
  timer?: (ms: number, fire: () => void) => () => void;
  log?: (msg: string) => void;
}

interface Waiter {
  kind: HoldKind;
  label: string;
  /** A stop that goes ahead although the queue is closed (see {@link MachineQueue.stop}). */
  force?: boolean;
  grant: () => void;
  fail: (err: Error) => void;
  /** For a stop: ends its wait for leases. */
  cancelTimer?: () => void;
  timerFor?: number;
}

interface MachineState {
  /** Granted uses. */
  uses: number;
  /** A granted serial or stop operation, if any. */
  holder?: "serial" | "stop" | undefined;
  waiters: Waiter[];
  history: QueueOp[];
}

const realTimer = (ms: number, fire: () => void): (() => void) => {
  const t = setTimeout(fire, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export class MachineQueue {
  private readonly machines = new Map<string, MachineState>();
  private readonly leaseWaitMs: number;
  private readonly now: () => number;
  private readonly timer: (ms: number, fire: () => void) => () => void;
  private closed = false;

  constructor(private readonly o: QueueOptions = {}) {
    this.leaseWaitMs = o.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS;
    this.now = o.now ?? Date.now;
    this.timer = o.timer ?? realTimer;
  }

  private state(machine: string): MachineState {
    let st = this.machines.get(machine);
    if (!st) {
      st = { uses: 0, waiters: [], history: [] };
      this.machines.set(machine, st);
    }
    return st;
  }

  /**
   * Takes a hold on a machine and resolves with what ends it. `stop` rejects with {@link MachineBusy} if
   * the leases outlast `leaseWaitMs`, or if the queue is closed.
   */
  acquire(machine: string, kind: HoldKind, label: string, force = false): Promise<Release> {
    if (this.closed && kind === "stop" && !force) {
      return Promise.reject(
        new MachineBusy(machine, `the daemon is shutting down, so ${machine} is not stopped`),
      );
    }
    const st = this.state(machine);
    return new Promise<Release>((resolve, reject) => {
      const op: QueueOp = { kind, label, at: 0 };
      const waiter: Waiter = {
        kind,
        label,
        force,
        grant: () => {
          waiter.cancelTimer?.();
          op.at = this.now();
          st.history.push(op);
          if (st.history.length > HISTORY_LEN) st.history.shift();
          if (kind === "use") st.uses++;
          else st.holder = kind;
          let released = false;
          resolve((result = "ok") => {
            if (released) return;
            released = true;
            op.endedAt = this.now();
            op.result = result;
            if (kind === "use") st.uses--;
            else st.holder = undefined;
            this.pump(machine);
          });
        },
        fail: (err) => reject(err),
      };
      st.waiters.push(waiter);
      this.pump(machine);
    });
  }

  /** Grants holds from the front of the line, as far as they don't conflict. */
  private pump(machine: string): void {
    const st = this.machines.get(machine);
    if (!st) return;
    for (;;) {
      const w = st.waiters[0];
      if (!w) break;
      if (st.holder === "stop") break;
      if (w.kind === "use") {
        st.waiters.shift();
        w.grant();
        continue;
      }
      if (w.kind === "serial") {
        if (st.holder) break;
        st.waiters.shift();
        w.grant();
        continue;
      }
      // a stop: alone, and only once the leases have ended
      if (st.holder || st.uses > 0) {
        if (st.uses > 0 && !w.cancelTimer) {
          const waiting = w;
          waiting.cancelTimer = this.timer(this.leaseWaitMs, () => {
            const i = st.waiters.indexOf(waiting);
            if (i < 0) return;
            st.waiters.splice(i, 1);
            this.o.log?.(
              `[sandbox:${machine}] not stopped: ${st.uses} lease(s) still held after ${Math.round(this.leaseWaitMs / 1000)}s (${waiting.label}); nothing was killed, and the next idle pass tries again`,
            );
            waiting.fail(
              new MachineBusy(
                machine,
                `${machine} is still in use after ${Math.round(this.leaseWaitMs / 1000)}s, so it is not stopped`,
              ),
            );
            this.pump(machine);
          });
        }
        break;
      }
      st.waiters.shift();
      w.grant();
    }
  }

  /** Runs `fn` while holding a lease: beside other uses, never beside a stop. */
  use<T>(machine: string, label: string, fn: () => Promise<T>): Promise<T> {
    return this.hold(machine, "use", label, fn);
  }

  /** Runs `fn` alone among serial operations (boots, creates, adoption): the old per-machine lock. */
  serial<T>(machine: string, label: string, fn: () => Promise<T>): Promise<T> {
    return this.hold(machine, "serial", label, fn);
  }

  /** Runs `fn` (the `machine stop`) alone, once every lease has ended. Rejects with {@link MachineBusy} if it can't. */
  stop<T>(
    machine: string,
    label: string,
    fn: () => Promise<T>,
    o: { whenClosed?: boolean } = {},
  ): Promise<T> {
    return this.hold(machine, "stop", label, fn, o.whenClosed === true);
  }

  private async hold<T>(
    machine: string,
    kind: HoldKind,
    label: string,
    fn: () => Promise<T>,
    force = false,
  ): Promise<T> {
    const release = await this.acquire(machine, kind, label, force);
    try {
      const out = await fn();
      release("ok");
      return out;
    } catch (err) {
      release(err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120));
      throw err;
    }
  }

  /** A lease that lasts as long as the caller wants (an agent's session): call the result to end it. */
  lease(machine: string, label: string): Promise<Release> {
    return this.acquire(machine, "use", label);
  }

  /**
   * The daemon is leaving: no stop is issued from now on (a machine left running is adopted, and stopped when
   * idle, by the next daemon), and stops still waiting give up. Runs already granted are not touched. A stop
   * asked with `whenClosed` (a machine the walls refused must not stay up) still waits its turn and goes ahead.
   */
  close(): void {
    this.closed = true;
    for (const [machine, st] of this.machines) {
      for (const w of [...st.waiters]) {
        if (w.kind !== "stop" || w.force) continue;
        w.cancelTimer?.();
        st.waiters.splice(st.waiters.indexOf(w), 1);
        w.fail(new MachineBusy(machine, `the daemon is shutting down, so ${machine} is not stopped`));
      }
      this.pump(machine);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Leases held on a machine now. */
  leases(machine: string): number {
    return this.machines.get(machine)?.uses ?? 0;
  }

  /** Whether any machine has a hold or a waiter: the container service is restarted only when none does. */
  get idle(): boolean {
    for (const st of this.machines.values()) {
      if (st.uses > 0 || st.holder || st.waiters.length > 0) return false;
    }
    return true;
  }

  /** The machine's latest operations, oldest first (at most {@link HISTORY_LEN}). */
  history(machine: string): QueueOp[] {
    return (this.machines.get(machine)?.history ?? []).map((o) => ({ ...o }));
  }

  /** The history as a line for the log: `stop@12:00:01.123 ok, run(probe)@… (running)`. */
  describeHistory(machine: string): string {
    const ops = this.history(machine);
    if (ops.length === 0) return "none";
    return ops
      .map((o) => {
        const t = (ms: number) => new Date(ms).toISOString().slice(11, 23);
        const end =
          o.endedAt === undefined ? "still running" : `ended ${t(o.endedAt)} ${o.result ?? ""}`.trim();
        return `${o.kind}(${o.label}) started ${t(o.at)}, ${end}`;
      })
      .join("; ");
  }

  /** How many machines the queue holds state for (one small record per machine ever seen), for the leak test. */
  get size(): number {
    return this.machines.size;
  }
}

const queues = new WeakMap<object, MachineQueue>();

/**
 * The queue that goes with a set of settings: `s.queue` when it has one, else one made for that settings
 * object. So the provider, the script runner and the launcher built from the same settings share a queue
 * without being wired together.
 */
export function queueFor(s: { queue?: MachineQueue }): MachineQueue {
  if (s.queue) return s.queue;
  let q = queues.get(s);
  if (!q) {
    q = new MachineQueue();
    queues.set(s, q);
  }
  return q;
}
