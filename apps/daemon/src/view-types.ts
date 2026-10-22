// The shapes the API returns, kept apart from the daemon's code so the web app can import them.
import type {
  Id,
  NeedsYou,
  ProjectRelease,
  Report,
  Spend,
  StageId,
  TicketAttachment,
  TicketState,
  Wait,
} from "@i-inc/core";

export type Column = "todo" | "in-progress" | "review" | "done";

/** Enough of an employee to draw their avatar. */
export interface Person {
  id: Id;
  name: string;
  tint: number;
  role?: string;
}

/** A follow-up that went over the daily budget and waits for the owner (C20). */
export interface ProposalView {
  id: number;
  project: string;
  title: string;
  /** Why it's worth doing. */
  body: string;
  doneWhen: string[];
  type: "fix" | "feat" | "chore";
  effort: "low" | "medium" | "high";
  proposedBy: Id;
  /** The proposer, to draw their avatar and name. */
  proposer: Person;
  /** The ticket they had just finished. */
  sourceTicket: Id;
  createdAt: number;
  status: "open" | "accepted" | "declined";
  decidedAt: number | null;
  /** The ticket filed on accept. */
  ticketId: Id | null;
}

export interface TicketView {
  id: Id;
  title: string;
  project: string;
  type: string;
  effort: string;
  /** What was asked: the ticket's "done when" list, as the owner (or the agent that filed it) wrote it. */
  doneWhen: string[];
  /** Why it is worth doing, for a follow-up an agent filed. Absent for the owner's tickets. */
  reason?: string;
  assignee: Person | null;
  column: Column;
  status: TicketState["status"] | "queued";
  /** Kept out of the queue: a draft from chat, or a ticket the owner holds. */
  held: boolean;
  stages: { id: StageId; state: "done" | "current" | "todo" }[];
  /** One line of what's happening now, e.g. "Checks · 2 failing". */
  live: string;
  /** When the ticket resumes, if `live` is "Waiting for tokens" (epoch ms): the web app words it in the owner's time zone. */
  resumesAt?: number;
  needsYou: NeedsYou | null;
  /** The scheduler's reason this ticket isn't running, as it sends it (the web app words it for people). */
  waiting: string | null;
  /** When an account or usage cap resets, when `waiting` is about that (epoch ms). */
  waitingUntil?: number;
  report: Report | null;
  failure: TicketState["failure"];
  outcome: TicketState["outcome"];
  createdBy?: Person | null;
  finishedAt?: number | null;
  pushed?: boolean;
  /** One line about the ticket's record, e.g. that unreadable events were set aside (T63). Absent when there is none. */
  note?: string;
  /** The owner's images, each with the URL that serves it. */
  attachments?: (TicketAttachment & { url: string })[];
  /** Made from a conversation ("Make this a ticket"); `title` is null when that conversation is gone. */
  fromConversation?: { id: string; title: string | null };
}

export type EmployeeState =
  | "idle"
  | "working"
  | "reviewing"
  | "needs-you"
  | "out-of-tokens"
  | "done"
  | "failed"
  | "off";

export interface DeskEntry {
  id: Id;
  name: string;
  tint: number;
  role: string;
  engine: string;
  state: EmployeeState;
  ticket: { id: Id; title: string; project: string; live: string; resumesAt?: number } | null;
}

export interface PendingTicket {
  id: Id;
  title: string;
  pushed?: string;
}

export interface PendingRelease {
  project: Id;
  id: Id;
  repo: string;
  pendingTickets: PendingTicket[];
}

export interface AccountRateLimit {
  status?: string;
  resetsAt?: number;
  fiveHourUtilization?: number;
  sevenDayUtilization?: number;
  updatedAt: number;
}

export interface DeskView {
  spend: Spend;
  waits: Wait[];
  bottleneck: Wait | null;
  merged: number;
  releases?: ProjectRelease[];
  pendingReleases?: PendingRelease[];
}

/** A page of a brain or the handbook: plain markdown. */
export interface Page {
  path: string;
  text: string;
}

/** One commit to a brain or the handbook. */
export interface Change {
  commit: string;
  at: number;
  subject: string;
  /** The employee whose edit this was, if it came from one. */
  author: Id | null;
  ticketId: Id | null;
  /** A later commit undid this one. */
  reverted: boolean;
  /** This commit undoes another. */
  revert: boolean;
}

export interface NamedChange extends Change {
  authorName: string | null;
  /** "handbook" or "brain:<id>", in the recent list. */
  repo?: string;
}

/** A handbook policy change waiting for the owner. */
export interface PolicyProposal {
  id: string;
  ticketId: Id;
  author: string;
  at: number;
  page: string;
  text: string;
}

export interface KnowledgeView {
  pages: Page[];
  history: NamedChange[];
  /** The handbook only. */
  awaiting?: PolicyProposal[];
  /** A brain only. */
  employee?: Person & { role: string };
}

// ── shipping a conversation's work (T62b, contract C22b) ──

export type ShipMode = "direct" | "owner-merges";

/** What a conversation's row says about its ticket and PR. */
export interface ShipBrief {
  ticket: { id: Id; held: boolean } | null;
  pr: { number: number; url: string } | null;
}

export interface ShipFile {
  path: string;
  added: number;
  removed: number;
  binary?: true;
}

export interface ShipChecks {
  state: "none" | "pending" | "success" | "failure";
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface ShipView {
  project: string | null;
  mode: ShipMode | null;
  /** "Make this a ticket" can be pressed. */
  canTicket: boolean;
  /** "Open a PR" can be pressed (owner-merges projects only). */
  canPr: boolean;
  /** Why neither can, as a sentence. */
  reason?: string;
  ticket: {
    id: Id;
    title: string;
    status: TicketView["status"];
    stage: string | null;
    live: string;
    /** The conversation can't change its working copy: the ticket has it. */
    held: boolean;
    outcome: TicketView["outcome"];
    /** It waits for the owner, so the work can be taken back from it. */
    canTakeBack?: boolean;
  } | null;
  pr: {
    number: number;
    url: string;
    state: "open" | "closed" | "merged" | "unknown";
    draft: boolean;
    checks: ShipChecks | null;
    problem?: string;
  } | null;
  /** Only with `?preview=1`: what shipping would commit, and where it would go. */
  copy?: {
    branch: string;
    files: ShipFile[];
    uncommitted: number;
    ahead: number;
    protectedPaths: string[];
    pushed: boolean;
    blockers: string[];
    /** Binary files that can't be scanned for credentials: the owner confirms them before anything is shipped. */
    binaries: { path: string; size: number }[];
  };
  /** Only with `?preview=1` and no copy: why the working copy couldn't be read. */
  problem?: string;
  /** Only with `?preview=1`: what the confirm dialog starts with. */
  suggestion?: { title: string; doneWhen: string[]; description: string };
}

/** One entry of the Brain changes feed (contract C19): a change an agent made to its brain copy, committed or refused. */
export interface BrainChangeView {
  id: number;
  /** `h<n>`: the collection it came from. */
  harvest: string;
  at: number;
  status: "committed" | "rejected";
  /** A committed change the owner undid. */
  reverted: boolean;
  revertedAt: number | null;
  scope: string | null;
  slug: string | null;
  /** The page in the agent's copy, e.g. `company/facts/gh.md`. */
  path: string;
  op: "create" | "update" | "delete" | "rename";
  employee: { id: Id; name: string };
  source: { kind: "ticket" | "conversation"; id: string; url: string };
  /** Why a refused change was refused (`code`), in words. */
  code: string | null;
  reason: string | null;
  commit: string | null;
  /** A few changed lines: `+` added, `-` removed. */
  diff: string;
  notes: string[];
  untrusted: boolean;
  policy: boolean;
  conflict: boolean;
  revertible: boolean;
}

export interface BrainChangesView {
  changes: BrainChangeView[];
  /** Pass as `before` for the next page; null at the end. */
  next: number | null;
  facets: { scopes: string[]; employees: { id: Id; name: string }[] };
}
