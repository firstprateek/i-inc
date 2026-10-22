// Browser sessions. A login makes a random session token and the browser keeps it as the `i_inc` cookie;
// the daemon keeps only its sha-256, with an expiry, so a database copy holds nothing a cookie can be
// made from and signing out can revoke it. The daemon token itself (Authorization: Bearer, for scripts
// and the deployer) is never handed to a browser.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";

/** A session lasts this long after its last renewal. */
export const SESSION_MS = 30 * 24 * 3600_000;
/** Use renews it, at most this often (the cookie is sent again with the new Max-Age). */
const RENEW_AFTER_MS = 24 * 3600_000;
/** More live sessions than this drop the oldest, so a script cannot fill the table. */
const MAX_LIVE = 200;

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export class WebSessions {
  private revokeListeners: (() => void)[] = [];

  constructor(
    private db: Db,
    private now: () => number,
  ) {}

  /** A new session: the token to put in the cookie, and for how many seconds. */
  create(): { token: string; maxAge: number } {
    const at = this.now();
    this.db.run("DELETE FROM web_sessions WHERE expires_at <= ?", at);
    this.db.run(
      "DELETE FROM web_sessions WHERE id_hash IN (SELECT id_hash FROM web_sessions ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
      MAX_LIVE - 1,
    );
    const token = randomBytes(32).toString("base64url");
    this.db.run(
      "INSERT INTO web_sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)",
      hash(token),
      at,
      at + SESSION_MS,
    );
    return { token, maxAge: SESSION_MS / 1000 };
  }

  /** Is this a live session? */
  valid(raw: string): boolean {
    const [row] = this.db.all<{ expires_at: number }>(
      "SELECT expires_at FROM web_sessions WHERE id_hash = ?",
      hash(raw),
    );
    return row !== undefined && row.expires_at > this.now();
  }

  /** Pushes a live session's expiry out, once a day at most. True when it did (send the cookie again). */
  renew(raw: string): boolean {
    const at = this.now();
    const changed = this.db.run(
      "UPDATE web_sessions SET expires_at = ? WHERE id_hash = ? AND expires_at > ? AND expires_at < ?",
      at + SESSION_MS,
      hash(raw),
      at,
      at + SESSION_MS - RENEW_AFTER_MS,
    ).changes;
    return (changed ?? 0) > 0;
  }

  /** Signs a session out, and tells whoever holds something open on it (the AHP sockets) to let go. */
  revoke(raw: string): void {
    this.db.run("DELETE FROM web_sessions WHERE id_hash = ?", hash(raw));
    for (const f of this.revokeListeners) f();
  }

  /** Called after any session is revoked. */
  onRevoke(f: () => void): void {
    this.revokeListeners.push(f);
  }
}
