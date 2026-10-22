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
    CREATE INDEX IF NOT EXISTS idx_events_type_at ON events(type, at);
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      hold INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      picked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_created_at_id ON tickets(created_at, CAST(id AS INTEGER));
    CREATE TABLE IF NOT EXISTS chat (
      employee_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (employee_id, seq)
    );
    CREATE TABLE IF NOT EXISTS knowledge_applied (
      edit_id TEXT PRIMARY KEY,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS company (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE TABLE IF NOT EXISTS owner_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_sent (
      key TEXT PRIMARY KEY,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      engine_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_sessions_ticket ON ticket_sessions(ticket_id, id);
    CREATE INDEX IF NOT EXISTS idx_ticket_sessions_started_at ON ticket_sessions(started_at);
    CREATE TABLE IF NOT EXISTS ticket_session_items (
      session_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      title TEXT,
      status TEXT,
      at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_session_items_session ON ticket_session_items(session_id, seq);
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      ticket_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, seq)
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      proposed_by TEXT NOT NULL,
      source_ticket TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined')),
      decided_at INTEGER,
      ticket_id TEXT,
      type TEXT NOT NULL DEFAULT 'chore',
      effort TEXT NOT NULL DEFAULT 'medium',
      done_when TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, project);
    -- Which brain pages went into a ticket session (kind 'session', ref = the session id) or a
    -- conversation turn (kind 'turn', ref = the conversation, unit = the turn). T57, contract C19.
    CREATE TABLE IF NOT EXISTS brain_used (
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (kind, ref, unit)
    );
    -- What each sandbox's brain copy was last given, so the next copy sends only what changed.
    CREATE TABLE IF NOT EXISTS brain_synced (
      machine TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      files TEXT NOT NULL,
      pending TEXT NOT NULL DEFAULT '[]',
      at INTEGER NOT NULL,
      PRIMARY KEY (machine, employee_id)
    );
    -- Harvests of the agents' edits to their brain copies (T58, contract C19): one row a collection.
    CREATE TABLE IF NOT EXISTS brain_harvests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      employee_id TEXT NOT NULL,
      copy TEXT NOT NULL,
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      committed INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      detail TEXT
    );
    -- The Brain changes feed: every change that was committed or refused, newest first by id.
    CREATE TABLE IF NOT EXISTS brain_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      harvest TEXT NOT NULL,
      at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('committed', 'rejected')),
      employee_id TEXT NOT NULL,
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      scope TEXT,
      slug TEXT,
      path TEXT NOT NULL,
      op TEXT NOT NULL,
      code TEXT,
      reason TEXT,
      repo TEXT,
      commit_sha TEXT,
      sha TEXT,
      diff TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '[]',
      untrusted INTEGER NOT NULL DEFAULT 0,
      policy INTEGER NOT NULL DEFAULT 0,
      conflict INTEGER NOT NULL DEFAULT 0,
      reverted_at INTEGER,
      revert_sha TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_brain_changes_employee ON brain_changes(employee_id, id);
    CREATE INDEX IF NOT EXISTS idx_brain_changes_seen ON brain_changes(employee_id, path, sha, code);
    -- What to tell an agent about its earlier edits at its next brief or turn (a duplicate and the page to merge into).
    CREATE TABLE IF NOT EXISTS brain_hints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT NOT NULL,
      copy TEXT NOT NULL,
      at INTEGER NOT NULL,
      text TEXT NOT NULL,
      taken INTEGER NOT NULL DEFAULT 0
    );
    -- Copies to harvest when their machine is next up: the ticket or conversation ended while it was stopped.
    CREATE TABLE IF NOT EXISTS brain_harvest_due (
      employee_id TEXT NOT NULL,
      copy TEXT NOT NULL,
      ref_kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      tidy INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL,
      PRIMARY KEY (employee_id, copy)
    );
    CREATE TABLE IF NOT EXISTS storage_state (
      key TEXT PRIMARY KEY,
      body TEXT NOT NULL
    );
  `);
}
