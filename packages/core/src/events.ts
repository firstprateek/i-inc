// A ticket's history is an append-only list of events (spec §9, "Durable state").
// Everything the pipeline knows is folded from these, so a crash loses nothing that was appended.
import type { FollowUp, Id, KnowledgeEdit, Proposal, PullRequestRef } from "./model.ts";
import type { StageId } from "./stages.ts";

export type NeedsYou =
  | { kind: "plan-gate"; plan: string }
  | { kind: "disagreement"; builder: string; reviewer: string }
  | { kind: "stuck"; reason: string }
  | { kind: "proposals"; items: Proposal[] }
  /** Direct mode: the change touches protected paths, so it waits for the owner's OK. */
  | { kind: "protected-paths"; paths: string[] };

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
  /** The branch is ready in `employeeId`'s machine (absent on events from before handoffs did this). */
  | { type: "pr-opened"; at: number; pr: PullRequestRef; employeeId?: Id }
  | { type: "report-ready"; at: number; summary: string }
  /** Direct mode: the work reached main as this commit. */
  | { type: "pushed"; at: number; sha: string }
  /** Direct mode: CI failed on a commit this ticket pushed; the builder fixes it, or it's reverted. */
  | { type: "main-red"; at: number; sha: string; reason: string }
  | { type: "reverted"; at: number; sha: string }
  /** CI passed on a commit this ticket pushed. */
  | { type: "ci-green"; at: number; sha: string }
  /** Tickets an agent proposes for itself; the daemon files them within the project's budget. */
  | { type: "follow-ups"; at: number; employeeId: Id; tickets: FollowUp[] }
  /** The owner tries a failed ticket again, from the stage it failed in. */
  | { type: "retried"; at: number }
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
  /**
   * A reviewer or verifier couldn't start (its engine didn't launch, wasn't signed in, or its sandbox
   * wouldn't boot). The builder's ticket carries on: this employee (on `engineId`, when it was the
   * builder's own seat on another engine) is skipped for this duty and another is picked.
   */
  | {
      type: "helper-unavailable";
      at: number;
      stage: StageId;
      duty: HelperDuty;
      employeeId: Id;
      engineId?: Id;
      reason: string;
    }
  | { type: "failed"; at: number; stage: StageId; reason: string; tried: string[] };
