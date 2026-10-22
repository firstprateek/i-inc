// How the brain reaches agents (docs/design/brain.md, "Reading"; contract C19). Three jobs:
//
//   1. the COPY: before a session starts, the readable scopes of the employee go into the sandbox as
//      files (brain-snapshot.ts), incrementally, and a refresh keeps the agent's own edits;
//   2. the PROMPT: the maps of those scopes, and the pages that match the task, fitted to a budget,
//      as text for a ticket brief or a conversation turn;
//   3. the RECORD: which pages went into which session or turn, and which the agent then opened, so
//      the app can show them and the pages' `use_count` and `last_used_at` mean something.
//
// Who may see what is decided in exactly one place, `readable()`: the scopes `readableScopes` gives
// for that employee. Nothing else ever picks a scope, so another employee's brain can't get in.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type BrainUse,
  brainHome,
  buildMap,
  conversationQuery,
  fitMaps,
  isHomeEmployee,
  isSafeSnapshotPath,
  type PromptMap,
  pageOfPath,
  type RetrievedPage,
  readableScopes,
  renderBrainPrompt,
  repoOfScope,
  retrieve,
  type Scope,
  scopeDir,
  scopeOfPath,
  snapshotPath,
  type TicketQueryInput,
  ticketQuery,
  usesOf,
} from "@i-inc/core";
import type { BrainIndex } from "./brain-index.ts";
import {
  applyScript,
  changedFiles,
  commandPath,
  gitBlobSha,
  parseApply,
  removeScript,
  type Snapshot,
  type SnapshotFile,
  snapshotId,
  verifyScript,
} from "./brain-snapshot.ts";
import type { Db } from "./db.ts";
import type { RunScript } from "./harness.ts";
import type { KnowledgeStore, Repo } from "./knowledge.ts";
import type { Registry } from "./registry.ts";

const commandSource = readFileSync(new URL("./brain-cli.cjs", import.meta.url));

export interface BrainFeedOptions {
  index: BrainIndex;
  store: KnowledgeStore;
  registry: Registry;
  db: Db;
  now: () => number;
  log?: (msg: string) => void;
  /** Where copies live in a sandbox. Default /home/employee/brain; tests point it at a folder. */
  home?: string;
  /** A page bigger than this is left out of a copy. Default 256 KB. */
  maxFileBytes?: number;
  /** All the pages of one copy. Default 16 MB. */
  maxBytes?: number;
  /** Give up on a script in a sandbox after this long. Default 3 minutes. */
  runTimeoutMs?: number;
  /** A copy known to be in a sandbox is checked at most this often. Default 5 minutes. */
  verifyEveryMs?: number;
}

export interface BrainContext {
  /** The text for the end of a brief or a turn; empty when there is nothing to say. */
  text: string;
  /** Pages put in the prompt. */
  pages: BrainUse[];
  /** The copy is in the sandbox (the prompt tells the agent where; otherwise it says it is missing). */
  copy: boolean;
  /** The maps were part of the text. */
  maps: boolean;
}

export interface SyncReport {
  ok: boolean;
  /** What was done: nothing needed, a delta, a whole copy. */
  how: "current" | "delta" | "full" | "failed" | "skipped";
  id?: string;
  sent?: number;
  /** Files whose local edits were kept instead of replaced. */
  kept: string[];
  /** The `brain search` command works in that sandbox (false when its Node can't do SQLite FTS5). */
  search?: boolean;
  detail?: string;
}

/** What a machine's copy holds, as far as the daemon knows. */
interface Delivered {
  snap: Snapshot;
  verifiedAt: number;
  /** Files whose local edits were kept: they are offered again by the next copy. */
  pending: string[];
  /** `brain search` works in that sandbox. */
  search: boolean;
}

interface Built {
  /** The state of the repos it was built from. */
  key: string;
  snap: Snapshot;
  /** Where each tracked page's blob lives, and the text of generated files. */
  source: Map<string, { repo: Repo; sha: string } | { data: Buffer }>;
  /** The slugs that really are in the copy, by scope: a page left out (too big, odd name, copy full) is in no map. */
  included: Map<Scope, Set<string>>;
  /** Scopes where some page was left out. */
  trimmed: Set<Scope>;
}

export const scopeLabel = (scope: Scope, registry?: Registry): string => {
  if (scope === "company") return "Company handbook";
  if (scope.startsWith("team:")) {
    const id = scope.slice(5);
    return `Team ${registry?.teams().find((t) => t.id === id)?.name ?? id}`;
  }
  return "Your own brain";
};

const repoKey = (r: Repo) => (r.kind === "handbook" ? "handbook" : `brain:${r.id}`);
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export class BrainFeed {
  /** Whether a machine is running now (`machine ls`). Absent: every machine is taken to be. */
  isUp: ((machine: string) => Promise<boolean>) | undefined;
  private readonly upSeen = new Map<string, { up: boolean; at: number }>();

  /** Runs a script in an employee's sandbox. Absent in demo mode and in tests without a machine: then nothing is added to prompts. */
  deliver: RunScript | undefined;

  private readonly built = new Map<string, Built>();
  private readonly delivered = new Map<string, Delivered>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly seenReads = new Map<string, true>();
  private readonly trees = new Map<string, { head: string; tree: Map<string, string> }>();
  private readonly cleaned = new Set<string>();
  private readonly keptLogged = new Map<string, string>();
  private readonly removeWarned = new Set<string>();
  private reconciledAt = Number.NEGATIVE_INFINITY;
  private reconciling: Promise<void> | undefined;
  private reconcileAgain = false;

  constructor(private readonly o: BrainFeedOptions) {}

  get enabled(): boolean {
    return this.deliver !== undefined;
  }
  get home(): string | undefined {
    return this.o.home;
  }
  private log(m: string): void {
    this.o.log?.(`brain: ${m}`);
  }
  private get index(): BrainIndex {
    return this.o.index;
  }

  /** The machine an employee's copy is in: their team's sandbox. */
  private machineOf(employeeId: string): string {
    return `inc-${this.o.registry.teamOf(employeeId).id}`;
  }
  private rootOf(copy: string): string {
    return `${this.o.home ?? "/home/employee/brain"}/${copy}`;
  }

  /**
   * Which copy a session uses. Everyone has one, at `<home>/<employee>/`. A PA has a second,
   * `<home>/<employee>.code/` (employee ids have no dots), without its own brain, for work that goes to
   * a repository: an errand and a code session running side by side never share a folder, so neither
   * can take files out from under the other, and the code session never has the home data in reach.
   */
  copyId(employeeId: string, allowHome = true): string {
    return !allowHome && this.isHome(employeeId) ? `${employeeId}.code` : employeeId;
  }

  /** The daemon started (or checked) this employee's machine: forget any "it is down" it saw before. */
  noteMachineUp(employeeId: string): void {
    this.upSeen.delete(this.machineOf(employeeId));
  }

  /** Is the machine running? A copy is never made, or taken out, by starting a machine for it. */
  private async machineIsUp(machine: string): Promise<boolean> {
    if (!this.isUp) return true;
    const seen = this.upSeen.get(machine);
    if (seen && performance.now() - seen.at < 20_000) return seen.up;
    let up = false;
    try {
      up = await this.isUp(machine);
    } catch {
      up = false;
    }
    this.upSeen.set(machine, { up, at: performance.now() });
    return up;
  }

  /** Does this employee work on home data (a PA)? */
  private isHome(employeeId: string): boolean {
    try {
      return isHomeEmployee(this.o.registry.employee(employeeId));
    } catch {
      return false;
    }
  }

  /**
   * The scopes this employee may read, nearest first, that have any pages. The only place scopes are
   * chosen. A PA's own brain holds home data: it is part of a session only when `allowHome` (an errand,
   * orientation, or a conversation with no project, whose answers stay in the chat), never in a session
   * whose work goes to a repository.
   */
  readable(employeeId: string, allowHome = true): Scope[] {
    const all = readableScopes({ id: employeeId }, this.o.registry.teams());
    const have = new Set(this.index.scopes());
    const homeBlocked = !allowHome && this.isHome(employeeId);
    return all.filter((s) => have.has(s) && !(homeBlocked && s === `brain:${employeeId}`));
  }

  // ---- The copy ------------------------------------------------------------------------------------

  private tree(repo: Repo): Map<string, string> {
    const head = this.o.store.head(repo)?.sha ?? "";
    const k = repoKey(repo);
    const cached = this.trees.get(k);
    if (cached && cached.head === head) return cached.tree;
    const tree = this.o.store.tree(repo);
    this.trees.set(k, { head, tree });
    return tree;
  }

  /** The files an employee's copy holds right now, with their ids. Cached until a repo changes. */
  build(employeeId: string, allowHome = true): Built {
    const scopes = this.readable(employeeId, allowHome);
    const repos = new Map<string, Repo>();
    for (const s of scopes) {
      const r = repoOfScope(s);
      if (r) repos.set(repoKey(r), r);
    }
    const key = `${[...repos.values()].map((r) => `${repoKey(r)}@${this.o.store.head(r)?.sha ?? ""}`).join(",")}|${scopes.join(",")}|${hash(commandSource.toString("utf8"))}`;
    const cached = this.built.get(this.copyId(employeeId, allowHome));
    if (cached && cached.key === key) return cached;

    const files = new Map<string, SnapshotFile>();
    const source: Built["source"] = new Map();
    const skipped: string[] = [];
    const dirs: Record<string, string> = {};
    const included = new Map<Scope, Set<string>>();
    const trimmed = new Set<Scope>();
    const maxFile = this.o.maxFileBytes ?? 256 * 1024;
    let bytes = 0;
    const cap = this.o.maxBytes ?? 16 * 1024 * 1024;

    for (const scope of scopes) {
      const repo = repoOfScope(scope);
      const dir = scopeDir(scope);
      if (!repo || !dir) continue;
      dirs[scope] = dir;
      const here = new Set<string>();
      included.set(scope, here);
      const entries: { path: string; sha: string; slug: string }[] = [];
      for (const [path, sha] of this.tree(repo)) {
        const at = scopeOfPath(repo, path);
        if (!at || at.scope !== scope) continue;
        const rel = snapshotPath(scope, at.slug);
        if (!rel) {
          skipped.push(`${scope}:${at.slug} (name)`);
          trimmed.add(scope);
          continue;
        }
        entries.push({ path: rel, sha, slug: at.slug });
      }
      const sizes = this.o.store.blobSizes(repo, [...new Set(entries.map((e) => e.sha))]);
      entries.sort((a, b) => (a.path < b.path ? -1 : 1));
      for (const e of entries) {
        const size = sizes.get(e.sha) ?? 0;
        if (size > maxFile) {
          skipped.push(`${scope}:${e.slug} (${Math.round(size / 1024)} KB)`);
          trimmed.add(scope);
          continue;
        }
        if (bytes + size > cap) {
          skipped.push(`${scope}:${e.slug} (copy full)`);
          trimmed.add(scope);
          continue;
        }
        bytes += size;
        files.set(e.path, { path: e.path, sha: e.sha, tracked: true });
        source.set(e.path, { repo, sha: e.sha });
        here.add(e.slug);
      }
      // The scope's whole map, as a file (the prompt gets the same map cut to about 150 lines).
      const map = buildMap(
        this.index
          .pages([scope])
          .filter((p) => here.has(p.slug))
          .map((p) => ({ slug: p.slug, title: p.title, description: p.description })),
        1_000_000,
      );
      const text = Buffer.from(
        [
          `# ${scopeLabel(scope, this.o.registry)} · map`,
          "",
          `One line per page in this folder: \`[[slug]]\` is the file \`${dir}/<slug>.md\`. Search all of your copy with \`.bin/brain search "<words>"\`.`,
          "",
          ...map.root,
          "",
        ].join("\n"),
      );
      const mapPath = `${dir}/INDEX.md`;
      files.set(mapPath, { path: mapPath, sha: gitBlobSha(text), tracked: true });
      source.set(mapPath, { data: text });
    }
    files.set(commandPath, { path: commandPath, sha: gitBlobSha(commandSource), tracked: false });
    source.set(commandPath, { data: commandSource });
    for (const f of files.keys()) {
      if (f !== commandPath && !isSafeSnapshotPath(f)) throw new Error(`unsafe path in a copy: ${f}`);
    }
    if (skipped.length)
      this.log(
        `${employeeId}'s copy leaves out ${skipped.length} page(s): ${skipped.slice(0, 5).join(", ")}`,
      );
    const snap: Snapshot = { id: snapshotId(files.values()), employeeId, files, dirs, skipped, bytes };
    const b: Built = { key, snap, source, included, trimmed };
    this.built.set(this.copyId(employeeId, allowHome), b);
    return b;
  }

  /** The bytes of these files of a built snapshot. */
  private contents(b: Built, paths: string[]): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    const byRepo = new Map<string, { repo: Repo; shas: Map<string, string[]> }>();
    for (const p of paths) {
      const s = b.source.get(p);
      if (!s) continue;
      if ("data" in s) out.set(p, s.data);
      else {
        const g = byRepo.get(repoKey(s.repo)) ?? { repo: s.repo, shas: new Map() };
        g.shas.set(s.sha, [...(g.shas.get(s.sha) ?? []), p]);
        byRepo.set(repoKey(s.repo), g);
      }
    }
    for (const g of byRepo.values()) {
      const texts = this.o.store.blobs(g.repo, [...g.shas.keys()]);
      for (const [sha, ps] of g.shas) {
        const t = texts.get(sha);
        if (t !== undefined) for (const p of ps) out.set(p, Buffer.from(t, "utf8"));
      }
    }
    return out;
  }

  private run(
    employeeId: string,
    script: string,
    machine?: string,
  ): Promise<{ code: number; output: string }> {
    const deliver = this.deliver;
    if (!deliver) return Promise.reject(new Error("no sandbox to copy into"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("copying the brain took too long")),
        this.o.runTimeoutMs ?? 180_000,
      );
      timer.unref?.();
    });
    return Promise.race([deliver(employeeId, script, {}, machine ? { machine } : {}), limit]).finally(() =>
      clearTimeout(timer),
    );
  }

  private lastDelivered(key: string, employeeId: string, copy: string): Delivered | undefined {
    const mem = this.delivered.get(key);
    if (mem) return mem;
    const [row] = this.o.db.all<{ snapshot_id: string; files: string; pending: string }>(
      "SELECT snapshot_id, files, pending FROM brain_synced WHERE machine = ? AND employee_id = ?",
      this.machineOf(employeeId),
      copy,
    );
    if (!row) return undefined;
    try {
      const files = new Map<string, SnapshotFile>(
        Object.entries(JSON.parse(row.files) as Record<string, [string, number]>).map(([path, [sha, t]]) => [
          path,
          { path, sha, tracked: t === 1 },
        ]),
      );
      // Believed, not trusted: a delta is applied only if the sandbox says it holds this id.
      return {
        snap: { id: row.snapshot_id, employeeId, files, dirs: {}, skipped: [], bytes: 0 },
        verifiedAt: 0,
        pending: JSON.parse(row.pending) as string[],
        search: true,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Brings the employee's copy in their sandbox up to date. Sends only what changed since the copy the
   * sandbox was last given; falls back to a whole copy when the sandbox doesn't hold what we believe.
   * Calls for one employee run one at a time. Never throws: a failure is reported, and the session
   * goes on without the files. A PA gets no copy while anyone else works in its sandbox.
   */
  async sync(employeeId: string, allowHome = true): Promise<SyncReport> {
    const copy = this.copyId(employeeId, allowHome);
    const key = `${this.machineOf(employeeId)}:${copy}`;
    const prior = this.locks.get(key) ?? Promise.resolve();
    const mine = prior.then(
      () => this.syncNow(employeeId, copy, key, allowHome),
      () => this.syncNow(employeeId, copy, key, allowHome),
    );
    this.locks.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.locks.get(key) === mine) this.locks.delete(key);
    }
  }

  private async syncNow(
    employeeId: string,
    copy: string,
    key: string,
    allowHome: boolean,
  ): Promise<SyncReport> {
    try {
      const machine = this.machineOf(employeeId);
      // Copies in machines their employees no longer work in go first.
      if (performance.now() - this.reconciledAt > 60_000) await this.reconcile();
      // A PA's brain is home data: never into a sandbox (one Unix user, open internet) that anyone else
      // works in. Its prompts still get its pages; and a copy that may already be there goes, once.
      if (this.isHome(employeeId) && this.o.registry.machineMates(employeeId).length > 0) {
        // Both of its copies go, once each (and again later if the machine was down).
        for (const id of [employeeId, `${employeeId}.code`]) {
          if (this.cleaned.has(`${machine}:${id}`)) continue;
          if (await this.removeCopy(id, machine)) this.cleaned.add(`${machine}:${id}`);
        }
        return {
          ok: false,
          how: "skipped",
          kept: [],
          detail: `${employeeId} works on home data and shares ${machine} with others, so nothing is copied there`,
        };
      }
      // A stopped machine is not started for a copy; the session that follows will have started it.
      if (!(await this.machineIsUp(machine))) {
        return {
          ok: false,
          how: "skipped",
          kept: [],
          detail: `${machine} isn't running, so nothing is copied`,
        };
      }
      this.index.refresh();
      const b = this.build(employeeId, allowHome);
      const root = this.rootOf(copy);
      const last = this.lastDelivered(key, employeeId, copy);
      const now = this.o.now();

      if (last && last.snap.id === b.snap.id && last.pending.length === 0) {
        if (now - last.verifiedAt < (this.o.verifyEveryMs ?? 5 * 60_000)) {
          return { ok: true, how: "current", id: b.snap.id, kept: [], search: last.search };
        }
        const v = parseApply(...(await this.verify(employeeId, root, b.snap.id)));
        if (v.kind === "current") {
          this.delivered.set(key, { ...last, verifiedAt: now });
          return { ok: true, how: "current", id: b.snap.id, kept: [], search: last.search };
        }
      }

      const send = async (base: string | undefined, paths: string[]) => {
        const script = applyScript({
          root,
          next: b.snap,
          ...(base !== undefined ? { base } : {}),
          contents: this.contents(b, paths),
          meta: { version: 1, employee: employeeId, at: now, dirs: b.snap.dirs },
          at: now,
        });
        const r = await this.run(employeeId, script);
        return parseApply(r.code, r.output);
      };

      let how: SyncReport["how"] = "full";
      let sent = b.snap.files.size;
      let result: ReturnType<typeof parseApply> | undefined;
      if (last) {
        const paths = changedFiles(b.snap, last.snap);
        result = await send(last.snap.id, paths);
        if (result.kind !== "need-full") {
          how = "delta";
          sent = paths.length;
        }
      }
      if (!result || result.kind === "need-full") result = await send(undefined, [...b.snap.files.keys()]);

      if (result.kind !== "synced") {
        const detail = result.detail ?? result.kind;
        this.log(`couldn't copy ${employeeId}'s brain into ${machine}: ${detail}`);
        return { ok: false, how: "failed", kept: result.kept, detail };
      }
      if (!result.search && (last?.search ?? true)) {
        this.log(
          `${machine} has no usable Node with SQLite FTS5, so \`brain search\` won't work for ${employeeId}; the files are copied and the maps work`,
        );
      }
      // What the sandbox holds: the new snapshot, except the files whose local edits were kept. Those
      // stay as they were last delivered (or absent), so the next copy offers them again, and a copy
      // is never taken for "current" while any are pending.
      const kept = new Set(result.kept);
      const files = new Map(b.snap.files);
      for (const p of kept) {
        const before = last?.snap.files.get(p);
        if (before) files.set(p, before);
        else files.delete(p);
      }
      const delivered: Delivered = {
        snap: { ...b.snap, files },
        verifiedAt: now,
        pending: [...kept].sort(),
        search: result.search,
      };
      this.delivered.set(key, delivered);
      this.o.db.run(
        "INSERT OR REPLACE INTO brain_synced (machine, employee_id, snapshot_id, files, pending, at) VALUES (?, ?, ?, ?, ?, ?)",
        machine,
        copy,
        b.snap.id,
        JSON.stringify(
          Object.fromEntries([...files.values()].map((f) => [f.path, [f.sha, f.tracked ? 1 : 0]])),
        ),
        JSON.stringify(delivered.pending),
        now,
      );
      const said = delivered.pending.join("\n");
      if (delivered.pending.length && this.keptLogged.get(key) !== said) {
        this.log(
          `kept ${employeeId}'s own edits to ${delivered.pending.length} page(s) in their brain copy instead of replacing them: ${delivered.pending.slice(0, 8).join(", ")}`,
        );
      }
      this.keptLogged.set(key, said);
      return { ok: true, how, id: b.snap.id, sent, kept: delivered.pending, search: result.search };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.log(`couldn't copy ${employeeId}'s brain: ${detail}`);
      return { ok: false, how: "failed", kept: [], detail };
    }
  }

  private async verify(employeeId: string, root: string, id: string): Promise<[number, string]> {
    try {
      const r = await this.run(employeeId, verifyScript(root, id));
      return [r.code, r.output];
    } catch {
      return [1, ""];
    }
  }

  // ---- What a harvest needs (brain-harvest.ts) ---------------------------------------------------------

  /** Where an employee's copy for this kind of session is, and whether it may be in that machine at all. */
  place(
    employeeId: string,
    allowHome = true,
  ): { copy: string; machine: string; root: string; blocked: string | null } {
    const copy = this.copyId(employeeId, allowHome);
    const machine = this.machineOf(employeeId);
    const blocked =
      this.isHome(employeeId) && this.o.registry.machineMates(employeeId).length > 0
        ? `${employeeId} works on home data and shares ${machine} with others, so there is no copy to collect from`
        : null;
    return { copy, machine, root: this.rootOf(copy), blocked };
  }

  /** Whether a machine is running now. A harvest, like a copy, never starts one. */
  isMachineUp(machine: string): Promise<boolean> {
    return this.machineIsUp(machine);
  }

  /** Runs one script in the employee's sandbox (with the same time limit as a copy). */
  exec(employeeId: string, script: string): Promise<{ code: number; output: string }> {
    return this.run(employeeId, script);
  }

  /** Runs `fn` while nothing else (a copy, another harvest) touches this employee's copy. */
  async exclusive<T>(employeeId: string, allowHome: boolean, fn: () => Promise<T>): Promise<T> {
    const copy = this.copyId(employeeId, allowHome);
    const key = `${this.machineOf(employeeId)}:${copy}`;
    const prior = this.locks.get(key) ?? Promise.resolve();
    const mine = prior.then(fn, fn);
    this.locks.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.locks.get(key) === mine) this.locks.delete(key);
    }
  }

  /**
   * The paths the baseline of a copy took from the agent's text: the next copy sends them again (the
   * shared brain's version, repaired and merged) over the agent's file, which is no longer an edit.
   */
  forget(employeeId: string, allowHome: boolean, paths: string[]): void {
    if (!paths.length) return;
    const copy = this.copyId(employeeId, allowHome);
    const machine = this.machineOf(employeeId);
    const key = `${machine}:${copy}`;
    const last = this.lastDelivered(key, employeeId, copy);
    if (!last) return;
    const files = new Map(last.snap.files);
    for (const p of paths) files.delete(p);
    const next: Delivered = {
      ...last,
      snap: { ...last.snap, files },
      pending: [...new Set([...last.pending, ...paths])].sort(),
    };
    this.delivered.set(key, next);
    this.o.db.run(
      "INSERT OR REPLACE INTO brain_synced (machine, employee_id, snapshot_id, files, pending, at) VALUES (?, ?, ?, ?, ?, ?)",
      machine,
      copy,
      last.snap.id,
      JSON.stringify(
        Object.fromEntries([...files.values()].map((f) => [f.path, [f.sha, f.tracked ? 1 : 0]])),
      ),
      JSON.stringify(next.pending),
      this.o.now(),
    );
  }

  /** Something to tell an agent at its next brief or turn about its earlier edits. */
  addHint(employeeId: string, copy: string, text: string): void {
    const have = this.o.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM brain_hints WHERE employee_id = ? AND copy = ? AND text = ? AND taken = 0",
      employeeId,
      copy,
      text,
    );
    if (have[0]?.n) return;
    this.o.db.run(
      "INSERT INTO brain_hints (employee_id, copy, at, text) VALUES (?, ?, ?, ?)",
      employeeId,
      copy,
      this.o.now(),
      text.slice(0, 600),
    );
  }

  /** The hints not told yet (newest five, none older than three days). */
  private hints(employeeId: string, copy: string): { id: number; text: string }[] {
    return this.o.db
      .all<{ id: number; text: string }>(
        "SELECT id, text FROM brain_hints WHERE employee_id = ? AND copy = ? AND taken = 0 AND at > ? ORDER BY id DESC LIMIT 5",
        employeeId,
        copy,
        this.o.now() - 3 * 86_400_000,
      )
      .reverse();
  }

  private markHints(ids: number[]): void {
    for (const id of ids) this.o.db.run("UPDATE brain_hints SET taken = 1 WHERE id = ?", id);
  }

  // ---- Copies that don't belong any more -------------------------------------------------------------

  /**
   * Takes a copy (an employee's, or a PA's `.code` one) out of a machine, and forgets it was there. Not
   * done while the machine is stopped, which would start it: the record stays, and the next pass does it.
   */
  async removeCopy(copy: string, machine: string): Promise<boolean> {
    if (!this.deliver) return false;
    const employeeId = copy.replace(/\.code$/, "");
    const note = (why: string) => {
      if (!this.removeWarned.has(`${machine}:${copy}`)) {
        this.removeWarned.add(`${machine}:${copy}`);
        this.log(
          `${copy}'s brain copy is still in ${machine} (it is removed when the machine is up): ${why}`,
        );
      }
    };
    if (!(await this.machineIsUp(machine))) {
      note(`${machine} isn't running`);
      return false;
    }
    try {
      const r = await this.run(employeeId, removeScript(this.o.home ?? brainHome, copy), machine);
      if (r.code !== 0 || !r.output.includes("@@removed"))
        throw new Error(r.output.trim().slice(-120) || "failed");
      this.o.db.run("DELETE FROM brain_synced WHERE machine = ? AND employee_id = ?", machine, copy);
      this.delivered.delete(`${machine}:${copy}`);
      this.keptLogged.delete(`${machine}:${copy}`);
      this.removeWarned.delete(`${machine}:${copy}`);
      this.log(`removed ${copy}'s brain copy from ${machine}`);
      return true;
    } catch (e) {
      note(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /**
   * Removes the copies that are in a machine their employee no longer works in: the employee moved to
   * another team, left, or is a PA that now shares a sandbox. Called before a copy, and when the
   * registry's employees or teams change.
   */
  async reconcile(): Promise<void> {
    this.reconciledAt = performance.now();
    if (!this.deliver) return;
    // A change that arrives while a pass is running gets its own pass after it.
    if (this.reconciling) {
      this.reconcileAgain = true;
      return this.reconciling;
    }
    this.reconciling = (async () => {
      do {
        this.reconcileAgain = false;
        const rows = this.o.db.all<{ machine: string; employee_id: string }>(
          "SELECT machine, employee_id FROM brain_synced",
        );
        const people = new Set(this.o.registry.employees().map((e) => e.id));
        for (const r of rows) {
          if (!/^[a-z0-9-]{1,32}(\.code)?$/.test(r.employee_id) || !/^inc-[a-z0-9-]{1,32}$/.test(r.machine))
            continue;
          const who = r.employee_id.replace(/\.code$/, "");
          const here = people.has(who) && this.machineOf(who) === r.machine;
          if (!here) await this.removeCopy(r.employee_id, r.machine);
        }
      } while (this.reconcileAgain);
    })().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  // ---- The prompt ----------------------------------------------------------------------------------

  /**
   * The maps for a prompt: only pages that are in the copy, each scope's cut to its share of about 150
   * lines in all (closest scope first).
   */
  private maps(employeeId: string, scopes: Scope[], allowHome: boolean): PromptMap[] {
    const built = this.build(employeeId, allowHome);
    return fitMaps(
      scopes.map((scope) => {
        const keep = built.trimmed.has(scope) ? built.included.get(scope) : undefined;
        const lines = keep
          ? [
              ...buildMap(
                this.index
                  .pages([scope])
                  .filter((p) => keep.has(p.slug))
                  .map((p) => ({
                    slug: p.slug,
                    title: p.title,
                    description: p.external ? `(untrusted) ${p.description}` : p.description,
                  })),
              ).root,
            ]
          : [...this.index.mapFor(scope, true).root];
        return {
          scope,
          dir: scopeDir(scope) ?? scope,
          label: scopeLabel(scope, this.o.registry),
          pages: keep ? keep.size : this.index.count(scope),
          lines,
        };
      }),
    );
  }

  private retrieveFor(
    employeeId: string,
    query: string,
    exclude: string[],
    allowHome = true,
  ): RetrievedPage[] {
    this.index.refresh();
    const scopes = this.readable(employeeId, allowHome);
    // The personality page is the role instructions, which the brief already carries; it stays in the
    // map and the copy, but is never what a task "matches".
    return retrieve(this.index, { query, scopes, exclude: [...exclude, `brain:${employeeId}:personality`] });
  }

  /**
   * The brain section of a ticket stage's brief. Syncs the copy first, then adds the maps and the
   * pages that match the ticket. Records the pages against the session. Empty when this daemon has no
   * sandboxes (demo mode).
   */
  async forTicket(i: {
    employeeId: string;
    sessionId: number | null;
    query: TicketQueryInput;
    /** The session may carry home data (a PA's own brain): an errand or orientation, not code work. Default: yes. */
    allowHome?: boolean;
  }): Promise<BrainContext> {
    if (!this.enabled) return { text: "", pages: [], copy: false, maps: false };
    const allowHome = i.allowHome ?? true;
    const report = await this.sync(i.employeeId, allowHome);
    const scopes = this.readable(i.employeeId, allowHome);
    const pages = this.retrieveFor(i.employeeId, ticketQuery(i.query), [], allowHome);
    const hints = report.ok ? this.hints(i.employeeId, this.copyId(i.employeeId, allowHome)) : [];
    const text = renderBrainPrompt(
      {
        maps: this.maps(i.employeeId, scopes, allowHome),
        pages,
        snapshot: report.ok,
        search: report.search !== false,
        employeeId: this.copyId(i.employeeId, allowHome),
        ...(this.o.home ? { home: this.o.home } : {}),
        ...(hints.length ? { notes: hints.map((h) => h.text) } : {}),
      },
      { maps: true },
    );
    this.markHints(hints.map((h) => h.id));
    const uses = usesOf(pages);
    if (i.sessionId !== null) this.record("session", String(i.sessionId), "", { pages: uses });
    this.countUse(scopes, uses);
    return { text, pages: uses, copy: report.ok, maps: true };
  }

  /**
   * The brain section of a conversation turn: the copy refreshed at this turn boundary, the pages that
   * match your message and the topic, minus those already sent in this conversation, and the maps when
   * they are new to the agent (the first turn, a changed map, or an agent that has lost its memory).
   */
  async forTurn(i: {
    employeeId: string;
    conversation: string;
    turn: string;
    message: string;
    title?: string | undefined;
    project?: string | null | undefined;
    /** The agent has no memory of earlier turns: everything is new to it. */
    fresh?: boolean;
    /** The conversation may carry home data (a PA's own brain): it has no project, so nothing leaves the chat. Default: yes. */
    allowHome?: boolean;
  }): Promise<BrainContext & { conversationPages: BrainUse[]; commit: () => void }> {
    if (!this.enabled) {
      return { text: "", pages: [], copy: false, maps: false, conversationPages: [], commit: () => {} };
    }
    const allowHome = i.allowHome ?? true;
    const report = await this.sync(i.employeeId, allowHome);
    const scopes = this.readable(i.employeeId, allowHome);
    const earlier = this.turnsOf(i.conversation).filter((t) => t.unit !== i.turn);
    // Pages the agent was given or opened itself are in its context already.
    const sent = i.fresh ? [] : earlier.flatMap((t) => t.body.pages.map((p) => `${p.scope}:${p.slug}`));
    const maps = this.maps(i.employeeId, scopes, allowHome);
    // Each map is sent again only when its own lines changed (or the agent has lost its memory).
    const mapHashes: Record<string, string> = {};
    for (const m of maps) mapHashes[m.scope] = hash(JSON.stringify(m.lines));
    const lastHashes: Record<string, string> = {};
    for (const t of earlier) Object.assign(lastHashes, t.body.maps ?? {});
    const changed = maps.filter((m) => i.fresh === true || lastHashes[m.scope] !== mapHashes[m.scope]);
    const pages = this.retrieveFor(
      i.employeeId,
      conversationQuery({ message: i.message, title: i.title, project: i.project }),
      sent,
      allowHome,
    );
    const uses = usesOf(pages);
    const hints = report.ok ? this.hints(i.employeeId, this.copyId(i.employeeId, allowHome)) : [];
    let text = "";
    if (changed.length || pages.length || hints.length) {
      text = renderBrainPrompt(
        {
          maps,
          pages,
          snapshot: report.ok,
          search: report.search !== false,
          employeeId: this.copyId(i.employeeId, allowHome),
          ...(this.o.home ? { home: this.o.home } : {}),
          ...(hints.length ? { notes: hints.map((h) => h.text) } : {}),
        },
        { maps: changed.map((m) => m.scope) },
      );
    }
    const record = {
      pages: uses,
      ...(changed.length
        ? { maps: Object.fromEntries(changed.map((m) => [m.scope, mapHashes[m.scope] as string])) }
        : {}),
    };
    // Nothing is recorded as sent until the prompt has been accepted (`commit`): a turn that is
    // cancelled or fails before the agent has it leaves the pages to go with the next one.
    const commit = () => {
      this.commitTurn(i.conversation, i.turn, record);
      this.countUse(scopes, uses);
      this.markHints(hints.map((h) => h.id));
    };
    const shown = new Map<string, BrainUse>();
    for (const p of [...uses, ...this.conversationPages(i.conversation)]) {
      if (!shown.has(`${p.scope}:${p.slug}`)) shown.set(`${p.scope}:${p.slug}`, p);
    }
    return {
      text,
      pages: uses,
      copy: report.ok,
      maps: changed.length > 0,
      conversationPages: [...shown.values()].slice(-100),
      commit,
    };
  }

  /** Records a turn's pages (and the maps it sent), merging with what the agent opened during the turn. */
  private commitTurn(
    conversation: string,
    turn: string,
    record: { pages: BrainUse[]; maps?: Record<string, string> },
  ): void {
    const mine = this.turnsOf(conversation).find((t) => t.unit === turn);
    const pages = new Map<string, BrainUse>();
    for (const p of [...record.pages, ...(mine?.body.pages ?? [])]) {
      if (!pages.has(`${p.scope}:${p.slug}`)) pages.set(`${p.scope}:${p.slug}`, p);
    }
    const maps = { ...(mine?.body.maps ?? {}), ...(record.maps ?? {}) };
    this.record("turn", conversation, turn, {
      pages: [...pages.values()],
      ...(Object.keys(maps).length ? { maps } : {}),
    });
  }

  // ---- The record ----------------------------------------------------------------------------------

  private record(
    kind: "session" | "turn",
    ref: string,
    unit: string,
    body: { pages: BrainUse[]; maps?: Record<string, string> },
  ): void {
    try {
      this.o.db.run(
        "INSERT OR REPLACE INTO brain_used (kind, ref, unit, at, body) VALUES (?, ?, ?, ?, ?)",
        kind,
        ref,
        unit,
        this.o.now(),
        JSON.stringify(body),
      );
    } catch (e) {
      this.log(`couldn't record the pages used: ${String(e)}`);
    }
  }

  private turnsOf(
    conversation: string,
  ): { unit: string; body: { pages: BrainUse[]; maps?: Record<string, string> } }[] {
    return this.o.db
      .all<{ unit: string; body: string }>(
        "SELECT unit, body FROM brain_used WHERE kind = 'turn' AND ref = ? ORDER BY at, rowid",
        conversation,
      )
      .flatMap((r) => {
        try {
          return [
            {
              unit: r.unit,
              body: JSON.parse(r.body) as { pages: BrainUse[]; maps?: Record<string, string> },
            },
          ];
        } catch {
          return [];
        }
      });
  }

  /** The pages used by a ticket session, or none. */
  sessionPages(sessionId: number): BrainUse[] {
    const [r] = this.o.db.all<{ body: string }>(
      "SELECT body FROM brain_used WHERE kind = 'session' AND ref = ?",
      String(sessionId),
    );
    try {
      return r ? (JSON.parse(r.body) as { pages: BrainUse[] }).pages : [];
    } catch {
      return [];
    }
  }

  /** Every page a conversation has used so far, each once (a read upgrades nothing: the first use stands). */
  conversationPages(conversation: string, limit = 100): BrainUse[] {
    const seen = new Map<string, BrainUse>();
    for (const t of this.turnsOf(conversation)) {
      for (const p of t.body.pages)
        if (!seen.has(`${p.scope}:${p.slug}`)) seen.set(`${p.scope}:${p.slug}`, p);
    }
    return [...seen.values()].slice(-limit);
  }

  /** Pages that went into a prompt count as used. */
  private countUse(scopes: Scope[], uses: BrainUse[]): void {
    const at = this.o.now();
    for (const u of uses)
      if (scopes.includes(u.scope as Scope)) this.index.markUsed(u.scope as Scope, u.slug, at);
  }

  /**
   * File paths seen in an agent's tool calls. A path inside the employee's own copy that names a page
   * they may read is a read: `use_count` and `last_used_at` go up (once per session or conversation),
   * and the page is added to what that session or conversation used. Paths anywhere else are ignored.
   */
  noteRead(
    employeeId: string,
    paths: string[],
    where: { kind: "session"; id: number } | { kind: "turn"; conversation: string; turn: string },
  ): BrainUse[] {
    const scopes = this.readable(employeeId);
    const added: BrainUse[] = [];
    const wk = where.kind === "session" ? `s${where.id}` : `c${where.conversation}`;
    for (const path of paths) {
      // The employee's own copy, or a PA's `.code` copy (which has no personal folder of its own).
      let at = pageOfPath(path, employeeId, this.o.home);
      if (!at) {
        const code = `${this.o.home ?? brainHome}/${employeeId}.code/`;
        if (path.startsWith(code)) {
          at = pageOfPath(
            `${this.o.home ?? brainHome}/${employeeId}/${path.slice(code.length)}`,
            employeeId,
            this.o.home,
          );
          if (at?.scope === `brain:${employeeId}`) at = null;
        }
      }
      if (!at || !scopes.includes(at.scope)) continue;
      const seenKey = `${wk}|${at.scope}:${at.slug}`;
      if (this.seenReads.has(seenKey)) continue;
      const page = this.index.page(at.scope, at.slug);
      if (!page) continue;
      if (this.seenReads.size > 5000) this.seenReads.clear();
      this.seenReads.set(seenKey, true);
      this.index.markUsed(at.scope, at.slug, this.o.now());
      added.push({
        scope: at.scope,
        slug: at.slug,
        title: page.title,
        updated: page.updated,
        via: "read",
        ...(page.external ? { untrusted: true as const } : {}),
      });
    }
    if (!added.length) return added;
    if (where.kind === "session") {
      const have = this.sessionPages(where.id);
      const fresh = added.filter((a) => !have.some((h) => h.scope === a.scope && h.slug === a.slug));
      if (fresh.length) this.record("session", String(where.id), "", { pages: [...have, ...fresh] });
    } else {
      const mine = this.turnsOf(where.conversation).find((t) => t.unit === where.turn);
      const all = this.conversationPages(where.conversation, 10_000);
      const fresh = added.filter((a) => !all.some((h) => h.scope === a.scope && h.slug === a.slug));
      if (fresh.length) {
        this.record("turn", where.conversation, where.turn, {
          pages: [...(mine?.body.pages ?? []), ...fresh],
          ...(mine?.body.maps ? { maps: mine.body.maps } : {}),
        });
      }
    }
    return added;
  }
}
