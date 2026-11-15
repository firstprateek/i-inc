// Stages are data, set per effort (spec §6, "Effort sets how far the loop goes").
import { type Duty, defaultProjectPolicy, type Effort, type ProjectPolicy, type Ticket } from "./model.ts";

export type StageId =
  | "pickup"
  | "plan"
  | "build"
  | "checks"
  | "prove"
  | "review"
  | "done-when"
  | "gates"
  | "report"
  | "work"
  | "proposals"
  | "orient"
  | "tidy"
  | "retro";

/** Who does a stage: an employee with a duty, or the harness (deterministic code, no tokens). */
export const stageDuty: Record<StageId, Duty | "harness"> = {
  pickup: "harness",
  plan: "plan",
  build: "build",
  checks: "harness",
  prove: "verify",
  review: "review",
  // (T72) A light, read-only check of each done-when item by a fresh session that is never the builder's own;
  // where the prove stage already checked them it only records that.
  "done-when": "verify",
  gates: "harness",
  report: "build",
  work: "build",
  proposals: "harness",
  orient: "build",
  tidy: "librarian",
  retro: "build",
};

export interface StagePlan {
  stages: StageId[];
  /** Review rounds before an open disagreement goes to the owner. */
  reviewRounds: number;
  /** Plan gate: whether the plan always waits for the owner. */
  planGate: "always" | "risky" | "never";
  /**
   * Fast mode (decided 2026-11-14, direct mode's default): the builder plans inside its build session; one fresh
   * check session, in the builder's own seat and engine unless the project opts in to another vendor, reviews the
   * diff and checks every done-when item together, without the brain and at low effort; round 2 looks only at what
   * changed; the daemon writes the report from the builder's own summary; and the retro runs only when something
   * happened worth learning from.
   */
  fast?: true;
}

export const stagePlans: Record<Effort, StagePlan> = {
  low: {
    stages: ["pickup", "build", "checks", "done-when", "gates", "report"],
    reviewRounds: 0,
    planGate: "never",
  },
  medium: {
    stages: ["pickup", "plan", "build", "checks", "prove", "review", "done-when", "gates", "report"],
    reviewRounds: 1,
    planGate: "risky",
  },
  high: {
    stages: ["pickup", "plan", "build", "checks", "prove", "review", "done-when", "gates", "report"],
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

/** The daily "Tend the brain" ticket (docs/design/brain.md, "Tending"): one session by the librarian, no code. */
export const tidyPlan: StagePlan = {
  stages: ["pickup", "tidy"],
  reviewRounds: 0,
  planGate: "never",
};

/**
 * Direct mode (decided 2026-10-17): every code ticket is reviewed by a fresh pair of eyes, for at
 * most 2 rounds, and nothing waits for the owner except protected paths. The gates push to main.
 *
 * Low and Medium run fast (decided 2026-11-14): build, checks, one check session that reviews the diff
 * and the done-when together, the gates and a report. High is thorough: a plan, a separate proof and
 * done-when check, and a review on another vendor's engine where there is one.
 */
const fastPlan: StagePlan = {
  stages: ["pickup", "build", "checks", "review", "gates", "report"],
  reviewRounds: 2,
  planGate: "never",
  fast: true,
};

export const directPlans: Record<Effort, StagePlan> = {
  low: fastPlan,
  medium: fastPlan,
  high: {
    stages: ["pickup", "plan", "build", "checks", "prove", "review", "done-when", "gates", "report"],
    reviewRounds: 2,
    planGate: "never",
  },
};

/** Ticket kinds are data: code tickets follow their effort's plan, errands and orientation their own. */
export function planFor(ticket: Ticket, policy: ProjectPolicy = defaultProjectPolicy): StagePlan {
  if (ticket.type === "errand") return errandPlan;
  if (ticket.type === "orientation") return orientationPlan;
  if (ticket.type === "tidy") return tidyPlan;
  // An effort this version doesn't know (a bad value stored from an agent's reply) plans as Medium.
  const plans = policy.mode === "direct" ? directPlans : stagePlans;
  return plans[ticket.effort] ?? plans.medium;
}

/** What a stage is called where the owner sees it: a stage with no entry shows as its own id. */
const stageLabels: Partial<Record<StageId, string>> = { "done-when": "Checking done-when" };
export const stageLabel = (id: StageId): string => stageLabels[id] ?? id;
