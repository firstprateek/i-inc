// A ticket's history is an append-only list of events (spec §9, "Durable state").
// Everything the pipeline knows is folded from these, so a crash loses nothing that was appended.
import type { Id, KnowledgeEdit, Proposal, PullRequestRef } from "./model.ts";
import type { StageId } from "./stages.ts";

export type NeedsYou =
  | { kind: "plan-gate"; plan: string }
  | { kind: "disagreement"; builder: string; reviewer: string }
  | { kind: "stuck"; reason: string }
  | { kind: "proposals"; items: Proposal[] };

/** Duties done for another employee's ticket. */
export type HelperDuty = "review" | "verify";

/** The owner's decision on a ready ticket (spec §6, stage 10). */
export type Decision = "approve" | "changes" | "reject";

export interface Finding {
  severity: "blocking" | "should-fix" | "nit";
  where: string;
  text: string;
}

export type TicketEvent =
  | { type: "ticket-created"; at: number; ticketId: Id }
  | { type: "stage-started"; at: number; stage: StageId }
  | { type: "session-started"; at: number; stage: StageId; employeeId: Id; engineId: Id; resume: boolean }
  | { type: "checkpoint"; at: number; stage: StageId; note: string }
  | { type: "stage-finished"; at: number; stage: StageId; output?: string }
  | { type: "out-of-tokens"; at: number; stage: StageId; engineId: Id; resetsAt: number }
  | { type: "engine-switched"; at: number; stage: StageId; from: Id; to: Id; reason: string }
  | { type: "checks-ran"; at: number; green: boolean; failures: string[] }
  | { type: "proof"; at: number; items: { doneWhen: string; pass: boolean; evidence: string }[] }
  | {
      type: "review-verdict";
      at: number;
      reviewerId: Id;
      round: number;
      approved: boolean;
      findings: Finding[];
    }
  | { type: "addressed"; at: number; round: number; disputed: string | null }
  | { type: "gates-ran"; at: number; ok: boolean; conflict: boolean; reason?: string }
  | { type: "needs-you"; at: number; stage: StageId; ask: NeedsYou }
  | {
      type: "owner-answered";
      at: number;
      answer: "approve" | "reject" | "builder" | "reviewer";
      note?: string;
    }
  | { type: "proposals-sorted"; at: number; auto: Proposal[]; ask: Proposal[]; off: Proposal[] }
  | { type: "proposals-decided"; at: number; carryOut: Proposal[]; declined: Proposal[] }
  | { type: "pr-opened"; at: number; pr: PullRequestRef }
  | { type: "report-ready"; at: number; summary: string }
  | { type: "owner-decided"; at: number; decision: Decision; note?: string }
  | {
      type: "knowledge-proposed";
      at: number;
      employeeId: Id;
      apply: KnowledgeEdit[];
      awaitOwner: KnowledgeEdit[];
    }
  | { type: "closed"; at: number; outcome: "merged" | "rejected" | "done" }
  /** The owner approved or declined a proposed handbook policy change (see knowledge.ts for ids). */
  | { type: "policy-decided"; at: number; editId: string; approved: boolean }
  | { type: "reassigned"; at: number; from: Id; to: Id }
  | { type: "owner-message"; at: number; text: string; urgent?: boolean }
  /** The owner stopped a session with an urgent message; the stage starts again with it. */
  | { type: "session-interrupted"; at: number; stage: StageId; reason: string }
  /** The stage needs another employee, and the scheduler will pick one (spec §6, "Assignment and scheduling"). */
  | { type: "helper-wanted"; at: number; stage: StageId; duty: HelperDuty }
  | { type: "helper-assigned"; at: number; duty: HelperDuty; employeeId: Id }
  | { type: "failed"; at: number; stage: StageId; reason: string; tried: string[] };
