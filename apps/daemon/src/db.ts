// A tiny SQL surface over bun:sqlite (on the host) and node:sqlite (in tests), so the daemon's code
// runs on both. Only what the daemon needs: exec, run, all, and a transaction.

export type Row = Record<string, unknown>;
export type Param = string | number | null | Uint8Array;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): { changes?: number };
  all<T extends Row = Row>(sql: string, ...params: Param[]): T[];
  transaction(fn: () => void): void;
  close(): void;
}

/** Opens a database file (or ":memory:") with whichever SQLite the runtime has. */
export async function openDb(path: string): Promise<Db> {
  const db = typeof Bun !== "undefined" ? await openBun(path) : await openNode(path);
  // WAL, and a 5 s busy timeout so a second connection waits for a lock instead of failing at once.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}

async function openBun(path: string): Promise<Db> {
  const { Database } = await import("bun:sqlite");
  const d = new Database(path, { create: true });
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, ...params) => {
      const res = d.query(sql).run(...params);
      return { changes: res.changes };
    },
    all: <T extends Row>(sql: string, ...params: Param[]) => d.query(sql).all(...params) as T[],
    transaction: (fn) => d.transaction(fn)(),
    close: () => d.close(),
  };
}

async function openNode(path: string): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(path);
  let depth = 0;
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, ...params) => {
      const res = d.prepare(sql).run(...params);
      return { changes: Number(res.changes) };
    },
    all: <T extends Row>(sql: string, ...params: Param[]) => d.prepare(sql).all(...params) as T[],
    // A transaction inside one joins it (Bun's does too, as a savepoint), so a caller can make several
    // writes, each of which is a transaction on its own, atomic as a whole.
    transaction: (fn) => {
      if (depth > 0) {
        fn();
        return;
      }
      d.exec("BEGIN");
      depth++;
      try {
        fn();
        d.exec("COMMIT");
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => d.close(),
  };
}
