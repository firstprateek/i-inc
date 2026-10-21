// The host's durable state, in bun:sqlite: the sequenced action log, channel records with their initial
// state, periodic snapshots (so a restart replays only a tail), and content blobs for ContentRef URIs.
import { Database } from "bun:sqlite";

export interface ActionRow {
  seq: number;
  channel: string;
  action: any;
  origin: { clientId: string; clientSeq: number } | undefined;
  at: number;
}

export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS channels(
      uri TEXT PRIMARY KEY, kind TEXT NOT NULL, initial TEXT NOT NULL, created_seq INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}')`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ahp_actions(
      seq INTEGER PRIMARY KEY, channel TEXT NOT NULL, action TEXT NOT NULL, origin TEXT, at INTEGER NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS ahp_actions_channel ON ahp_actions(channel, seq)");
    this.db.run(`CREATE TABLE IF NOT EXISTS ahp_snapshots(
      channel TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(channel, seq))`);
    this.db.run("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS blobs(hash TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL)");
  }

  maxSeq(): number {
    return (this.db.query("SELECT COALESCE(MAX(seq), 0) AS s FROM ahp_actions").get() as { s: number }).s;
  }

  createChannel(uri: string, kind: string, initial: unknown, seq: number, meta: unknown = {}): void {
    this.db.query("INSERT OR REPLACE INTO channels(uri, kind, initial, created_seq, meta) VALUES(?,?,?,?,?)").run(
      uri, kind, JSON.stringify(initial), seq, JSON.stringify(meta),
    );
  }

  setMeta(uri: string, meta: unknown): void {
    this.db.query("UPDATE channels SET meta = ? WHERE uri = ?").run(JSON.stringify(meta), uri);
  }

  channels(): { uri: string; kind: string; initial: any; created_seq: number; meta: any }[] {
    return (this.db.query("SELECT * FROM channels ORDER BY created_seq, rowid").all() as any[]).map((r) => ({
      ...r,
      initial: JSON.parse(r.initial),
      meta: JSON.parse(r.meta),
    }));
  }

  append(row: ActionRow): void {
    this.db.query("INSERT INTO ahp_actions(seq, channel, action, origin, at) VALUES(?,?,?,?,?)").run(
      row.seq, row.channel, JSON.stringify(row.action), row.origin ? JSON.stringify(row.origin) : null, row.at,
    );
  }

  actionsAfter(seq: number, channels?: string[]): ActionRow[] {
    const rows = this.db.query("SELECT * FROM ahp_actions WHERE seq > ? ORDER BY seq").all(seq) as any[];
    return rows
      .filter((r) => !channels || channels.includes(r.channel))
      .map((r) => ({
        seq: r.seq, channel: r.channel, action: JSON.parse(r.action), at: r.at,
        origin: r.origin ? JSON.parse(r.origin) : undefined,
      }));
  }

  channelActionsAfter(channel: string, seq: number): ActionRow[] {
    return this.actionsAfter(seq, [channel]);
  }

  snapshot(channel: string, seq: number, state: unknown): void {
    this.db.query("INSERT OR REPLACE INTO ahp_snapshots(channel, seq, state) VALUES(?,?,?)").run(channel, seq, JSON.stringify(state));
  }

  latestSnapshot(channel: string): { seq: number; state: any } | undefined {
    const r = this.db.query("SELECT seq, state FROM ahp_snapshots WHERE channel = ? ORDER BY seq DESC LIMIT 1").get(channel) as
      | { seq: number; state: string }
      | null;
    return r ? { seq: r.seq, state: JSON.parse(r.state) } : undefined;
  }

  /** Drop log rows at or below `seq` (after snapshots cover them): reconnects older than this get snapshots. */
  prune(seq: number): void {
    this.db.query("DELETE FROM ahp_actions WHERE seq <= ?").run(seq);
    this.db.query("INSERT OR REPLACE INTO kv(k, v) VALUES('prunedThrough', ?)").run(String(seq));
  }

  /** The newest serverSeq the log no longer holds: a reconnect from at or below it must get snapshots. */
  floor(): number {
    return Number((this.db.query("SELECT v FROM kv WHERE k = 'prunedThrough'").get() as { v: string } | null)?.v ?? 0);
  }

  putBlob(hash: string, mime: string, data: Uint8Array): void {
    this.db.query("INSERT OR IGNORE INTO blobs(hash, mime, data) VALUES(?,?,?)").run(hash, mime, data);
  }

  getBlob(hash: string): { mime: string; data: Uint8Array } | undefined {
    return (this.db.query("SELECT mime, data FROM blobs WHERE hash = ?").get(hash) as any) ?? undefined;
  }

  close(): void {
    this.db.close();
  }
}
