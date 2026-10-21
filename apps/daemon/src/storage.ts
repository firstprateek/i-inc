// Storage and cleanup (T52, contract C23): what grows, how it is bounded, and how the owner sees it.
//
// Sandbox side: a closed or failed ticket's copies in the team machines (its worktree, a reviewer's
// copy of the branch, the images) go a few days after it ends, in one script per machine that runs
// only when the machine is already up and nothing is using it (storage-script.ts). Host side: old
// transcripts are compacted, the database is vacuumed when it is mostly free pages, logs rotate and
// the daemon's own stale backups go (retention.ts). Everything is logged as one line per run, kept
// as a summary in SQLite, and shown by `GET /api/storage`.
import { statfsSync } from "node:fs";
import { join } from "node:path";
import { type Clock, type EventStore, fold, type Id } from "@i-inc/core";
import { imageLimits } from "./api.ts";
import type { Db } from "./db.ts";
import type { MachineRow } from "./machines.ts";
import type { PushService } from "./push.ts";
import type { Registry } from "./registry.ts";
import {
  checkpoint,
  compactTranscripts,
  type DbSpace,
  dbSpace,
  dirBytes,
  duBytes,
  fileBytes,
  gcRepo,
  logName,
  pruneBackups,
  type RotateResult,
  rotateLogs,
  vacuumIfNeeded,
} from "./retention.ts";
import { cleanupScript, readCleanup } from "./storage-script.ts";
import {
  defaultStorageSettings,
  readStorageSettings,
  type StorageSettings,
  storageSettings,
  storageSettingsProblem,
} from "./storage-settings.ts";
import type { Tickets } from "./tickets.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;

/** What the daemon needs from the machine provider (AppleMachines has all of it). */
export interface MachineOps {
  machineFor(employeeId: Id): string;
  listMachines(): Promise<MachineRow[]>;
  runIn(machine: string, script: string, timeoutMs?: number): Promise<string>;
  footprint?(): Record<string, number>;
}

export interface StoragePaths {
  /** ~/.i-inc: the database, its backups and the knowledge repos. */
  home: string;
  dbPath: string;
  knowledgeDir: string;
  /** ~/Library/Logs, where the launch agents write i-inc-*.log. */
  logDir?: string;
  /** Apple container's data folder, measured with `du`, never changed. */
  containerData?: string;
  /** The deployer's releases folder (T54), measured, never changed here. */
  releases?: string;
}

export interface StorageDeps {
  db: Db;
  clock: Clock;
  registry: Registry;
  tickets: Tickets;
  events: EventStore;
  paths: StoragePaths;
  /** Absent in demo mode and tests that have no machines. */
  ops?: MachineOps;
  push?: Pick<PushService, "send">;
  log?: (msg: string) => void;
  /** Whether anything is using this machine now: a session, or a ticket running there. */
  machineBusy: (machine: string) => Promise<boolean>;
  /** Whether the daemon has work going (a ticket, a conversation turn). */
  hostBusy: () => boolean;
  /** Whether a ticket is being worked on now. */
  ticketActive: (id: Id) => boolean;
  /** Entry counts of the long-lived structures, and memory, for the report. */
  footprint: () => Record<string, number>;
  /** The folder with the worktrees inside a machine. */
  work?: string;
  /** Archived conversations, with when they were archived: their working copies are cleaned like closed tickets'. */
  archivedConversations?: () => { id: Id; employeeId: Id; project: string | null; archivedAt: number }[];
  /** Ask a machine to hand freed blocks back to the host. */
  trim?: boolean;
  memory?: () => NodeJS.MemoryUsage;
  /** How long after truncating a log to wait before checking its start (default 2 s). */
  logSettleMs?: number;
}

export interface FsUsage {
  totalBytes: number;
  usedBytes: number;
  percent: number;
  measuredAt: number;
}

export interface CleanupSummary {
  at: number;
  status: "cleaned" | "failed" | "skipped";
  reason?: string;
  tickets: number;
  removedBytes: number;
  freed: Record<string, number>;
  freedBytes: number;
  kept: { ticket: Id; reason: string }[];
  trimmed: boolean;
  cacheOverBytes?: number;
}

interface MachineMemo {
  lastAttemptAt?: number;
  fs?: FsUsage;
  diskBytes?: number;
  lastCleanup?: CleanupSummary;
  freedBytesTotal?: number;
  warnedAt?: number;
}

export interface MachineStorage {
  team: string;
  machine: string;
  state: "running" | "stopped" | "missing" | "unknown";
  /** The machine's disk on the host (container machine ls), even when it is stopped. */
  diskBytes: number | null;
  /** Used and total inside the machine, when it was last measured (only a running machine can be). */
  fs: FsUsage | null;
  lastCleanup: CleanupSummary | null;
  freedBytesTotal: number;
  /** When the next cleanup can run at the earliest (epoch ms), or null if it is off. */
  nextCleanupAfter: number | null;
}

export interface MachineCleanup {
  machine: string;
  dryRun: boolean;
  status: "cleaned" | "dry-run" | "skipped" | "failed";
  reason?: string;
  removed: { ticket: Id; bytes: number }[];
  kept: { ticket: Id; reason: string }[];
  refused: { ticket: Id; reason: string }[];
  freed: Record<string, number>;
  freedBytes: number;
  fs?: FsUsage;
}

export interface HostMaintenance {
  dryRun: boolean;
  at: number;
  skipped?: string;
  transcripts: { tickets: number; sessions: number; itemsRemoved: number };
  vacuum: { ran: boolean; reason?: string; freeBytes: number; freePct: number };
  logs: RotateResult[];
  backups: { name: string; bytes: number }[];
  gc: string[];
  errors: string[];
}

export interface StorageReport {
  at: number;
  settings: StorageSettings;
  defaults: StorageSettings;
  machines: MachineStorage[];
  host: {
    freeBytes: number | null;
    db: { bytes: number; walBytes: number } & DbSpace;
    rows: {
      events: { count: number; bytes: number };
      transcripts: { sessions: number; items: number; bytes: number };
      chat: { count: number; bytes: number };
      images: { count: number; bytes: number; largestTicket: { ticket: Id; bytes: number } | null };
    };
    knowledgeBytes: number;
    logs: { bytes: number; files: number };
    backups: { count: number; bytes: number };
    containerData: { path: string; bytes: number | null } | null;
    releases: { path: string; bytes: number } | null;
    imageLimits: { perRequest: number; bytesEach: number; perTicket: number };
    lastMaintenance: HostMaintenance | null;
  };
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    uptimeSeconds: number;
    structures: Record<string, number>;
  };
}

const sizeText = (bytes: number) =>
  bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

export class Storage {
  private readonly memo = new Map<string, MachineMemo>();
  /** Machines being cleaned, with a promise that settles when each is free again. */
  private readonly locks = new Map<string, { free: Promise<void>; open: () => void }>();
  private maintaining = false;
  private lastHost: HostMaintenance | null = null;
  private lastHostAt = 0;
  private lastGcAt = 0;
  private containerSize: { at: number; bytes: number | null } | null = null;

  constructor(private readonly d: StorageDeps) {
    const saved = this.read<{ at: number; gcAt?: number; result?: HostMaintenance }>("host");
    if (saved) {
      this.lastHostAt = saved.at;
      this.lastGcAt = saved.gcAt ?? 0;
      this.lastHost = saved.result ?? null;
    }
  }

  // --- settings and the little state kept in SQLite -------------------------------------------

  settings(): StorageSettings {
    return storageSettings(this.d.registry.settings().storage);
  }

  /** Saves a partial update from the API, or says why not. */
  update(body: unknown): { settings: StorageSettings } | { error: string } {
    const read = readStorageSettings(body);
    if ("error" in read) return read;
    const merged = { ...this.d.registry.settings().storage, ...read.ok };
    const problem = storageSettingsProblem(storageSettings(merged, false));
    if (problem) return { error: problem };
    this.d.registry.setSettings({ storage: merged });
    return { settings: this.settings() };
  }

  private read<T>(key: string): T | undefined {
    const [row] = this.d.db.all<{ body: string }>("SELECT body FROM storage_state WHERE key = ?", key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.body) as T;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    this.d.db.run(
      "INSERT INTO storage_state (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body",
      key,
      JSON.stringify(value),
    );
  }

  private memoOf(machine: string): MachineMemo {
    let m = this.memo.get(machine);
    if (!m) {
      m = this.read<MachineMemo>(`machine:${machine}`) ?? {};
      this.memo.set(machine, m);
    }
    return m;
  }

  private save(machine: string): void {
    this.write(`machine:${machine}`, this.memoOf(machine));
  }

  private log(msg: string): void {
    this.d.log?.(`[storage] ${msg}`);
  }

  // --- what the daemon asks while it decides whether to stop a machine ------------------------

  machineOf(employeeId: Id): string | undefined {
    try {
      return this.d.ops?.machineFor(employeeId);
    } catch {
      return undefined;
    }
  }

  /**
   * A cleanup is running in this machine: it stays up until that ends, and the daemon makes new
   * sessions, tickets and conversation turns wait for it (`untilFree`) before they start there.
   */
  holding(machine: string): boolean {
    return this.locks.has(machine);
  }

  /** Takes a machine's lock. False if a cleanup already holds it. */
  private lock(machine: string): boolean {
    if (this.locks.has(machine)) return false;
    let open: () => void = () => {};
    const free = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.locks.set(machine, { free, open });
    return true;
  }

  private unlock(machine: string): void {
    const l = this.locks.get(machine);
    this.locks.delete(machine);
    l?.open();
  }

  /**
   * Resolves true once no cleanup holds the machine, or false after `maxMs` (the caller then says
   * why it is waiting). Work that is about to start in a machine calls this first.
   */
  async untilFree(machine: string, maxMs: number): Promise<boolean> {
    const l = this.locks.get(machine);
    if (!l) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), maxMs);
    });
    try {
      return await Promise.race([l.free.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether this machine is due a cleanup: it is on, and the last one was over an hour ago. */
  due(machine: string): boolean {
    if (!this.d.ops || this.settings().sandboxCleanupDays <= 0) return false;
    if (this.locks.has(machine)) return false;
    return this.d.clock.now() - (this.memoOf(machine).lastAttemptAt ?? 0) >= HOUR;
  }

  /** Cleans a machine in the background, then calls `done` (the daemon stops the machine after). */
  startClean(machine: string, done: () => void): void {
    // The lock is taken now, before anything else, so no new work can start in the machine.
    if (!this.lock(machine)) {
      done();
      return;
    }
    void this.cleanMachine(machine, { held: true })
      .catch((err) => this.log(`${machine}: cleanup failed: ${String(err)}`))
      .finally(() => {
        this.unlock(machine);
        done();
      });
  }

  // --- tickets that are over ---------------------------------------------------------------

  /** Tickets that closed or failed, with when, whether they merged, and the machines that held copies. */
  private async closedTickets(): Promise<
    { id: Id; endedAt: number; merged: boolean; machines: Set<string> }[]
  > {
    const out: { id: Id; endedAt: number; merged: boolean; machines: Set<string> }[] = [];
    for (const r of this.d.tickets.all()) {
      const state = fold(await this.d.events.read(r.ticket.id));
      if (state.status !== "done" && state.status !== "failed") continue;
      const endedAt = state.closedAt ?? state.lastAt;
      if (endedAt === null || this.d.ticketActive(r.ticket.id)) continue;
      const who = new Set<Id>(
        [
          r.ticket.assignee,
          state.assignee,
          state.handedFrom,
          state.prFor,
          ...state.sessions.map((s) => s.employeeId),
          ...Object.values(state.helpers),
          ...Object.keys(state.copiedUpTo),
        ].filter((x): x is Id => typeof x === "string" && x !== ""),
      );
      const machines = new Set<string>();
      for (const id of who) {
        const m = this.machineOf(id);
        if (m) machines.add(m);
      }
      out.push({ id: r.ticket.id, endedAt, merged: state.outcome === "merged", machines });
    }
    return out;
  }

  // --- a team machine --------------------------------------------------------------------------

  /**
   * Cleans one machine: its closed tickets' copies, over-cap caches and Docker's leftovers. It never
   * boots a machine and never runs while the machine is in use. Without `dryRun` or `manual`, it
   * runs at most once an hour per machine. It does not throw: the result says what happened.
   */
  async cleanMachine(
    machine: string,
    o: { dryRun?: boolean; manual?: boolean; held?: boolean } = {},
  ): Promise<MachineCleanup> {
    // Taking the lock comes first: from here until the end, nothing new starts in the machine. A dry
    // run changes nothing, so it doesn't make work wait.
    const takes = o.held !== true && o.dryRun !== true;
    if (takes && !this.lock(machine)) {
      return {
        machine,
        dryRun: false,
        status: "skipped",
        reason: "a cleanup is already running",
        removed: [],
        kept: [],
        refused: [],
        freed: {},
        freedBytes: 0,
      };
    }
    try {
      return await this.cleanLocked(machine, o);
    } finally {
      if (takes) this.unlock(machine);
    }
  }

  private async cleanLocked(
    machine: string,
    o: { dryRun?: boolean; manual?: boolean },
  ): Promise<MachineCleanup> {
    const dryRun = o.dryRun === true;
    const result: MachineCleanup = {
      machine,
      dryRun,
      status: "skipped",
      removed: [],
      kept: [],
      refused: [],
      freed: {},
      freedBytes: 0,
    };
    const skip = (reason: string): MachineCleanup => {
      result.reason = reason;
      return result;
    };
    const { ops } = this.d;
    if (!ops) return skip("this daemon has no machines");
    const settings = this.settings();
    if (settings.sandboxCleanupDays <= 0 && !o.manual) return skip("sandbox cleanup is off");
    const now = this.d.clock.now();
    const memo = this.memoOf(machine);
    if (!o.manual && !dryRun && now - (memo.lastAttemptAt ?? 0) < HOUR)
      return skip("cleaned less than an hour ago");
    if (!dryRun) {
      memo.lastAttemptAt = now;
      this.save(machine);
    }
    try {
      const row = (await ops.listMachines()).find((m) => m.name === machine);
      if (row?.diskBytes !== undefined) memo.diskBytes = row.diskBytes;
      if (row?.state !== "running") return skip("the machine isn't running (cleaning never starts one)");
      if (await this.d.machineBusy(machine)) return skip("the machine is in use");

      const cutoff = now - settings.sandboxCleanupDays * DAY;
      const unpushedCutoff = now - settings.unpushedKeepDays * DAY;
      // The ticket list is read now, after the lock is held, and the machine's use is checked once
      // more right before the script (the delete step) goes in.
      const mine = (await this.closedTickets()).filter(
        (t) => t.machines.has(machine) && (settings.sandboxCleanupDays > 0 ? t.endedAt <= cutoff : false),
      );
      if (await this.d.machineBusy(machine)) return skip("the machine came into use");
      // Archived conversations are cleaned like closed tickets: past the same retention, with the same
      // fail-safe rules, and unpushed work kept for unpushedKeepDays.
      const convs =
        settings.sandboxCleanupDays > 0
          ? (this.d.archivedConversations?.() ?? []).filter(
              (c) => c.archivedAt <= cutoff && this.machineOf(c.employeeId) === machine,
            )
          : [];
      const script = cleanupScript({
        work: this.d.work ?? "/home/employee/work",
        ids: mine.map((t) => t.id),
        aged: mine.filter((t) => t.endedAt <= unpushedCutoff).map((t) => t.id),
        merged: mine.filter((t) => t.merged).map((t) => t.id),
        convs: convs.map((c) => c.id),
        convsAged: convs.filter((c) => c.archivedAt <= unpushedCutoff).map((c) => c.id),
        convsScratch: convs.filter((c) => c.project === null).map((c) => c.id),
        dryRun,
        cacheCapKb: settings.cacheCapGb * 1024 * 1024,
        docker: settings.dockerPrune,
        trim: this.d.trim ?? true,
      });
      const report = readCleanup(await ops.runIn(machine, script));
      if (!report.done) {
        result.status = "failed";
        return skip("the cleanup script didn't finish");
      }
      Object.assign(result, {
        status: dryRun ? "dry-run" : "cleaned",
        removed: report.removed,
        kept: report.kept,
        refused: report.refused,
        freed: report.freed,
        freedBytes: Object.values(report.freed).reduce((a, b) => a + b, 0),
      });
      const after = report.diskAfter ?? report.disk;
      if (after && after.total > 0) {
        result.fs = {
          totalBytes: after.total,
          usedBytes: after.used,
          percent: Math.round((after.used / after.total) * 100),
          measuredAt: now,
        };
        memo.fs = result.fs;
      }
      if (!dryRun) {
        const summary: CleanupSummary = {
          at: now,
          status: "cleaned",
          tickets: new Set(report.removed.map((r) => r.ticket)).size,
          removedBytes: report.removed.reduce((a, r) => a + r.bytes, 0),
          freed: report.freed,
          freedBytes: result.freedBytes,
          kept: report.kept,
          trimmed: report.trimmed,
          ...(report.cacheOver ? { cacheOverBytes: report.cacheOver } : {}),
        };
        memo.lastCleanup = summary;
        memo.freedBytesTotal = (memo.freedBytesTotal ?? 0) + result.freedBytes;
        this.log(this.summaryLine(machine, summary, result.fs, report.failed.length));
        await this.warnIfFull(machine, result.fs);
      }
      return result;
    } catch (err) {
      result.status = "failed";
      result.reason = String(err instanceof Error ? err.message : err);
      if (!dryRun) {
        memo.lastCleanup = {
          at: now,
          status: "failed",
          reason: result.reason,
          tickets: 0,
          removedBytes: 0,
          freed: {},
          freedBytes: 0,
          kept: [],
          trimmed: false,
        };
        this.log(`${machine}: cleanup failed: ${result.reason}`);
      }
      return result;
    } finally {
      if (!dryRun) this.save(machine);
    }
  }

  private summaryLine(machine: string, s: CleanupSummary, fs: FsUsage | undefined, failed: number): string {
    const parts = Object.entries(s.freed)
      .map(([k, v]) => `${k} ${sizeText(v)}`)
      .join(", ");
    return [
      `${machine}: freed ${sizeText(s.freedBytes)}${parts ? ` (${parts})` : ""}`,
      `from ${s.tickets} closed ticket${s.tickets === 1 ? "" : "s"}`,
      s.kept.length ? `kept ${s.kept.length} (${[...new Set(s.kept.map((k) => k.reason))].join(", ")})` : "",
      failed ? `couldn't remove ${failed}` : "",
      s.cacheOverBytes ? `a cache is still ${sizeText(s.cacheOverBytes)}` : "",
      fs ? `disk ${fs.percent}% of ${sizeText(fs.totalBytes)}` : "",
    ]
      .filter(Boolean)
      .join("; ");
  }

  /** One push when a machine's disk passes the warning level, and again no sooner than a day later. */
  private async warnIfFull(machine: string, fs: FsUsage | undefined): Promise<void> {
    if (!fs) return;
    const memo = this.memoOf(machine);
    const limit = this.settings().diskWarnPct;
    if (fs.percent < limit - 10) delete memo.warnedAt;
    if (fs.percent < limit) return;
    const now = this.d.clock.now();
    if (memo.warnedAt !== undefined && now - memo.warnedAt < DAY) return;
    memo.warnedAt = now;
    const team = machine.replace(/^inc-/, "");
    this.log(`${machine}: disk is ${fs.percent}% full`);
    try {
      await this.d.push?.send({
        title: `Sandbox ${team} is ${fs.percent}% full`,
        body: `${sizeText(fs.usedBytes)} of ${sizeText(fs.totalBytes)} used. Cleanup runs about once an hour; see Setup, Sandboxes.`,
        url: "#/setup/sandboxes",
      });
    } catch (err) {
      this.log(`couldn't push the ${machine} disk warning: ${String(err)}`);
    }
  }

  // --- the host ----------------------------------------------------------------------------------

  /**
   * Trims what the host keeps. It runs at most once an hour unless asked (`manual`), and with
   * `dryRun` it only reports. The VACUUM waits for an idle daemon.
   */
  async maintainHost(o: { dryRun?: boolean; manual?: boolean } = {}): Promise<HostMaintenance> {
    const dryRun = o.dryRun === true;
    const now = this.d.clock.now();
    const out: HostMaintenance = {
      dryRun,
      at: now,
      transcripts: { tickets: 0, sessions: 0, itemsRemoved: 0 },
      vacuum: { ran: false, freeBytes: 0, freePct: 0 },
      logs: [],
      backups: [],
      gc: [],
      errors: [],
    };
    if (this.maintaining) return { ...out, skipped: "already running" };
    if (!o.manual && !dryRun && now - this.lastHostAt < HOUR)
      return { ...out, skipped: "ran less than an hour ago" };
    this.maintaining = true;
    const settings = this.settings();
    const step = async (name: string, fn: () => void | Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        out.errors.push(`${name}: ${String(err instanceof Error ? err.message : err)}`);
      }
    };
    try {
      await step("transcripts", async () => {
        if (settings.transcriptCompactDays <= 0) return;
        const cutoff = now - settings.transcriptCompactDays * DAY;
        const old = (await this.closedTickets()).filter((t) => t.endedAt <= cutoff).map((t) => t.id);
        const r = compactTranscripts(this.d.db, old, settings.transcriptKeepItems, now, dryRun);
        out.transcripts = { tickets: old.length, sessions: r.sessions, itemsRemoved: r.itemsRemoved };
      });
      await step("vacuum", () => {
        const r = vacuumIfNeeded(this.d.db, {
          freePct: settings.vacuumFreePct,
          minFreeBytes: 16 * 1024 ** 2,
          idle: !this.d.hostBusy(),
          dryRun,
        });
        out.vacuum = {
          ran: r.ran,
          freeBytes: r.space.freeBytes,
          freePct: r.space.freePct,
          ...(r.reason ? { reason: r.reason } : {}),
        };
        if (!dryRun && !r.ran && !this.d.hostBusy()) checkpoint(this.d.db);
      });
      await step("logs", async () => {
        if (!this.d.paths.logDir) return;
        out.logs = await rotateLogs(this.d.paths.logDir, {
          maxBytes: settings.logMaxMb * 1024 ** 2,
          keep: settings.logKeep,
          dryRun,
          ...(this.d.logSettleMs !== undefined ? { settleMs: this.d.logSettleMs } : {}),
        });
        for (const l of out.logs.filter((x) => x.nulAtStart)) {
          this.log(
            `warning: ${l.file} begins with NUL bytes after rotating, so its writer doesn't append; switch the daemon to its own log writer (O_APPEND) rather than rotating by truncation`,
          );
        }
      });
      await step("backups", async () => {
        if (settings.backupMaxAgeDays <= 0) return;
        const r = await pruneBackups(this.d.paths.home, {
          maxAgeDays: settings.backupMaxAgeDays,
          now,
          dryRun,
        });
        out.backups = r.deleted;
      });
      await step("knowledge", async () => {
        if (dryRun || now - this.lastGcAt < 7 * DAY) return;
        for (const dir of await this.knowledgeRepos()) {
          await gcRepo(dir).catch((err) => out.errors.push(`git gc ${dir}: ${String(err)}`));
          out.gc.push(dir);
        }
        this.lastGcAt = now;
      });
    } finally {
      this.maintaining = false;
    }
    if (!dryRun) {
      this.lastHostAt = now;
      this.lastHost = out;
      this.write("host", { at: now, gcAt: this.lastGcAt, result: out });
      const bits = [
        out.transcripts.itemsRemoved ? `compacted ${out.transcripts.itemsRemoved} transcript items` : "",
        out.vacuum.ran ? "vacuumed the database" : "",
        out.logs.length ? `rotated ${out.logs.map((l) => l.file).join(", ")}` : "",
        out.backups.length ? `deleted ${out.backups.length} old backups` : "",
        out.gc.length ? `packed ${out.gc.length} knowledge repos` : "",
        out.errors.length ? `${out.errors.length} errors: ${out.errors.join("; ")}` : "",
      ].filter(Boolean);
      this.log(`host: ${bits.join("; ") || "nothing to trim"}`);
    }
    return out;
  }

  private async knowledgeRepos(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const root = this.d.paths.knowledgeDir;
    const dirs = [join(root, "handbook")];
    try {
      for (const e of await readdir(join(root, "brains"), { withFileTypes: true })) {
        if (e.isDirectory()) dirs.push(join(root, "brains", e.name));
      }
    } catch {
      // no brains yet
    }
    return dirs;
  }

  /** The periodic pass main.ts runs: the host, then any machine that is up and idle and due. */
  async maintain(): Promise<void> {
    await this.maintainHost().catch((err) => this.log(`host maintenance failed: ${String(err)}`));
    const { ops } = this.d;
    if (!ops) return;
    let rows: MachineRow[];
    try {
      rows = await ops.listMachines();
    } catch {
      return;
    }
    for (const row of rows) {
      if (row.diskBytes !== undefined) {
        this.memoOf(row.name).diskBytes = row.diskBytes;
        this.save(row.name);
      }
      if (row.state === "running" && this.due(row.name)) await this.cleanMachine(row.name);
    }
  }

  /** `POST /api/storage/cleanup`: the same work, now, for every machine that is up and for the host. */
  async cleanupNow(o: {
    dryRun: boolean;
  }): Promise<{ dryRun: boolean; machines: MachineCleanup[]; host: HostMaintenance }> {
    const machines: MachineCleanup[] = [];
    if (this.d.ops) {
      let rows: MachineRow[] = [];
      try {
        rows = await this.d.ops.listMachines();
      } catch (err) {
        this.log(`couldn't list the machines: ${String(err)}`);
      }
      for (const row of rows) {
        machines.push(await this.cleanMachine(row.name, { dryRun: o.dryRun, manual: true }));
      }
    }
    const host = await this.maintainHost({ dryRun: o.dryRun, manual: true });
    return { dryRun: o.dryRun, machines, host };
  }

  // --- the report -----------------------------------------------------------------------------

  async report(): Promise<StorageReport> {
    const now = this.d.clock.now();
    const settings = this.settings();
    const { paths } = this.d;

    let rows: MachineRow[] = [];
    try {
      rows = (await this.d.ops?.listMachines()) ?? [];
    } catch {
      rows = [];
    }
    const teams = new Set<string>([...this.d.registry.teams().map((t) => t.id)]);
    for (const row of rows) teams.add(row.name.replace(/^inc-/, ""));
    const machines: MachineStorage[] = [];
    for (const team of [...teams].sort()) {
      const machine = `inc-${team}`;
      const row = rows.find((r) => r.name === machine);
      const memo = this.memoOf(machine);
      const diskBytes = row?.diskBytes ?? memo.diskBytes ?? null;
      machines.push({
        team,
        machine,
        state: row
          ? row.state === "running" || row.state === "stopped"
            ? row.state
            : "unknown"
          : this.d.ops
            ? "missing"
            : "unknown",
        diskBytes,
        fs: memo.fs ?? null,
        lastCleanup: memo.lastCleanup ?? null,
        freedBytesTotal: memo.freedBytesTotal ?? 0,
        nextCleanupAfter: settings.sandboxCleanupDays > 0 ? (memo.lastAttemptAt ?? 0) + HOUR : null,
      });
    }

    const one = <T extends Record<string, unknown>>(sql: string): T => this.d.db.all<T>(sql)[0] ?? ({} as T);
    const num = (v: unknown) => Number(v ?? 0);
    const events = one("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS b FROM events");
    const items = one(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(text, '')) + LENGTH(COALESCE(title, '')) + LENGTH(COALESCE(status, ''))), 0) AS b FROM ticket_session_items",
    );
    const sessions = one("SELECT COUNT(*) AS n FROM ticket_sessions");
    const chat = one("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS b FROM chat");
    const images = one("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM ticket_attachments");
    const largest = one(
      "SELECT ticket_id AS t, SUM(size) AS b FROM ticket_attachments GROUP BY ticket_id ORDER BY b DESC LIMIT 1",
    );

    const logs = await this.logSizes();
    const backups = await pruneBackups(paths.home, { maxAgeDays: 0, now, dryRun: true });
    const backupBytes = await this.backupBytes();
    let free: number | null = null;
    try {
      const st = statfsSync(paths.home);
      free = Number(st.bavail) * Number(st.bsize);
    } catch {
      free = null;
    }

    const mem = (this.d.memory ?? process.memoryUsage)();
    return {
      at: now,
      settings,
      defaults: defaultStorageSettings,
      machines,
      host: {
        freeBytes: free,
        db: {
          bytes: await fileBytes(paths.dbPath),
          walBytes: (await fileBytes(`${paths.dbPath}-wal`)) + (await fileBytes(`${paths.dbPath}-shm`)),
          ...dbSpace(this.d.db),
        },
        rows: {
          events: { count: num(events.n), bytes: num(events.b) },
          transcripts: { sessions: num(sessions.n), items: num(items.n), bytes: num(items.b) },
          chat: { count: num(chat.n), bytes: num(chat.b) },
          images: {
            count: num(images.n),
            bytes: num(images.b),
            largestTicket:
              largest.t !== undefined ? { ticket: String(largest.t), bytes: num(largest.b) } : null,
          },
        },
        knowledgeBytes: await dirBytes(paths.knowledgeDir),
        logs,
        backups: { count: backups.kept, bytes: backupBytes },
        containerData: await this.containerData(),
        releases: paths.releases ? { path: paths.releases, bytes: await dirBytes(paths.releases) } : null,
        imageLimits: {
          perRequest: imageLimits.count,
          bytesEach: imageLimits.bytes,
          perTicket: imageLimits.perTicket,
        },
        lastMaintenance: this.lastHost,
      },
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
        uptimeSeconds: Math.round(process.uptime()),
        structures: { ...this.d.footprint(), ...this.footprint() },
      },
    };
  }

  /** Entry counts of this class's own maps. */
  footprint(): Record<string, number> {
    return { storageMachines: this.memo.size, storageLocks: this.locks.size };
  }

  private async logSizes(): Promise<{ bytes: number; files: number }> {
    const dir = this.d.paths.logDir;
    if (!dir) return { bytes: 0, files: 0 };
    const { readdir } = await import("node:fs/promises");
    let bytes = 0;
    let files = 0;
    try {
      for (const name of await readdir(dir)) {
        if (!logName.test(name.replace(/\.\d+\.gz$/, ""))) continue;
        bytes += await fileBytes(join(dir, name));
        files++;
      }
    } catch {
      // no log folder
    }
    return { bytes, files };
  }

  private async backupBytes(): Promise<number> {
    const { readdir } = await import("node:fs/promises");
    const { backupName } = await import("./retention.ts");
    let bytes = 0;
    try {
      for (const name of await readdir(this.d.paths.home)) {
        if (backupName.test(name)) bytes += await fileBytes(join(this.d.paths.home, name));
      }
    } catch {
      // no folder
    }
    return bytes;
  }

  private async containerData(): Promise<{ path: string; bytes: number | null } | null> {
    const path = this.d.paths.containerData;
    if (!path) return null;
    const now = this.d.clock.now();
    if (!this.containerSize || now - this.containerSize.at > 10 * 60_000) {
      this.containerSize = { at: now, bytes: await duBytes(path) };
    }
    return { path, bytes: this.containerSize.bytes };
  }
}
