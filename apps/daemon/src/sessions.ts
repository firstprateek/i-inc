import type { Clock, Id, SessionTranscriptItem, TicketSessionTranscript } from "@i-inc/core";
import type { Db } from "./db.ts";

export const MAX_SESSION_ITEMS = 500;
export const MAX_SESSIONS_PER_TICKET = 50;

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

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Authorization: <anything> header values
  out = out.replace(
    /(authorization:\s*)(?:["'])(?:bearer\s+|basic\s+|token\s+)?[^\r\n"']+["']/gi,
    "$1[redacted]",
  );
  out = out.replace(/(authorization:\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s\r\n"']+/gi, "$1[redacted]");

  // 2. Bearer <token> headers/values
  out = out.replace(/(bearer\s+)[^\s\r\n"']+/gi, "$1[redacted]");

  // 3. GitHub tokens (ghp_, gho_, ghs_, github_pat_)
  out = out.replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]+\b/g, "[redacted]");

  // 4. OpenAI / Anthropic keys (sk-...)
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");

  // 5. Google AIza API keys
  out = out.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]");

  // 6. Slack xox[bp]- tokens
  out = out.replace(/\bxox[baprs]-[0-9A-Za-z-]{8,}\b/g, "[redacted]");

  // 7. JWT-like tokens (eyJ...\.eyJ...\....)
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g, "[redacted]");

  // 8. curl credentials (-u user:pass or --user user:pass)
  out = out.replace(/(-u\s+|--user\s+)([^\s:]+):([^\s"'&;]+)/gi, "$1$2:[redacted]");

  // 9. JSON-style: "password": "...", "api_key": "..."
  out = out.replace(
    /((\\"|")?[a-zA-Z0-9_-]*(?:token|key|secret|password)[a-zA-Z0-9_-]*\2\s*:\s*)(\\"|")[^"'\r\n]+?\3/gi,
    "$1$3[redacted]$3",
  );

  // 10. *TOKEN= / *KEY= / *SECRET= / *PASSWORD= query or env values
  out = out.replace(
    /(?<=[?&]|\b)([a-zA-Z0-9_-]*(?:password|token|secret|key)[a-zA-Z0-9_-]*=)(?:(["'])([^\r\n"']+)\2|([^\s&;"']+))/gi,
    "$1[redacted]",
  );

  // 11. Long hex strings (32+ chars, containing both digits and hex letters)
  out = out.replace(/\b(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{32,}\b/g, "[redacted]");

  // 12. Base64 strings (20+ chars with padding = or ==)
  out = out.replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{20,}={1,2}(?![A-Za-z0-9+/=])/g, "[redacted]");

  return out;
}

export { redactSecrets as redact };

interface ActiveSession {
  seq: number;
  count: number;
  truncated: boolean;
  itemSeqById: Map<string, number>;
  lastSeq?: number | undefined;
}

export class SessionStore {
  private readonly active = new Map<number, ActiveSession>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  start(ticketId: Id, stage: string, employeeId: Id, engineId: Id): number {
    const startedAt = this.clock.now();
    this.db.run(
      "INSERT INTO ticket_sessions (ticket_id, stage, employee_id, engine_id, started_at) VALUES (?, ?, ?, ?, ?)",
      ticketId,
      stage,
      employeeId,
      engineId,
      startedAt,
    );
    const [row] = this.db.all<{ id: number }>("SELECT last_insert_rowid() AS id");
    const sessionId = row?.id ?? 0;
    this.active.set(sessionId, {
      seq: 0,
      count: 0,
      truncated: false,
      itemSeqById: new Map(),
    });

    this.pruneOldSessions(ticketId, MAX_SESSIONS_PER_TICKET);
    return sessionId;
  }

  recordItem(sessionId: number, item: SessionTranscriptItem): void {
    let state = this.active.get(sessionId);
    if (!state) {
      const rows = this.db.all<{ seq: number; kind: string; text: string | null }>(
        "SELECT seq, kind, text FROM ticket_session_items WHERE session_id = ? ORDER BY seq ASC",
        sessionId,
      );
      const last = rows.at(-1);
      state = {
        seq: last?.seq ?? 0,
        count: rows.length,
        truncated: last?.kind === "text" && last.text === "[truncated]",
        itemSeqById: new Map(),
        ...(last?.seq !== undefined ? { lastSeq: last.seq } : {}),
      };
      this.active.set(sessionId, state);
    }

    const text = item.text !== undefined ? capText(redactSecrets(item.text), 4096) : undefined;
    const title = item.title !== undefined ? capText(redactSecrets(item.title), 4096) : undefined;
    const status = item.status !== undefined ? capText(redactSecrets(item.status), 4096) : undefined;

    // Check if this item updates an existing item by id
    const existingSeq = item.id ? state.itemSeqById.get(item.id) : undefined;
    if (existingSeq !== undefined) {
      this.db.run(
        "UPDATE ticket_session_items SET text = coalesce(?, text), title = coalesce(?, title), status = coalesce(?, status) WHERE session_id = ? AND seq = ?",
        text !== undefined ? text : null,
        title !== undefined ? title : null,
        status !== undefined ? status : null,
        sessionId,
        existingSeq,
      );
      return;
    }

    if (state.truncated) {
      return;
    }

    if (state.count >= MAX_SESSION_ITEMS) {
      state.truncated = true;
      state.seq++;
      state.count++;
      state.lastSeq = state.seq;
      this.db.run(
        "INSERT INTO ticket_session_items (session_id, seq, kind, text, title, status, at) VALUES (?, ?, 'text', '[truncated]', NULL, NULL, ?)",
        sessionId,
        state.seq,
        item.at,
      );
      return;
    }

    state.seq++;
    state.count++;
    state.lastSeq = state.seq;
    if (item.id) {
      state.itemSeqById.set(item.id, state.seq);
    }

    this.db.run(
      "INSERT INTO ticket_session_items (session_id, seq, kind, text, title, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sessionId,
      state.seq,
      item.kind,
      text !== undefined ? text : null,
      title !== undefined ? title : null,
      status !== undefined ? status : null,
      item.at,
    );
  }

  finish(sessionId: number): void {
    const endedAt = this.clock.now();
    this.db.run("UPDATE ticket_sessions SET ended_at = ? WHERE id = ?", endedAt, sessionId);
    this.active.delete(sessionId);
  }

  list(ticketId: Id): TicketSessionTranscript[] {
    const sessions = this.db.all<{
      id: number;
      stage: string;
      employee_id: string;
      engine_id: string;
      started_at: number;
      ended_at: number | null;
    }>(
      "SELECT id, stage, employee_id, engine_id, started_at, ended_at FROM ticket_sessions WHERE ticket_id = ? ORDER BY id ASC",
      ticketId,
    );
    if (sessions.length === 0) return [];

    const sessionIds = sessions.map((s) => s.id);
    const placeholders = sessionIds.map(() => "?").join(", ");
    const itemRows = this.db.all<{
      session_id: number;
      kind: "text" | "tool";
      text: string | null;
      title: string | null;
      status: string | null;
      at: number;
    }>(
      `SELECT session_id, kind, text, title, status, at FROM ticket_session_items WHERE session_id IN (${placeholders}) ORDER BY session_id ASC, seq ASC`,
      ...sessionIds,
    );

    const itemsBySession = new Map<number, SessionTranscriptItem[]>();
    for (const row of itemRows) {
      let list = itemsBySession.get(row.session_id);
      if (!list) {
        list = [];
        itemsBySession.set(row.session_id, list);
      }
      const item: SessionTranscriptItem = {
        kind: row.kind,
        at: row.at,
      };
      if (row.text !== null && row.text !== undefined) item.text = row.text;
      if (row.title !== null && row.title !== undefined) item.title = row.title;
      if (row.status !== null && row.status !== undefined) item.status = row.status;
      list.push(item);
    }

    return sessions.map((s) => ({
      stage: s.stage,
      employeeId: s.employee_id,
      engineId: s.engine_id,
      startedAt: s.started_at,
      endedAt: s.ended_at !== null ? s.ended_at : null,
      items: itemsBySession.get(s.id) ?? [],
    }));
  }

  private pruneOldSessions(ticketId: Id, keepLimit = MAX_SESSIONS_PER_TICKET): void {
    const oldSessions = this.db.all<{ id: number }>(
      "SELECT id FROM ticket_sessions WHERE ticket_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?",
      ticketId,
      keepLimit,
    );
    for (const s of oldSessions) {
      this.db.run("DELETE FROM ticket_session_items WHERE session_id = ?", s.id);
      this.db.run("DELETE FROM ticket_sessions WHERE id = ?", s.id);
    }
  }
}
