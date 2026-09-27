// The daemon's tables. The event log is the source of truth; the other tables hold configuration
// and the backlog.
import type { Db } from "./db.ts";

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      ticket_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (ticket_id, seq)
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      hold INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      picked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS company (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
  `);
}
