// The SQLite event log (spec §9, "Durable state"): append-only, one sequence per ticket.
import type { EventStore, Id, TicketEvent } from "@i-inc/core";
import type { Db } from "./db.ts";

export class SqliteEventStore implements EventStore {
  onAppend?: (ticketId: Id, events: TicketEvent[]) => void;
  private readonly listeners = new Set<(ticketId: Id, events: TicketEvent[]) => void>();

  subscribe(fn: (ticketId: Id, events: TicketEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  constructor(private readonly db: Db) {}

  async read(ticketId: Id): Promise<TicketEvent[]> {
    return this.db
      .all<{ body: string }>("SELECT body FROM events WHERE ticket_id = ? ORDER BY seq", ticketId)
      .map((r) => JSON.parse(r.body) as TicketEvent);
  }

  async append(ticketId: Id, events: TicketEvent[]): Promise<void> {
    this.write(ticketId, events);
    if (events.length > 0) {
      this.onAppend?.(ticketId, events);
      for (const listener of this.listeners) {
        listener(ticketId, events);
      }
    }
  }

  /** The write alone, for a caller that makes it part of a transaction of its own and tells `onAppend` after. */
  write(ticketId: Id, events: TicketEvent[]): void {
    this.db.transaction(() => {
      const [row] = this.db.all<{ n: number | null }>(
        "SELECT MAX(seq) AS n FROM events WHERE ticket_id = ?",
        ticketId,
      );
      let seq = (row?.n ?? 0) + 1;
      for (const e of events) {
        this.db.run(
          "INSERT INTO events (ticket_id, seq, at, type, body) VALUES (?, ?, ?, ?, ?)",
          ticketId,
          seq++,
          e.at,
          e.type,
          JSON.stringify(e),
        );
      }
    });
  }

  /** Every ticket's events, for My desk. */
  async all(): Promise<Map<Id, TicketEvent[]>> {
    const out = new Map<Id, TicketEvent[]>();
    for (const r of this.db.all<{ ticket_id: string; body: string }>(
      "SELECT ticket_id, body FROM events ORDER BY ticket_id, seq",
    )) {
      const list = out.get(r.ticket_id) ?? [];
      list.push(JSON.parse(r.body) as TicketEvent);
      out.set(r.ticket_id, list);
    }
    return out;
  }
}
