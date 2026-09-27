// What the board, office, ticket and My desk views read. Pure shaping of the event log and config.
import {
  assembleReport,
  type Employee,
  type Id,
  type NeedsYou,
  planFor,
  type Report,
  type Spend,
  type StageId,
  sessionHours,
  spend,
  type TicketEvent,
  type TicketState,
  type Wait,
  waits,
  withinHours,
} from "@i-inc/core";
import type { Registry } from "./registry.ts";
import type { TicketRecord } from "./tickets.ts";

export type Column = "todo" | "in-progress" | "review" | "done";

export interface TicketView {
  id: Id;
  title: string;
  project: string;
  type: string;
  effort: string;
  assignee: { id: Id; name: string } | null;
  column: Column;
  status: TicketState["status"] | "queued";
  stages: { id: StageId; state: "done" | "current" | "todo" }[];
  /** One line of what's happening now, e.g. "Checks · 2 failing". */
  live: string;
  needsYou: NeedsYou | null;
  waiting: string | null;
  report: Report | null;
  failure: TicketState["failure"];
  outcome: TicketState["outcome"];
}

export function ticketView(
  r: TicketRecord,
  s: TicketState,
  events: TicketEvent[],
  registry: Registry,
  waiting: string | null,
): TicketView {
  const assigneeId = s.assignee ?? r.ticket.assignee;
  const assignee = assigneeId ? { id: assigneeId, name: nameOf(registry, assigneeId) } : null;
  const plan = planFor(r.ticket).stages;
  const stages = plan.map((id) => ({
    id,
    state: s.finished.includes(id)
      ? ("done" as const)
      : s.active === id
        ? ("current" as const)
        : ("todo" as const),
  }));
  return {
    id: r.ticket.id,
    title: r.ticket.title,
    project: r.ticket.project,
    type: r.ticket.type,
    effort: r.ticket.effort,
    assignee,
    column: columnOf(s),
    status: s.created ? s.status : "queued",
    stages,
    live: liveLine(events, registry),
    needsYou: s.needsYou,
    waiting,
    report: s.status === "ready" ? assembleReport({ ...r.ticket, assignee: assigneeId }, s, registry) : null,
    failure: s.failure,
    outcome: s.outcome,
  };
}

export function columnOf(s: TicketState): Column {
  if (!s.created) return "todo";
  if (s.status === "ready" || s.status === "failed") return "review";
  if (s.status === "done") return "done";
  return "in-progress";
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
    switch (e.type) {
      case "checks-ran":
        return e.green ? "Checks green" : `Checks · ${e.failures.length} failing`;
      case "out-of-tokens":
        return `Out of tokens · resumes ${new Date(e.resetsAt).toISOString().slice(11, 16)} UTC`;
      case "engine-switched":
        return `Switched to ${registry.engine(e.to).model}: ${e.reason}`;
      case "review-verdict":
        return e.approved
          ? `Approved in round ${e.round}`
          : `Review round ${e.round} · ${e.findings.length} findings`;
      case "needs-you":
        return "Needs you";
      case "report-ready":
        return "Report ready";
      case "failed":
        return `Failed: ${e.reason}`;
      case "closed":
        return e.outcome === "merged" ? "Merged" : e.outcome === "rejected" ? "Rejected" : "Done";
      case "session-started":
        return `${capitalize(e.stage)} · ${nameOf(registry, e.employeeId)} on ${registry.engine(e.engineId).model}`;
      case "stage-started":
        return capitalize(e.stage);
    }
  }
  return "Queued";
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type EmployeeState =
  | "idle"
  | "working"
  | "reviewing"
  | "needs-you"
  | "out-of-tokens"
  | "done"
  | "failed"
  | "off";

export interface DeskEntry {
  id: Id;
  name: string;
  role: string;
  engine: string;
  state: EmployeeState;
  ticket: { id: Id; title: string; project: string; live: string } | null;
}

/** The office: each employee's desk (spec §10). */
export function officeView(
  employees: Employee[],
  views: TicketView[],
  states: Map<Id, TicketState>,
  registry: Registry,
  localHour: number,
): DeskEntry[] {
  return employees.map((e) => {
    const engine = registry.engine(e.engines.default).model;
    const own = views.filter((v) => v.assignee?.id === e.id && v.column !== "done" && v.status !== "queued");
    const reviewing = [...states.entries()].find(
      ([, s]) => s.active === "review" && s.sessions.at(-1)?.employeeId === e.id,
    );
    const current = own.find((v) => v.column === "in-progress") ?? own[0];
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
    return { id: e.id, name: e.name, role: e.role, engine, state, ticket };
  });
}

export interface DeskView {
  spend: Spend;
  waits: Wait[];
  bottleneck: Wait | null;
  merged: number;
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
