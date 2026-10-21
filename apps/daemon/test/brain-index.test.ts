// The brain's search index: built from the git repos, kept current after every commit, ranked by BM25
// and scope, linked, mapped, and fast.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildQuery, type ProposedEdit, retrieve, type Scope } from "@i-inc/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { BrainIndex, Fts5UnavailableError } from "../src/brain-index.ts";
import { openDb } from "../src/db.ts";
import { KnowledgeStore } from "../src/knowledge.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const page = (title: string, description: string, body: string, tags: string[] = []) =>
  `---\ntitle: ${title}\ndescription: ${description}\ntags: [${tags.join(", ")}]\nupdated: 2026-10-01\nsources: []\n---\n${body}\n`;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "i-inc-brain-"));
  roots.push(root);
  const store = new KnowledgeStore(root);
  const index = await BrainIndex.open(":memory:", store);
  store.onCommit = (repo) => index.follow(repo);
  store.ensureHandbook();
  store.ensureBrain({ id: "ada", name: "Ada", role: "Engineer" });
  store.ensureBrain({ id: "pia", name: "Pia", role: "Personal Assistant" });

  /** Writes files into a repo and commits them in one go (the way a harvest or a migration would). */
  const commit = (repo: "handbook" | string, files: Record<string, string>, message = "Add pages") => {
    const dir = repo === "handbook" ? join(root, "handbook") : join(root, "brains", repo);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], {
        cwd: dir,
        stdio: "pipe",
      });
    git("add", "-A");
    git("commit", "-q", "-m", message);
    store.onCommit?.(repo === "handbook" ? { kind: "handbook" } : { kind: "brain", id: repo });
  };
  const rm = (repo: string, path: string) => {
    const dir = repo === "handbook" ? join(root, "handbook") : join(root, "brains", repo);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "rm", "-q", path], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "rm"],
      { cwd: dir },
    );
    store.onCommit?.(repo === "handbook" ? { kind: "handbook" } : { kind: "brain", id: repo });
  };
  const all: Scope[] = ["brain:ada", "team:eng", "company"];
  return { root, store, index, commit, rm, all };
}

describe("building the index", () => {
  it("indexes every page of every repo into its scope, skipping the old maps", async () => {
    const { index, commit } = await setup();
    commit("handbook", {
      "facts/gh-cli.md": page("GitHub CLI", "gh pr checks waits for CI", "Use gh pr checks --watch."),
      "projects/duet.md": page("Duet", "The couples' finance app", "Tauri and Lit."),
      "teams/eng/release.md": page("Release", "How eng releases", "Cut with release-please."),
    });
    commit("ada", { "tools/vitest.md": "# Vitest\n\nReset mocks between tests.\n" });
    index.rebuild();

    expect(index.pages().map((p) => `${p.scope}/${p.slug}`)).toEqual([
      "brain:ada/personality",
      "brain:ada/tools/vitest",
      "brain:pia/personality",
      "company/facts/gh-cli",
      "company/projects/duet",
      "team:eng/release",
    ]);
    const v = index.pages(["brain:ada"]).find((p) => p.slug === "tools/vitest");
    // A page without frontmatter gets a title and description from its text, and a date from git.
    expect(v).toMatchObject({ title: "Vitest", description: "Reset mocks between tests.", tags: [] });
    expect(v?.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v?.words).toBeGreaterThan(3);
    expect(v?.gitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(index.pages(["company"]).find((p) => p.slug === "facts/gh-cli")?.updated).toBe("2026-10-01");
  });

  it("follows each KnowledgeStore commit incrementally", async () => {
    const { index, store, rm, commit } = await setup();
    const hit = (q: string, scope: Scope) => index.search(buildQuery(q), [scope], 10).map((h) => h.slug);
    expect(hit("squash", "company")).toEqual([]);

    // A learned edit through the store's own API shows up straight away…
    const edit: ProposedEdit = {
      id: "1:0:a0",
      ticketId: "1",
      author: "ada",
      at: 0,
      edit: { layer: "fact", page: "merging", text: "Squash-merge every PR." },
    };
    store.apply(edit, () => ({ name: "Ada", role: "Engineer" }));
    expect(hit("squash merge", "company")).toEqual(["facts/merging"]);

    // …an appended edit re-reads only that page…
    const before = index.pages(["company"]).find((p) => p.slug === "facts/merging");
    store.apply({ ...edit, id: "1:1:a0", edit: { ...edit.edit, text: "Rebase never." } }, () => ({
      name: "Ada",
      role: "Engineer",
    }));
    const after = index.pages(["company"]).find((p) => p.slug === "facts/merging");
    expect(after?.gitSha).not.toBe(before?.gitSha);
    expect(hit("rebase", "company")).toEqual(["facts/merging"]);

    // …and deleting a page, or reverting, removes it.
    commit("handbook", { "facts/extra.md": page("Extra", "zebra facts", "zebra") });
    expect(hit("zebra", "company")).toEqual(["facts/extra"]);
    rm("handbook", "facts/extra.md");
    expect(hit("zebra", "company")).toEqual([]);
    expect(index.pages(["company"]).map((p) => p.slug)).toEqual(["facts/merging"]);
  });

  it("an incremental update gives the same index as a full rebuild", async () => {
    const { index, commit, rm } = await setup();
    commit("handbook", {
      "facts/a.md": page("A", "alpha", "alpha body [[b]]"),
      "facts/b.md": page("B", "beta", "beta body"),
    });
    commit("handbook", {
      "facts/a.md": page("A", "alpha two", "alpha changed [[c]]"),
      "facts/c.md": "# C\n\ngamma\n",
    });
    rm("handbook", "facts/b.md");
    const dump = () =>
      JSON.stringify([
        index.pages().map(({ lastUsedAt: _a, useCount: _b, ...p }) => p),
        index
          .search('"alpha" OR "beta" OR "gamma" OR "changed"', ["company"], 10)
          .map((h) => [h.slug, h.snippet]),
        index.linksOf("company", "facts/a", ["company"]),
      ]);
    const incremental = dump();
    index.rebuild();
    expect(dump()).toBe(incremental);
  });

  it("keeps usage counters across a rebuild", async () => {
    const { index, commit } = await setup();
    commit("handbook", { "facts/a.md": page("A", "alpha", "alpha") });
    index.markUsed("company", "facts/a", 1234);
    index.markUsed("company", "facts/a", 1300);
    index.rebuild();
    expect(index.pages(["company"])[0]).toMatchObject({ useCount: 2, lastUsedAt: 1300 });
    // A rewritten page keeps its counters too.
    commit("handbook", { "facts/a.md": page("A", "alpha", "alpha, rewritten") });
    expect(index.pages(["company"])[0]).toMatchObject({ useCount: 2, lastUsedAt: 1300 });
  });

  it("flags needs-tidy and external pages", async () => {
    const { index, commit } = await setup();
    commit("handbook", {
      "facts/a.md": `---\ntitle: A\ndescription: a\nneeds-tidy: true\nsource: external\n---\nx\n`,
    });
    expect(index.needingTidy().map((p) => p.slug)).toEqual(["facts/a"]);
    expect(index.pages(["company"])[0]?.external).toBe(true);
  });
});

describe("ranking", () => {
  it("ranks a title match above a body match (BM25 weights title 5, description 3, tags 2, body 1)", async () => {
    const { index, commit } = await setup();
    const filler = "Quarantine them and file a ticket for each one we find.";
    commit("handbook", {
      "facts/body-only.md": page("Misc notes", "odds and ends", `${filler} Mind the flaky one.`),
      "facts/title.md": page("Flaky", "odds and ends", filler),
      "facts/desc.md": page("Misc", "How to handle flaky", filler),
      "facts/tags.md": page("Misc two", "odds and ends", filler, ["flaky"]),
    });
    const hits = index.search(buildQuery("flaky"), ["company"], 10);
    expect(hits.map((h) => h.slug)).toEqual(["facts/title", "facts/desc", "facts/tags", "facts/body-only"]);
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it("stems words (porter) and gives a snippet", async () => {
    const { index, commit } = await setup();
    commit("handbook", { "facts/a.md": page("Notes", "x", "The runner was running the deployments.") });
    const [h] = index.search(buildQuery("deploy run"), ["company"], 5);
    expect(h?.slug).toBe("facts/a");
    expect(h?.snippet).toContain("running");
  });

  it("only searches the scopes it is given", async () => {
    const { index, commit } = await setup();
    commit("pia", { "reference/home.md": page("Home data", "the mortgage account", "mortgage numbers") });
    commit("handbook", { "facts/a.md": page("Mortgage", "x", "mortgage") });
    const q = buildQuery("mortgage");
    expect(index.search(q, ["brain:ada", "company"], 10).map((h) => h.scope)).toEqual(["company"]);
    expect(index.search(q, ["brain:pia"], 10).map((h) => h.slug)).toEqual(["reference/home"]);
    expect(index.search(q, [], 10)).toEqual([]);
  });

  it("boosts the closest scope: identical text ranks own brain, then team, then company", async () => {
    const { index, commit } = await setup();
    const same = page("Database migrations", "How we run migrations", "Run them with the tool.");
    commit("handbook", { "facts/migrations.md": same, "teams/eng/migrations.md": same });
    commit("ada", { "tools/migrations.md": same });
    const out = retrieve(index, {
      query: "database migrations",
      scopes: ["brain:ada", "team:eng", "company"],
    });
    expect(out.map((p) => p.scope)).toEqual(["brain:ada", "team:eng", "company"]);
    // The boost is a multiplier on the BM25 score.
    expect((out[0]?.score ?? 0) / (out[2]?.score ?? 1)).toBeCloseTo(1.5, 1);
    // Without the own-brain scope the team section still beats the company.
    expect(
      retrieve(index, { query: "database migrations", scopes: ["team:eng", "company"] }).map((p) => p.scope),
    ).toEqual(["team:eng", "company"]);
  });

  it("adds pages one link from the best two, only through scopes the reader can read", async () => {
    const { index, commit } = await setup();
    commit("handbook", {
      "facts/migrations.md": page(
        "Database migrations",
        "How we run migrations",
        "Run them with the tool. See [[rollbacks]] and [[tools/pia-secret]].",
      ),
      "facts/rollbacks.md": page("Rollbacks", "Undoing a change", "Revert the commit."),
    });
    commit("pia", { "tools/pia-secret.md": page("Secret", "home data", "never share") });
    const out = retrieve(index, {
      query: "database migrations",
      scopes: ["brain:ada", "team:eng", "company"],
    });
    expect(out.map((p) => [`${p.scope}/${p.slug}`, p.via])).toEqual([
      ["company/facts/migrations", "search"],
      ["company/facts/rollbacks", "link"],
    ]);
    // Pia herself can follow the link into her own brain.
    const pia = retrieve(index, { query: "database migrations", scopes: ["brain:pia", "company"] });
    expect(pia.map((p) => p.slug)).toEqual(["facts/migrations", "facts/rollbacks", "tools/pia-secret"]);
  });

  it("resolves links to the reader's own scope first", async () => {
    const { index, commit } = await setup();
    commit("handbook", {
      "facts/a.md": page("A", "a", "see [[notes]]"),
      "facts/notes.md": page("Notes", "n", "company notes"),
    });
    commit("ada", { "tools/notes.md": page("Notes", "n", "ada notes") });
    // Bare name "notes": in company, only facts/notes matches; Ada's tools/notes is another scope.
    expect(index.linksOf("company", "facts/a", ["brain:ada", "company"])).toEqual([
      { scope: "company", slug: "facts/notes" },
    ]);
  });
});

describe("hostile input", () => {
  it("survives 100 KB of FTS syntax in under 50 ms", async () => {
    const { index, commit } = await setup();
    commit("handbook", { "facts/a.md": page("A", "alpha", "alpha beta") });
    const nasty = ['"(*^:NEAR('.repeat(8000), `${"alpha ".repeat(20000)}`, '" OR title:a*'.repeat(8000)];
    for (const text of nasty) {
      const t = performance.now();
      const out = retrieve(index, { query: text, scopes: ["company"] });
      expect(performance.now() - t).toBeLessThan(50);
      expect(Array.isArray(out)).toBe(true);
    }
    // Even a raw bad expression finds nothing instead of throwing.
    expect(index.search('"unbalanced', ["company"], 5)).toEqual([]);
    expect(index.search("NEAR(", ["company"], 5)).toEqual([]);
  });
});

describe("maps", () => {
  it("lists one line per page with its description, by folder", async () => {
    const { index, commit } = await setup();
    commit("ada", {
      "tools/vitest.md": page("Vitest", "Reset mocks between tests", "x"),
      "duties/review.md": page("Review", "What Ada checks first", "x"),
    });
    const m = index.mapFor("brain:ada");
    expect(m.sections).toEqual({});
    expect(m.root).toContain("- [[tools/vitest]] — Reset mocks between tests");
    expect(m.root).toContain("## duties");
    expect(m.root).toContain("- [[personality]] — Ada is a Engineer at i.inc.");
  });

  it("splits a big scope into sections of at most 150 lines", async () => {
    const { index, commit } = await setup();
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`facts/p${i}.md`] = page(`P${i}`, `about ${i}`, "x");
    commit("handbook", files);
    const m = index.mapFor("company");
    expect(m.root.length).toBeLessThanOrEqual(150);
    expect(Object.keys(m.sections)).toEqual(["facts", "facts#2", "facts#3"]);
    expect(
      Object.values(m.sections)
        .flat()
        .filter((l) => l.startsWith("- [[")).length,
    ).toBe(300);
  });
});

describe("performance", () => {
  it("rebuilds 1,000 pages in under 3 s and answers a query in under 20 ms", async () => {
    const { index, commit } = await setup();
    const words =
      "alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega release deploy test build review".split(
        " ",
      );
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      const body = Array.from({ length: 120 }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(" ");
      files[`facts/page-${i}.md`] = page(
        `Page ${i} ${words[i % words.length]}`,
        `About ${words[i % 17]} things`,
        `${body} [[page-${(i + 1) % 1000}]]`,
        [words[i % 5] ?? "x"],
      );
    }
    commit("handbook", files);

    const t0 = performance.now();
    index.rebuild();
    const rebuildMs = performance.now() - t0;
    expect(index.pages(["company"]).length).toBe(1000);

    const q = buildQuery("how do we release and deploy the review build for kappa");
    index.search(q, ["company"], 50); // warm
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      retrieve(index, {
        query: "how do we release and deploy the review build for kappa",
        scopes: ["brain:ada", "company"],
      });
      times.push(performance.now() - t);
    }
    const queryMs = Math.max(...times);
    console.log(
      `brain index: rebuild(1000 pages) ${rebuildMs.toFixed(0)} ms; retrieve max ${queryMs.toFixed(1)} ms`,
    );
    expect(rebuildMs).toBeLessThan(3000);
    expect(queryMs).toBeLessThan(20);
  });
});

describe("startup", () => {
  it("fails loudly, with a clear message, when SQLite has no FTS5", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-inc-brain-"));
    roots.push(root);
    const noFts5 = () => {
      throw new Error("no such module: fts5");
    };
    const store = new KnowledgeStore(root);
    const err = await BrainIndex.open(":memory:", store, undefined, { probe: noFts5 }).catch((e) => e);
    expect(err).toBeInstanceOf(Fts5UnavailableError);
    expect(err.message).toMatch(/needs SQLite's FTS5/);
    expect(err.message).toMatch(/no such module: fts5/);

    // The whole app refuses to start, and a file index is not moved aside for it.
    const file = join(root, "brain-index.db");
    const app = createApp({
      dbPath: ":memory:",
      knowledgeDir: join(root, "knowledge"),
      brainIndexPath: file,
      brainProbe: noFts5,
      // biome-ignore lint/suspicious/noExplicitAny: the ports aren't reached before the index fails
      ...({} as any),
    });
    await expect(app).rejects.toBeInstanceOf(Fts5UnavailableError);
    expect(readdirSync(root).filter((f) => f.includes("corrupt"))).toEqual([]);
  });

  it("moves a corrupt index file aside and rebuilds from git", async () => {
    const { root, store, commit } = await setup();
    commit("handbook", { "facts/a.md": page("A", "alpha", "alpha body") });
    const file = join(root, "brain-index.db");
    writeFileSync(file, Buffer.alloc(5000, "this is not a sqlite database "));
    writeFileSync(`${file}-wal`, "junk");
    const logs: string[] = [];
    const index = await BrainIndex.open(file, store, (m) => logs.push(m));
    index.rebuild();
    expect(index.pages(["company"]).map((p) => p.slug)).toEqual(["facts/a"]);
    expect(index.search(buildQuery("alpha"), ["company"], 5).length).toBe(1);
    const aside = readdirSync(root).filter((f) => f.startsWith("brain-index.db.corrupt-"));
    expect(aside.length).toBe(1);
    expect(
      readFileSync(join(root, aside[0] ?? ""))
        .subarray(0, 12)
        .toString(),
    ).toBe("this is not ");
    expect(logs.join("\n")).toMatch(/not a usable database/);
    index.close();

    // A good file is left alone and reused.
    const again = await BrainIndex.open(file, store);
    expect(again.pages(["company"]).length).toBe(1);
    expect(readdirSync(root).filter((f) => f.includes("corrupt")).length).toBe(1);
    again.close();
  });

  it("opens the index file in WAL mode with a 5 s busy timeout", async () => {
    const { root, store } = await setup();
    const file = join(root, "brain-index.db");
    const index = await BrainIndex.open(file, store);
    index.close();
    expect(existsSync(file)).toBe(true);
    const raw = await openDb(file);
    expect(raw.all("PRAGMA busy_timeout")).toEqual([{ timeout: 5000 }]);
    expect(raw.all("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    raw.close();
  });
});
