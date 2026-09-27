// A ticket's history is an append-only list of events (spec §9, "Durable state").
// Everything the pipeline knows is folded from these, so a crash loses nothing that was appended.
import type { Id, KnowledgeEdit, Proposal } from "./model.ts";
import type { StageId } from "./stages.ts";

export type NeedsYou =
  | { kind: "plan-gate"; plan: string }
  | { kind: "disagreement"; builder: string; reviewer: string }
  | { kind: "stuck"; reason: string }
  | { kind: "proposals"; items: Proposal[] };

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
  | { type: "failed"; at: number; stage: StageId; reason: string; tried: string[] };
