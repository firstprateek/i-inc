// Host retention (T52): transcript compaction, VACUUM, log rotation and stale backups. Everything
// runs on temp folders and temp databases; the real ~/.i-inc and ~/Library/Logs are never touched.
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  backupName,
  compactTranscripts,
  dbSpace,
  dirBytes,
  pruneBackups,
  rotateLogs,
  vacuumIfNeeded,
} from "../src/retention.ts";
import { migrate } from "../src/schema.ts";
import { SessionStore } from "../src/sessions.ts";
import { Storage } from "../src/storage.ts";
import { refunds, testApp } from "./setup.ts";

const DAY = 86_400_000;
const tmp = () => mkdtempSync(join(tmpdir(), "i-inc-retention-"));

async function memoryDb() {
  const db = await openDb(":memory:");
  migrate(db);
  return db;
}

/** A session with `n` items alternating text and tool calls. */
function fillSession(sessions: SessionStore, ticket: string, n: number, at = 1000) {
  const id = sessions.start(ticket, "build", "ada", "opus");
  for (let i = 1; i <= n; i++) {
    sessions.recordItem(
      id,
      i % 2
        ? { kind: "text", text: `message ${i}`, at: at + i }
        : { kind: "tool", title: `tool ${i}`, at: at + i },
    );
  }
  sessions.finish(id);
  return id;
}

describe("compacting transcripts", () => {
  it("keeps the last items of each session and one line saying what went", async () => {
    const db = await memoryDb();
    const sessions = new SessionStore(db, { now: () => 5000 });
    fillSession(sessions, "1", 200);
    const r = compactTranscripts(db, ["1"], 50, Date.UTC(2026, 9, 21));
    expect(r).toEqual({ sessions: 1, itemsRemoved: 150 });

    const [s] = sessions.list("1");
    expect(s?.items).toHaveLength(51);
    expect(s?.items[0]?.text).toBe(
      "[150 earlier items removed on 2026-10-21 to save space: 75 tool calls, 75 messages]",
    );
    expect(s?.items[1]?.text).toBe("message 151");
    expect(s?.items.at(-1)?.title).toBe("tool 200");
    // Items stay in time order, so the transcript still reads straight through.
    const times = (s?.items ?? []).map((i) => i.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("leaves a compacted session alone, and sessions that are small enough", async () => {
    const db = await memoryDb();
    const sessions = new SessionStore(db, { now: () => 5000 });
    fillSession(sessions, "1", 200);
    fillSession(sessions, "1", 51);
    fillSession(sessions, "1", 10);
    expect(compactTranscripts(db, ["1"], 50, 0).itemsRemoved).toBe(150);
    expect(compactTranscripts(db, ["1"], 50, 0)).toEqual({ sessions: 0, itemsRemoved: 0 });
    expect(sessions.list("1").map((s) => s.items.length)).toEqual([51, 51, 10]);
  });

  it("only touches the tickets it is given", async () => {
    const db = await memoryDb();
    const sessions = new SessionStore(db, { now: () => 5000 });
    fillSession(sessions, "1", 100);
    fillSession(sessions, "2", 100);
    compactTranscripts(db, ["1"], 50, 0);
    expect(sessions.list("1")[0]?.items).toHaveLength(51);
    expect(sessions.list("2")[0]?.items).toHaveLength(100);
  });

  it("reports in a dry run and changes nothing", async () => {
    const db = await memoryDb();
    const sessions = new SessionStore(db, { now: () => 5000 });
    fillSession(sessions, "1", 100);
    expect(compactTranscripts(db, ["1"], 50, 0, true)).toEqual({ sessions: 1, itemsRemoved: 50 });
    expect(sessions.list("1")[0]?.items).toHaveLength(100);
  });
});

describe("vacuuming the database", () => {
  async function bloated() {
    const path = join(tmp(), "i-inc.db");
    const db = await openDb(path);
    migrate(db);
    const text = "x".repeat(3000);
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) {
        db.run(
          "INSERT INTO ticket_session_items (session_id, seq, kind, text, at) VALUES (1, ?, 'text', ?, 0)",
          i,
          text,
        );
      }
    });
    db.run("DELETE FROM ticket_session_items");
    return { db, path };
  }

  it("rewrites the file when most of it is free pages and the daemon is idle", async () => {
    const { db, path } = await bloated();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = statSync(path).size;
    expect(dbSpace(db).freePct).toBeGreaterThan(50);

    const r = vacuumIfNeeded(db, { freePct: 20, minFreeBytes: 1024, idle: true });

    expect(r.ran).toBe(true);
    expect(dbSpace(db).freePages).toBe(0);
    expect(statSync(path).size).toBeLessThan(before / 4);
    db.close();
  });

  it("waits while the daemon is busy, and does nothing under the thresholds", async () => {
    const { db } = await bloated();
    expect(vacuumIfNeeded(db, { freePct: 20, minFreeBytes: 1024, idle: false })).toMatchObject({
      ran: false,
      reason: "busy",
    });
    expect(vacuumIfNeeded(db, { freePct: 100.5, minFreeBytes: 1024, idle: true })).toMatchObject({
      ran: false,
    });
    expect(vacuumIfNeeded(db, { freePct: 20, minFreeBytes: 1024 ** 3, idle: true })).toMatchObject({
      ran: false,
    });
    expect(vacuumIfNeeded(db, { freePct: 20, minFreeBytes: 1, idle: true, dryRun: true })).toMatchObject({
      ran: false,
      reason: "dry run",
    });
    expect(dbSpace(db).freePages).toBeGreaterThan(0);
    db.close();
  });
});

describe("rotating logs", () => {
  const write = (dir: string, name: string, bytes: number, ch = "a") =>
    writeFileSync(join(dir, name), ch.repeat(bytes));

  it("gzips a log over the limit, truncates it in place and keeps the newest copies", async () => {
    const dir = tmp();
    write(dir, "i-inc-daemon.log", 3000, "1");
    const first = await rotateLogs(dir, { maxBytes: 1000, keep: 2, settleMs: 0 });
    expect(first).toEqual([{ file: "i-inc-daemon.log", bytes: 3000 }]);
    expect(statSync(join(dir, "i-inc-daemon.log")).size).toBe(0);
    expect(gunzipSync(readFileSync(join(dir, "i-inc-daemon.log.1.gz"))).toString()).toBe("1".repeat(3000));

    write(dir, "i-inc-daemon.log", 2000, "2");
    await rotateLogs(dir, { maxBytes: 1000, keep: 2, settleMs: 0 });
    write(dir, "i-inc-daemon.log", 2000, "3");
    await rotateLogs(dir, { maxBytes: 1000, keep: 2, settleMs: 0 });

    expect(gunzipSync(readFileSync(join(dir, "i-inc-daemon.log.1.gz"))).toString()[0]).toBe("3");
    expect(gunzipSync(readFileSync(join(dir, "i-inc-daemon.log.2.gz"))).toString()[0]).toBe("2");
    // The first one is the oldest past `keep`, so it is gone.
    expect(existsSync(join(dir, "i-inc-daemon.log.3.gz"))).toBe(false);
  });

  it("leaves small logs and other files alone, and removes copies past the new limit", async () => {
    const dir = tmp();
    write(dir, "i-inc-container.log", 500);
    write(dir, "other.log", 5000);
    write(dir, "i-inc-daemon.log.4.gz", 10);
    write(dir, "i-inc-daemon.log", 10);
    write(dir, "i-inc-daemon.log.1.gz", 10);
    const r = await rotateLogs(dir, { maxBytes: 1000, keep: 2, settleMs: 0 });
    expect(r).toEqual([]);
    expect(statSync(join(dir, "other.log")).size).toBe(5000);
    expect(statSync(join(dir, "i-inc-container.log")).size).toBe(500);
    expect(existsSync(join(dir, "i-inc-daemon.log.4.gz"))).toBe(false);
    expect(existsSync(join(dir, "i-inc-daemon.log.1.gz"))).toBe(true);
  });

  it("copies then truncates, leaves no temp file, and loses nothing a writer that appends logs afterwards", async () => {
    const dir = tmp();
    const file = join(dir, "i-inc-daemon.log");
    writeFileSync(file, "old line\n".repeat(300));
    // launchd opens the log for appending, and keeps the descriptor.
    const fd = openSync(file, "a");
    const r = await rotateLogs(dir, { maxBytes: 1000, keep: 2, settleMs: 30 });
    writeSync(fd, "new line\n");
    closeSync(fd);
    expect(r[0]?.nulAtStart).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("new line\n");
    expect(gunzipSync(readFileSync(`${file}.1.gz`)).toString()).toBe("old line\n".repeat(300));
    expect(existsSync(`${file}.rotating`)).toBe(false);
  });

  it("warns when the log starts with NUL bytes because its writer doesn't append", async () => {
    const dir = tmp();
    const file = join(dir, "i-inc-daemon.log");
    writeFileSync(file, "x".repeat(3000));
    // A writer holding a plain descriptor at its old offset: its next write lands past the new end.
    const fd = openSync(file, "r+");
    writeSync(fd, "y", 2999);
    // The write comes in the settling window, after the truncation: no timer to win or lose a race.
    const r = await rotateLogs(dir, {
      maxBytes: 1000,
      keep: 2,
      settle: async () => {
        writeSync(fd, "late line\n", 3000);
      },
    });
    closeSync(fd);
    expect(r).toEqual([{ file: "i-inc-daemon.log", bytes: 3000, nulAtStart: true }]);
    expect(readFileSync(file)[0]).toBe(0);
  });

  it("reports and changes nothing in a dry run, and survives a missing folder", async () => {
    const dir = tmp();
    write(dir, "i-inc-daemon.log", 3000);
    expect(await rotateLogs(dir, { maxBytes: 1000, keep: 2, dryRun: true })).toHaveLength(1);
    expect(statSync(join(dir, "i-inc-daemon.log")).size).toBe(3000);
    expect(await rotateLogs(join(dir, "nope"), { maxBytes: 1, keep: 1 })).toEqual([]);
  });
});

describe("stale backups", () => {
  const now = Date.UTC(2026, 9, 21);
  const make = (dir: string, name: string, daysOld: number) => {
    writeFileSync(join(dir, name), "backup");
    const t = new Date(now - daysOld * DAY);
    utimesSync(join(dir, name), t, t);
  };

  it("matches only the daemon's own backup names", () => {
    expect(backupName.test("i-inc.db.autobak-20260901")).toBe(true);
    expect(backupName.test("i-inc.db.autobak-before-vacuum")).toBe(true);
    expect(backupName.test("demo.db.autobak-1")).toBe(true);
    for (const n of [
      "i-inc.db",
      "i-inc.db-wal",
      "notes.bak-1",
      "i-inc.db.bak",
      "i-inc.db.autobak-",
      "../i-inc.db.autobak-1",
    ]) {
      expect(backupName.test(n)).toBe(false);
    }
  });

  it("deletes old ones, keeps recent ones and always the newest, and leaves everything else", async () => {
    const dir = tmp();
    make(dir, "i-inc.db.autobak-20250101", 300);
    make(dir, "i-inc.db.autobak-20250601", 100);
    make(dir, "i-inc.db.autobak-20260901", 50);
    make(dir, "i-inc.db.autobak-20261015", 6);
    make(dir, "i-inc.db", 400);
    make(dir, "notes.bak-1", 400);
    mkdirSync(join(dir, "i-inc.db.autobak-dir"));
    symlinkSync(dir, join(dir, "i-inc.db.autobak-link"));

    const r = await pruneBackups(dir, { maxAgeDays: 30, now });

    expect(r.deleted.map((d) => d.name).sort()).toEqual([
      "i-inc.db.autobak-20250101",
      "i-inc.db.autobak-20250601",
      "i-inc.db.autobak-20260901",
    ]);
    expect(existsSync(join(dir, "i-inc.db.autobak-20261015"))).toBe(true);
    for (const keep of ["i-inc.db", "notes.bak-1", "i-inc.db.autobak-dir", "i-inc.db.autobak-link"]) {
      expect(existsSync(join(dir, keep))).toBe(true);
    }
  });

  it("never deletes a backup somebody made by hand, however old", async () => {
    const dir = tmp();
    make(dir, "i-inc.db.bak-20240101", 700);
    make(dir, "i-inc.db.bak-before-upgrade", 900);
    make(dir, "demo.db.bak-1", 900);
    make(dir, "i-inc.db.autobak-20240101", 700);
    make(dir, "i-inc.db.autobak-20261015", 2);
    const r = await pruneBackups(dir, { maxAgeDays: 30, now });
    expect(r.deleted.map((d) => d.name)).toEqual(["i-inc.db.autobak-20240101"]);
    for (const hand of ["i-inc.db.bak-20240101", "i-inc.db.bak-before-upgrade", "demo.db.bak-1"]) {
      expect(existsSync(join(dir, hand))).toBe(true);
    }
  });

  it("keeps the newest backup even when all of them are old", async () => {
    const dir = tmp();
    make(dir, "i-inc.db.autobak-a", 200);
    make(dir, "i-inc.db.autobak-b", 100);
    await pruneBackups(dir, { maxAgeDays: 30, now });
    expect(existsSync(join(dir, "i-inc.db.autobak-b"))).toBe(true);
    expect(existsSync(join(dir, "i-inc.db.autobak-a"))).toBe(false);
  });

  it("deletes nothing in a dry run or with the limit off", async () => {
    const dir = tmp();
    make(dir, "i-inc.db.autobak-a", 200);
    make(dir, "i-inc.db.autobak-b", 100);
    expect((await pruneBackups(dir, { maxAgeDays: 30, now, dryRun: true })).deleted).toHaveLength(1);
    expect((await pruneBackups(dir, { maxAgeDays: 0, now })).deleted).toHaveLength(0);
    expect(existsSync(join(dir, "i-inc.db.autobak-a"))).toBe(true);
  });
});

describe("dirBytes", () => {
  it("adds up files and does not follow symlinks", async () => {
    const dir = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "big"), "x".repeat(10_000));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "a"), "x".repeat(100));
    writeFileSync(join(dir, "b"), "x".repeat(50));
    symlinkSync(outside, join(dir, "link"));
    expect(await dirBytes(dir)).toBe(150);
    expect(await dirBytes(join(dir, "missing"))).toBe(0);
  });
});

describe("host maintenance", () => {
  async function storageFor() {
    const app = await testApp();
    const home = tmp();
    const logDir = tmp();
    const logs: string[] = [];
    const storage = new Storage({
      db: app.db,
      clock: app.clock,
      registry: app.deps.registry,
      tickets: app.deps.tickets,
      events: app.deps.store,
      paths: { home, dbPath: join(home, "i-inc.db"), knowledgeDir: join(home, "knowledge"), logDir },
      log: (m) => logs.push(m),
      machineBusy: async () => false,
      hostBusy: () => false,
      ticketActive: () => false,
      footprint: () => ({}),
      logSettleMs: 0,
    });
    return { app, storage, home, logDir, logs };
  }

  it("compacts a closed ticket's transcripts after the days, never an open ticket's", async () => {
    const { app, storage } = await storageFor();
    // Ticket 1 closes; ticket 2 stays ready for the owner.
    await app.call("POST", "/api/tickets", refunds);
    await app.daemon.idle();
    await app.call("POST", "/api/tickets/1/decide", { decision: "approve" });
    await app.daemon.idle();
    await app.call("POST", "/api/tickets", { ...refunds, title: "Another" });
    await app.daemon.idle();
    const sessions = app.deps.sessions;
    for (const t of ["1", "2"]) {
      // Whatever the fake agent recorded, replace it with a long transcript of our own.
      app.db.run(
        "DELETE FROM ticket_session_items WHERE session_id IN (SELECT id FROM ticket_sessions WHERE ticket_id = ?)",
        t,
      );
      app.db.run("DELETE FROM ticket_sessions WHERE ticket_id = ?", t);
      fillSession(sessions, t, 120);
    }

    app.clock.advance(10 * 24 * 60);
    expect((await storage.maintainHost({ manual: true })).transcripts.itemsRemoved).toBe(0);

    app.clock.advance(25 * 24 * 60);
    const r = await storage.maintainHost({ manual: true });
    expect(r.transcripts).toEqual({ tickets: 1, sessions: 1, itemsRemoved: 70 });

    // The API still answers, with the same shape.
    const closed = await app.call("GET", "/api/tickets/1/sessions");
    expect(closed.status).toBe(200);
    expect(closed.body.sessions[0].items).toHaveLength(51);
    expect(closed.body.sessions[0].items[0].kind).toBe("text");
    const open = await app.call("GET", "/api/tickets/2/sessions");
    expect(open.body.sessions[0].items).toHaveLength(120);
  });

  it("runs once an hour on its own, and any time on request, and logs one line", async () => {
    const { app, storage, logs } = await storageFor();
    const first = await storage.maintainHost();
    expect(first.skipped).toBeUndefined();
    expect((await storage.maintainHost()).skipped).toBe("ran less than an hour ago");
    expect((await storage.maintainHost({ manual: true })).skipped).toBeUndefined();
    app.clock.advance(61);
    expect((await storage.maintainHost()).skipped).toBeUndefined();
    expect(logs.filter((l) => l.startsWith("[storage] host:"))).toHaveLength(3);
  });

  it("logs a warning when a rotated log starts with NUL bytes", async () => {
    const { storage, logDir, logs } = await storageFor();
    const file = join(logDir, "i-inc-daemon.log");
    writeFileSync(file, "x".repeat(21 * 1024 ** 2));
    const fd = openSync(file, "r+");
    writeSync(fd, "y", 21 * 1024 ** 2 - 1);
    // Written after the truncation, at the old offset, by a writer that doesn't append.
    (storage as unknown as { d: { logSettle: () => Promise<void> } }).d.logSettle = async () => {
      writeSync(fd, "late\n", 21 * 1024 ** 2);
    };
    await storage.maintainHost({ manual: true });
    closeSync(fd);
    expect(
      logs.some(
        (l) => l.includes("warning: i-inc-daemon.log begins with NUL bytes") && l.includes("O_APPEND"),
      ),
    ).toBe(true);
  });

  it("rotates logs, deletes stale backups and reports it all, and a dry run touches nothing", async () => {
    const { app, storage, home, logDir } = await storageFor();
    writeFileSync(join(logDir, "i-inc-daemon.log"), "x".repeat(21 * 1024 ** 2));
    writeFileSync(join(home, "i-inc.db.autobak-old"), "x");
    writeFileSync(join(home, "i-inc.db.autobak-new"), "x");
    const old = new Date(app.clock.now() - 40 * DAY);
    utimesSync(join(home, "i-inc.db.autobak-old"), old, old);

    const dry = await storage.maintainHost({ dryRun: true });
    expect(dry.logs).toHaveLength(1);
    expect(dry.backups.map((b) => b.name)).toEqual(["i-inc.db.autobak-old"]);
    expect(statSync(join(logDir, "i-inc-daemon.log")).size).toBe(21 * 1024 ** 2);
    expect(existsSync(join(home, "i-inc.db.autobak-old"))).toBe(true);

    const real = await storage.maintainHost({ manual: true });
    expect(real.logs).toHaveLength(1);
    expect(statSync(join(logDir, "i-inc-daemon.log")).size).toBe(0);
    expect(existsSync(join(home, "i-inc.db.autobak-old"))).toBe(false);
    expect(existsSync(join(home, "i-inc.db.autobak-new"))).toBe(true);

    const report = await storage.report();
    expect(report.host.lastMaintenance?.logs).toHaveLength(1);
    expect(report.host.logs.files).toBe(2);
    expect(report.host.backups.count).toBe(1);
  });
});
