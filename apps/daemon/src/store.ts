// The SQLite event log (spec §9, "Durable state"): append-only, one sequence per ticket.
import type { EventStore, Id, TicketEvent } from "@i-inc/core";
import type { Db } from "./db.ts";

/** What an event row must be to be replayed: an object with a type and a time. */
function readEvent(body: string): { event: TicketEvent } | { why: string } {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch (err) {
    return { why: err instanceof Error ? err.message : String(err) };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { why: "not an object" };
  const e = v as { type?: unknown; at?: unknown };
  if (typeof e.type !== "string") return { why: "no event type" };
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return { why: "no event time" };
  return { event: v as TicketEvent };
}

type EventRow = {
  ticket_id: string;
  seq: number;
  at: number;
  body: string;
};

export class SqliteEventStore implements EventStore {
  onAppend?: (ticketId: Id, events: TicketEvent[]) => void;
  private readonly listeners = new Set<(ticketId: Id, events: TicketEvent[]) => void>();

  subscribe(fn: (ticketId: Id, events: TicketEvent[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Rows already reported, so a bad row is logged once and not at every tick. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly log?: (msg: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A ticket's events in order. A row that can't be read back (truncated by a crash, not JSON, not an
   * event) is kept in `event_quarantine`, logged once, and replayed as an `unreadable` placeholder that
   * changes nothing, so one bad row never takes down the tick, the board or startup. The placeholder
   * keeps every later event at its index, which push keys and knowledge edit ids are made from.
   */
  async read(ticketId: Id): Promise<TicketEvent[]> {
    return this.db
      .all<EventRow>("SELECT ticket_id, seq, at, body FROM events WHERE ticket_id = ? ORDER BY seq", ticketId)
      .map((r) => this.decode(r));
  }

  private decode(r: EventRow): TicketEvent {
    const read = readEvent(r.body);
    if ("event" in read) return read.event;
    this.quarantine(r.ticket_id, r.seq, r.body, read.why);
    return { type: "unreadable", at: Number.isFinite(r.at) ? r.at : 0, seq: r.seq, reason: read.why };
  }

  private quarantine(ticketId: Id, seq: number, body: string, why: string): void {
    const key = `${ticketId}:${seq}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.log?.(
      `ticket ${ticketId}: event ${seq} can't be read (${why}); it is skipped and kept in event_quarantine`,
    );
    try {
      this.db.run(
        "INSERT OR IGNORE INTO event_quarantine (ticket_id, seq, reason, body, at) VALUES (?, ?, ?, ?, ?)",
        ticketId,
        seq,
        why,
        body.slice(0, 64_000),
        this.now(),
      );
    } catch (err) {
      this.log?.(`ticket ${ticketId}: couldn't record the quarantine of event ${seq}: ${String(err)}`);
    }
  }

  /** The rows set aside, for the owner to look at. */
  quarantined(): { ticketId: Id; seq: number; reason: string }[] {
    return this.db
      .all<{ ticket_id: string; seq: number; reason: string }>(
        "SELECT ticket_id, seq, reason FROM event_quarantine ORDER BY ticket_id, seq",
      )
      .map((r) => ({ ticketId: r.ticket_id, seq: r.seq, reason: r.reason }));
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
    const rows = this.db.all<EventRow>("SELECT ticket_id, seq, at, body FROM events ORDER BY ticket_id, seq");
    for (const r of rows) {
      const list = out.get(r.ticket_id) ?? [];
      list.push(this.decode(r));
      out.set(r.ticket_id, list);
    }
    return out;
  }
}
