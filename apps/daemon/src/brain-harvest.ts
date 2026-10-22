// How an agent's edits to its brain copy reach the shared brain (docs/design/brain.md, "Writing"; contract
// C19). When a ticket ends, a conversation goes idle or ends, or the owner says "remember this", the daemon:
//
//   1. collects `git diff refs/inc/baseline` from the employee's copy in the sandbox (a `machine run` script;
//      a stopped machine is never started for it, the copy is collected when it is next up);
//   2. checks every change as untrusted input (brain-check.ts);
//   3. merges each accepted change with what the shared brain has now (a three-way merge; a real conflict keeps
//      both versions, the other under `## Conflict`, for the tidy-up) and commits it, one commit a change,
//      with who, what and the harvest id in the message;
//   4. moves the copy's baseline, so the same diff is not collected twice, and sends the shared brain's version
//      of the pages back with the next copy;
//   5. writes every change, refused ones too, to the Brain changes feed, and tells the owner by push when a
//      company policy page changed.
//
// Nothing here waits for the owner. Every committed change can be undone from the feed (`revert`).
import {
  buildQuery,
  type Employee,
  isHomeEmployee,
  parsePage,
  pathOfSlug,
  type RepoRef,
  readableScopes,
  repoOfScope,
  scopeDir,
  scopeOfDir,
  serializePage,
} from "@i-inc/core";
import {
  type Accepted,
  type CheckContext,
  checkHarvest,
  defaultLimits,
  type Existing,
  forDiff,
  type Limits,
  lineDiff,
  normalizePage,
  type RawChange,
  type Rejected,
} from "./brain-check.ts";
import type { BrainFeed } from "./brain-feed.ts";
import { advanceScript, harvestScript, parseAdvance, parseHarvest } from "./brain-harvest-script.ts";
import type { BrainIndex } from "./brain-index.ts";
import type { Db, Row } from "./db.ts";
import type { KnowledgeStore, Repo } from "./knowledge.ts";
import type { PushService } from "./push.ts";
import type { Registry } from "./registry.ts";

export type HarvestSource = { kind: "ticket"; id: string } | { kind: "conversation"; id: string };
export type Trigger = "ticket-end" | "idle" | "end" | "remember" | "catch-up";

export interface HarvestRequest {
  employeeId: string;
  /** The session may carry home data (an errand, orientation, a conversation with no project). Default yes. */
  allowHome?: boolean;
  source: HarvestSource;
  trigger: Trigger;
  /** It is the tidy-up ticket: it may shrink and delete more. */
  tidy?: boolean;
}

export interface HarvestReport {
  /** `h<n>`, or null when nothing was collected. */
  id: string | null;
  status: "done" | "nothing" | "skipped" | "failed";
  committed: number;
  rejected: number;
  detail?: string;
}

export interface BrainHarvestOptions {
  feed: BrainFeed;
  store: KnowledgeStore;
  index: BrainIndex;
  registry: Registry;
  db: Db;
  now: () => number;
  /** The owner's push, for policy changes. */
  push?: () => PushService | undefined;
  limits?: Partial<Limits>;
  log?: (msg: string) => void;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A body in the shape `normalizePage` writes: LF endings, no blank lines at the start, one final newline. */
const shape = (s: string) => `${s.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd()}\n`;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const repoKey = (r: RepoRef | Repo) => (r.kind === "handbook" ? "handbook" : `brain:${r.id}`);

/** A change the merge could not make on top of what the shared brain has (a delete of a page edited since). */
interface Stale {
  stale: string;
}

interface Committed {
  commit: string;
  text: string | null;
  before: string | null;
  conflict: boolean;
  notes: string[];
}

export class BrainHarvest {
  /** Harvests in flight, so a deploy and the tests can wait for them. */
  private readonly flying = new Set<Promise<unknown>>();

  constructor(private readonly o: BrainHarvestOptions) {}

  private log(m: string): void {
    this.o.log?.(`brain: ${m}`);
  }

  /** Resolves when no harvest is running. */
  async settled(): Promise<void> {
    while (this.flying.size) await Promise.allSettled([...this.flying]);
  }

  get busy(): boolean {
    return this.flying.size > 0;
  }

  /** Employees whose copy is being collected now: their machines are in use. */
  private readonly working = new Map<string, number>();
  employeesWorking(): string[] {
    return [...this.working.keys()];
  }

  /** Runs a harvest and tracks it; never throws. */
  run(req: HarvestRequest): Promise<HarvestReport> {
    const p = this.collect(req)
      .catch((e): HarvestReport => {
        this.log(`harvest of ${req.employeeId}'s copy failed: ${e instanceof Error ? e.message : String(e)}`);
        return { id: null, status: "failed", committed: 0, rejected: 0, detail: String(e) };
      })
      .finally(() => this.flying.delete(p));
    this.flying.add(p);
    return p;
  }

  /** A ticket ended: collect the copy of everyone who had a session on it. */
  async ticketEnded(ticket: { id: string; type: string }, employees: string[]): Promise<HarvestReport[]> {
    const out: HarvestReport[] = [];
    for (const employeeId of [...new Set(employees)]) {
      out.push(
        await this.run({
          employeeId,
          allowHome: ticket.type === "errand" || ticket.type === "orientation",
          source: { kind: "ticket", id: ticket.id },
          trigger: "ticket-end",
          tidy: ticket.type === "tidy",
        }),
      );
    }
    return out;
  }

  // ---- Collecting -----------------------------------------------------------------------------------

  private async collect(req: HarvestRequest): Promise<HarvestReport> {
    const allowHome = req.allowHome ?? true;
    const feed = this.o.feed;
    if (!feed.enabled) return skipped("this daemon has no sandboxes");
    this.working.set(req.employeeId, (this.working.get(req.employeeId) ?? 0) + 1);
    try {
      return await feed.exclusive(req.employeeId, allowHome, () => this.collectLocked(req, allowHome));
    } finally {
      const n = (this.working.get(req.employeeId) ?? 1) - 1;
      if (n <= 0) this.working.delete(req.employeeId);
      else this.working.set(req.employeeId, n);
    }
  }

  private async collectLocked(req: HarvestRequest, allowHome: boolean): Promise<HarvestReport> {
    const { feed, db } = this.o;
    const place = feed.place(req.employeeId, allowHome);
    if (place.blocked) return skipped(place.blocked);
    // A stopped machine is not started for this: the copy is collected when the machine is next up.
    if (!(await feed.isMachineUp(place.machine))) {
      this.markDue(req, place.copy);
      return skipped(`${place.machine} isn't running; the copy is collected when it is`);
    }
    let r: { code: number; output: string };
    try {
      r = await feed.exec(req.employeeId, harvestScript(place.root));
    } catch (e) {
      // The machine went down mid-run, or the script timed out: try again when it is up, for the same work.
      this.markDue(req, place.copy);
      this.log(
        `couldn't collect ${req.employeeId}'s copy from ${place.machine}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { id: null, status: "failed", committed: 0, rejected: 0, detail: String(e) };
    }
    const got = parseHarvest(r.code, r.output);
    if (got.kind !== "failed") {
      db.run("DELETE FROM brain_harvest_due WHERE employee_id = ? AND copy = ?", req.employeeId, place.copy);
    }
    if (got.kind === "missing") return skipped("there is no copy in the sandbox yet");
    if (got.kind === "failed") {
      this.markDue(req, place.copy);
      this.log(`couldn't collect ${req.employeeId}'s copy from ${place.machine}: ${got.detail}`);
      return {
        id: null,
        status: "failed",
        committed: 0,
        rejected: 0,
        ...(got.detail ? { detail: got.detail } : {}),
      };
    }
    if (got.employee !== req.employeeId) {
      // Whatever is in that folder is not this employee's copy: nothing in it is theirs to write.
      this.log(
        `the copy at ${place.root} says it is for "${got.employee}", not ${req.employeeId}: not collected`,
      );
      return {
        id: null,
        status: "failed",
        committed: 0,
        rejected: 0,
        detail: "the copy belongs to someone else",
      };
    }
    // A change refused before, still in the copy for the agent to deal with, is not told again.
    const fresh = got.changes.filter((c) => !this.seen(req.employeeId, c));
    if (!fresh.length) return { id: null, status: "nothing", committed: 0, rejected: 0 };
    return this.deal(req, allowHome, place.copy, place.root, fresh);
  }

  /**
   * Remembers that this copy has work to collect: when its machine is up again (or the script ran again), the
   * harvest is made for the session that made the edits, the first one asked for (a later one doesn't replace it).
   */
  private markDue(req: HarvestRequest, copy: string): void {
    this.o.db.run(
      "INSERT OR IGNORE INTO brain_harvest_due (employee_id, copy, ref_kind, ref_id, trigger, tidy, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      req.employeeId,
      copy,
      req.source.kind,
      req.source.id,
      req.trigger,
      req.tidy ? 1 : 0,
      this.o.now(),
    );
  }

  /** Whether this exact change was refused before and left in the copy. */
  private seen(employeeId: string, c: RawChange): boolean {
    if (c.sha === null) return false;
    const [row] = this.o.db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM brain_changes WHERE employee_id = ? AND path = ? AND sha = ? AND status = 'rejected' AND code IN ('duplicate', 'too-many', 'oversize')",
      employeeId,
      c.path,
      c.sha,
    );
    return (row?.n ?? 0) > 0;
  }

  // ---- Where the edits came from ---------------------------------------------------------------------

  /** A conversation turn of this employee is running: they may be editing files in their team's machine. */
  beginActivity(employeeId: string): () => void {
    const { db } = this.o;
    db.run("INSERT INTO brain_activity (employee_id, started_at) VALUES (?, ?)", employeeId, this.o.now());
    const id = db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0]?.id ?? 0;
    return () => {
      db.run("UPDATE brain_activity SET ended_at = ? WHERE id = ?", this.o.now(), id);
    };
  }

  /** The session of a ticket or conversation fetched something from outside (a web page, an issue). */
  noteExternal(source: HarvestSource, why: string): void {
    this.o.db.run(
      "INSERT OR IGNORE INTO brain_external (ref_kind, ref_id, why) VALUES (?, ?, ?)",
      source.kind,
      source.id,
      why.slice(0, 120),
    );
  }

  private externalInput(source: HarvestSource): string | null {
    const [row] = this.o.db.all<{ why: string }>(
      "SELECT why FROM brain_external WHERE ref_kind = ? AND ref_id = ?",
      source.kind,
      source.id,
    );
    return row?.why ?? null;
  }

  /**
   * Whether another employee had a session in this employee's machine since this copy was last collected or
   * delivered: a ticket stage or a conversation turn. A team shares one Unix user in its sandbox, so such a
   * teammate could have written in this copy; what the daemon knows (not file times, which can be set) says when.
   */
  private teammateWorked(employeeId: string, copy: string, allowHome: boolean, now: number): boolean {
    const { db, registry, feed } = this.o;
    let mates: string[];
    try {
      const team = registry.teamOf(employeeId).id;
      mates = registry
        .employees()
        .filter((e) => e.id !== employeeId && registry.teamOf(e.id).id === team)
        .map((e) => e.id);
    } catch {
      return false;
    }
    if (!mates.length) return false;
    const [last] = db.all<{ t: number | null }>(
      "SELECT MAX(at) AS t FROM brain_harvests WHERE employee_id = ? AND copy = ?",
      employeeId,
      copy,
    );
    const since = Math.max(last?.t ?? 0, feed.deliveredInfo(employeeId, allowHome)?.at ?? 0);
    const marks = mates.map(() => "?").join(",");
    for (const table of ["ticket_sessions", "brain_activity"]) {
      const [row] = db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE employee_id IN (${marks}) AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`,
        ...mates,
        now,
        since,
      );
      if ((row?.n ?? 0) > 0) return true;
    }
    return false;
  }

  /** The text the daemon knows the copy's baseline holds for a path: its record of what it took, else what it delivered. */
  private baseOf(employeeId: string, copy: string, allowHome: boolean, path: string): string | null {
    const { db, feed, store } = this.o;
    const [row] = db.all<{ text: string }>(
      "SELECT text FROM brain_bases WHERE employee_id = ? AND copy = ? AND path = ?",
      employeeId,
      copy,
      path,
    );
    if (row) return row.text;
    const sha = feed.deliveredInfo(employeeId, allowHome)?.files.get(path);
    const slash = path.indexOf("/");
    const scope = slash < 1 ? null : scopeOfDir(path.slice(0, slash), employeeId);
    const repo = scope ? repoOfScope(scope) : null;
    if (!sha || !repo || !store.exists(repo)) return null;
    try {
      return store.blobs(repo, [sha]).get(sha) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The changes with their bases and kinds from the daemon's own record: a page it never delivered is new
   * whatever the copy's baseline says, a page it did is an edit, and a delete of an unknown page is nothing.
   */
  private withOwnBases(
    employeeId: string,
    copy: string,
    allowHome: boolean,
    changes: RawChange[],
  ): RawChange[] {
    const out: RawChange[] = [];
    for (const c of changes) {
      if (c.bad) {
        out.push({ ...c, base: null });
        continue;
      }
      const base = this.baseOf(employeeId, copy, allowHome, c.path);
      if (c.status === "D" && base === null) continue;
      out.push({ ...c, base, status: c.status === "D" ? "D" : base === null ? "A" : "M" });
    }
    return out;
  }

  private keepBase(employeeId: string, copy: string, path: string, text: string | null): void {
    const { db } = this.o;
    if (text === null) {
      db.run(
        "DELETE FROM brain_bases WHERE employee_id = ? AND copy = ? AND path = ?",
        employeeId,
        copy,
        path,
      );
      return;
    }
    db.run(
      "INSERT OR REPLACE INTO brain_bases (employee_id, copy, path, text) VALUES (?, ?, ?, ?)",
      employeeId,
      copy,
      path,
      text,
    );
  }

  // ---- Checking and committing ----------------------------------------------------------------------

  private context(
    req: HarvestRequest,
    employee: Employee,
    provenance: string,
    suspect: string[],
  ): CheckContext {
    const { index, store, registry } = this.o;
    index.refresh();
    const limits = { ...defaultLimits, ...this.o.limits, ...(req.tidy ? { maxDeletes: 25 } : {}) };
    return {
      employeeId: employee.id,
      employeeIds: registry.employees().map((e) => e.id),
      scopes: readableScopes({ id: employee.id }, registry.teams()),
      isHome: isHomeEmployee(employee),
      copy: "main",
      provenance,
      today: day(this.o.now()),
      tainted: this.tainted(req.source),
      suspect,
      tidy: req.tidy === true,
      limits,
      pagesOf: (scope): Existing[] =>
        index.pages([scope]).map((p) => ({ slug: p.slug, title: p.title, description: p.description })),
      search: (scope, title, description) =>
        index.search(buildQuery(`${title} ${description}`), [scope], 5).map((h) => h.slug),
      exists: (scope, slug) => {
        const repo = repoOfScope(scope);
        return repo ? store.textOf(repo, pathOfSlug(scope, slug)) !== null : false;
      },
    };
  }

  /** The session or conversation read pages that were built from untrusted content. */
  private tainted(source: HarvestSource): boolean {
    const { db } = this.o;
    const bodies: string[] = [];
    if (source.kind === "ticket") {
      const sessions = db.all<{ id: number }>(
        "SELECT id FROM ticket_sessions WHERE ticket_id = ?",
        source.id,
      );
      for (const s of sessions) {
        bodies.push(
          ...db
            .all<{ body: string }>(
              "SELECT body FROM brain_used WHERE kind = 'session' AND ref = ?",
              String(s.id),
            )
            .map((r) => r.body),
        );
      }
    } else {
      bodies.push(
        ...db
          .all<{ body: string }>("SELECT body FROM brain_used WHERE kind = 'turn' AND ref = ?", source.id)
          .map((r) => r.body),
      );
    }
    return bodies.some((b) => {
      try {
        return (
          (JSON.parse(b) as { pages?: { untrusted?: boolean }[] }).pages?.some((p) => p.untrusted) === true
        );
      } catch {
        return false;
      }
    });
  }

  private async deal(
    req: HarvestRequest,
    allowHome: boolean,
    copy: string,
    root: string,
    changes: RawChange[],
  ): Promise<HarvestReport> {
    const { db, feed } = this.o;
    const employee = this.o.registry.employee(req.employeeId);
    const at = this.o.now();
    // Doubts about where the edits came from, worked out before this harvest is written down (they use the last one).
    const suspect: string[] = [];
    if (this.teammateWorked(employee.id, copy, allowHome, at)) {
      suspect.push("possibly edited by a teammate (shared sandbox)");
    }
    const outside = this.externalInput(req.source);
    if (outside) suspect.push(`the session handled external content (${outside})`);
    db.run(
      "INSERT INTO brain_harvests (at, employee_id, copy, ref_kind, ref_id, trigger) VALUES (?, ?, ?, ?, ?, ?)",
      at,
      req.employeeId,
      copy,
      req.source.kind,
      req.source.id,
      req.trigger,
    );
    const hid = `h${db.all<{ id: number }>("SELECT last_insert_rowid() AS id")[0]?.id ?? 0}`;
    const provenance = `${req.source.kind}-${req.source.id}`;
    const ctx = this.context(req, employee, provenance, suspect);
    ctx.copy = copy.endsWith(".code") ? "code" : "main";
    // The base of a change is what the daemon delivered or took, never what the copy's own ref says.
    const rawText = new Map(changes.map((c) => [c.path, c.text]));
    const trusted = this.withOwnBases(employee.id, copy, allowHome, changes);
    const { accepted, rejected } = checkHarvest(trusted, ctx);

    // Commit what passed. A change that cannot be committed is left for the next harvest.
    const moved: { path: string; sha: string | null }[] = [];
    const reject: Rejected[] = [...rejected];
    const forget: string[] = [];
    let committed = 0;
    for (const a of accepted) {
      try {
        if (a.noop) {
          // The edit leaves the page as it is: only the baseline moves.
          moved.push({ path: a.path, sha: a.sha });
          forget.push(a.path);
          this.keepBase(employee.id, copy, a.path, rawText.get(a.path) ?? null);
          continue;
        }
        const done = this.commit(a, req, hid, employee);
        if ("stale" in done) {
          reject.push({
            path: a.path,
            status: "D",
            scope: a.scope,
            slug: a.slug,
            code: "stale",
            reason: done.stale,
            keep: false,
            silent: false,
            sha: a.sha,
            base: a.base,
            text: a.text,
          });
          continue;
        }
        moved.push({ path: a.path, sha: a.op === "delete" ? null : a.sha });
        if (a.from) moved.push({ path: a.from.path, sha: null });
        forget.push(a.path);
        if (a.from) forget.push(a.from.path);
        this.keepBase(employee.id, copy, a.path, a.op === "delete" ? null : (rawText.get(a.path) ?? null));
        if (a.from) this.keepBase(employee.id, copy, a.from.path, null);
        if (done.commit === "") continue;
        committed++;
        this.record({
          hid,
          at,
          status: "committed",
          req,
          a,
          commit: done.commit,
          repoKey: repoKey(repoOfScope(a.scope) as RepoRef),
          diff: lineDiff(forDiff(done.before, a.slug), forDiff(done.text, a.slug)),
          conflict: done.conflict,
          notes: [...a.notes, ...done.notes],
        });
        if (a.policy) this.policyChanged(a, req, employee, done.conflict);
      } catch (e) {
        this.log(
          `couldn't commit ${a.path} from ${req.employeeId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    for (const r of reject) {
      if (r.silent) continue;
      this.recordRejected(hid, at, req, r);
      if (r.mergeInto) {
        const dir = scopeDir(r.mergeInto.scope) ?? "";
        feed.addHint(
          req.employeeId,
          copy,
          `Your new page ${r.path} was not created: ${r.reason}. Merge what is new into ${dir}/${r.mergeInto.slug}.md, rewriting it rather than appending, then delete ${r.path}.`,
        );
      }
    }

    // The baseline moves past everything that was dealt with; refused changes the agent is not meant to
    // keep are undone in its copy.
    const discard = reject.filter((r) => !r.keep).map((r) => r.path);
    if (moved.length || discard.length) {
      try {
        const adv = await feed.exec(
          req.employeeId,
          advanceScript({ root, harvest: hid, accept: moved, discard }),
        );
        const ok = parseAdvance(adv.code, adv.output);
        if (!ok.ok || ok.advanced < moved.length) {
          this.log(`couldn't move ${req.employeeId}'s baseline (${hid}): ${adv.output.trim().slice(-160)}`);
        }
      } catch (e) {
        this.log(
          `couldn't move ${req.employeeId}'s baseline (${hid}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      feed.forget(req.employeeId, allowHome, forget);
    }
    const shown = reject.filter((r) => !r.silent).length;
    db.run(
      "UPDATE brain_harvests SET status = 'done', committed = ?, rejected = ? WHERE id = ?",
      committed,
      shown,
      Number(hid.slice(1)),
    );
    if (committed || shown) {
      this.log(`${hid}: ${req.employeeId}'s copy (${provenance}): ${committed} committed, ${shown} refused`);
    }
    return { id: hid, status: "done", committed, rejected: shown };
  }

  /**
   * Commits one accepted change on top of what the shared brain has now. Returns the commit ("" when the
   * brain already had it), or why it can't be made. Synchronous, so nothing else commits in between.
   */
  private commit(
    a: Accepted,
    req: HarvestRequest,
    hid: string,
    employee: Employee,
  ): (Committed & { commit: string }) | Stale {
    const { store } = this.o;
    const repo = repoOfScope(a.scope) as RepoRef;
    if (!store.exists(repo)) {
      if (repo.kind === "brain") store.ensureBrain({ id: repo.id, name: employee.name, role: employee.role });
      else store.ensureHandbook();
    }
    const path = pathOfSlug(a.scope, a.slug);
    const ours = store.textOf(repo, path);
    const notes: string[] = [];
    const who = employee.id;
    const trailers: Record<string, string> = {
      Author: who,
      [req.source.kind === "ticket" ? "Ticket" : "Conversation"]: req.source.id,
      Harvest: hid,
      Scope: a.scope,
    };

    if (a.op === "delete") {
      if (ours === null) return { commit: "", text: null, before: null, conflict: false, notes };
      if (a.base !== null && ours !== a.base) {
        return { stale: "the page was edited after the copy was made, so it was not deleted" };
      }
      const commit = store.commitFiles(repo, { [path]: null }, `Delete ${path}`, trailers);
      return { commit: commit ?? "", text: null, before: ours, conflict: false, notes };
    }

    const final = this.merged(a, ours, hid, req, employee);
    notes.push(...final.notes);
    const files: Record<string, string | null> = {};
    let subject = `${a.op === "create" ? "Add" : "Update"} ${path}`;
    if (final.text === ours) {
      return { commit: "", text: ours, before: ours, conflict: false, notes };
    }
    files[path] = final.text;
    if (a.op === "rename" && a.from) {
      const fromPath = pathOfSlug(a.scope, a.from.slug);
      const fromText = store.textOf(repo, fromPath);
      if (fromText !== null && (a.from.base === null || fromText === a.from.base)) files[fromPath] = null;
      else if (fromText !== null)
        notes.push(`the old page ${a.from.slug} was edited meanwhile, so it was kept`);
      subject = `Rename ${fromPath} to ${path}`;
    }
    const commit = store.commitFiles(repo, files, subject, trailers);
    return { commit: commit ?? "", text: final.text, before: ours, conflict: final.conflict, notes };
  }

  /** The text to write for a create or an update, given what the shared brain has now. */
  private merged(
    a: Accepted,
    ours: string | null,
    hid: string,
    req: HarvestRequest,
    employee: Employee,
  ): { text: string; conflict: boolean; notes: string[] } {
    const { store } = this.o;
    const opts = { today: day(this.o.now()), provenance: `${req.source.kind}-${req.source.id}` };
    const theirs = a.text ?? "";
    if (ours === null) {
      return {
        text: theirs,
        conflict: false,
        notes: a.op === "update" ? ["the page had been deleted meanwhile, so it was made again"] : [],
      };
    }
    const mine = parsePage(ours, a.slug);
    const external = a.untrusted || mine.meta.source === "external";
    if (a.base !== null && ours === a.base) {
      // Nobody changed the page since the copy was made: the agent's version is the page.
      return { text: normalizePage(theirs, a.slug, { ...opts, external }).text, conflict: false, notes: [] };
    }
    const theirParsed = parsePage(theirs, a.slug);
    if (squash(mine.body) === squash(theirParsed.body) && mine.meta.title === theirParsed.meta.title) {
      return { text: ours, conflict: false, notes: [] };
    }
    // Both changed it: merge the bodies, line by line, from the text the copy was given. All three are put in
    // the same shape first (line endings, edges, one final newline), or a missing newline is a conflict.
    let body: string | null = null;
    if (a.base !== null) {
      const base = parsePage(a.base, a.slug);
      const m = store.mergeText(shape(mine.body), shape(base.body), shape(theirParsed.body));
      if (m.conflicts === 0) body = m.text;
    }
    const meta = { ...mine.meta };
    const base = a.base !== null ? parsePage(a.base, a.slug).meta : null;
    const pick = <T>(b: T | undefined, o: T, t: T): T => (base === null ? o : b === o ? t : o);
    meta.title = pick(base?.title, mine.meta.title, theirParsed.meta.title);
    meta.description = pick(base?.description, mine.meta.description, theirParsed.meta.description);
    meta.tags = [...new Set([...mine.meta.tags, ...theirParsed.meta.tags])];
    meta.sources = [...new Set([...mine.meta.sources, ...theirParsed.meta.sources])];
    if (body !== null) {
      return {
        text: normalizePage(serializePage({ meta, body }), a.slug, { ...opts, external }).text,
        conflict: false,
        notes: ["merged with an edit made meanwhile"],
      };
    }
    // A conflict keeps both: the page as it is in the brain, and the other version under `## Conflict`.
    const other = theirParsed.body
      .trimEnd()
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
    const section = `\n## Conflict\n\nAn edit by ${employee.name} (${req.source.kind} ${req.source.id}, ${hid}) disagreed with the text above and is kept here for the tidy-up to resolve:\n\n${other}\n`;
    const keptBody = `${mine.body.trimEnd()}\n${section}`;
    const text = normalizePage(
      serializePage({ meta: { ...meta, needsTidy: true }, body: keptBody }),
      a.slug,
      {
        ...opts,
        external,
      },
    ).text;
    return { text, conflict: true, notes: ["both versions kept under ## Conflict"] };
  }

  // ---- The feed's rows -------------------------------------------------------------------------------

  private record(r: {
    hid: string;
    at: number;
    status: "committed";
    req: HarvestRequest;
    a: Accepted;
    commit: string;
    repoKey: string;
    diff: string;
    conflict: boolean;
    notes: string[];
  }): void {
    this.o.db.run(
      `INSERT INTO brain_changes (harvest, at, status, employee_id, ref_kind, ref_id, scope, slug, path, op, repo, commit_sha, sha, diff, notes, untrusted, policy, conflict)
       VALUES (?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.hid,
      r.at,
      r.req.employeeId,
      r.req.source.kind,
      r.req.source.id,
      r.a.scope,
      r.a.slug,
      r.a.path,
      r.a.op,
      r.repoKey,
      r.commit,
      r.a.sha,
      r.diff.slice(0, 4000),
      JSON.stringify(r.notes),
      r.a.untrusted ? 1 : 0,
      r.a.policy ? 1 : 0,
      r.conflict ? 1 : 0,
    );
  }

  private recordRejected(hid: string, at: number, req: HarvestRequest, r: Rejected): void {
    this.o.db.run(
      `INSERT INTO brain_changes (harvest, at, status, employee_id, ref_kind, ref_id, scope, slug, path, op, code, reason, sha, diff)
       VALUES (?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hid,
      at,
      req.employeeId,
      req.source.kind,
      req.source.id,
      r.scope,
      r.slug,
      r.path,
      r.status === "A" ? "create" : r.status === "D" ? "delete" : "update",
      r.code,
      r.reason,
      r.sha,
      lineDiff(forDiff(r.base, r.slug ?? ""), forDiff(r.text, r.slug ?? "")).slice(0, 4000),
    );
  }

  // ---- Policies ---------------------------------------------------------------------------------------

  /** A company policy page changed: no approval, but the owner is told. */
  private policyChanged(a: Accepted, req: HarvestRequest, employee: Employee, conflict: boolean): void {
    const push = this.o.push?.();
    if (!push) return;
    const verb = a.op === "create" ? "added" : a.op === "delete" ? "removed" : "changed";
    const from = req.source.kind === "ticket" ? `ticket #${req.source.id}` : "a conversation";
    void push
      .send({
        title: `Policy ${verb} · ${a.slug.replace(/^policies\//, "")}`,
        body: `${employee.name} ${verb} the company policy "${a.slug}" in ${from}${conflict ? " (a conflict is kept for the tidy-up)" : ""}${a.notes.some((n) => /teammate/.test(n)) ? ". It may have been edited by a teammate (shared sandbox)" : ""}. You can undo it in Company → Brain → Changes.`,
        url: "#/company/brain/changes",
        tag: `brain-policy:${a.slug}`,
      })
      .catch((e) => this.log(`couldn't send the policy notice: ${String(e)}`));
  }

  // ---- The feed --------------------------------------------------------------------------------------------

  /** Entries of the Brain changes feed, newest first. */
  feedPage(q: FeedQuery = {}): FeedPage {
    const { db } = this.o;
    const limit = Math.min(200, Math.max(1, q.limit ?? 50));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.scope) {
      where.push("scope = ?");
      params.push(q.scope);
    }
    if (q.employee) {
      where.push("employee_id = ?");
      params.push(q.employee);
    }
    if (q.status) {
      where.push("status = ?");
      params.push(q.status);
    }
    if (q.before !== undefined) {
      where.push("id < ?");
      params.push(q.before);
    }
    const rows = db.all<ChangeRow>(
      `SELECT * FROM brain_changes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      changes: page.map(toChange),
      next: more ? (page[page.length - 1]?.id ?? null) : null,
      facets: {
        scopes: db
          .all<{ scope: string }>(
            "SELECT DISTINCT scope FROM brain_changes WHERE scope IS NOT NULL ORDER BY scope",
          )
          .map((r) => r.scope),
        employees: db
          .all<{ employee_id: string }>("SELECT DISTINCT employee_id FROM brain_changes ORDER BY employee_id")
          .map((r) => r.employee_id),
      },
    };
  }

  change(id: number): BrainChange | null {
    const [row] = this.o.db.all<ChangeRow>("SELECT * FROM brain_changes WHERE id = ?", id);
    return row ? toChange(row) : null;
  }

  /**
   * Undoes a committed change with a new commit, "reverted by owner". Throws a RevertError (404 no such
   * entry, 400 it was never committed, 409 already undone or later edits overlap).
   */
  revert(id: number): BrainChange {
    const { db, store } = this.o;
    const [row] = db.all<ChangeRow>("SELECT * FROM brain_changes WHERE id = ?", id);
    if (!row) throw new RevertError("no such change", 404);
    if (row.status !== "committed" || !row.commit_sha || !row.repo) {
      throw new RevertError("only a committed change can be undone", 400);
    }
    if (row.reverted_at !== null) throw new RevertError("that change was already undone", 409);
    const repo: Repo =
      row.repo === "handbook" ? { kind: "handbook" } : { kind: "brain", id: row.repo.slice(6) };
    let sha: string;
    try {
      sha = store.revertCommit(repo, row.commit_sha, {
        "Reverted-By": "owner",
        Change: String(row.id),
        Harvest: row.harvest,
      });
    } catch (e) {
      throw new RevertError(e instanceof Error ? e.message : String(e), 409);
    }
    db.run("UPDATE brain_changes SET reverted_at = ?, revert_sha = ? WHERE id = ?", this.o.now(), sha, id);
    this.log(`${row.path} (${row.harvest}) reverted by the owner`);
    return this.change(id) as BrainChange;
  }

  // ---- Copies waiting for their machine --------------------------------------------------------------

  /** Collects the copies whose machine was stopped when their ticket or conversation ended and is up now. */
  async catchUp(): Promise<void> {
    const rows = this.o.db.all<{
      employee_id: string;
      copy: string;
      ref_kind: string;
      ref_id: string;
      tidy: number;
    }>("SELECT employee_id, copy, ref_kind, ref_id, tidy FROM brain_harvest_due ORDER BY at");
    for (const r of rows) {
      if (!this.o.registry.employees().some((e) => e.id === r.employee_id)) {
        this.o.db.run(
          "DELETE FROM brain_harvest_due WHERE employee_id = ? AND copy = ?",
          r.employee_id,
          r.copy,
        );
        continue;
      }
      const place = this.o.feed.place(r.employee_id, !r.copy.endsWith(".code"));
      if (!(await this.o.feed.isMachineUp(place.machine))) continue;
      await this.run({
        employeeId: r.employee_id,
        allowHome: !r.copy.endsWith(".code"),
        source: { kind: r.ref_kind === "ticket" ? "ticket" : "conversation", id: r.ref_id },
        trigger: "catch-up",
        tidy: r.tidy === 1,
      });
    }
  }
}

// ---- The Brain changes feed ---------------------------------------------------------------------------

/** One entry of the Brain changes feed (contract C19). */
export interface BrainChange {
  id: number;
  harvest: string;
  at: number;
  /** A change that was committed, or one that was refused (with `code` and `reason`). */
  status: "committed" | "rejected";
  /** A committed change the owner undid. */
  reverted: boolean;
  revertedAt: number | null;
  scope: string | null;
  slug: string | null;
  path: string;
  op: "create" | "update" | "delete" | "rename";
  employee: string;
  source: { kind: "ticket" | "conversation"; id: string };
  code: string | null;
  reason: string | null;
  commit: string | null;
  diff: string;
  notes: string[];
  untrusted: boolean;
  policy: boolean;
  conflict: boolean;
  /** A committed change that has not been undone. */
  revertible: boolean;
}

interface ChangeRow extends Row {
  id: number;
  harvest: string;
  at: number;
  status: "committed" | "rejected";
  employee_id: string;
  ref_kind: string;
  ref_id: string;
  scope: string | null;
  slug: string | null;
  path: string;
  op: string;
  code: string | null;
  reason: string | null;
  repo: string | null;
  commit_sha: string | null;
  diff: string;
  notes: string;
  untrusted: number;
  policy: number;
  conflict: number;
  reverted_at: number | null;
  revert_sha: string | null;
}

const toChange = (r: ChangeRow): BrainChange => ({
  id: r.id,
  harvest: r.harvest,
  at: r.at,
  status: r.status,
  reverted: r.reverted_at !== null,
  revertedAt: r.reverted_at,
  scope: r.scope,
  slug: r.slug,
  path: r.path,
  op: r.op as BrainChange["op"],
  employee: r.employee_id,
  source: { kind: r.ref_kind === "conversation" ? "conversation" : "ticket", id: r.ref_id },
  code: r.code,
  reason: r.reason,
  commit: r.commit_sha,
  diff: r.diff,
  notes: JSON.parse(r.notes) as string[],
  untrusted: r.untrusted === 1,
  policy: r.policy === 1,
  conflict: r.conflict === 1,
  revertible: r.status === "committed" && r.reverted_at === null && r.commit_sha !== null,
});

/** Why the owner's undo did not happen; `status` is the HTTP status the API answers. */
export class RevertError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface FeedQuery {
  scope?: string;
  employee?: string;
  status?: "committed" | "rejected";
  limit?: number;
  /** Entries older than this id. */
  before?: number;
}

export interface FeedPage {
  changes: BrainChange[];
  /** Pass as `before` for the next page; null at the end. */
  next: number | null;
  /** Every scope and employee that has an entry, for the filters. */
  facets: { scopes: string[]; employees: string[] };
}

function skipped(detail: string): HarvestReport {
  return { id: null, status: "skipped", committed: 0, rejected: 0, detail };
}
