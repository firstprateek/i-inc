// Follow-ups an agent proposed after the project's daily budget was used up. They wait here for the
// owner to accept (which files the ticket) or decline, instead of being dropped (v1-plan §6, C20).
import type { Effort, Id } from "@i-inc/core";
import type { Db } from "./db.ts";

export type ProposalStatus = "open" | "accepted" | "declined";

export interface StoredProposal {
  id: number;
  project: string;
  title: string;
  /** Why it's worth doing, in the proposer's words. */
  body: string;
  proposedBy: Id;
  /** The ticket the agent had just finished when it proposed this. */
  sourceTicket: Id;
  createdAt: number;
  status: ProposalStatus;
  decidedAt: number | null;
  /** The ticket filed when the owner accepted. */
  ticketId: Id | null;
  type: "fix" | "feat" | "chore";
  effort: Effort;
  doneWhen: string[];
}

/** What a new proposal needs; the rest is set when it's stored. */
export type NewProposal = Pick<
  StoredProposal,
  "project" | "title" | "body" | "proposedBy" | "sourceTicket" | "type" | "effort" | "doneWhen"
>;

type Row = {
  id: number;
  project: string;
  title: string;
  body: string;
  proposed_by: string;
  source_ticket: string;
  created_at: number;
  status: string;
  decided_at: number | null;
  ticket_id: string | null;
  type: string;
  effort: string;
  done_when: string;
};

/** Titles that differ only in case, spacing, quotes or end punctuation are the same proposal. */
export function normalTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.!?:;,\-"'`\u201c\u201d\u2018\u2019]+|[\s.!?:;,\-"'`\u201c\u201d\u2018\u2019]+$/g, "");
}

function stored(r: Row): StoredProposal {
  let doneWhen: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.done_when);
    if (Array.isArray(parsed)) doneWhen = parsed.filter((x): x is string => typeof x === "string");
  } catch {}
  return {
    id: r.id,
    project: r.project,
    title: r.title,
    body: r.body,
    proposedBy: r.proposed_by,
    sourceTicket: r.source_ticket,
    createdAt: r.created_at,
    status: r.status as ProposalStatus,
    decidedAt: r.decided_at,
    ticketId: r.ticket_id,
    type: (["fix", "feat", "chore"].includes(r.type) ? r.type : "chore") as StoredProposal["type"],
    effort: (["low", "medium", "high"].includes(r.effort) ? r.effort : "medium") as Effort,
    doneWhen,
  };
}

export class Proposals {
  /** Called when a proposal is stored or decided, so open views refresh. */
  onChange?: () => void;

  constructor(private readonly db: Db) {}

  /** Stores a proposal, or returns undefined when an open one with the same project and title exists. */
  add(p: NewProposal, now: number): StoredProposal | undefined {
    const key = normalTitle(p.title);
    const dup = this.db
      .all<{ title: string }>("SELECT title FROM proposals WHERE project = ? AND status = 'open'", p.project)
      .some((r) => normalTitle(r.title) === key);
    if (dup) return undefined;
    this.db.run(
      `INSERT INTO proposals (project, title, body, proposed_by, source_ticket, created_at, status, type, effort, done_when)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      p.project,
      p.title,
      p.body,
      p.proposedBy,
      p.sourceTicket,
      now,
      p.type,
      p.effort,
      JSON.stringify(p.doneWhen),
    );
    const [row] = this.db.all<{ id: number }>("SELECT last_insert_rowid() AS id");
    const made = this.get(Number(row?.id)) as StoredProposal;
    this.onChange?.();
    return made;
  }

  get(id: number): StoredProposal | undefined {
    const [r] = this.db.all<Row>("SELECT * FROM proposals WHERE id = ?", id);
    return r ? stored(r) : undefined;
  }

  /** Newest first when `status` is given; otherwise all. */
  list(status?: ProposalStatus): StoredProposal[] {
    const rows = status
      ? this.db.all<Row>("SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC, id DESC", status)
      : this.db.all<Row>("SELECT * FROM proposals ORDER BY created_at DESC, id DESC");
    return rows.map(stored);
  }

  /**
   * Decides an open proposal. Only one caller wins a race: the update is conditional on the
   * proposal still being open, and the others get false.
   */
  decide(id: number, status: "accepted" | "declined", now: number): boolean {
    const res = this.db.run(
      "UPDATE proposals SET status = ?, decided_at = ? WHERE id = ? AND status = 'open'",
      status,
      now,
      id,
    );
    if (res.changes !== 1) return false;
    this.onChange?.();
    return true;
  }

  setTicket(id: number, ticketId: Id): void {
    this.db.run("UPDATE proposals SET ticket_id = ? WHERE id = ?", ticketId, id);
    this.onChange?.();
  }

  /** Puts a claimed proposal back to open, when filing its ticket failed. */
  reopen(id: number): void {
    this.db.run("UPDATE proposals SET status = 'open', decided_at = NULL WHERE id = ?", id);
    this.onChange?.();
  }
}
