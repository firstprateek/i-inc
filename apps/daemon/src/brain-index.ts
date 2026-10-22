// The brain's search index (docs/design/brain.md, "The index"): a SEPARATE, disposable SQLite file
// next to the daemon's. Markdown in git is the truth; this is rebuilt from the repos at any time (at
// startup, and incrementally after every KnowledgeStore commit). It holds a page table, an FTS5 table
// (BM25 weighted title 5, description 3, tags 2, body 1; porter + unicode61) and the [[links]].

import { existsSync, renameSync, rmSync } from "node:fs";
import {
  type BuiltMap,
  buildMap,
  type Hit,
  isoDate,
  type MapPage,
  parsePage,
  type RepoRef,
  type RetrievalSource,
  type Scope,
  type StoredPage,
  scopeOfPath,
  wordCount,
} from "@i-inc/core";
import { type Db, openDb, type Param, type Row } from "./db.ts";
import type { KnowledgeStore, Repo } from "./knowledge.ts";

/**
 * Bump when the tables change, or when the page parser changes what it indexes. A different version
 * rebuilds the file from scratch (the tables are dropped and made again).
 */
const schemaVersion = 2;

/** BM25 column weights, in the FTS table's column order: title, description, tags, body. */
export const bm25Weights = [5, 3, 2, 1] as const;

/** Whether this SQLite can make an FTS5 table. Throws if not. */
export function probeFts5(db: Db): void {
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts5_probe USING fts5(x)");
  db.exec("DROP TABLE IF EXISTS temp.fts5_probe");
}

export class Fts5UnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `The brain index needs SQLite's FTS5 full-text extension, and this SQLite doesn't have it (${
        cause instanceof Error ? cause.message : String(cause)
      }). Use a Bun or Node build with FTS5 enabled; the stock Bun and Node 22+ builds have it.`,
    );
    this.name = "Fts5UnavailableError";
  }
}

export interface IndexedPage {
  scope: Scope;
  slug: string;
  title: string;
  description: string;
  tags: string[];
  updated: string | null;
  words: number;
  lastUsedAt: number | null;
  useCount: number;
  gitSha: string;
  needsTidy: boolean;
  external: boolean;
}

interface PageRow extends Row {
  id: number;
  scope: string;
  slug: string;
  title: string;
  description: string;
  tags: string;
  updated: string | null;
  words: number;
  last_used_at: number | null;
  use_count: number;
  git_sha: string;
  needs_tidy: number;
  external: number;
}

const toPage = (r: PageRow): IndexedPage => ({
  scope: r.scope as Scope,
  slug: r.slug,
  title: r.title,
  description: r.description,
  tags: JSON.parse(r.tags) as string[],
  updated: r.updated,
  words: r.words,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
  gitSha: r.git_sha,
  needsTidy: r.needs_tidy === 1,
  external: r.external === 1,
});

const repoRef = (r: Repo): RepoRef => r;

/** A page to write: where it lives and the blob it is at. */
interface Item {
  scope: Scope;
  slug: string;
  path: string;
  sha: string;
}
/** The scopes a repo's files land in: the handbook has the company's and every team's. */
const scopeFilter = (r: Repo): { sql: string; params: Param[] } =>
  r.kind === "handbook"
    ? { sql: "(scope = 'company' OR scope LIKE 'team:%')", params: [] }
    : { sql: "scope = ?", params: [`brain:${r.id}`] };

export class BrainIndex implements RetrievalSource {
  /** Built maps by scope. Pages only change through `sync` and `rebuild`, which clear it. */
  private readonly maps = new Map<string, BuiltMap>();

  private constructor(
    private readonly db: Db,
    private readonly store: KnowledgeStore,
    private readonly log: (msg: string) => void,
    private readonly path: string,
  ) {}

  /**
   * Opens (or creates) the index file. Throws `Fts5UnavailableError` when this SQLite has no FTS5, so
   * the daemon refuses to start with a clear message rather than failing on the first search. A file
   * that isn't a usable SQLite database (the index is disposable) is moved aside and made again; the
   * caller rebuilds it from git. `o.probe` is the FTS5 capability check, injectable for tests.
   */
  static async open(
    path: string,
    store: KnowledgeStore,
    log: (msg: string) => void = () => {},
    o: { probe?: (db: Db) => void } = {},
  ): Promise<BrainIndex> {
    const attempt = async () => {
      const db = await openDb(path);
      try {
        const index = new BrainIndex(db, store, log, path);
        index.init(o.probe ?? probeFts5);
        return index;
      } catch (e) {
        db.close();
        throw e;
      }
    };
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof Fts5UnavailableError || path === ":memory:" || !existsSync(path)) throw e;
      const aside = `${path}.corrupt-${Date.now()}`;
      log(`brain index: ${path} is not a usable database (${String(e)}); moved to ${aside} and rebuilding`);
      renameSync(path, aside);
      for (const ext of ["-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
      return await attempt();
    }
  }

  private init(probe: (db: Db) => void): void {
    try {
      probe(this.db);
    } catch (e) {
      throw new Fts5UnavailableError(e);
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const [row] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'");
    if (row?.value !== String(schemaVersion)) {
      // An older file's tables go, and the file shrinks to what is left before they are made again.
      this.dropTables();
      this.compact();
    }
    this.createTables();
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", String(schemaVersion));
  }

  private dropTables(): void {
    this.db.exec(
      "DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS pages_fts; DROP TABLE IF EXISTS links; DELETE FROM meta WHERE key LIKE 'head:%';",
    );
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        tags TEXT NOT NULL,
        updated TEXT,
        words INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        git_sha TEXT NOT NULL,
        needs_tidy INTEGER NOT NULL DEFAULT 0,
        external INTEGER NOT NULL DEFAULT 0,
        UNIQUE (scope, slug)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
        title, description, tags, body,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS links (
        from_scope TEXT NOT NULL,
        from_slug TEXT NOT NULL,
        to_slug TEXT NOT NULL,
        PRIMARY KEY (from_scope, from_slug, to_slug)
      );
      CREATE INDEX IF NOT EXISTS links_to ON links (to_slug);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---- Building ------------------------------------------------------------------------------------

  /**
   * Rebuilds everything from the git repos, into tables made new (dropped and created again, then the
   * file compacted), so a rebuild is always the size of the pages and never of the rebuilds before it.
   * Usage counters survive (they aren't in git); pages whose repo is gone don't.
   */
  rebuild(): void {
    this.maps.clear();
    const stats = new Map(
      this.db
        .all<PageRow>("SELECT * FROM pages WHERE use_count > 0 OR last_used_at IS NOT NULL")
        .map((r) => [`${r.scope}\0${r.slug}`, { n: r.use_count, at: r.last_used_at }] as const),
    );
    this.db.transaction(() => {
      this.dropTables();
      this.createTables();
      for (const repo of this.store.repos()) {
        this.syncRepo(repo);
        this.setHead(repo);
      }
      for (const [key, s] of stats) {
        const [scope, slug] = key.split("\0");
        this.db.run(
          "UPDATE pages SET use_count = ?, last_used_at = ? WHERE scope = ? AND slug = ?",
          s.n,
          s.at,
          scope ?? "",
          slug ?? "",
        );
      }
    });
    this.compact();
  }

  /** Hands the freed pages back to the file system: VACUUM, then empty the write-ahead log. */
  private compact(): void {
    if (this.path === ":memory:") return;
    try {
      this.db.exec("VACUUM");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      this.log(`brain index: couldn't compact ${this.path}: ${String(e)}`);
    }
  }

  // ---- Keeping up ----------------------------------------------------------------------------------
  //
  // The index remembers the HEAD of each repo it has read (`meta`, key `head:<repo>`). An update that
  // names the paths a commit touched is trusted only when that commit's parent IS the remembered HEAD;
  // in every other case (an external commit such as the migration run while the daemon is up, a
  // follow that failed, a force-push, anything unexpected) the whole tree is compared by blob id,
  // which re-reads only the pages that changed. So the index heals by itself and needs no restart.

  private headKey = (repo: Repo): string =>
    `head:${repo.kind === "handbook" ? "handbook" : `brain:${repo.id}`}`;

  private indexedHead(repo: Repo): string | null {
    const [r] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = ?", this.headKey(repo));
    return r ? r.value : null;
  }

  private setHead(repo: Repo, sha?: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      this.headKey(repo),
      sha ?? this.store.head(repo)?.sha ?? "",
    );
  }

  /**
   * Brings one repo's pages up to date with its HEAD. Given the paths a commit touched, only those are
   * read (one `git cat-file` for all of them, nothing at all when none is a page), but only when that
   * commit follows the HEAD already indexed; otherwise, or without paths, the whole tree is compared by
   * blob id and only changed pages are re-read.
   */
  sync(repo: Repo, paths?: string[], stampMs?: number): void {
    const indexed = this.indexedHead(repo);
    // The cheap look first: HEAD read from the repo's files. Nothing new, nothing to do.
    const quick = this.store.headSha(repo);
    if (quick !== null && quick === indexed) return;
    const head = this.store.head(repo);
    if (head && indexed === head.sha) return; // already there
    const next = head !== null && indexed !== null && head.parent === indexed;
    this.maps.clear();
    this.db.transaction(() => {
      if (next) {
        const touched = paths ?? this.store.changedPaths(repo);
        // A commit with no page in it (a map, a dotfile) changes nothing here.
        if (touched.some((p) => scopeOfPath(repoRef(repo), p)))
          this.syncPaths(repo, touched, paths ? stampMs : undefined);
      } else {
        this.syncRepo(repo);
      }
      this.setHead(repo, head?.sha);
    });
  }

  /** The hook for `KnowledgeStore.onCommit`: a failure here must never break a commit. */
  follow(repo: Repo, paths?: string[]): void {
    try {
      // Pages with no date of their own take the commit's: our own write just now, or HEAD's time.
      this.sync(repo, paths, paths !== undefined ? this.store.clock() : undefined);
    } catch (e) {
      this.log(`brain index: couldn't update after a commit to ${repo.kind}: ${String(e)}`);
    }
  }

  /**
   * Looks at every repo's HEAD and brings the index up to date where it differs; drops the pages of
   * repos that are gone. This is what makes a restart unnecessary after anything changes a repo
   * behind the daemon's back. It costs a couple of small file reads a repo when nothing changed, so
   * it can run at every brief and every API read, with no clock to get wrong. Returns the repos that
   * were behind.
   */
  refresh(): number {
    let behind = 0;
    const repos = this.store.repos();
    for (const repo of repos) {
      const before = this.indexedHead(repo);
      try {
        this.sync(repo);
      } catch (e) {
        this.log(`brain index: couldn't update ${repo.kind}: ${String(e)}`);
        continue;
      }
      if (before !== this.indexedHead(repo)) behind++;
    }
    // Pages of a repo that was deleted from the disk.
    const here = new Set(repos.map((r) => this.headKey(r)));
    const gone = this.db
      .all<{ scope: string }>("SELECT DISTINCT scope FROM pages")
      .map((r) => r.scope)
      .filter((scope) => !here.has(scope.startsWith("brain:") ? `head:${scope}` : "head:handbook"));
    if (gone.length) {
      this.maps.clear();
      this.db.transaction(() => {
        for (const scope of gone) {
          for (const r of this.db.all<{ id: number; slug: string }>(
            "SELECT id, slug FROM pages WHERE scope = ?",
            scope,
          )) {
            this.remove(r.id, scope, r.slug);
          }
        }
      });
      behind++;
    }
    return behind;
  }

  private syncPaths(repo: Repo, paths: string[], stampMs?: number): void {
    const ats = [...new Set(paths)].flatMap((path) => {
      const at = scopeOfPath(repoRef(repo), path);
      return at ? [{ ...at, path }] : [];
    });
    const heads = this.store.readAtHead(
      repo,
      ats.map((a) => a.path),
    );
    const changed: Item[] = [];
    const texts = new Map<string, string>();
    for (const at of ats) {
      const [old] = this.db.all<PageRow>(
        "SELECT id, scope, slug, git_sha FROM pages WHERE scope = ? AND slug = ?",
        at.scope,
        at.slug,
      );
      const head = heads.get(at.path);
      if (!head) {
        if (old) this.remove(old.id, old.scope, old.slug);
      } else if (old?.git_sha !== head.sha) {
        changed.push({ ...at, sha: head.sha });
        texts.set(head.sha, head.text);
      }
    }
    this.upsert(repo, changed, texts, () => stampMs ?? this.store.headTime(repo));
  }

  private syncRepo(repo: Repo): void {
    const want = new Map<string, Item>();
    for (const [path, sha] of this.store.tree(repo)) {
      const at = scopeOfPath(repoRef(repo), path);
      if (at) want.set(`${at.scope}\0${at.slug}`, { ...at, path, sha });
    }

    const f = scopeFilter(repo);
    const have = new Map<string, PageRow>(
      this.db
        .all<PageRow>(`SELECT id, scope, slug, git_sha FROM pages WHERE ${f.sql}`, ...f.params)
        .map((r) => [`${r.scope}\0${r.slug}`, r] as const),
    );

    for (const [key, r] of have) if (!want.has(key)) this.remove(r.id, r.scope, r.slug);

    const changed = [...want.entries()].filter(([key, w]) => have.get(key)?.git_sha !== w.sha);
    if (!changed.length) return;
    const texts = this.store.blobs(repo, [...new Set(changed.map(([, w]) => w.sha))]);
    this.upsert(
      repo,
      changed.map(([, w]) => w),
      texts,
    );
  }

  /** Writes (or rewrites) pages: row, FTS entry and links. Counters of a rewritten page are kept. */
  private upsert(repo: Repo, items: Item[], texts: Map<string, string>, stamp?: () => number): void {
    if (!items.length) return;
    // Pages with no `updated:` of their own take the date they were last committed.
    const parsed = items.map((w) => ({ w, page: parsePage(texts.get(w.sha) ?? "", w.slug) }));
    const undated = parsed.filter((p) => !p.page.meta.updated).map((p) => p.w.path);
    const when = new Map<string, number>();
    if (undated.length) {
      if (stamp) {
        const at = stamp();
        for (const path of undated) when.set(path, at);
      } else for (const [path, at] of this.store.modified(repo, undated)) when.set(path, at);
    }

    for (const { w, page } of parsed) {
      const [old] = this.db.all<PageRow>(
        "SELECT id FROM pages WHERE scope = ? AND slug = ?",
        w.scope,
        w.slug,
      );
      if (old) this.remove(old.id, w.scope, w.slug, true);
      const m = page.meta;
      const stamp = m.updated ?? (when.has(w.path) ? isoDate(when.get(w.path) ?? 0) : null);
      const prior = old
        ? this.db.all<PageRow>("SELECT use_count, last_used_at FROM pages WHERE id = ?", old.id)[0]
        : undefined;
      this.db.run(
        `INSERT INTO pages (scope, slug, title, description, tags, updated, words, last_used_at, use_count,
           git_sha, needs_tidy, external)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, slug) DO UPDATE SET title = excluded.title, description = excluded.description,
           tags = excluded.tags, updated = excluded.updated, words = excluded.words,
           git_sha = excluded.git_sha, needs_tidy = excluded.needs_tidy, external = excluded.external`,
        w.scope,
        w.slug,
        m.title,
        m.description,
        JSON.stringify(m.tags),
        stamp,
        wordCount(page.body),
        prior?.last_used_at ?? null,
        prior?.use_count ?? 0,
        w.sha,
        m.needsTidy ? 1 : 0,
        m.source === "external" ? 1 : 0,
      );
      const [{ id } = { id: 0 }] = this.db.all<{ id: number }>(
        "SELECT id FROM pages WHERE scope = ? AND slug = ?",
        w.scope,
        w.slug,
      );
      this.db.run(
        "INSERT INTO pages_fts (rowid, title, description, tags, body) VALUES (?, ?, ?, ?, ?)",
        id,
        m.title,
        m.description,
        m.tags.join(" "),
        page.body,
      );
      for (const to of page.links) {
        this.db.run(
          "INSERT OR IGNORE INTO links (from_scope, from_slug, to_slug) VALUES (?, ?, ?)",
          w.scope,
          w.slug,
          to,
        );
      }
    }
  }

  /** Drops a page's FTS row and links; the pages row too unless it's about to be replaced. */
  private remove(id: number, scope: string, slug: string, keepRow = false): void {
    this.db.run("DELETE FROM pages_fts WHERE rowid = ?", id);
    this.db.run("DELETE FROM links WHERE from_scope = ? AND from_slug = ?", scope, slug);
    if (!keepRow) this.db.run("DELETE FROM pages WHERE id = ?", id);
  }

  // ---- Reading -------------------------------------------------------------------------------------

  /** Every scope that has pages. */
  scopes(): Scope[] {
    return this.db
      .all<{ scope: string }>("SELECT DISTINCT scope FROM pages ORDER BY scope")
      .map((r) => r.scope as Scope);
  }

  pages(scopes?: Scope[]): IndexedPage[] {
    if (scopes && !scopes.length) return [];
    const where = scopes ? `WHERE scope IN (${scopes.map(() => "?").join(",")})` : "";
    return this.db
      .all<PageRow>(`SELECT * FROM pages ${where} ORDER BY scope, slug`, ...(scopes ?? []))
      .map(toPage);
  }

  page(scope: Scope, slug: string): StoredPage | null {
    const [r] = this.db.all<PageRow & { body: string }>(
      `SELECT p.*, f.body AS body FROM pages p JOIN pages_fts f ON f.rowid = p.id
       WHERE p.scope = ? AND p.slug = ?`,
      scope,
      slug,
    );
    return r
      ? {
          scope,
          slug,
          title: r.title,
          description: r.description,
          updated: r.updated,
          body: r.body,
          external: r.external === 1,
        }
      : null;
  }

  /** How many pages a scope has. */
  count(scope: Scope): number {
    return this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM pages WHERE scope = ?", scope)[0]?.n ?? 0;
  }

  /**
   * Pages matching an FTS5 expression (use `buildQuery`; this never builds one itself), best first.
   * A malformed expression finds nothing rather than throwing.
   */
  search(match: string, scopes: Scope[], limit: number): Hit[] {
    if (!match || !scopes.length) return [];
    try {
      return this.db
        .all<PageRow & { rank: number; snippet: string }>(
          `SELECT p.scope, p.slug, p.title, p.description, p.updated,
             bm25(pages_fts, ${bm25Weights.join(", ")}) AS rank,
             snippet(pages_fts, -1, '', '', '…', 24) AS snippet
           FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
           WHERE pages_fts MATCH ? AND p.scope IN (${scopes.map(() => "?").join(",")})
           ORDER BY rank LIMIT ?`,
          match,
          ...scopes,
          limit,
        )
        .map((r) => ({
          scope: r.scope as Scope,
          slug: r.slug,
          title: r.title,
          description: r.description,
          updated: r.updated,
          score: -r.rank,
          snippet: r.snippet,
        }));
    } catch (e) {
      this.log(`brain index: search failed: ${String(e)}`);
      return [];
    }
  }

  /** `[[links]]` out of a page, resolved through the reader's scopes: the page's own scope first. */
  linksOf(scope: Scope, slug: string, readable: Scope[]): { scope: Scope; slug: string }[] {
    const order = [scope, ...readable.filter((s) => s !== scope)].filter((s) => readable.includes(s));
    const out: { scope: Scope; slug: string }[] = [];
    const seen = new Set<string>();
    for (const l of this.db.all<{ to_slug: string }>(
      "SELECT to_slug FROM links WHERE from_scope = ? AND from_slug = ? ORDER BY to_slug",
      scope,
      slug,
    )) {
      const hit = this.resolve(l.to_slug, order);
      if (hit && !(hit.scope === scope && hit.slug === slug) && !seen.has(`${hit.scope}:${hit.slug}`)) {
        seen.add(`${hit.scope}:${hit.slug}`);
        out.push(hit);
      }
    }
    return out;
  }

  /** Every `[[link]]` out of the pages of these scopes: where it is written and what it names. */
  allLinks(scopes: Scope[]): { scope: Scope; slug: string; to: string }[] {
    if (!scopes.length) return [];
    return this.db
      .all<{ from_scope: string; from_slug: string; to_slug: string }>(
        `SELECT from_scope, from_slug, to_slug FROM links WHERE from_scope IN (${scopes.map(() => "?").join(",")}) ORDER BY from_scope, from_slug, to_slug`,
        ...scopes,
      )
      .map((r) => ({ scope: r.from_scope as Scope, slug: r.from_slug, to: r.to_slug }));
  }

  /** The page a `[[link]]` names, looked for in these scopes in order; null when it names none. */
  resolveLink(to: string, scopes: Scope[]): { scope: Scope; slug: string } | null {
    return this.resolve(to, scopes);
  }

  /** An exact slug, else a unique page whose last path segment is the name, in the first scope that has one. */
  private resolve(to: string, scopes: Scope[]): { scope: Scope; slug: string } | null {
    for (const scope of scopes) {
      const exact = this.db.all<{ slug: string }>(
        "SELECT slug FROM pages WHERE scope = ? AND slug = ?",
        scope,
        to,
      );
      if (exact[0]) return { scope, slug: exact[0].slug };
      if (!to.includes("/")) {
        const byName = this.db.all<{ slug: string }>(
          "SELECT slug FROM pages WHERE scope = ? AND substr(slug, -(length(?) + 1)) = '/' || ? ORDER BY slug LIMIT 2",
          scope,
          to,
          to,
        );
        if (byName.length === 1 && byName[0]) return { scope, slug: byName[0].slug };
      }
    }
    return null;
  }

  /**
   * A scope's map: one line per page by folder; split into named sections when it passes 150 lines.
   * With `mark`, the line of a page built from untrusted content starts with "(untrusted)", so an
   * agent reading the map can't take such a description for the company's own words.
   */
  mapFor(scope: Scope, mark = false): BuiltMap {
    const key = (mark ? "!" : "") + scope;
    const cached = this.maps.get(key);
    if (cached) return cached;
    const pages: MapPage[] = this.db
      .all<PageRow>(
        "SELECT slug, title, description, external FROM pages WHERE scope = ? ORDER BY slug",
        scope,
      )
      .map((r) => ({
        slug: r.slug,
        title: r.title,
        description: mark && r.external === 1 ? `(untrusted) ${r.description}` : r.description,
      }));
    const built = buildMap(pages);
    // Shared between callers, so read-only.
    for (const lines of Object.values(built.sections)) Object.freeze(lines);
    Object.freeze(built.root);
    Object.freeze(built.sections);
    Object.freeze(built);
    this.maps.set(key, built);
    return built;
  }

  /** Counts a page as read (T57 feeds this from retrieval and ACP tool calls). */
  markUsed(scope: Scope, slug: string, at: number): void {
    this.db.run(
      "UPDATE pages SET use_count = use_count + 1, last_used_at = ? WHERE scope = ? AND slug = ?",
      at,
      scope,
      slug,
    );
  }

  /** Pages marked `needs-tidy`, for the tidy-up. */
  needingTidy(): IndexedPage[] {
    return this.db.all<PageRow>("SELECT * FROM pages WHERE needs_tidy = 1 ORDER BY scope, slug").map(toPage);
  }
}
