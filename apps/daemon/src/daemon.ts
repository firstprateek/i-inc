// The daemon's heartbeat-free loop (spec §4, principle 4): code schedules, agents work. Each tick
// asks the scheduler what to start, runs those tickets, and re-runs paused ones whose wait may be
// over. Tickets run concurrently; each is resumable from its event log, so a restart loses nothing.

import {
  type Agent,
  assignHelper,
  type BacklogItem,
  type ChatSession,
  type Clock,
  fold,
  type Harness,
  type HelperModel,
  type Id,
  knowledgeLog,
  type MachineProvider,
  occupancy,
  type PendingDuty,
  type Ports,
  type ProjectRelease,
  type RunResult,
  runTicket,
  type Snapshot,
  schedule,
  type Ticket,
  type TicketEvent,
  type TicketState,
  type Waiting,
  type Workspace,
} from "@i-inc/core";
import type { ChatLog } from "./chat.ts";
import type { Db } from "./db.ts";
import type { KnowledgeStore } from "./knowledge.ts";
import type { LiveEvents } from "./live.ts";
import type { NotificationPayload, PushService } from "./push.ts";
import type { Registry } from "./registry.ts";
import type { SqliteEventStore } from "./store.ts";
import type { TicketRecord, Tickets } from "./tickets.ts";

export interface DaemonDeps {
  clock: Clock;
  store: SqliteEventStore;
  registry: Registry;
  tickets: Tickets;
  machines: MachineProvider;
  agent: Agent;
  harness: Harness;
  workspace?: Workspace;
  helper: HelperModel;
  chat: ChatSession;
  chatLog: ChatLog;
  knowledge: KnowledgeStore;
  db: Db;
  push?: PushService;
  live?: LiveEvents;
  log?: (msg: string) => void;
}

export class Daemon {
  private readonly running = new Map<Id, Promise<void>>();
  /** The session each ticket is in now, so an urgent message can stop it. */
  private readonly sessions = new Map<Id, { employeeId: Id; controller: AbortController }>();
  /** Why each ticket that didn't start is waiting, from the last tick. */
  waiting: Waiting[] = [];

  constructor(private readonly d: DaemonDeps) {}

  /** Employees whose machines are up, as far as this daemon knows. */
  private readonly awake = new Set<Id>();

  private get ports(): Ports {
    const { clock, store, agent, harness, registry } = this.d;
    const machines = {
      ensureUp: async (id: Id) => {
        await this.d.machines.ensureUp(id);
        this.awake.add(id);
      },
    };
    const { workspace } = this.d;
    return { clock, store, machines, agent, harness, company: registry, ...(workspace ? { workspace } : {}) };
  }

  async state(id: Id): Promise<TicketState> {
    return fold(await this.d.store.read(id));
  }

  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;

  /**
   * One scheduling pass. Returns once everything it started is under way. Passes never overlap, so
   * a reviewer is never picked twice; a tick asked for while one is waiting to run joins it.
   */
  tick(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.chain.then(() => {
      this.queued = null;
      return this.pass();
    });
    this.queued = next;
    this.chain = next.catch((e: unknown) => this.d.log?.(`tick failed: ${String(e)}`));
    return next;
  }

  private async pass(): Promise<void> {
    const now = this.d.clock.now();
    const records = this.d.tickets.all();
    const states = new Map<Id, TicketState>();
    for (const r of records) {
      const events = await this.d.store.read(r.ticket.id);
      states.set(r.ticket.id, fold(events));
      this.applyKnowledge(r.ticket.id, events);
      this.fileFollowUps(r.ticket.id, events);
      try {
        await this.sendPushNotifications(r.ticket, events);
      } catch (err) {
        this.d.log?.(`push error: ${String(err)}`);
      }
    }

    this.checkAutoReleases(records, states, now);

    // Paused tickets run again (the runner returns at once if the wait isn't over), and so do running
    // ones that nothing is driving, e.g. after a restart.
    for (const r of records) {
      const s = states.get(r.ticket.id);
      if (s?.created && (s.status === "paused" || (s.status === "running" && !s.waitingFor)))
        this.run(r.ticket.id);
    }

    const builderOf = (id: Id, fallback: Id) => states.get(id)?.assignee ?? fallback;
    const { busy, holding } = occupancy(
      records.flatMap((r) => {
        const state = states.get(r.ticket.id);
        return state ? [{ builder: builderOf(r.ticket.id, r.ticket.assignee), state }] : [];
      }),
      now,
    );
    // A builder waiting for a reviewer resumes within minutes, so their machine stays up; one waiting
    // for the owner or an account may wait hours, so it sleeps.
    const soon = records
      .filter((r) => states.get(r.ticket.id)?.waitingFor)
      .map((r) => builderOf(r.ticket.id, r.ticket.assignee));
    await this.sleepIdle(new Set([...busy, ...soon]));
    const pending: PendingDuty[] = records.flatMap((r) => {
      const w = states.get(r.ticket.id)?.waitingFor;
      return w
        ? [
            {
              ticketId: r.ticket.id,
              duty: w.duty,
              builder: builderOf(r.ticket.id, r.ticket.assignee),
              exclude: [builderOf(r.ticket.id, r.ticket.assignee)],
              since: w.since,
            },
          ]
        : [];
    });

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

    const capReachedUntil: Record<Id, number> = {};
    for (const [accountId, limit] of Object.entries(this.d.registry.accountRateLimits())) {
      const rejected = limit.status === "rejected";
      const saturated = (limit.fiveHourUtilization ?? 0) >= 1 || (limit.sevenDayUtilization ?? 0) >= 1;
      if ((rejected || saturated) && limit.resetsAt && limit.resetsAt > now) {
        capReachedUntil[accountId] = Math.max(capReachedUntil[accountId] ?? 0, limit.resetsAt);
      }
    }
    const d = new Date(now);
    const nextMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
    for (const account of this.d.registry.accounts()) {
      if (
        account.monthlyCap !== undefined &&
        account.monthlyFee !== undefined &&
        account.monthlyFee > account.monthlyCap
      ) {
        capReachedUntil[account.id] = Math.max(capReachedUntil[account.id] ?? 0, nextMonthStart);
      }
    }

    const offset = this.d.registry.settings().utcOffsetMinutes;
    const snap: Snapshot = {
      now,
      localHour: new Date(now + offset * 60_000).getUTCHours(),
      employees: this.d.registry.employees(),
      busy,
      holding,
      accountsBlockedUntil,
      capReachedUntil,
      pickedUpToday: this.pickedUpToday(now),
      pending,
      backlog,
    };
    const plan = schedule(snap, this.d.registry);
    this.waiting = plan.waiting;

    for (const start of plan.starts) {
      if (start.as !== "build") await assignHelper(this.ports, start.ticketId, start.as, start.employeeId);
      else if (start.by === "standing-order") this.d.tickets.assign(start.ticketId, start.employeeId, now);
      this.run(start.ticketId);
    }
  }

  /** Runs (or resumes) one ticket in the background, unless it's already running. */
  run(id: Id): void {
    if (this.running.has(id)) return;
    const record = this.d.tickets.get(id);
    if (!record) throw new Error(`no ticket ${id}`);
    const signal = (employeeId: Id) => {
      const controller = new AbortController();
      this.sessions.set(id, { employeeId, controller });
      return controller.signal;
    };
    const done = runTicket(this.ports, record.ticket, { helpers: "scheduler", signal })
      .then(async (r: RunResult) => {
        this.d.log?.(`ticket ${id}: ${r.status}`);
        const events = await this.d.store.read(id);
        this.applyKnowledge(id, events);
        this.fileFollowUps(id, events);
        await this.sendPushNotifications(record.ticket, events);
        // A stage finished or wants a helper: someone may be free now, or a reviewer is needed.
        if (r.status !== "paused") void this.tick().catch(() => {});
      })
      .catch((e: unknown) => this.d.log?.(`ticket ${id} stopped: ${String(e)}`))
      .finally(() => {
        this.running.delete(id);
        this.sessions.delete(id);
      });
    this.running.set(id, done);
  }

  /**
   * Stops the machines of employees with nothing running (spec §12). A machine keeps what it has
   * touched in memory until it restarts, and wakes in under a second, so idle ones are stopped.
   */
  private async sleepIdle(busy: Set<Id>): Promise<void> {
    if (!this.d.machines.stop) return;
    const inSession = new Set([...this.sessions.values()].map((s) => s.employeeId));
    for (const id of [...this.awake]) {
      if (busy.has(id) || inSession.has(id)) continue;
      this.awake.delete(id);
      try {
        await this.d.machines.stop(id);
      } catch (e) {
        this.d.log?.(`machine for ${id} didn't stop: ${String(e)}`);
      }
    }
  }

  /** The handbook, and a brain for everyone who works here (hiring makes one; this covers the rest). */
  ensureKnowledge(): void {
    this.d.knowledge.ensureHandbook();
    for (const e of this.d.registry.employees()) this.d.knowledge.ensureBrain(e);
    this.ensurePushBaseline();
  }

  /** Seeds push_sent with a baseline on initial startup so historical events aren't notified. */
  ensurePushBaseline(): void {
    const [row] = this.d.db.all<{ key: string }>(
      "SELECT key FROM push_sent WHERE key = 'baseline:init' LIMIT 1",
    );
    if (row) return;

    this.d.db.transaction(() => {
      this.d.db.run(
        "INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)",
        "baseline:init",
        this.d.clock.now(),
      );
      const rows = this.d.db.all<{ ticket_id: string; body: string }>(
        "SELECT ticket_id, body FROM events ORDER BY ticket_id, seq",
      );
      const byTicket = new Map<string, number>();
      for (const r of rows) {
        const idx = byTicket.get(r.ticket_id) ?? 0;
        byTicket.set(r.ticket_id, idx + 1);
        const e = JSON.parse(r.body) as TicketEvent;
        if (e.type === "needs-you" || e.type === "report-ready" || e.type === "main-red") {
          this.d.db.run(
            "INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)",
            `push:${r.ticket_id}:${idx}`,
            this.d.clock.now(),
          );
        }
      }
    });
  }

  /**
   * Files the tickets agents proposed for themselves (decided 2026-10-17), each once, while the
   * project's daily budget allows. They go to the agent that proposed them, marked as its own.
   */
  fileFollowUps(ticketId: Id, events: TicketEvent[]): void {
    const from = this.d.tickets.get(ticketId)?.ticket;
    if (!from) return;
    const now = this.d.clock.now();
    const dayStart = now - (now % 86_400_000);
    events.forEach((e, i) => {
      if (e.type !== "follow-ups") return;
      e.tickets.forEach((f, j) => {
        const key = `followup:${ticketId}:${i}:${j}`;
        const [done] = this.d.db.all<{ n: number }>(
          "SELECT COUNT(*) AS n FROM knowledge_applied WHERE edit_id = ?",
          key,
        );
        if (done?.n) return;
        const filedToday = this.d.tickets
          .all()
          .filter(
            (r) => r.ticket.project === from.project && r.ticket.createdBy && r.createdAt >= dayStart,
          ).length;
        if (filedToday >= this.d.registry.projectPolicy(from.project).followUpsPerDay) {
          this.d.log?.(
            `follow-up "${f.title}" from ${e.employeeId} not filed: ${from.project}'s budget for today is used`,
          );
        } else {
          const t = this.d.tickets.create(
            {
              title: f.title,
              project: from.project,
              type: f.type,
              effort: f.effort,
              doneWhen: f.doneWhen,
              assignee: e.employeeId,
              createdBy: e.employeeId,
              labels: ["follow-up"],
            },
            now,
          );
          this.d.log?.(`ticket ${t.id} filed by ${e.employeeId} as a follow-up of ${ticketId}: ${f.title}`);
        }
        this.d.db.run("INSERT OR IGNORE INTO knowledge_applied (edit_id, at) VALUES (?, ?)", key, now);
      });
    });
  }

  /** Sends push notifications for needs-you, report-ready, and main-red events (Contract C2). */
  async sendPushNotifications(ticket: Ticket, events: TicketEvent[]): Promise<void> {
    if (!this.d.push) return;
    for (const [i, e] of events.entries()) {
      let payload: NotificationPayload | undefined;
      if (e.type === "needs-you") {
        payload = {
          title: `Needs you · #${ticket.id}`,
          body: ticket.title,
          url: `#/ticket/${ticket.id}`,
        };
      } else if (e.type === "report-ready") {
        payload = {
          title: `Report ready · #${ticket.id}`,
          body: ticket.title,
          url: `#/ticket/${ticket.id}`,
        };
      } else if (e.type === "main-red") {
        payload = {
          title: `Main is red · #${ticket.id}`,
          body: e.reason,
          url: `#/ticket/${ticket.id}`,
        };
      }
      if (!payload) continue;

      const key = `push:${ticket.id}:${i}`;
      const res = this.d.db.run(
        "INSERT INTO push_sent (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
        key,
        this.d.clock.now(),
      );
      if ((res?.changes ?? 0) === 0) continue;

      try {
        await this.d.push.send(payload);
      } catch (err) {
        this.d.log?.(`failed to send push notification for ${key}: ${String(err)}`);
      }
    }
  }

  /** Applies a ticket's proposed edits that are due and not yet applied (spec §5, "The brain"). */
  applyKnowledge(ticketId: Id, events: TicketEvent[]): void {
    const due = knowledgeLog(ticketId, events).due;
    if (!due.length) return;
    const applied = new Set(
      this.d.db
        .all<{ edit_id: string }>(
          "SELECT edit_id FROM knowledge_applied WHERE edit_id LIKE ?",
          `${ticketId}:%`,
        )
        .map((r) => r.edit_id),
    );
    for (const p of due) {
      if (applied.has(p.id)) continue;
      try {
        this.d.knowledge.apply(p, (id) => this.d.registry.employee(id));
        this.d.db.run(
          "INSERT OR IGNORE INTO knowledge_applied (edit_id, at) VALUES (?, ?)",
          p.id,
          this.d.clock.now(),
        );
      } catch (e) {
        this.d.log?.(`knowledge edit ${p.id} not applied: ${String(e)}`);
      }
    }
  }

  /**
   * Stops the employee's session on a ticket, if they're in one, so it starts again with the urgent
   * message first. Returns whether a session was stopped.
   */
  interrupt(ticketId: Id, employeeId: Id): boolean {
    const s = this.sessions.get(ticketId);
    if (!s || s.employeeId !== employeeId || s.controller.signal.aborted) return false;
    s.controller.abort("the owner sent an urgent message");
    return true;
  }

  /** Resolves when nothing is running. For tests and a clean shutdown. */
  async idle(): Promise<void> {
    // A ticket that finishes asks for a tick before it leaves `running`, so the chain covers it.
    for (;;) {
      await this.chain;
      if (!this.running.size) return;
      await Promise.all(this.running.values());
    }
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

  private checkAutoReleases(records: TicketRecord[], states: Map<Id, TicketState>, now: number): void {
    const allReleases = this.d.registry.releases();
    for (const project of this.d.registry.projects()) {
      const policy = this.d.registry.projectPolicy(project.id);
      if (!policy.autoRelease) continue;

      const projectReleases = allReleases.filter((r) => r.project === project.id);
      const releasedTicketIds = new Set(projectReleases.flatMap((r) => r.ticketIds));
      const latestReleaseAt = projectReleases.length ? Math.max(...projectReleases.map((r) => r.at)) : null;

      const projectTickets = records.filter((r) => r.ticket.project === project.id);
      const pendingTickets = projectTickets.filter((r) => {
        if (releasedTicketIds.has(r.ticket.id)) return false;
        const state = states.get(r.ticket.id);
        if (state?.outcome !== "merged") return false;
        if (latestReleaseAt !== null && (state.closedAt ?? 0) <= latestReleaseAt) return false;
        return true;
      });

      if (!pendingTickets.length) continue;

      const count = projectReleases.length + 1;
      const tag = `v${new Date(now).toISOString().slice(0, 10)}.${count}`;
      const ticketIds = pendingTickets.map((r) => r.ticket.id);
      const commits = pendingTickets
        .map((r) => states.get(r.ticket.id)?.pushed)
        .filter((c): c is string => typeof c === "string" && Boolean(c));

      const release: ProjectRelease = {
        project: project.id,
        tag,
        at: now,
        ticketIds,
        commits,
      };

      this.d.registry.recordRelease(release);
      allReleases.push(release);
      this.d.log?.(`auto-release ${tag} recorded for project ${project.id} (${ticketIds.length} tickets)`);
    }
  }
}
