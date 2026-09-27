// The backlog: ticket definitions, priority and holds. What happened to a ticket lives in the events.
import type { Id, Ticket } from "@i-inc/core";
import type { Db } from "./db.ts";

export interface NewTicket {
  title: string;
  project: string;
  type: Ticket["type"];
  effort: Ticket["effort"];
  doneWhen: string[];
  /** Empty means unassigned: a standing order may pick it up. */
  assignee?: Id;
  labels?: string[];
  priority?: number;
  hold?: boolean;
}

export interface TicketRecord {
  ticket: Ticket;
  priority: number;
  hold: boolean;
  createdAt: number;
  /** When a standing order picked it up, if one did. */
  pickedAt: number | null;
}

export class Tickets {
  constructor(private readonly db: Db) {}

  create(input: NewTicket, now: number): Ticket {
    const [row] = this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM tickets");
    const id = String((row?.n ?? 0) + 1);
    const ticket: Ticket = {
      id,
      title: input.title,
      project: input.project,
      type: input.type,
      effort: input.effort,
      doneWhen: input.doneWhen,
      assignee: input.assignee ?? "",
      ...(input.labels ? { labels: input.labels } : {}),
    };
    this.db.run(
      "INSERT INTO tickets (id, body, priority, hold, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      JSON.stringify(ticket),
      input.priority ?? 0,
      input.hold ? 1 : 0,
      now,
    );
    return ticket;
  }

  get(id: Id): TicketRecord | undefined {
    return this.rows("WHERE id = ?", id)[0];
  }

  all(): TicketRecord[] {
    return this.rows("ORDER BY created_at");
  }

  /** Assigns a ticket; `pickedAt` records a standing order picking it up (for its daily limit). */
  assign(id: Id, assignee: Id, pickedAt: number | null = null): void {
    const r = this.get(id);
    if (!r) throw new Error(`no ticket ${id}`);
    this.db.run(
      "UPDATE tickets SET body = ?, picked_at = ? WHERE id = ?",
      JSON.stringify({ ...r.ticket, assignee }),
      pickedAt,
      id,
    );
  }

  setHold(id: Id, hold: boolean): void {
    this.db.run("UPDATE tickets SET hold = ? WHERE id = ?", hold ? 1 : 0, id);
  }

  private rows(where: string, ...params: string[]): TicketRecord[] {
    return this.db
      .all<{ body: string; priority: number; hold: number; created_at: number; picked_at: number | null }>(
        `SELECT body, priority, hold, created_at, picked_at FROM tickets ${where}`,
        ...params,
      )
      .map((r) => ({
        ticket: JSON.parse(r.body) as Ticket,
        priority: r.priority,
        hold: r.hold === 1,
        createdAt: r.created_at,
        pickedAt: r.picked_at,
      }));
  }
}
