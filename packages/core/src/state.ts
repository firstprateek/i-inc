// Fold a ticket's events into the state the pipeline decides from. Pure.
import type { Decision, Finding, HelperDuty, NeedsYou, TicketEvent } from "./events.ts";
import type { Id, Proposal, PullRequestRef, TicketAttachment } from "./model.ts";
import type { StageId } from "./stages.ts";
import { isRecord, readFindings, text } from "./validate.ts";

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
  closedAt: number | null;
  /** Set by a handoff; otherwise the ticket's own assignee builds. */
  assignee: Id | null;
  handedFrom: Id | null;
  /** The owner's chat messages about this ticket. A session sees those sent before its stage began. */
  messages: { at: number; text: string; urgent?: boolean }[];
  /** Images the owner added after filing the ticket, with when. */
  attachments: (TicketAttachment & { at: number })[];
  /** The highest image number in each employee's worktree. */
  copiedUpTo: Record<Id, number>;
  /** When each employee's last session on this ticket started. */
  lastSessionAt: Record<Id, number>;
  /** The last session was stopped by an urgent message. Cleared when the next session starts. */
  interruptedByOwner: boolean;
  stageStartedAt: number | null;
  failure: { stage: StageId; reason: string; tried: string[] } | null;
  proposals: { auto: Proposal[]; ask: Proposal[]; off: Proposal[] } | null;
  startedAt: number | null;
  readyAt: number | null;
  /** The reviewer and verifier the scheduler (or the runner) picked for this ticket. */
  helpers: Partial<Record<HelperDuty, Id>>;
  /**
   * Helpers that couldn't start for this ticket, by duty. They are skipped, so a helper's startup
   * failure never fails the builder's ticket. An entry with `engineId` rules out that engine in the
   * builder's own seat, not the employee.
   */
  unavailable: Partial<Record<HelperDuty, { employeeId: Id; engineId?: Id }[]>>;
  /** The stage waits for the scheduler to find a helper. */
  waitingFor: { duty: HelperDuty; since: number } | null;
  /** A code ticket's branch and draft PR, from pick-up. */
  pr: PullRequestRef | null;
  /** Whose machine has the ticket's worktree; a handoff makes a new one in the new builder's. */
  prFor: Id | null;
  /** Direct mode: the last commit this ticket pushed to main. */
  pushed: string | null;
  /** Direct mode: CI went red on a commit this ticket pushed, since when. */
  mainRed: { sha: string; since: number; reason: string } | null;
  /** Time spent running, leaving out time paused, failed or waiting on the owner. */
  workedMs: number;
  /** When the last event happened, for `workedMs`. */
  lastAt: number | null;
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
    closedAt: null,
    assignee: null,
    handedFrom: null,
    messages: [],
    attachments: [],
    copiedUpTo: {},
    lastSessionAt: {},
    interruptedByOwner: false,
    stageStartedAt: null,
    failure: null,
    proposals: null,
    startedAt: null,
    readyAt: null,
    helpers: {},
    unavailable: {},
    waitingFor: null,
    pr: null,
    prFor: null,
    workedMs: 0,
    lastAt: null,
    pushed: null,
    mainRed: null,
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
        lastSessionAt: { ...s.lastSessionAt, [e.employeeId]: e.at },
        sessions: [
          ...s.sessions,
          { stage: e.stage, employeeId: e.employeeId, engineId: e.engineId, resume: e.resume },
        ],
      };
    case "checkpoint":
      return { ...s, interrupted: false, fixDue: false, outputs: { ...s.outputs, [e.stage]: text(e.note) } };
    case "stage-finished":
      return {
        ...s,
        active: null,
        engineOverride: null,
        interrupted: false,
        finished: [...s.finished, e.stage],
        outputs: e.output === undefined ? s.outputs : { ...s.outputs, [e.stage]: text(e.output) },
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
        lastChecks: { green: e.green === true, failures: Array.isArray(e.failures) ? e.failures : [] },
        checkFailures: e.green ? s.checkFailures : s.checkFailures + 1,
        fixDue: !e.green,
      };
    case "proof": {
      // An old event may hold a reply that was stored unchecked: anything but a list of items that
      // all pass counts as a failed proof, so the builder gets a fix session instead of a crash.
      const items = Array.isArray(e.items) ? e.items.filter(isRecord) : [];
      const pass =
        Array.isArray(e.items) && items.length === e.items.length && items.every((i) => i.pass === true);
      return {
        ...s,
        interrupted: false,
        fixDue: !pass,
        lastProof: items.map((i) => ({
          doneWhen: text(i.doneWhen),
          pass: i.pass === true,
          evidence: text(i.evidence),
        })),
        proofFailures: pass ? s.proofFailures : s.proofFailures + 1,
      };
    }
    case "review-verdict":
      return {
        ...s,
        interrupted: false,
        review: {
          round: typeof e.round === "number" && Number.isFinite(e.round) ? e.round : s.review.round + 1,
          approved: e.approved === true,
          findings: readFindings(e.findings),
          disputed: null,
          addressed: false,
        },
      };
    case "addressed":
      return {
        ...s,
        interrupted: false,
        review: {
          ...s.review,
          disputed: typeof e.disputed === "string" ? e.disputed : null,
          addressed: true,
        },
      };
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
    case "pushed":
      return { ...s, pushed: e.sha };
    case "main-red":
      return {
        ...s,
        fixDue: true,
        mainRed: { sha: s.mainRed?.sha ?? e.sha, since: s.mainRed?.since ?? e.at, reason: e.reason },
      };
    case "reverted":
      return { ...s, mainRed: null, fixDue: false };
    case "ci-green":
      return { ...s, mainRed: null };
    case "follow-ups":
      return s;
    case "retried":
      // The owner trying again also forgets which helpers couldn't start: they may be fixed by now.
      return s.status === "failed"
        ? { ...s, status: "running", failure: null, unavailable: {}, interrupted: s.active !== null }
        : s;
    case "pr-opened":
      return { ...s, pr: e.pr, prFor: e.employeeId ?? null };
    case "report-ready":
      return {
        ...s,
        status: "ready",
        readyAt: e.at,
        ownerNote: null,
        outputs: { ...s.outputs, report: text(e.summary) },
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
          // The worktree stays, and so do the images in it.
          pr: s.pr,
          prFor: s.prFor,
          attachments: s.attachments,
          copiedUpTo: s.copiedUpTo,
          lastSessionAt: s.lastSessionAt,
          finished: beforeBuild,
          outputs: s.outputs.plan === undefined ? {} : { plan: s.outputs.plan },
          ownerNote: e.note ?? "changes requested",
        };
      }
      return { ...s, status: "running", decision: e.decision };
    case "knowledge-proposed":
      return { ...s, interrupted: false, retroBy: [...s.retroBy, e.employeeId] };
    case "reply-flagged":
    case "unreadable":
      return s;
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
    case "helper-unavailable": {
      // The session that never really started doesn't count as that employee's work on the ticket.
      const at = s.sessions.findLastIndex(
        (x) =>
          x.stage === e.stage && x.employeeId === e.employeeId && (!e.engineId || x.engineId === e.engineId),
      );
      const { [e.duty]: assigned, ...otherHelpers } = s.helpers;
      return {
        ...s,
        sessions: at < 0 ? s.sessions : s.sessions.filter((_, i) => i !== at),
        helpers: assigned === e.employeeId && !e.engineId ? otherHelpers : s.helpers,
        unavailable: {
          ...s.unavailable,
          [e.duty]: [
            ...(s.unavailable[e.duty] ?? []),
            { employeeId: e.employeeId, ...(e.engineId ? { engineId: e.engineId } : {}) },
          ],
        },
        waitingFor: s.waitingFor?.duty === e.duty ? null : s.waitingFor,
        interrupted: false,
      };
    }
    case "owner-message":
      return {
        ...s,
        messages: [
          ...s.messages,
          e.urgent ? { at: e.at, text: e.text, urgent: true } : { at: e.at, text: e.text },
        ],
      };
    case "owner-attached":
      return {
        ...s,
        attachments: [
          ...s.attachments,
          ...(Array.isArray(e.attachments) ? e.attachments : [])
            .filter((a) => !s.attachments.some((x) => x.n === a.n))
            .map((a) => ({ ...a, at: e.at })),
        ],
      };
    case "attachments-copied":
      return {
        ...s,
        copiedUpTo: { ...s.copiedUpTo, [e.employeeId]: Math.max(e.upTo, s.copiedUpTo[e.employeeId] ?? 0) },
      };
    case "session-interrupted":
      return { ...s, interrupted: true, interruptedByOwner: true };
    case "closed":
      return { ...s, status: "done", outcome: e.outcome, closedAt: e.at };
    case "failed":
      return {
        ...s,
        status: "failed",
        failure: { stage: e.stage, reason: text(e.reason), tried: Array.isArray(e.tried) ? e.tried : [] },
      };
    default:
      // An event this version doesn't know (written by a newer release, then rolled back): ignored.
      return s;
  }
}

/**
 * Folds a ticket's events into its state. One bad event can't break it: a row that isn't an event, or
 * one that throws when applied, is skipped (and handed to `onSkip`), so a ticket always has a state.
 */
export function fold(events: TicketEvent[], onSkip?: (event: unknown, why: string) => void): TicketState {
  return events.reduce((s, e) => {
    if (!isRecord(e) || typeof e.type !== "string" || typeof e.at !== "number" || !Number.isFinite(e.at)) {
      onSkip?.(e, "not an event");
      return s;
    }
    try {
      const next = apply(s, e);
      const worked = s.status === "running" && s.lastAt !== null ? e.at - s.lastAt : 0;
      return { ...next, workedMs: s.workedMs + worked, lastAt: e.at };
    } catch (err) {
      onSkip?.(e, err instanceof Error ? err.message : String(err));
      return s;
    }
  }, emptyState());
}
