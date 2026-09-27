// The shapes the API returns, kept apart from the daemon's code so the web app can import them.
import type { Id, NeedsYou, Report, Spend, StageId, TicketState, Wait } from "@i-inc/core";

export type Column = "todo" | "in-progress" | "review" | "done";

/** Enough of an employee to draw their avatar. */
export interface Person {
  id: Id;
  name: string;
  tint: number;
}

export interface TicketView {
  id: Id;
  title: string;
  project: string;
  type: string;
  effort: string;
  assignee: Person | null;
  column: Column;
  status: TicketState["status"] | "queued";
  /** Kept out of the queue: a draft from chat, or a ticket the owner holds. */
  held: boolean;
  stages: { id: StageId; state: "done" | "current" | "todo" }[];
  /** One line of what's happening now, e.g. "Checks · 2 failing". */
  live: string;
  needsYou: NeedsYou | null;
  waiting: string | null;
  report: Report | null;
  failure: TicketState["failure"];
  outcome: TicketState["outcome"];
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
  ticket: { id: Id; title: string; project: string; live: string } | null;
}

export interface DeskView {
  spend: Spend;
  waits: Wait[];
  bottleneck: Wait | null;
  merged: number;
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
