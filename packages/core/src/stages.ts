// Stages are data, set per effort (spec §6, "Effort sets how far the loop goes").
import type { Duty, Effort, Ticket } from "./model.ts";

export type StageId =
  | "pickup"
  | "plan"
  | "build"
  | "checks"
  | "prove"
  | "review"
  | "gates"
  | "report"
  | "work"
  | "proposals";

/** Who does a stage: an employee with a duty, or the harness (deterministic code, no tokens). */
export const stageDuty: Record<StageId, Duty | "harness"> = {
  pickup: "harness",
  plan: "plan",
  build: "build",
  checks: "harness",
  prove: "verify",
  review: "review",
  gates: "harness",
  report: "build",
  work: "build",
  proposals: "harness",
};

export interface StagePlan {
  stages: StageId[];
  /** Review rounds before an open disagreement goes to the owner. */
  reviewRounds: number;
  /** Plan gate: whether the plan always waits for the owner. */
  planGate: "always" | "risky" | "never";
}

export const stagePlans: Record<Effort, StagePlan> = {
  low: { stages: ["pickup", "build", "checks", "gates", "report"], reviewRounds: 0, planGate: "never" },
  medium: {
    stages: ["pickup", "plan", "build", "checks", "prove", "review", "gates", "report"],
    reviewRounds: 1,
    planGate: "risky",
  },
  high: {
    stages: ["pickup", "plan", "build", "checks", "prove", "review", "gates", "report"],
    reviewRounds: 2,
    planGate: "always",
  },
};

/** An errand's shorter loop (spec §7): do the work, then sort its proposals by outbound permission. */
export const errandPlan: StagePlan = {
  stages: ["pickup", "work", "proposals"],
  reviewRounds: 0,
  planGate: "never",
};

/** Ticket kinds are data: code tickets follow their effort's plan, errands their own. */
export function planFor(ticket: Ticket): StagePlan {
  return ticket.type === "errand" ? errandPlan : stagePlans[ticket.effort];
}
