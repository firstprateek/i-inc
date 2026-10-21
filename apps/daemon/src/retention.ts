// Retention on the host (T52): what the daemon keeps of old data, and how it trims the rest. Each
// function does one thing, takes the paths it works on and never reaches outside them, and with
// `dryRun` only reports. Nothing here deletes the owner's own data: uploaded images, the event log
// and the brains are only measured.
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, open, readdir, rename, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Id } from "@i-inc/core";
import type { Db } from "./db.ts";

const DAY = 86_400_000;

/** The bytes a folder holds, not following symlinks. A folder that isn't there holds 0. */
export async function dirBytes(path: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    try {
      if (e.isDirectory()) total += await dirBytes(p);
      else if (e.isFile()) total += (await lstat(p)).size;
    } catch {
      // gone while we looked
    }
  }
  return total;
}

/** A file's size, or 0. */
export async function fileBytes(path: string): Promise<number> {
  try {
    return (await lstat(path)).size;
  } catch {
    return 0;
  }
}

/** The disk a big folder takes (`du`, which counts what a sparse file really uses), or null. */
export function duBytes(path: string, timeoutMs = 60_000): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("du", ["-sk", path], { timeout: timeoutMs, encoding: "utf8" }, (err, out) => {
      const kb = Number(out.split(/\s+/)[0]);
      resolve(err && !out ? null : Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

// --- transcripts ---------------------------------------------------------------------------------

export interface CompactResult {
  sessions: number;
  itemsRemoved: number;
}

/**
 * Shrinks the transcripts of the given (closed) tickets: a session with more than `keep` items keeps
 * its last `keep`, and one summary item in front says how many went. `GET /api/tickets/:id/sessions`
 * reads items in order, so it still answers; the summary is an ordinary text item. A compacted
 * session has keep + 1 items and is left alone next time.
 */
export function compactTranscripts(
  db: Db,
  ticketIds: Id[],
  keep: number,
  now: number,
  dryRun = false,
): CompactResult {
  const out: CompactResult = { sessions: 0, itemsRemoved: 0 };
  const day = new Date(now).toISOString().slice(0, 10);
  for (const ticketId of ticketIds) {
    const sessions = db.all<{ id: number }>("SELECT id FROM ticket_sessions WHERE ticket_id = ?", ticketId);
    for (const { id } of sessions) {
      const [count] = db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM ticket_session_items WHERE session_id = ?",
        id,
      );
      const n = count?.n ?? 0;
      if (n <= keep + 1) continue;
      const [first] = db.all<{ seq: number }>(
        "SELECT seq FROM ticket_session_items WHERE session_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
        id,
        keep - 1,
      );
      if (!first) continue;
      const cut = first.seq;
      const dropped = db.all<{ kind: string; n: number; at: number }>(
        "SELECT kind, COUNT(*) AS n, MIN(at) AS at FROM ticket_session_items WHERE session_id = ? AND seq < ? GROUP BY kind",
        id,
        cut,
      );
      const removed = dropped.reduce((sum, r) => sum + r.n, 0);
      if (removed === 0) continue;
      out.sessions++;
      out.itemsRemoved += removed;
      if (dryRun) continue;
      const tools = dropped.find((r) => r.kind === "tool")?.n ?? 0;
      const at = Math.min(...dropped.map((r) => r.at));
      db.transaction(() => {
        db.run("DELETE FROM ticket_session_items WHERE session_id = ? AND seq < ?", id, cut);
        db.run(
          "INSERT INTO ticket_session_items (session_id, seq, kind, text, title, status, at) VALUES (?, ?, 'text', ?, NULL, NULL, ?)",
          id,
          cut - 1,
          `[${removed} earlier items removed on ${day} to save space: ${tools} tool calls, ${removed - tools} messages]`,
          at,
        );
      });
    }
  }
  return out;
}

// --- the database --------------------------------------------------------------------------------

export interface DbSpace {
  pageSize: number;
  pages: number;
  freePages: number;
  freeBytes: number;
  /** Share of the file that is free pages, in percent. */
  freePct: number;
}

export function dbSpace(db: Db): DbSpace {
  const one = (pragma: string, key: string) =>
    Number(db.all<Record<string, number>>(`PRAGMA ${pragma}`)[0]?.[key] ?? 0);
  const pageSize = one("page_size", "page_size");
  const pages = one("page_count", "page_count");
  const freePages = one("freelist_count", "freelist_count");
  return {
    pageSize,
    pages,
    freePages,
    freeBytes: freePages * pageSize,
    freePct: pages ? Math.round((freePages / pages) * 1000) / 10 : 0,
  };
}

export interface VacuumResult {
  space: DbSpace;
  ran: boolean;
  reason?: string;
}

/**
 * VACUUM rewrites the file without its free pages and stops everything else that uses the database
 * while it runs, so the caller only asks when the daemon is idle. It runs when at least `freePct`
 * percent of the pages are free and they come to `minFreeBytes`, then truncates the write-ahead log.
 */
export function vacuumIfNeeded(
  db: Db,
  o: { freePct: number; minFreeBytes: number; idle: boolean; dryRun?: boolean },
): VacuumResult {
  const space = dbSpace(db);
  if (space.freePct < o.freePct || space.freeBytes < o.minFreeBytes) {
    return { space, ran: false, reason: "not enough free pages" };
  }
  if (!o.idle) return { space, ran: false, reason: "busy" };
  if (o.dryRun) return { space, ran: false, reason: "dry run" };
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { space: dbSpace(db), ran: true };
}

/** Folds the write-ahead log back into the database, which also lets the log file shrink. */
export function checkpoint(db: Db): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

// --- logs ----------------------------------------------------------------------------------------

/** The logs the host's launch agents write in ~/Library/Logs: i-inc-daemon.log, i-inc-container.log, … */
export const logName = /^i-inc-[a-z0-9-]+\.log$/;

export interface RotateResult {
  file: string;
  bytes: number;
  /**
   * The log began with NUL bytes shortly after it was truncated: whatever writes it doesn't append,
   * so its next write landed at the old offset and left a hole. Switch that writer to O_APPEND (the
   * daemon can write its own log file) instead of rotating by truncation.
   */
  nulAtStart?: boolean;
}

/** Whether a file's first bytes are NUL, as when a writer that doesn't append wrote past a truncation. */
async function startsWithNul(file: string): Promise<boolean> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await fh.read(buf, 0, 64, 0);
    return bytesRead > 0 && buf[0] === 0;
  } finally {
    await fh.close();
  }
}

/**
 * Rotates the i.inc logs in `dir` that are over `maxBytes`. launchd keeps the log open, so the file
 * can't be renamed (the writer would go on writing to the renamed one): it is copied, then truncated
 * in place, and the copy is gzipped to <log>.1.gz (older copies shift up and the one past `keep` goes).
 * The copy is a plain file copy and the truncation follows it at once, to keep the gap short. A line
 * written between the end of the copy and the truncation is lost, and that gap is the only loss.
 *
 * It then waits `settleMs` and looks at the start of the log: if it begins with NUL bytes, the writer
 * doesn't append (launchd is expected to), and the result says so.
 */
export async function rotateLogs(
  dir: string,
  o: { maxBytes: number; keep: number; dryRun?: boolean; settleMs?: number },
): Promise<RotateResult[]> {
  const rotated: RotateResult[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return rotated;
  }
  for (const name of names.filter((n) => logName.test(n))) {
    const file = join(dir, name);
    let st: import("node:fs").Stats;
    try {
      st = await lstat(file);
    } catch {
      continue;
    }
    // Rotated copies beyond the limit go, whatever the size of the log now.
    if (!o.dryRun) {
      for (const other of names) {
        const m = new RegExp(`^${name.replaceAll(".", "\\.")}\\.(\\d+)\\.gz$`).exec(other);
        if (m && Number(m[1]) > o.keep) await rm(join(dir, other), { force: true });
      }
    }
    if (!st.isFile() || st.size <= o.maxBytes) continue;
    const result: RotateResult = { file: name, bytes: st.size };
    rotated.push(result);
    if (o.dryRun) continue;
    await rm(`${file}.${o.keep}.gz`, { force: true });
    for (let n = o.keep - 1; n >= 1; n--) {
      await rename(`${file}.${n}.gz`, `${file}.${n + 1}.gz`).catch(() => {});
    }
    const copy = `${file}.rotating`;
    await copyFile(file, copy);
    await truncate(file, 0);
    await pipeline(createReadStream(copy), createGzip(), createWriteStream(`${file}.1.gz`));
    await rm(copy, { force: true });
    await new Promise((r) => setTimeout(r, o.settleMs ?? 2000));
    if (await startsWithNul(file).catch(() => false)) result.nulAtStart = true;
  }
  return rotated;
}

// --- backups -------------------------------------------------------------------------------------

/**
 * The names of backups the daemon makes itself: i-inc.db.autobak-<date or label>. A backup somebody
 * made by hand (i-inc.db.bak-…) never matches, so it is never deleted here.
 */
export const backupName = /^(?:i-inc|demo)\.db\.autobak-[A-Za-z0-9._-]+$/;

export interface BackupResult {
  deleted: { name: string; bytes: number }[];
  kept: number;
}

/**
 * Deletes database backups in `dir` that the daemon made (its own `autobak` naming) and are older than `maxAgeDays`.
 * The newest backup is never deleted, however old, and neither is anything that doesn't match the
 * name or isn't a plain file.
 */
export async function pruneBackups(
  dir: string,
  o: { maxAgeDays: number; now: number; dryRun?: boolean },
): Promise<BackupResult> {
  const result: BackupResult = { deleted: [], kept: 0 };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return result;
  }
  const found: { name: string; bytes: number; mtime: number }[] = [];
  for (const name of names.filter((n) => backupName.test(n))) {
    try {
      const st = await lstat(join(dir, name));
      if (st.isFile()) found.push({ name, bytes: st.size, mtime: st.mtimeMs });
    } catch {
      // gone
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  result.kept = found.length;
  if (o.maxAgeDays <= 0) return result;
  for (const f of found.slice(1)) {
    if (o.now - f.mtime < o.maxAgeDays * DAY) continue;
    if (!o.dryRun) await rm(join(dir, f.name), { force: true });
    result.deleted.push({ name: f.name, bytes: f.bytes });
    result.kept--;
  }
  return result;
}

// --- knowledge repos -----------------------------------------------------------------------------

/** Packs a git repo's loose objects if it has enough of them (`git gc --auto`). */
export function gcRepo(dir: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["gc", "--auto", "--quiet"], { cwd: dir, timeout: timeoutMs }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}
