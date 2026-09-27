// The shapes the API returns, kept apart from the daemon's code so the web app can import them.
import type { Id, NeedsYou, Report, Spend, StageId, TicketState, Wait } from "@i-inc/core";

export type Column = "todo" | "in-progress" | "review" | "done";

export interface TicketView {
  id: Id;
  title: string;
  project: string;
  type: string;
  effort: string;
  assignee: { id: Id; name: string } | null;
  column: Column;
  status: TicketState["status"] | "queued";
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
