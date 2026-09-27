// Who starts what next (spec §6, "Assignment and scheduling"). Pure: the daemon passes a snapshot
// and starts what comes back. Every ticket that doesn't start gets a reason, which the board shows
// ("waits for Claude Pro at 3:40 pm").
import type { Duty, Employee, Id, StandingOrder, TicketType, WorkingHours } from "./model.ts";
import type { Company } from "./ports.ts";

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
}

export function schedule(snap: Snapshot, company: Pick<Company, "engine">): Plan {
  const starts: Start[] = [];
  const waiting: Waiting[] = [];
  const taken = new Set(snap.busy);
  const picked = { ...snap.pickedUpToday };

  const available = (e: Employee, duty: Duty): string | null => {
    if (taken.has(e.id)) return `${e.name} is busy`;
    if (e.workingHours && !withinHours(e.workingHours, snap.localHour)) {
      return `${e.name} is off until ${e.workingHours.from}:00`;
    }
    const cap = snap.capReachedUntil[e.id];
    if (cap !== undefined && cap > snap.now) return `${e.name} reached its usage cap`;
    const engine = company.engine(e.engines.perDuty?.[duty] ?? e.engines.default);
    const blocked = snap.accountsBlockedUntil[engine.accountId];
    if (blocked !== undefined && blocked > snap.now) {
      return `${e.name} waits for ${engine.accountId} to reset`;
    }
    return null;
  };

  // A pending review goes ahead of starting a new build.
  for (const p of [...snap.pending].sort((a, b) => a.since - b.since)) {
    const candidates = snap.employees.filter((e) => e.duties.includes(p.duty) && !p.exclude.includes(e.id));
    const free = candidates.find((e) => available(e, p.duty) === null);
    if (free) {
      taken.add(free.id);
      starts.push({ employeeId: free.id, ticketId: p.ticketId, as: p.duty });
    } else {
      waiting.push({
        ticketId: p.ticketId,
        reason: candidates.length
          ? `no ${p.duty === "review" ? "reviewer" : "verifier"} is free`
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
      const why = available(e, "build");
      if (why) {
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
      waiting.push({
        ticketId: t.id,
        reason: takers.length
          ? (available(takers[0] as Employee, "build") ?? "")
          : "unassigned, and no standing order covers it",
      });
    }
  }

  return { starts, waiting };
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
