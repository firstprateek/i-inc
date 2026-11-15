// How often the owner is asked (decided 2026-11-15): a company-wide level with a per-employee override, in
// Company → Settings → Approvals. Lenient, the default, asks only where a mistake is costly or can't be undone;
// careful asks the way i.inc always did. What always asks, whatever the level, is `alwaysAsks`.

/** How often an employee's work waits for the owner. */
export type ApprovalLevel = "lenient" | "careful";
export const approvalLevels: readonly ApprovalLevel[] = ["lenient", "careful"];
export const defaultApprovalLevel: ApprovalLevel = "lenient";

export const isApprovalLevel = (v: unknown): v is ApprovalLevel =>
  typeof v === "string" && (approvalLevels as readonly string[]).includes(v);

/** The employee's own level, else the company's, else lenient. */
export function approvalLevel(
  employee: ApprovalLevel | undefined,
  company: ApprovalLevel | undefined,
): ApprovalLevel {
  return employee ?? company ?? defaultApprovalLevel;
}

/** What lenient stops asking about, in the owner's words (the Settings page lists it). */
export const lenientSkips: readonly string[] = [
  "A done-when item the checker can't confirm: the work goes on, and the report says what wasn't confirmed",
  "Plans, even for risky areas: the employee goes straight to building",
  "A builder and reviewer who still disagree after the review rounds: the work goes on, and the report notes it",
  "Follow-ups over the project's daily budget: filed on the board on hold, to start when you like",
];

/** What always waits for the owner, at any level. */
export const alwaysAsks: readonly string[] = [
  "Shipping a change to the code the live app runs (the deployer deploys only what you OKed)",
  "Changes to a project's protected paths",
  "Spending money, booking, deleting mail, forwarding, sharing files or changing account settings (a PA)",
  "Anything a PA sends to someone outside your contacts",
  "New handbook policy, which every employee follows",
  "Work that is really stuck, or a done-when item still not met after the builder's fix",
];

/** The longest a Needs you request may be: one line, at a high level. The details stay on the ticket. */
export const maxAskLength = 160;

/** A stuck card: one short line to answer, and the whole text as its detail when the line had to be cut. */
export function stuckAsk(text: string): { kind: "stuck"; reason: string; detail?: string } {
  const reason = askLine(text);
  const whole = text.trim();
  return reason === whole.replace(/\s+/g, " ")
    ? { kind: "stuck", reason }
    : { kind: "stuck", reason, detail: whole };
}

/** One short line: whitespace collapsed and cut at `max` characters, at a word where it can. */
export function askLine(text: string, max = maxAskLength): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.(–-]+$/, "")}…`;
}
