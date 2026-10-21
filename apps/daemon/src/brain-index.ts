// The brain's search index (docs/design/brain.md, "The index"): a SEPARATE, disposable SQLite file
// next to the daemon's. Markdown in git is the truth; this is rebuilt from the repos at any time (at
// startup, and incrementally after every KnowledgeStore commit). It holds a page table, an FTS5 table
// (BM25 weighted title 5, description 3, tags 2, body 1; porter + unicode61) and the [[links]].
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

/** Bump when the tables change. A different version rebuilds the file from scratch. */
const schemaVersion = 1;

/** BM25 column weights, in the FTS table's column order: title, description, tags, body. */
export const bm25Weights = [5, 3, 2, 1] as const;

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
/** The scopes a repo's files land in: the handbook has the company's and every team's. */
const scopeFilter = (r: Repo): { sql: string; params: Param[] } =>
  r.kind === "handbook"
    ? { sql: "(scope = 'company' OR scope LIKE 'team:%')", params: [] }
    : { sql: "scope = ?", params: [`brain:${r.id}`] };

export class BrainIndex implements RetrievalSource {
  private constructor(
    private readonly db: Db,
    private readonly store: KnowledgeStore,
    private readonly log: (msg: string) => void,
  ) {}

  /**
   * Opens (or creates) the index file. Throws `Fts5UnavailableError` when this SQLite has no FTS5, so
   * the daemon refuses to start with a clear message rather than failing on the first search.
   */
  static async open(path: string, store: KnowledgeStore, log: (msg: string) => void = () => {}) {
    const db = await openDb(path);
    const index = new BrainIndex(db, store, log);
    index.init();
    return index;
  }

  private init(): void {
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts5_probe USING fts5(x)");
      this.db.exec("DROP TABLE IF EXISTS temp.fts5_probe");
    } catch (e) {
      throw new Fts5UnavailableError(e);
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const [row] = this.db.all<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'");
    if (row?.value !== String(schemaVersion)) {
      this.db.exec("DROP TABLE IF EXISTS pages; DROP TABLE IF EXISTS pages_fts; DROP TABLE IF EXISTS links");
    }
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
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)", String(schemaVersion));
  }

  close(): void {
    this.db.close();
  }

  // ---- Building ------------------------------------------------------------------------------------

  /**
   * Rebuilds everything from the git repos. Usage counters survive (they aren't in git); pages whose
   * repo is gone don't.
   */
  rebuild(): void {
    const stats = new Map(
      this.db
        .all<PageRow>("SELECT * FROM pages WHERE use_count > 0 OR last_used_at IS NOT NULL")
        .map((r) => [`${r.scope}\0${r.slug}`, { n: r.use_count, at: r.last_used_at }] as const),
    );
    this.db.transaction(() => {
      this.db.exec("DELETE FROM pages; DELETE FROM pages_fts; DELETE FROM links;");
      for (const repo of this.store.repos()) this.syncRepo(repo);
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
  }

  /** Brings one repo's pages up to date with its HEAD: only pages whose blob changed are re-read. */
  sync(repo: Repo): void {
    this.db.transaction(() => this.syncRepo(repo));
  }

  /** The hook for `KnowledgeStore.onCommit`: a failure here must never break a commit. */
  follow(repo: Repo): void {
    try {
      this.sync(repo);
    } catch (e) {
      this.log(`brain index: couldn't update after a commit to ${repo.kind}: ${String(e)}`);
    }
  }

  private syncRepo(repo: Repo): void {
    const want = new Map<string, { scope: Scope; slug: string; path: string; sha: string }>();
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
    // Pages with no `updated:` of their own take the date they were last committed.
    const parsed = changed.map(([key, w]) => ({ key, w, page: parsePage(texts.get(w.sha) ?? "", w.slug) }));
    const undated = parsed.filter((p) => !p.page.meta.updated).map((p) => p.w.path);
    const when = this.store.modified(repo, undated);

    for (const { key, w, page } of parsed) {
      const old = have.get(key);
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
      ? { scope, slug, title: r.title, description: r.description, updated: r.updated, body: r.body }
      : null;
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

  /** A scope's map: one line per page, in sections; `section` picks one of a split map's sections. */
  mapFor(scope: Scope): BuiltMap {
    const pages: MapPage[] = this.db
      .all<PageRow>("SELECT slug, title, description FROM pages WHERE scope = ? ORDER BY slug", scope)
      .map((r) => ({ slug: r.slug, title: r.title, description: r.description }));
    return buildMap(pages);
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
