// The daemon's heartbeat-free loop (spec §4, principle 4): code schedules, agents work. Each tick
// asks the scheduler what to start, runs those tickets, and re-runs paused ones whose wait may be
// over. Tickets run concurrently; each is resumable from its event log, so a restart loses nothing.
import {
  type Agent,
  type BacklogItem,
  type Clock,
  fold,
  type Harness,
  type Id,
  type MachineProvider,
  type Ports,
  type RunResult,
  runTicket,
  type Snapshot,
  schedule,
  type TicketState,
  type Waiting,
} from "@i-inc/core";
import type { Registry } from "./registry.ts";
import type { SqliteEventStore } from "./store.ts";
import type { Tickets } from "./tickets.ts";

export interface DaemonDeps {
  clock: Clock;
  store: SqliteEventStore;
  registry: Registry;
  tickets: Tickets;
  machines: MachineProvider;
  agent: Agent;
  harness: Harness;
  log?: (msg: string) => void;
}

export class Daemon {
  private readonly running = new Map<Id, Promise<void>>();
  /** Why each ticket that didn't start is waiting, from the last tick. */
  waiting: Waiting[] = [];

  constructor(private readonly d: DaemonDeps) {}

  private get ports(): Ports {
    const { clock, store, machines, agent, harness, registry } = this.d;
    return { clock, store, machines, agent, harness, company: registry };
  }

  async state(id: Id): Promise<TicketState> {
    return fold(await this.d.store.read(id));
  }

  /** One scheduling pass. Returns once everything it started is under way. */
  async tick(): Promise<void> {
    const now = this.d.clock.now();
    const records = this.d.tickets.all();
    const states = new Map<Id, TicketState>();
    for (const r of records) states.set(r.ticket.id, await this.state(r.ticket.id));

    // Paused tickets: run again; the runner returns at once if the wait isn't over.
    for (const r of records) {
      if (states.get(r.ticket.id)?.status === "paused") this.run(r.ticket.id);
    }

    const active = (s: TicketState | undefined) =>
      !!s?.created && (s.status === "running" || s.status === "paused" || s.status === "needs-you");
    const busy = records
      .filter((r) => active(states.get(r.ticket.id)))
      .map((r) => states.get(r.ticket.id)?.assignee ?? r.ticket.assignee);

    const accountsBlockedUntil: Record<Id, number> = {};
    for (const s of states.values()) {
      if (s.paused) {
        const account = this.d.registry.engine(s.paused.engineId).accountId;
        accountsBlockedUntil[account] = Math.max(accountsBlockedUntil[account] ?? 0, s.paused.until);
      }
    }

    const backlog: BacklogItem[] = records
      .filter((r) => !states.get(r.ticket.id)?.created)
      .map((r) => ({
        id: r.ticket.id,
        project: r.ticket.project,
        type: r.ticket.type,
        ...(r.ticket.labels ? { labels: r.ticket.labels } : {}),
        priority: r.priority,
        createdAt: r.createdAt,
        assignee: r.ticket.assignee || null,
        hold: r.hold,
      }));

    const offset = this.d.registry.settings().utcOffsetMinutes;
    const snap: Snapshot = {
      now,
      localHour: new Date(now + offset * 60_000).getUTCHours(),
      employees: this.d.registry.employees(),
      busy,
      accountsBlockedUntil,
      capReachedUntil: {},
      pickedUpToday: this.pickedUpToday(now),
      pending: [],
      backlog,
    };
    const plan = schedule(snap, this.d.registry);
    this.waiting = plan.waiting;

    for (const start of plan.starts) {
      if (start.as !== "build") continue; // Reviews and proofs run inside their ticket, for now.
      if (start.by === "standing-order") this.d.tickets.assign(start.ticketId, start.employeeId, now);
      this.run(start.ticketId);
    }
  }

  /** Runs (or resumes) one ticket in the background, unless it's already running. */
  run(id: Id): void {
    if (this.running.has(id)) return;
    const record = this.d.tickets.get(id);
    if (!record) throw new Error(`no ticket ${id}`);
    const done = runTicket(this.ports, record.ticket)
      .then((r: RunResult) => this.d.log?.(`ticket ${id}: ${r.status}`))
      .catch((e: unknown) => this.d.log?.(`ticket ${id} stopped: ${String(e)}`))
      .finally(() => this.running.delete(id));
    this.running.set(id, done);
  }

  /** Resolves when nothing is running. For tests and a clean shutdown. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values());
  }

  private pickedUpToday(now: number): Record<Id, number> {
    const dayStart = now - (now % 86_400_000);
    const out: Record<Id, number> = {};
    for (const r of this.d.tickets.all()) {
      if (r.pickedAt !== null && r.pickedAt >= dayStart)
        out[r.ticket.assignee] = (out[r.ticket.assignee] ?? 0) + 1;
    }
    return out;
  }
}
