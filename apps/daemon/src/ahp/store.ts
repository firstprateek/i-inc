// The AHP host's durable state, in the daemon's own SQLite database (through `Db`, so it runs on
// bun:sqlite on the host and node:sqlite in tests):
//
//   ahp_channels   one row per channel (root, session, chat): its initial state and host-side metadata
//   ahp_actions    the sequenced action log: server_seq is ONE counter for the whole host (spec: serverSeq)
//   ahp_snapshots  periodic channel states, so a restart replays only a tail
//   ahp_blobs      content behind ContentRef URIs (diffs, offloaded attachments), capped in total
//   ahp_kv         the sequence counter and the prune floor
//
// A channel's state is always: latest snapshot (or the initial state) + the actions after it. The log
// is pruned behind snapshots, by age and by count, and what a reconnecting client can no longer be
// replayed it gets as snapshots (the spec's "gap beyond the host's buffer").
import type { Db } from "../db.ts";
import type { ChannelKind, Json } from "./wire.ts";

export interface ChannelRow {
  uri: string;
  kind: ChannelKind;
  initial: unknown;
  createdSeq: number;
  createdAt: number;
  meta: Json;
}

export interface ActionRow {
  seq: number;
  channel: string;
  at: number;
  action: unknown;
  origin?: { clientId: string; clientSeq: number };
}

export interface Limits {
  /** Take a snapshot of a channel after this many actions. */
  snapshotEvery: number;
  /** Keep actions at least this long (ms) even when a snapshot covers them, for reconnects. */
  retainMs: number;
  /** Never keep more than this many action rows once snapshots cover them. */
  maxActionRows: number;
  /** Total bytes of content blobs; the oldest are dropped past it. */
  maxBlobBytes: number;
}

export const defaultLimits: Limits = {
  snapshotEvery: 200,
  retainMs: 24 * 3_600_000,
  maxActionRows: 200_000,
  maxBlobBytes: 512 * 1024 * 1024,
};

const SNAPSHOTS_KEPT = 2;

export class AhpStore {
  constructor(
    private readonly db: Db,
    readonly limits: Limits = defaultLimits,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ahp_channels (
        uri TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        initial TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS ahp_actions (
        server_seq INTEGER PRIMARY KEY,
        channel TEXT NOT NULL,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        origin TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ahp_actions_channel ON ahp_actions(channel, server_seq);
      CREATE TABLE IF NOT EXISTS ahp_snapshots (
        channel TEXT NOT NULL,
        server_seq INTEGER NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (channel, server_seq)
      );
      CREATE TABLE IF NOT EXISTS ahp_blobs (
        hash TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        data BLOB NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ahp_kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  transaction(fn: () => void): void {
    this.db.transaction(fn);
  }

  // ── the counter and the prune floor ─────────────────────────────────────────────────────────

  private kv(k: string): number {
    const [r] = this.db.all<{ v: string }>("SELECT v FROM ahp_kv WHERE k = ?", k);
    return r ? Number(r.v) : 0;
  }
  private setKv(k: string, v: number): void {
    this.db.run("INSERT OR REPLACE INTO ahp_kv (k, v) VALUES (?, ?)", k, String(v));
  }

  /** The highest serverSeq ever issued: the log's newest row, or the one recorded when the log was pruned. */
  maxSeq(): number {
    const [r] = this.db.all<{ s: number | null }>("SELECT MAX(server_seq) AS s FROM ahp_actions");
    return Math.max(r?.s ?? 0, this.kv("seq"));
  }

  /** The newest serverSeq the log no longer holds. A reconnect from at or below it gets snapshots. */
  floor(): number {
    return this.kv("floor");
  }

  // ── channels ────────────────────────────────────────────────────────────────────────────────

  createChannel(row: ChannelRow): void {
    this.db.run(
      "INSERT INTO ahp_channels (uri, kind, initial, created_seq, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)",
      row.uri,
      row.kind,
      JSON.stringify(row.initial),
      row.createdSeq,
      row.createdAt,
      JSON.stringify(row.meta),
    );
  }

  setMeta(uri: string, meta: Json): void {
    this.db.run("UPDATE ahp_channels SET meta = ? WHERE uri = ?", JSON.stringify(meta), uri);
  }

  channels(): ChannelRow[] {
    return this.db
      .all<{
        uri: string;
        kind: string;
        initial: string;
        created_seq: number;
        created_at: number;
        meta: string;
      }>("SELECT * FROM ahp_channels ORDER BY created_seq, rowid")
      .map((r) => ({
        uri: r.uri,
        kind: r.kind as ChannelKind,
        initial: JSON.parse(r.initial) as unknown,
        createdSeq: r.created_seq,
        createdAt: r.created_at,
        meta: JSON.parse(r.meta) as Json,
      }));
  }

  /** Forgets a channel for good: its row, its log and its snapshots. */
  deleteChannels(uris: string[]): void {
    this.db.transaction(() => {
      // The counter must never go backwards when the newest row belongs to a channel that is going.
      this.setKv("seq", this.maxSeq());
      for (const u of uris) {
        this.db.run("DELETE FROM ahp_actions WHERE channel = ?", u);
        this.db.run("DELETE FROM ahp_snapshots WHERE channel = ?", u);
        this.db.run("DELETE FROM ahp_channels WHERE uri = ?", u);
      }
    });
  }

  // ── the log ─────────────────────────────────────────────────────────────────────────────────

  /** Appends one sequenced action, and a snapshot in the same transaction when one is due. */
  append(row: ActionRow, snapshot?: unknown): void {
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO ahp_actions (server_seq, channel, at, action, origin) VALUES (?, ?, ?, ?, ?)",
        row.seq,
        row.channel,
        row.at,
        JSON.stringify(row.action),
        row.origin ? JSON.stringify(row.origin) : null,
      );
      if (snapshot !== undefined) this.snapshotNoTx(row.channel, row.seq, snapshot);
    });
  }

  private static parse(r: {
    server_seq: number;
    channel: string;
    at: number;
    action: string;
    origin: string | null;
  }): ActionRow {
    return {
      seq: r.server_seq,
      channel: r.channel,
      at: r.at,
      action: JSON.parse(r.action) as unknown,
      ...(r.origin ? { origin: JSON.parse(r.origin) as ActionRow["origin"] } : {}),
    } as ActionRow;
  }

  /** One channel's actions after `seq`, oldest first, at most `limit` of them. */
  channelActionsAfter(channel: string, seq: number, limit = -1): ActionRow[] {
    return this.db
      .all<{ server_seq: number; channel: string; at: number; action: string; origin: string | null }>(
        "SELECT * FROM ahp_actions WHERE channel = ? AND server_seq > ? ORDER BY server_seq LIMIT ?",
        channel,
        seq,
        limit,
      )
      .map(AhpStore.parse);
  }

  countChannelActionsAfter(channel: string, seq: number): number {
    const [r] = this.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ahp_actions WHERE channel = ? AND server_seq > ?",
      channel,
      seq,
    );
    return r?.n ?? 0;
  }

  // ── snapshots ───────────────────────────────────────────────────────────────────────────────

  snapshot(channel: string, seq: number, state: unknown): void {
    this.db.transaction(() => this.snapshotNoTx(channel, seq, state));
  }

  private snapshotNoTx(channel: string, seq: number, state: unknown): void {
    this.db.run(
      "INSERT OR REPLACE INTO ahp_snapshots (channel, server_seq, state) VALUES (?, ?, ?)",
      channel,
      seq,
      JSON.stringify(state),
    );
    this.db.run(
      `DELETE FROM ahp_snapshots WHERE channel = ? AND server_seq NOT IN (
         SELECT server_seq FROM ahp_snapshots WHERE channel = ? ORDER BY server_seq DESC LIMIT ?)`,
      channel,
      channel,
      SNAPSHOTS_KEPT,
    );
  }

  latestSnapshot(channel: string): { seq: number; state: unknown } | undefined {
    const [r] = this.db.all<{ server_seq: number; state: string }>(
      "SELECT server_seq, state FROM ahp_snapshots WHERE channel = ? ORDER BY server_seq DESC LIMIT 1",
      channel,
    );
    return r ? { seq: r.server_seq, state: JSON.parse(r.state) as unknown } : undefined;
  }

  /** The newest log row of each channel, for the channels that have rows. */
  lastSeqByChannel(): Map<string, number> {
    return new Map(
      this.db
        .all<{ channel: string; s: number }>(
          "SELECT channel, MAX(server_seq) AS s FROM ahp_actions GROUP BY channel",
        )
        .map((r) => [r.channel, r.s]),
    );
  }

  /** The newest snapshot seq of each channel. */
  snapshotSeqByChannel(): Map<string, number> {
    return new Map(
      this.db
        .all<{ channel: string; s: number }>(
          "SELECT channel, MAX(server_seq) AS s FROM ahp_snapshots GROUP BY channel",
        )
        .map((r) => [r.channel, r.s]),
    );
  }

  // ── pruning ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Drops log rows that a snapshot of their channel already covers, when they are older than the
   * retention time, or whatever is over the row cap (oldest first). Rows after a channel's latest
   * snapshot are never dropped: they are what a restart replays. Returns the rows removed.
   */
  prune(now: number): number {
    const covered =
      "server_seq <= COALESCE((SELECT MAX(s.server_seq) FROM ahp_snapshots s WHERE s.channel = ahp_actions.channel), 0)";
    const [total] = this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM ahp_actions");
    const over = Math.max(0, (total?.n ?? 0) - this.limits.maxActionRows);
    // The newest seq among the rows to remove: the new floor.
    const [byAge] = this.db.all<{ s: number | null }>(
      `SELECT MAX(server_seq) AS s FROM ahp_actions WHERE at < ? AND ${covered}`,
      now - this.limits.retainMs,
    );
    let removed = 0;
    let floor = this.floor();
    this.db.transaction(() => {
      // Remember the counter first: the newest row may be about to go.
      this.setKv("seq", this.maxSeq());
      if (byAge?.s != null) {
        removed +=
          this.db.run(`DELETE FROM ahp_actions WHERE at < ? AND ${covered}`, now - this.limits.retainMs)
            .changes ?? 0;
        floor = Math.max(floor, byAge.s);
      }
      if (over > 0) {
        const rows = this.db.all<{ server_seq: number }>(
          `SELECT server_seq FROM ahp_actions WHERE ${covered} ORDER BY server_seq LIMIT ?`,
          over,
        );
        const last = rows[rows.length - 1]?.server_seq;
        if (last !== undefined) {
          removed +=
            this.db.run(`DELETE FROM ahp_actions WHERE server_seq <= ? AND ${covered}`, last).changes ?? 0;
          floor = Math.max(floor, last);
        }
      }
      this.setKv("floor", floor);
    });
    return removed;
  }

  // ── content blobs ───────────────────────────────────────────────────────────────────────────

  putBlob(hash: string, mime: string, data: Uint8Array, now: number): void {
    this.db.run(
      "INSERT OR IGNORE INTO ahp_blobs (hash, mime, bytes, data, at) VALUES (?, ?, ?, ?, ?)",
      hash,
      mime,
      data.byteLength,
      data,
      now,
    );
    const [t] = this.db.all<{ n: number | null }>("SELECT SUM(bytes) AS n FROM ahp_blobs");
    let total = t?.n ?? 0;
    if (total <= this.limits.maxBlobBytes) return;
    for (const old of this.db.all<{ hash: string; bytes: number }>(
      "SELECT hash, bytes FROM ahp_blobs WHERE hash != ? ORDER BY at, rowid",
      hash,
    )) {
      if (total <= this.limits.maxBlobBytes) break;
      this.db.run("DELETE FROM ahp_blobs WHERE hash = ?", old.hash);
      total -= old.bytes;
    }
  }

  getBlob(hash: string): { mime: string; data: Uint8Array } | undefined {
    const [r] = this.db.all<{ mime: string; data: Uint8Array }>(
      "SELECT mime, data FROM ahp_blobs WHERE hash = ?",
      hash,
    );
    return r ? { mime: r.mime, data: new Uint8Array(r.data) } : undefined;
  }
}
