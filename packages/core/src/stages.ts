// Stages are data, set per effort (spec §6, "Effort sets how far the loop goes").
import { type Duty, defaultProjectPolicy, type Effort, type ProjectPolicy, type Ticket } from "./model.ts";

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
  | "proposals"
  | "orient"
  | "retro";

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
  orient: "build",
  retro: "build",
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
  stages: ["pickup", "work", "proposals", "retro"],
  reviewRounds: 0,
  planGate: "never",
};

/** A new hire's orientation (spec §5, "Hiring"): read, then write the brain's first pages. */
export const orientationPlan: StagePlan = {
  stages: ["pickup", "orient"],
  reviewRounds: 0,
  planGate: "never",
};

/**
 * Direct mode (decided 2026-10-17): every code ticket is reviewed by a fresh pair of eyes, for at
 * most 2 rounds, and nothing waits for the owner except protected paths. The gates push to main.
 */
export const directPlans: Record<Effort, StagePlan> = {
  low: {
    stages: ["pickup", "build", "checks", "review", "gates", "report"],
    reviewRounds: 2,
    planGate: "never",
  },
  medium: {
    stages: ["pickup", "plan", "build", "checks", "prove", "review", "gates", "report"],
    reviewRounds: 2,
    planGate: "never",
  },
  high: {
    stages: ["pickup", "plan", "build", "checks", "prove", "review", "gates", "report"],
    reviewRounds: 2,
    planGate: "never",
  },
};

/** Ticket kinds are data: code tickets follow their effort's plan, errands and orientation their own. */
export function planFor(ticket: Ticket, policy: ProjectPolicy = defaultProjectPolicy): StagePlan {
  if (ticket.type === "errand") return errandPlan;
  if (ticket.type === "orientation") return orientationPlan;
  return (policy.mode === "direct" ? directPlans : stagePlans)[ticket.effort];
}
