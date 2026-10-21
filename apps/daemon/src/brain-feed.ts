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
  buildMap,
  conversationQuery,
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
  /** The index is looked at again for outside changes at most this often. Default 2 s. */
  refreshEveryMs?: number;
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
  how: "current" | "delta" | "full" | "failed";
  id?: string;
  sent?: number;
  /** Files whose local edits were kept instead of replaced. */
  kept: string[];
  detail?: string;
}

interface Built {
  /** The state of the repos it was built from. */
  key: string;
  snap: Snapshot;
  /** Where each tracked page's blob lives, and the text of generated files. */
  source: Map<string, { repo: Repo; sha: string } | { data: Buffer }>;
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
  /** Runs a script in an employee's sandbox. Absent in demo mode and in tests without a machine: then nothing is added to prompts. */
  deliver: RunScript | undefined;

  private readonly built = new Map<string, Built>();
  private readonly delivered = new Map<string, { snap: Snapshot; verifiedAt: number }>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly seenReads = new Map<string, true>();
  private readonly trees = new Map<string, { head: string; tree: Map<string, string> }>();

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
  private rootOf(employeeId: string): string {
    return `${this.o.home ?? "/home/employee/brain"}/${employeeId}`;
  }

  /** The scopes this employee may read, nearest first, that have any pages. The only place scopes are chosen. */
  readable(employeeId: string): Scope[] {
    const all = readableScopes({ id: employeeId }, this.o.registry.teams());
    const have = new Set(this.index.scopes());
    return all.filter((s) => have.has(s));
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
  build(employeeId: string): Built {
    const scopes = this.readable(employeeId);
    const repos = new Map<string, Repo>();
    for (const s of scopes) {
      const r = repoOfScope(s);
      if (r) repos.set(repoKey(r), r);
    }
    const key = `${[...repos.values()].map((r) => `${repoKey(r)}@${this.o.store.head(r)?.sha ?? ""}`).join(",")}|${scopes.join(",")}|${hash(commandSource.toString("utf8"))}`;
    const cached = this.built.get(employeeId);
    if (cached && cached.key === key) return cached;

    const files = new Map<string, SnapshotFile>();
    const source: Built["source"] = new Map();
    const skipped: string[] = [];
    const dirs: Record<string, string> = {};
    const maxFile = this.o.maxFileBytes ?? 256 * 1024;
    let bytes = 0;
    const cap = this.o.maxBytes ?? 16 * 1024 * 1024;

    for (const scope of scopes) {
      const repo = repoOfScope(scope);
      const dir = scopeDir(scope);
      if (!repo || !dir) continue;
      dirs[scope] = dir;
      const entries: { path: string; sha: string; slug: string }[] = [];
      for (const [path, sha] of this.tree(repo)) {
        const at = scopeOfPath(repo, path);
        if (!at || at.scope !== scope) continue;
        const rel = snapshotPath(scope, at.slug);
        if (!rel) {
          skipped.push(`${scope}:${at.slug} (name)`);
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
          continue;
        }
        if (bytes + size > cap) {
          skipped.push(`${scope}:${e.slug} (copy full)`);
          continue;
        }
        bytes += size;
        files.set(e.path, { path: e.path, sha: e.sha, tracked: true });
        source.set(e.path, { repo, sha: e.sha });
      }
      // The scope's whole map, as a file (the prompt gets the same map cut to about 150 lines).
      const map = buildMap(
        this.index.pages([scope]).map((p) => ({ slug: p.slug, title: p.title, description: p.description })),
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
    const b: Built = { key, snap, source };
    this.built.set(employeeId, b);
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

  private run(employeeId: string, script: string): Promise<{ code: number; output: string }> {
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
    return Promise.race([deliver(employeeId, script), limit]).finally(() => clearTimeout(timer));
  }

  private lastDelivered(key: string, employeeId: string): { snap: Snapshot; verifiedAt: number } | undefined {
    const mem = this.delivered.get(key);
    if (mem) return mem;
    const [row] = this.o.db.all<{ snapshot_id: string; files: string; at: number }>(
      "SELECT snapshot_id, files, at FROM brain_synced WHERE machine = ? AND employee_id = ?",
      this.machineOf(employeeId),
      employeeId,
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
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Brings the employee's copy in their sandbox up to date. Sends only what changed since the copy the
   * sandbox was last given; falls back to a whole copy when the sandbox doesn't hold what we believe.
   * Calls for one employee run one at a time. Never throws: a failure is reported, and the session
   * goes on without the files.
   */
  async sync(employeeId: string): Promise<SyncReport> {
    const key = `${this.machineOf(employeeId)}:${employeeId}`;
    const prior = this.locks.get(key) ?? Promise.resolve();
    const mine = prior.then(
      () => this.syncNow(employeeId, key),
      () => this.syncNow(employeeId, key),
    );
    this.locks.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.locks.get(key) === mine) this.locks.delete(key);
    }
  }

  private async syncNow(employeeId: string, key: string): Promise<SyncReport> {
    try {
      this.index.refresh(this.o.refreshEveryMs ?? 2000, this.o.now());
      const b = this.build(employeeId);
      const root = this.rootOf(employeeId);
      const last = this.lastDelivered(key, employeeId);
      const now = this.o.now();

      if (last && last.snap.id === b.snap.id) {
        if (now - last.verifiedAt < (this.o.verifyEveryMs ?? 5 * 60_000)) {
          return { ok: true, how: "current", id: b.snap.id, kept: [] };
        }
        const v = parseApply(...(await this.verify(employeeId, root, b.snap.id)));
        if (v.kind === "current") {
          this.delivered.set(key, { snap: last.snap, verifiedAt: now });
          return { ok: true, how: "current", id: b.snap.id, kept: [] };
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
        this.log(`couldn't copy ${employeeId}'s brain into ${this.machineOf(employeeId)}: ${detail}`);
        return { ok: false, how: "failed", kept: result.kept, detail };
      }
      this.delivered.set(key, { snap: b.snap, verifiedAt: now });
      this.o.db.run(
        "INSERT OR REPLACE INTO brain_synced (machine, employee_id, snapshot_id, files, at) VALUES (?, ?, ?, ?, ?)",
        this.machineOf(employeeId),
        employeeId,
        b.snap.id,
        JSON.stringify(
          Object.fromEntries([...b.snap.files.values()].map((f) => [f.path, [f.sha, f.tracked ? 1 : 0]])),
        ),
        now,
      );
      if (result.kept.length) {
        this.log(
          `kept ${employeeId}'s own edits to ${result.kept.length} page(s) in their brain copy instead of replacing them: ${result.kept.slice(0, 8).join(", ")}`,
        );
      }
      return { ok: true, how, id: b.snap.id, sent, kept: result.kept };
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

  // ---- The prompt ----------------------------------------------------------------------------------

  private maps(scopes: Scope[]): PromptMap[] {
    return scopes.map((scope) => ({
      scope,
      dir: scopeDir(scope) ?? scope,
      label: scopeLabel(scope, this.o.registry),
      pages: this.index.count(scope),
      lines: [...this.index.mapFor(scope).root],
    }));
  }

  private retrieveFor(employeeId: string, query: string, exclude: string[]): RetrievedPage[] {
    const scopes = this.readable(employeeId);
    return retrieve(this.index, { query, scopes, exclude });
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
  }): Promise<BrainContext> {
    if (!this.enabled) return { text: "", pages: [], copy: false, maps: false };
    const report = await this.sync(i.employeeId);
    const scopes = this.readable(i.employeeId);
    const pages = this.retrieveFor(i.employeeId, ticketQuery(i.query), []);
    const text = renderBrainPrompt(
      {
        maps: this.maps(scopes),
        pages,
        snapshot: report.ok,
        employeeId: i.employeeId,
        ...(this.o.home ? { home: this.o.home } : {}),
      },
      { maps: true },
    );
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
  }): Promise<BrainContext & { conversationPages: BrainUse[] }> {
    if (!this.enabled) return { text: "", pages: [], copy: false, maps: false, conversationPages: [] };
    const report = await this.sync(i.employeeId);
    const scopes = this.readable(i.employeeId);
    const earlier = this.turnsOf(i.conversation).filter((t) => t.unit !== i.turn);
    // Pages the agent was given or opened itself are in its context already.
    const sent = i.fresh ? [] : earlier.flatMap((t) => t.body.pages.map((p) => `${p.scope}:${p.slug}`));
    const maps = this.maps(scopes);
    const mapsHash = hash(JSON.stringify(maps.map((m) => [m.scope, m.lines])));
    const lastMaps = [...earlier].reverse().find((t) => t.body.maps)?.body.maps;
    const withMaps = i.fresh === true || lastMaps !== mapsHash;
    const pages = this.retrieveFor(
      i.employeeId,
      conversationQuery({ message: i.message, title: i.title, project: i.project }),
      sent,
    );
    const uses = usesOf(pages);
    let text = "";
    if (withMaps || pages.length) {
      text = renderBrainPrompt(
        {
          maps,
          pages,
          snapshot: report.ok,
          employeeId: i.employeeId,
          ...(this.o.home ? { home: this.o.home } : {}),
        },
        { maps: withMaps },
      );
    }
    this.record("turn", i.conversation, i.turn, { pages: uses, ...(withMaps ? { maps: mapsHash } : {}) });
    this.countUse(scopes, uses);
    return {
      text,
      pages: uses,
      copy: report.ok,
      maps: withMaps,
      conversationPages: this.conversationPages(i.conversation),
    };
  }

  // ---- The record ----------------------------------------------------------------------------------

  private record(
    kind: "session" | "turn",
    ref: string,
    unit: string,
    body: { pages: BrainUse[]; maps?: string },
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

  private turnsOf(conversation: string): { unit: string; body: { pages: BrainUse[]; maps?: string } }[] {
    return this.o.db
      .all<{ unit: string; body: string }>(
        "SELECT unit, body FROM brain_used WHERE kind = 'turn' AND ref = ? ORDER BY at, rowid",
        conversation,
      )
      .flatMap((r) => {
        try {
          return [{ unit: r.unit, body: JSON.parse(r.body) as { pages: BrainUse[]; maps?: string } }];
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
      const at = pageOfPath(path, employeeId, this.o.home);
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
