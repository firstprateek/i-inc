// Rules the board and the Needs you page share between the daemon (which builds their payloads) and the web
// app (which draws and updates them). Pure.
import type { TicketEvent } from "./events.ts";
import type { Id } from "./model.ts";

/** The scheduler's reason for a ticket that nobody is assigned to and no standing order covers. */
export const UNASSIGNED = "unassigned, and no standing order covers it";

/** The owner can fix this wait by assigning: nobody is assigned and no standing order covers it, or the assignee isn't on the team. */
export function waitsForAssignee(t: {
  status: string;
  waiting: string | null;
  held: boolean;
  assignee?: unknown;
}): boolean {
  if (t.status !== "queued" || t.held) return false;
  return t.waiting === UNASSIGNED || /^assignee .+ doesn't work here$/.test(t.waiting ?? "");
}

/**
 * The Needs you count: what waits for the owner's decision. Tickets asking a question or at a gate, finished
 * reports, conversations waiting for a permission or an answer, and handbook policy proposals. Agents' follow-up
 * proposals are suggestions and an unassigned ticket blocks nobody else's work, so neither counts; Needs you still
 * lists both. The daemon's `GET /api/needs-you`, the badge and the page all use this one rule.
 */
export function needsYouCount(
  tickets: readonly { status: string }[],
  policies: readonly unknown[] = [],
  conversations: readonly { needsYou?: unknown }[] = [],
): number {
  return (
    tickets.filter((t) => t.status === "needs-you" || t.status === "ready").length +
    conversations.filter((c) => c.needsYou).length +
    policies.length
  );
}

/** One line of the board's report on a finished ticket: how it ended. */
export interface DigestRow {
  id: Id;
  title: string;
  outcome: "Merged" | "Done" | "Rejected" | "Failed" | "Ready";
  /** "pushed" when the work reached main, "failed" when it didn't, else where it stands. */
  note: string;
  at: number;
}

/** The ticket's last report, from its event log. Null while it has none. */
export function digestRow(
  t: { id: Id; title: string; status: string },
  events: readonly TicketEvent[],
): DigestRow | null {
  const failed = t.status === "failed";
  const finished = events.filter(
    (e) => e.type === "closed" || e.type === "failed" || e.type === "report-ready",
  );
  const last = finished.at(-1);
  if (!last) return null;
  const pushed = events.some((e) => e.type === "pushed");
  const opened = events.some((e) => e.type === "pr-opened");
  const closed = events.findLast((e) => e.type === "closed");
  const outcome: DigestRow["outcome"] = failed
    ? "Failed"
    : closed?.type === "closed"
      ? closed.outcome === "merged"
        ? "Merged"
        : closed.outcome === "rejected"
          ? "Rejected"
          : "Done"
      : "Ready";
  return {
    id: t.id,
    title: t.title,
    outcome,
    note: failed
      ? "failed"
      : pushed
        ? "pushed"
        : outcome === "Ready"
          ? "awaits you"
          : opened
            ? "PR opened"
            : "not pushed",
    at: last.at,
  };
}
