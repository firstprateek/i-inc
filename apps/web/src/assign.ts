// Who can take a ticket, who usually does, and the plain-words reason a ticket is waiting. Pure, so the
// new-ticket form, the ticket page, the board and the inbox share one rule.
import type { Employee } from "@i-inc/core";
import type { TicketView } from "./api.ts";

/** An employee who may work on the project (`projects` absent means all) and builds tickets. */
export function assignable(employees: Employee[], project: string): Employee[] {
  return employees.filter((e) => e.duties.includes("build") && (!e.projects || e.projects.includes(project)));
}

/**
 * The people to offer for a project, the usual one first. The usual employee is the one with the
 * project in their `projects` who worked on it most recently (the highest ticket id they built there),
 * then the other project members, then employees who work on every project.
 */
export function assignees(employees: Employee[], project: string, tickets: TicketView[]): Employee[] {
  const lastWork = new Map<string, number>();
  for (const t of tickets) {
    if (t.project !== project || !t.assignee || t.status === "queued") continue;
    const n = Number(t.id);
    lastWork.set(t.assignee.id, Math.max(lastWork.get(t.assignee.id) ?? 0, Number.isFinite(n) ? n : 0));
  }
  const tier = (e: Employee) => (e.projects?.includes(project) ? 0 : 1);
  return assignable(employees, project)
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        tier(a.e) - tier(b.e) || (lastWork.get(b.e.id) ?? 0) - (lastWork.get(a.e.id) ?? 0) || a.i - b.i,
    )
    .map((x) => x.e);
}

/** The select's text: name and role. */
export const optionLabel = (e: Pick<Employee, "name" | "role">): string =>
  e.role ? `${e.name} · ${e.role}` : e.name;

/** The option for "no one yet", worded so the owner knows what it means. */
export const NOBODY_LABEL = "Nobody yet — Won't start until someone is assigned";

/** A ticket nobody has started: the owner may still choose who does it. */
export const notStarted = (t: Pick<TicketView, "status">): boolean => t.status === "queued";

/** The owner can fix this wait by assigning: nobody is assigned and no standing order covers it, or the assignee isn't on the team. */
export function waitsForAssignee(t: Pick<TicketView, "status" | "waiting" | "assignee" | "held">): boolean {
  if (!notStarted(t) || t.held) return false;
  return t.waiting === UNASSIGNED || /^assignee .+ doesn't work here$/.test(t.waiting ?? "");
}

export const UNASSIGNED = "unassigned, and no standing order covers it";

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The scheduler's reason in plain words, as a calm status line. Only reasons the daemon sends are
 * translated; any other is shown as it came ("Waiting: …") rather than guessed at.
 */
export function waitingLine(
  reason: string,
  until?: number | null,
  at: (ms: number) => string = clock,
): string {
  const when = until ? ` at ${at(until)}` : "";
  // Each rule: the scheduler's wording, and the clause that reads after "Waiting: ".
  const rules: [RegExp, (m: string[]) => string][] = [
    [/^assignee (.+) doesn't work here$/, (m) => `${m[1]} doesn't work on this project`],
    [/^(.+) is busy$/, (m) => `${m[1]} is busy with another ticket`],
    [/^(.+) is off until (\d+):00$/, (m) => `${m[1]} starts at ${m[2]}:00`],
    [
      /^(.+) reached its usage cap$/,
      (m) => (until ? `${m[1]}'s usage resets${when}` : `${m[1]} reached the usage cap`),
    ],
    [/^(.+) waits for (.+) to reset$/, (m) => `for ${m[2]} usage to reset${when}`],
    [/^no one else has the (review|verify) duty$/, (m) => `no other employee has the ${m[1]} duty`],
  ];
  const clause = (r: string): string => {
    if (r === UNASSIGNED) return "nobody is assigned yet";
    for (const [re, say] of rules) {
      const m = re.exec(r);
      if (m) return say(m);
    }
    return r;
  };
  const helper = /^waits for a (reviewer|verifier): (.+)$/.exec(reason);
  if (helper) return `Waiting for a ${helper[1]}: ${clause(helper[2] as string).replace(/^for /, "")}`;
  const c = clause(reason);
  return c.startsWith("for ") ? `Waiting ${c}` : `Waiting: ${c}`;
}
