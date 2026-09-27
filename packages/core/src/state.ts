// Fold a ticket's events into the state the pipeline decides from. Pure.
import type { Finding, NeedsYou, TicketEvent } from "./events.ts";
import type { Id } from "./model.ts";
import type { StageId } from "./stages.ts";

export interface SessionRecord {
  stage: StageId;
  employeeId: Id;
  engineId: Id;
  resume: boolean;
}

export interface TicketState {
  created: boolean;
  finished: StageId[];
  outputs: Partial<Record<StageId, string>>;
  active: StageId | null;
  /** Engine that a switch rule moved the active stage to. Cleared when the stage ends. */
  engineOverride: Id | null;
  paused: { engineId: Id; since: number; until: number } | null;
  needsYou: NeedsYou | null;
  lastAnswer: { answer: string; note?: string } | null;
  /** Failed check runs in the active stage since the last engine switch. */
  checkFailures: number;
  /** Checks, proof or gates failed and the builder hasn't had a fix session since. */
  fixDue: boolean;
  /** A session started and hasn't reported back: it crashed, or ran out of tokens. */
  interrupted: boolean;
  lastChecks: { green: boolean; failures: string[] } | null;
  lastProof: { doneWhen: string; pass: boolean; evidence: string }[] | null;
  review: {
    round: number;
    approved: boolean;
    findings: Finding[];
    disputed: string | null;
    addressed: boolean;
  };
  gateConflicts: number;
  proofFailures: number;
  sessions: SessionRecord[];
  switches: { stage: StageId; from: Id; to: Id; reason: string }[];
  status: "running" | "paused" | "needs-you" | "ready" | "failed";
  failure: { stage: StageId; reason: string; tried: string[] } | null;
  startedAt: number | null;
  readyAt: number | null;
}

export function emptyState(): TicketState {
  return {
    created: false,
    finished: [],
    outputs: {},
    active: null,
    engineOverride: null,
    paused: null,
    needsYou: null,
    lastAnswer: null,
    checkFailures: 0,
    fixDue: false,
    interrupted: false,
    lastChecks: null,
    lastProof: null,
    review: { round: 0, approved: false, findings: [], disputed: null, addressed: false },
    gateConflicts: 0,
    proofFailures: 0,
    sessions: [],
    switches: [],
    status: "running",
    failure: null,
    startedAt: null,
    readyAt: null,
  };
}

export function apply(s: TicketState, e: TicketEvent): TicketState {
  switch (e.type) {
    case "ticket-created":
      return { ...s, created: true, startedAt: e.at };
    case "stage-started":
      return {
        ...s,
        active: e.stage,
        engineOverride: null,
        checkFailures: 0,
        fixDue: false,
        lastAnswer: null,
      };
    case "session-started":
      return {
        ...s,
        paused: null,
        status: "running",
        interrupted: true,
        sessions: [
          ...s.sessions,
          { stage: e.stage, employeeId: e.employeeId, engineId: e.engineId, resume: e.resume },
        ],
      };
    case "checkpoint":
      return { ...s, interrupted: false, fixDue: false, outputs: { ...s.outputs, [e.stage]: e.note } };
    case "stage-finished":
      return {
        ...s,
        active: null,
        engineOverride: null,
        interrupted: false,
        finished: [...s.finished, e.stage],
        outputs: e.output === undefined ? s.outputs : { ...s.outputs, [e.stage]: e.output },
      };
    case "out-of-tokens":
      return { ...s, status: "paused", paused: { engineId: e.engineId, since: e.at, until: e.resetsAt } };
    case "engine-switched":
      return {
        ...s,
        paused: null,
        status: "running",
        engineOverride: e.to,
        checkFailures: 0,
        switches: [...s.switches, { stage: e.stage, from: e.from, to: e.to, reason: e.reason }],
      };
    case "checks-ran":
      return {
        ...s,
        lastChecks: { green: e.green, failures: e.failures },
        checkFailures: e.green ? s.checkFailures : s.checkFailures + 1,
        fixDue: !e.green,
      };
    case "proof": {
      const pass = e.items.every((i) => i.pass);
      return {
        ...s,
        interrupted: false,
        fixDue: !pass,
        lastProof: e.items,
        proofFailures: pass ? s.proofFailures : s.proofFailures + 1,
      };
    }
    case "review-verdict":
      return {
        ...s,
        interrupted: false,
        review: {
          round: e.round,
          approved: e.approved,
          findings: e.findings,
          disputed: null,
          addressed: false,
        },
      };
    case "addressed":
      return { ...s, interrupted: false, review: { ...s.review, disputed: e.disputed, addressed: true } };
    case "gates-ran":
      return { ...s, fixDue: e.conflict, gateConflicts: e.conflict ? s.gateConflicts + 1 : s.gateConflicts };
    case "needs-you":
      return { ...s, status: "needs-you", interrupted: false, needsYou: e.ask, lastAnswer: null };
    case "owner-answered":
      return {
        ...s,
        status: "running",
        needsYou: null,
        lastAnswer: e.note === undefined ? { answer: e.answer } : { answer: e.answer, note: e.note },
      };
    case "report-ready":
      return { ...s, status: "ready", readyAt: e.at, outputs: { ...s.outputs, report: e.summary } };
    case "failed":
      return { ...s, status: "failed", failure: { stage: e.stage, reason: e.reason, tried: e.tried } };
  }
}

export function fold(events: TicketEvent[]): TicketState {
  return events.reduce(apply, emptyState());
}
