import type { Clock, Id, SessionTranscriptItem, TicketSessionTranscript } from "@i-inc/core";
import type { Db } from "./db.ts";

export function capText(s: string, maxBytes = 4096): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let end = maxBytes;
  let truncated = Buffer.from(s, "utf8").subarray(0, end).toString("utf8");
  while (truncated.endsWith("\uFFFD")) {
    end--;
    truncated = Buffer.from(s, "utf8").subarray(0, end).toString("utf8");
  }
  return truncated;
}

export class SessionStore {
  private readonly active = new Map<number, SessionTranscriptItem[]>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  start(ticketId: Id, stage: string, employeeId: Id, engineId: Id): number {
    const startedAt = this.clock.now();
    this.db.run(
      "INSERT INTO ticket_sessions (ticket_id, stage, employee_id, engine_id, started_at, items_json) VALUES (?, ?, ?, ?, ?, '[]')",
      ticketId,
      stage,
      employeeId,
      engineId,
      startedAt,
    );
    const [row] = this.db.all<{ id: number }>("SELECT last_insert_rowid() AS id");
    const sessionId = row?.id ?? 0;
    this.active.set(sessionId, []);
    return sessionId;
  }

  recordItem(sessionId: number, item: SessionTranscriptItem): void {
    let items = this.active.get(sessionId);
    if (!items) {
      const [row] = this.db.all<{ items_json: string }>(
        "SELECT items_json FROM ticket_sessions WHERE id = ?",
        sessionId,
      );
      items = row?.items_json ? (JSON.parse(row.items_json) as SessionTranscriptItem[]) : [];
      this.active.set(sessionId, items);
    }

    if (item.id) {
      const existing = items.find((i) => i.id === item.id);
      if (existing) {
        if (item.text !== undefined) existing.text = item.text;
        if (item.title !== undefined) existing.title = item.title;
        if (item.status !== undefined) existing.status = item.status;
      } else {
        items.push({ ...item });
      }
    } else {
      items.push({ ...item });
    }

    this.db.run("UPDATE ticket_sessions SET items_json = ? WHERE id = ?", JSON.stringify(items), sessionId);
  }

  finish(sessionId: number): void {
    const endedAt = this.clock.now();
    this.db.run("UPDATE ticket_sessions SET ended_at = ? WHERE id = ?", endedAt, sessionId);
    this.active.delete(sessionId);
  }

  list(ticketId: Id): TicketSessionTranscript[] {
    return this.db
      .all<{
        stage: string;
        employee_id: string;
        engine_id: string;
        started_at: number;
        ended_at: number | null;
        items_json: string;
      }>(
        "SELECT stage, employee_id, engine_id, started_at, ended_at, items_json FROM ticket_sessions WHERE ticket_id = ? ORDER BY id ASC",
        ticketId,
      )
      .map((row) => ({
        stage: row.stage,
        employeeId: row.employee_id,
        engineId: row.engine_id,
        startedAt: row.started_at,
        endedAt: row.ended_at !== null ? row.ended_at : null,
        items: (JSON.parse(row.items_json || "[]") as SessionTranscriptItem[]).map((item) => {
          const res: SessionTranscriptItem = {
            kind: item.kind,
            at: item.at,
          };
          if (item.text !== undefined) res.text = capText(item.text, 4096);
          if (item.title !== undefined) res.title = capText(item.title, 4096);
          if (item.status !== undefined) res.status = capText(item.status, 4096);
          return res;
        }),
      }));
  }
}
