// Fold a ticket's events into the state the pipeline decides from. Pure.
import type { Decision, Finding, HelperDuty, NeedsYou, TicketEvent } from "./events.ts";
import type { Id, Proposal, PullRequestRef } from "./model.ts";
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
  status: "running" | "paused" | "needs-you" | "ready" | "failed" | "done";
  decision: Decision | null;
  /** The owner's requested changes, carried in every brief until the next report. */
  ownerNote: string | null;
  /** Employees who have proposed their retro edits. */
  retroBy: Id[];
  outcome: "merged" | "rejected" | "done" | null;
  /** Set by a handoff; otherwise the ticket's own assignee builds. */
  assignee: Id | null;
  handedFrom: Id | null;
  /** The owner's chat messages about this ticket. A session sees those sent before its stage began. */
  messages: { at: number; text: string; urgent?: boolean }[];
  /** The last session was stopped by an urgent message. Cleared when the next session starts. */
  interruptedByOwner: boolean;
  stageStartedAt: number | null;
  failure: { stage: StageId; reason: string; tried: string[] } | null;
  proposals: { auto: Proposal[]; ask: Proposal[]; off: Proposal[] } | null;
  startedAt: number | null;
  readyAt: number | null;
  /** The reviewer and verifier the scheduler (or the runner) picked for this ticket. */
  helpers: Partial<Record<HelperDuty, Id>>;
  /** The stage waits for the scheduler to find a helper. */
  waitingFor: { duty: HelperDuty; since: number } | null;
  /** A code ticket's branch and draft PR, from pick-up. */
  pr: PullRequestRef | null;
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
    decision: null,
    ownerNote: null,
    retroBy: [],
    outcome: null,
    assignee: null,
    handedFrom: null,
    messages: [],
    interruptedByOwner: false,
    stageStartedAt: null,
    failure: null,
    proposals: null,
    startedAt: null,
    readyAt: null,
    helpers: {},
    waitingFor: null,
    pr: null,
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
        stageStartedAt: e.at,
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
        interruptedByOwner: false,
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
    case "proposals-sorted":
      return { ...s, interrupted: false, proposals: { auto: e.auto, ask: e.ask, off: e.off } };
    case "proposals-decided":
    case "policy-decided":
      return s;
    case "pr-opened":
      return { ...s, pr: e.pr };
    case "report-ready":
      return {
        ...s,
        status: "ready",
        readyAt: e.at,
        ownerNote: null,
        outputs: { ...s.outputs, report: e.summary },
      };
    case "owner-decided":
      if (e.decision === "changes") {
        // A follow-up (spec §3, case 5): back to Build on the same branch, with the note first.
        const beforeBuild = s.finished.slice(0, Math.max(0, s.finished.indexOf("build")));
        return {
          ...emptyState(),
          created: true,
          startedAt: s.startedAt,
          sessions: s.sessions,
          switches: s.switches,
          finished: beforeBuild,
          outputs: s.outputs.plan === undefined ? {} : { plan: s.outputs.plan },
          ownerNote: e.note ?? "changes requested",
        };
      }
      return { ...s, status: "running", decision: e.decision };
    case "knowledge-proposed":
      return { ...s, interrupted: false, retroBy: [...s.retroBy, e.employeeId] };
    case "reassigned":
      return {
        ...s,
        assignee: e.to,
        handedFrom: e.from,
        helpers: Object.fromEntries(Object.entries(s.helpers).filter(([, id]) => id !== e.to)),
        engineOverride: null,
        paused: null,
        needsYou: null,
        failure: null,
        status: "running",
        interrupted: s.active !== null,
      };
    case "helper-wanted":
      return { ...s, waitingFor: { duty: e.duty, since: e.at } };
    case "helper-assigned":
      return { ...s, waitingFor: null, helpers: { ...s.helpers, [e.duty]: e.employeeId } };
    case "owner-message":
      return {
        ...s,
        messages: [
          ...s.messages,
          e.urgent ? { at: e.at, text: e.text, urgent: true } : { at: e.at, text: e.text },
        ],
      };
    case "session-interrupted":
      return { ...s, interrupted: true, interruptedByOwner: true };
    case "closed":
      return { ...s, status: "done", outcome: e.outcome };
    case "failed":
      return { ...s, status: "failed", failure: { stage: e.stage, reason: e.reason, tried: e.tried } };
  }
}

export function fold(events: TicketEvent[]): TicketState {
  return events.reduce(apply, emptyState());
}
