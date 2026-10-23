// Who starts what next (spec §6, "Assignment and scheduling"). Pure: the daemon passes a snapshot
// and starts what comes back. Every ticket that doesn't start gets a reason, which the board shows
// ("waits for Claude Pro at 3:40 pm").
import { UNASSIGNED } from "./board.ts";
import { findEngine } from "./engines.ts";
import type { Duty, Employee, Id, StandingOrder, TicketType, WorkingHours } from "./model.ts";
import type { Company } from "./ports.ts";
import { doneWhenChecker, type TicketState } from "./state.ts";

export interface BacklogItem {
  id: Id;
  project: string;
  type: TicketType;
  labels?: string[];
  /** Higher goes first; ties go to the older ticket. */
  priority: number;
  createdAt: number;
  /** The owner's choice. Null means unassigned: a standing order may pick it up. */
  assignee: Id | null;
  /** Kept for the owner: nothing picks it up. */
  hold?: boolean;
}

/** A running ticket that needs another employee for a stage, e.g. a reviewer. */
export interface PendingDuty {
  ticketId: Id;
  duty: Extract<Duty, "review" | "verify">;
  /** The ticket's builder: once a helper is found, the ticket resumes and the builder is busy again. */
  builder: Id;
  /** The builder, at least: the reviewer is never the builder. */
  exclude: Id[];
  since: number;
}

export interface Snapshot {
  now: number;
  /** The owner's local hour (0-23), for working hours. */
  localHour: number;
  employees: Employee[];
  /** Employees in the middle of something. Each employee does one thing at a time. */
  busy: Id[];
  /**
   * Employees with a ticket of their own under way, now waiting (for a reviewer, the owner or an
   * account). They don't start another build, but they may review or verify meanwhile.
   */
  holding?: Id[];
  /** Accounts that are out of tokens, until when. */
  accountsBlockedUntil: Record<Id, number>;
  /** Employees whose own usage cap is reached, until when. */
  capReachedUntil: Record<Id, number>;
  /** Tickets each employee has picked up by standing order today. */
  pickedUpToday: Record<Id, number>;
  pending: PendingDuty[];
  backlog: BacklogItem[];
}

export type Start =
  | { employeeId: Id; ticketId: Id; as: "build"; by: "assignment" | "standing-order" }
  | { employeeId: Id; ticketId: Id; as: "review" | "verify" };

export interface Waiting {
  ticketId: Id;
  reason: string;
}

export interface Plan {
  starts: Start[];
  waiting: Waiting[];
  /** For a ticket waiting on an account block or usage cap: when it resets (epoch ms). */
  resets?: Record<Id, number>;
}

export function schedule(snap: Snapshot, company: Pick<Company, "engine" | "engineBlock">): Plan {
  const starts: Start[] = [];
  const waiting: Waiting[] = [];
  const resets: Record<Id, number> = {};
  const taken = new Set(snap.busy);
  const holding = new Set(snap.holding ?? []);
  const picked = { ...snap.pickedUpToday };

  const available = (e: Employee, duty: Duty): string | null => {
    if (taken.has(e.id) || ((duty === "build" || duty === "librarian") && holding.has(e.id))) {
      return `${e.name} is busy`;
    }
    if (e.workingHours && !withinHours(e.workingHours, snap.localHour)) {
      return `${e.name} is off until ${e.workingHours.from}:00`;
    }
    const cap = snap.capReachedUntil[e.id];
    if (cap !== undefined && cap > snap.now) return `${e.name} reached its usage cap`;
    // An engine removed from Setup while the employee still names it: they can't start, and the
    // rest of the pass goes on.
    const engine = findEngine(company, e.engines.perDuty?.[duty] ?? e.engines.default);
    if (!engine) return `${e.name}'s engine was removed in Setup`;
    const accountCap = snap.capReachedUntil[engine.accountId];
    if (accountCap !== undefined && accountCap > snap.now) return `${e.name} reached its usage cap`;
    const blocked = snap.accountsBlockedUntil[engine.accountId];
    if (blocked !== undefined && blocked > snap.now) {
      return `${e.name} waits for ${engine.accountId} to reset`;
    }
    // Their sandbox can't start, or (for a reviewer or verifier) their engine isn't signed in there.
    const block = company.engineBlock?.(e.id, engine.id, duty);
    if (block) return block.reason;
    return null;
  };

  /** When an account block or usage cap on this employee's engine for the duty ends, if one is in force. */
  const resetAt = (e: Employee, duty: Duty = "build"): number | undefined => {
    const engine = findEngine(company, e.engines.perDuty?.[duty] ?? e.engines.default);
    if (!engine) return undefined;
    const times = [
      snap.capReachedUntil[e.id],
      snap.capReachedUntil[engine.accountId],
      snap.accountsBlockedUntil[engine.accountId],
      company.engineBlock?.(e.id, engine.id, duty)?.until,
    ].filter((x): x is number => x !== undefined && x > snap.now);
    return times.length ? Math.max(...times) : undefined;
  };
  const isReset = (why: string) => /usage cap|to reset|sandbox can't start/.test(why);

  // A pending review goes ahead of starting a new build.
  for (const p of [...snap.pending].sort((a, b) => a.since - b.since)) {
    // The builder may be reviewing someone else's work meanwhile; their own ticket waits for them.
    if (taken.has(p.builder)) {
      const name = snap.employees.find((e) => e.id === p.builder)?.name ?? p.builder;
      waiting.push({ ticketId: p.ticketId, reason: `${name} is busy` });
      continue;
    }
    const withDuty = snap.employees.filter((e) => e.duties.includes(p.duty) && e.id !== p.builder);
    const candidates = withDuty.filter((e) => !p.exclude.includes(e.id));
    const noun = p.duty === "review" ? "reviewer" : "verifier";
    const free = candidates.find((e) => available(e, p.duty) === null);
    if (free) {
      taken.add(free.id);
      taken.add(p.builder);
      starts.push({ employeeId: free.id, ticketId: p.ticketId, as: p.duty });
    } else {
      waiting.push({
        ticketId: p.ticketId,
        reason: candidates[0]
          ? `waits for a ${noun}: ${available(candidates[0], p.duty)}`
          : withDuty.length
            ? // Everyone with the duty already failed to start for this ticket.
              `waits for a ${noun} who can start`
            : `no one else has the ${p.duty} duty`,
      });
    }
  }

  const queue = snap.backlog
    .filter((t) => !t.hold)
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

  for (const t of queue) {
    if (t.assignee) {
      const e = snap.employees.find((x) => x.id === t.assignee);
      if (!e) {
        waiting.push({ ticketId: t.id, reason: `assignee ${t.assignee} doesn't work here` });
        continue;
      }
      // The daily brain tidy-up is the librarian's work: it runs on the engine chosen for that duty.
      const duty: Duty = t.type === "tidy" ? "librarian" : "build";
      const why = available(e, duty);
      if (why) {
        const until = isReset(why) ? resetAt(e, duty) : undefined;
        if (until) resets[t.id] = until;
        waiting.push({ ticketId: t.id, reason: why });
        continue;
      }
      taken.add(e.id);
      starts.push({ employeeId: e.id, ticketId: t.id, as: "build", by: "assignment" });
      continue;
    }

    const takers = snap.employees.filter(
      (e) =>
        worksOn(e, t.project) &&
        (e.standingOrders ?? []).some((o) => matches(o, t)) &&
        (picked[e.id] ?? 0) <
          Math.max(...(e.standingOrders ?? []).filter((o) => matches(o, t)).map((o) => o.maxPerDay)),
    );
    const taker = takers.find((e) => available(e, "build") === null);
    if (taker) {
      taken.add(taker.id);
      picked[taker.id] = (picked[taker.id] ?? 0) + 1;
      starts.push({ employeeId: taker.id, ticketId: t.id, as: "build", by: "standing-order" });
    } else {
      const first = takers[0];
      const why = first ? (available(first, "build") ?? "") : UNASSIGNED;
      const until = first && isReset(why) ? resetAt(first) : undefined;
      if (until) resets[t.id] = until;
      waiting.push({ ticketId: t.id, reason: why });
    }
  }

  return { starts, waiting, ...(Object.keys(resets).length ? { resets } : {}) };
}

/** One ticket as the scheduler sees it: who builds it, and its folded state. */
export interface Underway {
  builder: Id;
  state: TicketState;
}

/**
 * Who is busy and who is holding a waiting ticket. A builder is busy while their ticket is running
 * (or its account has reset, so it resumes now), and only holding while it waits for a helper, the
 * owner or an account. A reviewer or verifier is busy from being picked until their stage ends.
 */
export function occupancy(tickets: Underway[], now: number): { busy: Id[]; holding: Id[] } {
  const busy = new Set<Id>();
  const holding = new Set<Id>();
  for (const { builder, state: s } of tickets) {
    if (!s.created || s.status === "ready" || s.status === "done" || s.status === "failed") continue;
    const resumes = s.status === "paused" && s.paused !== null && s.paused.until <= now;
    if ((s.status === "running" && !s.waitingFor) || resumes) busy.add(builder);
    else holding.add(builder);
    const duty = s.active === "review" ? "review" : s.active === "prove" ? "verify" : null;
    const helper = duty ? s.helpers[duty] : doneWhenChecker(s, builder);
    if (helper && s.status !== "needs-you") busy.add(helper);
  }
  return { busy: [...busy], holding: [...holding].filter((id) => !busy.has(id)) };
}

export function withinHours(h: WorkingHours, hour: number): boolean {
  return h.from <= h.to ? hour >= h.from && hour < h.to : hour >= h.from || hour < h.to;
}

function worksOn(e: Employee, project: string): boolean {
  return !e.projects || e.projects.includes(project);
}

function matches(o: StandingOrder, t: BacklogItem): boolean {
  return (
    (!o.types || o.types.includes(t.type)) &&
    (!o.projects || o.projects.includes(t.project)) &&
    (!o.labels || o.labels.every((l) => t.labels?.includes(l)))
  );
}
