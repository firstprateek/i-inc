// The one-page report (spec §10). The harness supplies the facts from the event log; the builder's
// draft supplies the judgment.
import type { Ticket } from "./model.ts";
import type { Company } from "./ports.ts";
import type { TicketState } from "./state.ts";

export interface Report {
  /** e.g. "[fix] Refunds are counted as spending · Duet" */
  title: string;
  /** e.g. "Ada (Claude Opus), reviewed by Grace, 1 round" */
  byline: string;
  /** e.g. "started on Claude Sonnet; moved to Gemini 3.1 Pro for checks after 3 failed check runs", or null. */
  engines: string | null;
  checks: string;
  minutes: number;
  judgment: string;
  /** The ticket's pull request, when it has one. */
  pr: string | null;
}

export function assembleReport(ticket: Ticket, s: TicketState, company: Company): Report {
  const builder = company.employee(ticket.assignee);
  const model = (engineId: string) => company.engine(engineId).model;
  const own = s.sessions.filter((x) => x.employeeId === builder.id);
  const first = own[0] && model(own[0].engineId);
  const last = own.at(-1) && model(own.at(-1)?.engineId ?? "");

  const reviewerSession = s.sessions.find((x) => x.stage === "review" && x.employeeId !== builder.id);
  const reviewer = reviewerSession && company.employee(reviewerSession.employeeId).name;
  const rounds = s.review.round;
  const byline =
    `${builder.name} (${last ?? "no engine"})` +
    (reviewer ? `, reviewed by ${reviewer}, ${rounds} ${rounds === 1 ? "round" : "rounds"}` : "");

  // A switch lasts for the rest of its stage, so name each one with its stage (spec §5).
  const engines = s.switches.length
    ? [
        `started on ${first}`,
        ...s.switches.map((w) => `moved to ${model(w.to)} for ${w.stage} after ${w.reason}`),
      ].join("; ")
    : null;

  return {
    title: `[${ticket.type}] ${ticket.title} · ${ticket.project}`,
    byline,
    engines,
    checks: s.lastChecks?.green ? "checks green" : "checks not run",
    // Working time: the days a ticket sat failed or paused don't count.
    minutes: Math.round(s.workedMs / 60_000),
    judgment: s.outputs.report ?? "",
    pr: s.pr?.url ?? null,
  };
}

/** The report as the PR's body: the facts first, then the builder's judgment. */
export function reportMarkdown(r: Report): string {
  const facts = [r.byline, r.checks, `${r.minutes} ${r.minutes === 1 ? "minute" : "minutes"}`].join(" · ");
  return [`## ${r.title}`, "", facts, ...(r.engines ? ["", `Engines: ${r.engines}.`] : []), "", r.judgment]
    .join("\n")
    .trim();
}
