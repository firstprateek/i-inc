// A tiny SQL surface over bun:sqlite (on the host) and node:sqlite (in tests), so the daemon's code
// runs on both. Only what the daemon needs: exec, run, all, and a transaction.

export type Row = Record<string, unknown>;
export type Param = string | number | null;

export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): void;
  all<T extends Row = Row>(sql: string, ...params: Param[]): T[];
  transaction(fn: () => void): void;
  close(): void;
}

/** Opens a database file (or ":memory:") with whichever SQLite the runtime has. */
export async function openDb(path: string): Promise<Db> {
  const db = typeof Bun !== "undefined" ? await openBun(path) : await openNode(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

async function openBun(path: string): Promise<Db> {
  const { Database } = await import("bun:sqlite");
  const d = new Database(path, { create: true });
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, ...params) => void d.query(sql).run(...params),
    all: <T extends Row>(sql: string, ...params: Param[]) => d.query(sql).all(...params) as T[],
    transaction: (fn) => d.transaction(fn)(),
    close: () => d.close(),
  };
}

async function openNode(path: string): Promise<Db> {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(path);
  return {
    exec: (sql) => d.exec(sql),
    run: (sql, ...params) => void d.prepare(sql).run(...params),
    all: <T extends Row>(sql: string, ...params: Param[]) => d.prepare(sql).all(...params) as T[],
    transaction: (fn) => {
      d.exec("BEGIN");
      try {
        fn();
        d.exec("COMMIT");
      } catch (e) {
        d.exec("ROLLBACK");
        throw e;
      }
    },
    close: () => d.close(),
  };
}
