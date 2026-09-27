// Each employee's chat thread (spec §10), kept in SQLite.
import type { Id } from "@i-inc/core";
import type { Db } from "./db.ts";

export type ChatEntry =
  | { from: "owner"; at: number; text: string; urgent?: boolean }
  | { from: "employee"; at: number; text: string }
  | { from: "employee"; at: number; kind: "draft"; ticketId: Id; title: string; confirmed: boolean }
  | { from: "employee"; at: number; kind: "errand"; ticketId: Id; title: string }
  | { from: "system"; at: number; text: string };

export class ChatLog {
  constructor(private readonly db: Db) {}

  add(employeeId: Id, entry: ChatEntry): void {
    this.db.transaction(() => {
      const [row] = this.db.all<{ n: number | null }>(
        "SELECT MAX(seq) AS n FROM chat WHERE employee_id = ?",
        employeeId,
      );
      this.db.run(
        "INSERT INTO chat (employee_id, seq, at, body) VALUES (?, ?, ?, ?)",
        employeeId,
        (row?.n ?? 0) + 1,
        entry.at,
        JSON.stringify(entry),
      );
    });
  }

  thread(employeeId: Id): ChatEntry[] {
    return this.db
      .all<{ body: string }>("SELECT body FROM chat WHERE employee_id = ? ORDER BY seq", employeeId)
      .map((r) => JSON.parse(r.body) as ChatEntry);
  }

  /** Marks a draft ticket in the thread as put on the board. */
  confirm(employeeId: Id, ticketId: Id): void {
    const rows = this.db.all<{ seq: number; body: string }>(
      "SELECT seq, body FROM chat WHERE employee_id = ?",
      employeeId,
    );
    for (const r of rows) {
      const e = JSON.parse(r.body) as ChatEntry;
      if ("kind" in e && e.kind === "draft" && e.ticketId === ticketId) {
        this.db.run(
          "UPDATE chat SET body = ? WHERE employee_id = ? AND seq = ?",
          JSON.stringify({ ...e, confirmed: true }),
          employeeId,
          r.seq,
        );
      }
    }
  }

  /** The last message in each thread, for the chat list. */
  latest(): Map<Id, ChatEntry> {
    const out = new Map<Id, ChatEntry>();
    for (const r of this.db.all<{ employee_id: string; body: string }>(
      "SELECT employee_id, body FROM chat c WHERE seq = (SELECT MAX(seq) FROM chat WHERE employee_id = c.employee_id)",
    )) {
      out.set(r.employee_id, JSON.parse(r.body) as ChatEntry);
    }
    return out;
  }
}
