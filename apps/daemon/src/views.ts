import {
  type AccountCost,
  assembleReport,
  type Employee,
  type Id,
  planFor,
  sessionHours,
  spend,
  type TicketEvent,
  type TicketState,
  waits,
  withinHours,
} from "@i-inc/core";
import type { Db } from "./db.ts";
import type { Registry } from "./registry.ts";
import type {
  AccountRateLimit,
  Column,
  DeskEntry,
  DeskView,
  EmployeeState,
  PendingRelease,
  PendingTicket,
  Person,
  ProposalView,
  TicketView,
} from "./view-types.ts";

export type {
  AccountRateLimit,
  Column,
  DeskEntry,
  DeskView,
  EmployeeState,
  PendingRelease,
  PendingTicket,
  Person,
  ProposalView,
  TicketView,
};

import type { StoredProposal } from "./proposals.ts";
import type { TicketRecord } from "./tickets.ts";

export function ticketView(
  r: TicketRecord,
  s: TicketState,
  events: TicketEvent[],
  registry: Registry,
  waiting: string | null,
  waitingUntil: number | null = null,
): TicketView {
  const assigneeId = s.assignee ?? r.ticket.assignee;
  const assignee = assigneeId ? personOf(registry, assigneeId) : null;
  const plan = planFor(r.ticket, registry.projectPolicy(r.ticket.project)).stages;
  const stages = plan.map((id) => ({
    id,
    state: s.finished.includes(id)
      ? ("done" as const)
      : s.active === id
        ? ("current" as const)
        : ("todo" as const),
  }));
  const createdBy =
    !r.ticket.createdBy || r.ticket.createdBy === "owner" ? null : personOf(registry, r.ticket.createdBy);

  let finishedAt: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && (e.type === "closed" || e.type === "failed" || e.type === "report-ready")) {
      finishedAt = e.at;
      break;
    }
  }

  const pushed = events.some((e) => e.type === "pushed") || Boolean(s.pushed);

  return {
    id: r.ticket.id,
    title: r.ticket.title,
    project: r.ticket.project,
    type: r.ticket.type,
    effort: r.ticket.effort,
    assignee,
    column: columnOf(s),
    status: s.created ? s.status : "queued",
    held: r.hold,
    stages,
    live: liveLine(events, registry),
    needsYou: s.needsYou,
    waiting,
    ...(waiting && waitingUntil ? { waitingUntil } : {}),
    report: s.status === "ready" ? assembleReport({ ...r.ticket, assignee: assigneeId }, s, registry) : null,
    failure: s.failure,
    outcome: s.outcome,
    createdBy,
    finishedAt,
    pushed,
    ...(r.ticket.conversation ? { fromConversation: { id: r.ticket.conversation, title: null } } : {}),
    ...(r.ticket.attachments?.length
      ? {
          attachments: r.ticket.attachments.map((a) => ({
            ...a,
            url: `/api/tickets/${encodeURIComponent(r.ticket.id)}/attachments/${a.n}`,
          })),
        }
      : {}),
  };
}

export function columnOf(s: TicketState): Column {
  if (!s.created) return "todo";
  if (s.status === "ready" || s.status === "failed") return "review";
  if (s.status === "done") return "done";
  return "in-progress";
}

function personOf(registry: Registry, id: Id): Person {
  try {
    const e = registry.employee(id);
    return { id, name: e.name, tint: e.tint ?? 0, role: e.role };
  } catch {
    return { id, name: id, tint: 0, role: "" };
  }
}

/** A stored proposal as the API and the web show it. */
export function proposalView(p: StoredProposal, registry: Registry): ProposalView {
  return { ...p, proposer: personOf(registry, p.proposedBy) };
}

/** An engine's model name, or its id when the engine was removed in Setup while an event or employee still names it. */
function modelOf(registry: Registry, id: Id): string {
  try {
    return registry.engine(id).model;
  } catch {
    return id;
  }
}

function nameOf(registry: Registry, id: Id): string {
  try {
    return registry.employee(id).name;
  } catch {
    return id;
  }
}

/** The card's live status line, from the latest meaningful event. */
export function liveLine(events: TicketEvent[], registry: Registry): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    // An event that can't be described (stored before replies were checked) is passed over.
    try {
      const line = describe(e, registry);
      if (line !== null) return line;
    } catch {}
  }
  return "Queued";
}

function describe(e: TicketEvent, registry: Registry): string | null {
  switch (e.type) {
    case "checks-ran":
      return e.green ? "Checks green" : `Checks · ${e.failures.length} failing`;
    case "out-of-tokens":
      return `Out of tokens · resumes ${new Date(e.resetsAt).toISOString().slice(11, 16)} UTC`;
    case "engine-switched":
      return `Switched to ${modelOf(registry, e.to)}: ${e.reason}`;
    case "review-verdict":
      return e.approved
        ? `Approved in round ${e.round}`
        : `Review round ${e.round} · ${Array.isArray(e.findings) ? e.findings.length : 0} findings`;
    case "needs-you":
      return e.ask.kind === "plan-gate"
        ? "Plan gate: the plan waits for you"
        : e.ask.kind === "disagreement"
          ? "Disagreement: both sides wait for you"
          : e.ask.kind === "proposals"
            ? `${e.ask.items.length} ${e.ask.items.length === 1 ? "proposal waits" : "proposals wait"} for you`
            : e.ask.kind === "protected-paths"
              ? `Protected paths wait for your OK: ${e.ask.paths.join(", ")}`
              : `Stuck: ${e.ask.reason}`;
    case "report-ready":
      return "Report ready";
    case "failed":
      return `Failed: ${e.reason}`;
    case "closed":
      return e.outcome === "merged" ? "Merged" : e.outcome === "rejected" ? "Rejected" : "Done";
    case "session-started":
      return `${capitalize(e.stage)} · ${nameOf(registry, e.employeeId)} on ${modelOf(registry, e.engineId)}`;
    case "session-interrupted":
      return `${capitalize(e.stage)} · starting again with your urgent message`;
    case "helper-wanted":
      return `${capitalize(e.stage)} · waits for a ${e.duty === "review" ? "reviewer" : "verifier"}`;
    case "helper-unavailable":
      return `${capitalize(e.stage)} · ${nameOf(registry, e.employeeId)} unavailable: ${e.reason}`;
    case "stage-started":
      return capitalize(e.stage);
  }
  return null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The office: each employee's desk (spec §10). */
export function officeView(
  employees: Employee[],
  views: TicketView[],
  states: Map<Id, TicketState>,
  registry: Registry,
  localHour: number,
): DeskEntry[] {
  return employees.map((e) => {
    const engine = modelOf(registry, e.engines.default);
    const own = views.filter((v) => v.assignee?.id === e.id && v.column !== "done" && v.status !== "queued");
    const reviewing = [...states.entries()].find(
      ([, s]) =>
        (s.active === "review" && s.helpers.review === e.id) ||
        (s.active === "prove" && s.helpers.verify === e.id),
    );
    // While their own ticket waits for a reviewer, a builder may be reviewing someone else's.
    const current = (own.find((v) => v.column === "in-progress") ?? own[0]) as TicketView | undefined;
    const reviewed = reviewing && views.find((v) => v.id === reviewing[0]);
    if (reviewed && (!current || states.get(current.id)?.waitingFor)) {
      return {
        id: e.id,
        name: e.name,
        tint: e.tint ?? 0,
        role: e.role,
        engine,
        state: "reviewing" as const,
        ticket: { id: reviewed.id, title: reviewed.title, project: reviewed.project, live: reviewed.live },
      };
    }
    const off = e.workingHours && !withinHours(e.workingHours, localHour);
    let state: EmployeeState = "idle";
    if (reviewing) state = "reviewing";
    if (current) {
      const s = states.get(current.id);
      state =
        s?.status === "paused"
          ? "out-of-tokens"
          : s?.status === "needs-you"
            ? "needs-you"
            : s?.status === "ready"
              ? "done"
              : s?.status === "failed"
                ? "failed"
                : "working";
    }
    if (off && !current && !reviewing) state = "off";
    const ticket = current
      ? { id: current.id, title: current.title, project: current.project, live: current.live }
      : null;
    return { id: e.id, name: e.name, tint: e.tint ?? 0, role: e.role, engine, state, ticket };
  });
}

/** My desk (spec §10): this month's spend and where work waited. */
export function deskView(all: Map<Id, TicketEvent[]>, registry: Registry, now: number): DeskView {
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const tickets = [...all.values()].map((events) => events.filter((e) => e.at >= monthStart));
  const merged = tickets.filter((t) => t.some((e) => e.type === "closed" && e.outcome === "merged")).length;

  const hours = sessionHours(tickets);
  const localHours = registry
    .engines()
    .filter((e) => e.local)
    .reduce((sum, e) => sum + (hours[e.id] ?? 0), 0);
  const hosts = registry.hosts();
  const busyHoursByHost: Record<Id, number> = hosts[0] ? { [hosts[0].id]: localHours } : {};

  const w = waits(tickets, now);
  return {
    spend: spend({
      accounts: registry.accounts(),
      hosts,
      pricePerKWh: registry.settings().pricePerKWh,
      hoursInPeriod: (now - monthStart) / 3_600_000,
      tokensByAccount: {},
      busyHoursByHost,
      mergedPRs: merged,
    }),
    waits: w,
    bottleneck: w[0] ?? null,
    merged,
  };
}

/** Enriches accounts with bound models, harnesses, 5h/7d session counts & active minutes, and lastUsedAt. */
const MAX_RUNNING_SESSION_MS = 2 * 3_600_000; // 2 hours cap for unended sessions

function mergeIntervalMinutes(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  const first = intervals[0];
  if (!first) return 0;
  let totalMs = 0;
  let currStart = first[0];
  let currEnd = first[1];
  for (let i = 1; i < intervals.length; i++) {
    const item = intervals[i];
    if (!item) continue;
    const [s, e] = item;
    if (s <= currEnd) {
      currEnd = Math.max(currEnd, e);
    } else {
      totalMs += currEnd - currStart;
      currStart = s;
      currEnd = e;
    }
  }
  totalMs += currEnd - currStart;
  return Math.max(0, Math.round(totalMs / 60_000));
}

export function enrichAccounts(
  accounts: AccountCost[],
  registry: Registry,
  db: Db,
  now: number,
): AccountCost[] {
  const engines = registry.engines();
  const fiveHoursAgo = now - 5 * 3_600_000;
  const sevenDaysAgo = now - 7 * 24 * 3_600_000;

  let sessionRows: { engine_id: string; started_at: number; ended_at: number | null }[] = [];
  try {
    sessionRows = db.all<{ engine_id: string; started_at: number; ended_at: number | null }>(
      "SELECT engine_id, started_at, ended_at FROM ticket_sessions WHERE (ended_at IS NULL OR ended_at >= ?) AND started_at <= ? ORDER BY started_at DESC",
      sevenDaysAgo,
      now,
    );
  } catch {
    // If ticket_sessions table is not yet created
  }

  let eventRows: { body: string; at: number }[] = [];
  if (sessionRows.length === 0) {
    try {
      eventRows = db.all<{ body: string; at: number }>(
        "SELECT body, at FROM events WHERE type = 'session-started' AND at >= ? AND at <= ? ORDER BY at DESC",
        sevenDaysAgo,
        now,
      );
    } catch {}
  }

  return accounts.map((acc) => {
    const boundEngines = engines.filter((e) => e.accountId === acc.id);
    const models = [...new Set(boundEngines.map((e) => e.model))];
    const harnesses = [...new Set(boundEngines.map((e) => e.harness))];
    const engineIds = new Set(boundEngines.map((e) => e.id));

    let fiveHourSessions = 0;
    let fiveHourMinutes = 0;
    let sevenDaySessions = 0;
    let sevenDayMinutes = 0;
    let lastUsedAt: number | null = null;

    if (sessionRows.length > 0) {
      const intervals5: [number, number][] = [];
      const intervals7: [number, number][] = [];

      for (const row of sessionRows) {
        if (!engineIds.has(row.engine_id)) continue;
        if (row.started_at > now) continue;

        const effectiveEnd =
          row.ended_at !== null && row.ended_at !== undefined
            ? row.ended_at
            : Math.min(now, row.started_at + MAX_RUNNING_SESSION_MS);
        if (effectiveEnd <= row.started_at) continue;

        if (lastUsedAt === null || row.started_at > lastUsedAt) {
          lastUsedAt = row.started_at;
        }

        const start5 = Math.max(row.started_at, fiveHoursAgo);
        const end5 = Math.min(effectiveEnd, now);
        if (end5 > start5) {
          fiveHourSessions++;
          intervals5.push([start5, end5]);
        }

        const start7 = Math.max(row.started_at, sevenDaysAgo);
        const end7 = Math.min(effectiveEnd, now);
        if (end7 > start7) {
          sevenDaySessions++;
          intervals7.push([start7, end7]);
        }
      }

      fiveHourMinutes = mergeIntervalMinutes(intervals5);
      sevenDayMinutes = mergeIntervalMinutes(intervals7);
    } else if (eventRows.length > 0) {
      for (const er of eventRows) {
        try {
          const ev = JSON.parse(er.body) as { engineId?: string; at: number };
          if (ev.engineId && engineIds.has(ev.engineId) && ev.at <= now) {
            sevenDaySessions++;
            if (ev.at >= fiveHoursAgo) {
              fiveHourSessions++;
            }
            if (lastUsedAt === null || ev.at > lastUsedAt) {
              lastUsedAt = ev.at;
            }
          }
        } catch {}
      }
    }

    return {
      ...acc,
      ...(models.length ? { models } : {}),
      ...(harnesses.length ? { harnesses } : {}),
      fiveHourSessions,
      fiveHourMinutes,
      sevenDaySessions,
      sevenDayMinutes,
      lastUsedAt,
    };
  });
}

/** Provides rate limits for all accounts, expiring rejected limits past resetsAt without inventing statuses. */
export function allRateLimits(
  _accounts: AccountCost[],
  registry: Registry,
  now: number,
): Record<Id, AccountRateLimit> {
  const existing = registry.accountRateLimits();
  const out: Record<Id, AccountRateLimit> = {};
  for (const [id, rl] of Object.entries(existing)) {
    if (rl.status === "rejected" && rl.resetsAt && rl.resetsAt <= now) {
      const { status: _status, resetsAt: _resetsAt, ...rest } = rl;
      out[id] = { ...rest, updatedAt: now };
    } else {
      out[id] = rl;
    }
  }
  return out;
}
