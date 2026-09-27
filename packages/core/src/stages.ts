// Stages are data, set per effort (spec §6, "Effort sets how far the loop goes").
import type { Duty, Effort } from "./model.ts";

export type StageId = "pickup" | "plan" | "build" | "checks" | "prove" | "review" | "gates" | "report";

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
