// The migration of existing pages to the V1 format: dry run by default, --apply commits, no text lost.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, migrateKnowledge, parseArgs } from "../scripts/brain-migrate.ts";
import { BrainIndex } from "../src/brain-index.ts";
import { KnowledgeStore, pageTitle } from "../src/knowledge.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0))
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
    encoding: "utf8",
  });

/** Today's knowledge directory: appended pages, one with a pile of fragments, and one with frontmatter. */
function legacy() {
  const home = mkdtempSync(join(tmpdir(), "i-inc-migrate-"));
  roots.push(home);
  const root = join(home, "knowledge");
  mkdirSync(root);
  const store = new KnowledgeStore(root);
  store.ensureHandbook();
  store.ensureBrain({ id: "ada", name: "Ada", role: "Engineer" });
  // Pages as the daemon wrote them before frontmatter: a heading, then each edit appended.
  const oldApply = (repoDir: string, path: string, ticket: string, n: number, text: string) => {
    const file = join(repoDir, path);
    const isNew = !existsSync(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      isNew ? `# ${pageTitle(path)}\n\n${text}\n` : `${readFileSync(file, "utf8").trimEnd()}\n\n${text}\n`,
    );
    git(repoDir, "add", "-A");
    git(
      repoDir,
      "commit",
      "-q",
      "-m",
      `${isNew ? "Add" : "Update"} ${path}`,
      "-m",
      `Author: ada\nTicket: ${ticket}\nEdit-Id: ${ticket}:${n}:a0`,
    );
  };
  const hbDir = join(root, "handbook");
  const adaDir = join(root, "brains", "ada");
  oldApply(hbDir, "facts/gh-cli.md", "3", 0, "gh pr checks --watch waits for CI.");
  oldApply(hbDir, "facts/gh-cli.md", "5", 1, "Use --fail-fast to stop early.");
  oldApply(hbDir, "facts/gh-cli.md", "9", 2, "It needs a token with checks:read.");
  oldApply(hbDir, "facts/merging.md", "5", 3, "Squash-merge every PR.");
  oldApply(adaDir, "tools/vitest.md", "7", 4, "Reset mocks between tests.");

  const hb = join(root, "handbook");
  mkdirSync(join(hb, "teams", "eng"), { recursive: true });
  writeFileSync(join(hb, "teams", "eng", "release.md"), "# Release\n\nEng cuts releases on Fridays.\n");
  writeFileSync(
    join(hb, "projects.md"),
    "---\ntitle: Projects\ndescription: All projects\ntags: [x]\nupdated: 2026-01-01\nsources: [ticket-1]\n---\nBody stays.\n",
  );
  git(hb, "add", "-A");
  git(hb, "commit", "-q", "-m", "hand-written pages");
  return { root, store, home };
}

const text = (root: string, p: string) => readFileSync(join(root, p), "utf8");
const commits = (dir: string) => git(dir, "rev-list", "--count", "HEAD").trim();

describe("brain migration", () => {
  it("dry-runs by default: it reports what would change and writes nothing", () => {
    const { root } = legacy();
    const hb = join(root, "handbook");
    const before = { gh: text(root, "handbook/facts/gh-cli.md"), head: git(hb, "rev-parse", "HEAD") };

    const report = migrateKnowledge(root);
    expect(report.applied).toBe(false);
    expect(report.commits).toEqual([]);
    const gh = report.pages.find((p) => p.path === "facts/gh-cli.md");
    expect(gh).toMatchObject({ action: "migrate", needsTidy: true });
    expect(gh?.adds).toEqual([
      "frontmatter",
      "title",
      "description",
      "updated",
      "sources",
      "tags",
      "needs-tidy",
    ]);
    // Two edits is not a pile.
    expect(report.pages.find((p) => p.path === "facts/merging.md")?.needsTidy).toBe(false);
    // Already-migrated pages are left alone.
    expect(report.pages.find((p) => p.path === "projects.md")).toMatchObject({ action: "unchanged" });
    // The old map isn't a page.
    expect(report.pages.some((p) => p.path === "INDEX.md")).toBe(false);

    expect(text(root, "handbook/facts/gh-cli.md")).toBe(before.gh);
    expect(git(hb, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(hb, "status", "--porcelain")).toBe("");
  });

  it("applies with --apply: frontmatter from the text and git, bodies untouched, one commit per repo", () => {
    const { root, store } = legacy();
    const hb = join(root, "handbook");
    const body = text(root, "handbook/facts/gh-cli.md");
    const n = commits(hb);

    const report = migrateKnowledge(root, { apply: true });
    expect(report.commits.map((c) => c.replace(/: [0-9a-f]+$/, ""))).toEqual(["handbook", "brain:ada"]);
    expect(commits(hb)).toBe(String(Number(n) + 1));
    expect(git(hb, "status", "--porcelain")).toBe("");

    const after = text(root, "handbook/facts/gh-cli.md");
    expect(after.endsWith(body)).toBe(true); // the old text is there, byte for byte
    expect(after).toMatch(
      /^---\ntitle: Gh cli\ndescription: gh pr checks --watch waits for CI\.\ntags: \[facts\]\nupdated: \d{4}-\d{2}-\d{2}\nsources: \[ticket-3, ticket-5, ticket-9\]\nneeds-tidy: true\n---\n# Gh cli/,
    );
    expect(text(root, "handbook/facts/merging.md")).not.toContain("needs-tidy");
    expect(text(root, "handbook/teams/eng/release.md")).toMatch(
      /^---\ntitle: Release\ndescription: Eng cuts releases on Fridays\./,
    );
    expect(text(root, "handbook/projects.md")).toContain("Body stays.");
    expect(text(root, "brains/ada/personality.md")).toMatch(/^---\ntitle: Personality/);
    expect(text(root, "brains/ada/personality.md")).not.toContain("needs-tidy");
    expect(git(hb, "log", "-1", "--format=%s")).toBe("Migrate pages to the brain format\n");

    // Idempotent: a second run has nothing to do.
    const again = migrateKnowledge(root, { apply: true });
    expect(again.pages.every((p) => p.action === "unchanged")).toBe(true);
    expect(again.commits).toEqual([]);
    expect(commits(hb)).toBe(String(Number(n) + 1));

    // And the store still reads and appends to migrated pages.
    expect(
      store.apply(
        {
          id: "11:0:a0",
          ticketId: "11",
          author: "ada",
          at: 0,
          edit: { layer: "fact", page: "merging", text: "More." },
        },
        () => ({ name: "Ada", role: "Engineer" }),
      ),
    ).toBe(true);
  });

  it("makes the index see real titles, descriptions and tidy flags", async () => {
    const { root, store } = legacy();
    migrateKnowledge(root, { apply: true });
    const index = await BrainIndex.open(":memory:", store);
    index.rebuild();
    const gh = index.pages(["company"]).find((p) => p.slug === "facts/gh-cli");
    expect(gh).toMatchObject({ title: "Gh cli", needsTidy: true, tags: ["facts"] });
    expect(index.needingTidy().map((p) => p.slug)).toEqual(["facts/gh-cli"]);
  });

  it("refuses to touch a repo with uncommitted changes on --apply", () => {
    const { root } = legacy();
    writeFileSync(join(root, "handbook", "facts", "gh-cli.md"), "local edit\n");
    const report = migrateKnowledge(root, { apply: true });
    expect(report.skipped[0]).toMatch(/^handbook: uncommitted changes/);
    expect(text(root, "handbook/facts/gh-cli.md")).toBe("local edit\n");
    expect(report.commits.map((c) => c.replace(/: [0-9a-f]+$/, ""))).toEqual(["brain:ada"]);
  });

  it("is idempotent for pages with nothing to derive: empty and heading-only pages, two --apply runs", () => {
    const { root } = legacy();
    const hb = join(root, "handbook");
    writeFileSync(join(hb, "facts", "empty.md"), "");
    writeFileSync(join(hb, "facts", "heading.md"), "# Only a heading\n");
    git(hb, "add", "-A");
    git(hb, "commit", "-q", "-m", "empties");
    const first = migrateKnowledge(root, { apply: true });
    expect(first.pages.find((p) => p.path === "facts/empty.md")?.action).toBe("migrate");
    const n = commits(hb);
    const second = migrateKnowledge(root, { apply: true });
    expect(second.pages.every((p) => p.action === "unchanged")).toBe(true);
    expect(second.commits).toEqual([]);
    expect(commits(hb)).toBe(n);
    expect(() => migrateKnowledge(root, { apply: true })).not.toThrow();
    expect(text(root, "handbook/facts/empty.md")).toMatch(/^---\n[\s\S]*\n---\n$/);
    // A page that already has frontmatter is left alone, even one with an empty description.
    const keep = '---\ntitle: Keep\ndescription: ""\n---\n';
    writeFileSync(join(hb, "facts", "keep.md"), keep);
    git(hb, "add", "-A");
    git(hb, "commit", "-q", "-m", "keep");
    expect(
      migrateKnowledge(root, { apply: true }).pages.find((p) => p.path === "facts/keep.md")?.action,
    ).toBe("unchanged");
    expect(text(root, "handbook/facts/keep.md")).toBe(keep);
  });

  it("does not fail when there is nothing to commit", () => {
    const { root } = legacy();
    migrateKnowledge(root, { apply: true });
    expect(() => migrateKnowledge(root, { apply: true })).not.toThrow();
  });
});

describe("the command line is strict", () => {
  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    const code = main(argv);
    vi.restoreAllMocks();
    return { code, out, err };
  };

  it("refuses to run without an explicit --home, even with --apply --yes and an I_INC_HOME in the environment", () => {
    const { home, root } = legacy();
    const hb = join(root, "handbook");
    const head = git(hb, "rev-parse", "HEAD");
    process.env.I_INC_HOME = home;
    try {
      for (const argv of [[], ["--apply"], ["--apply", "--yes"], ["--yes"]]) {
        const r = run(argv);
        expect(r.code, argv.join(" ")).toBe(2);
        expect(r.err.join("\n")).toMatch(/--home <dir> is required|--yes only goes with --apply/);
        expect(r.out).toEqual([]);
      }
    } finally {
      delete process.env.I_INC_HOME;
    }
    expect(git(hb, "rev-parse", "HEAD")).toBe(head);
  });

  it("errors on a --home with no value, a value that is another flag, and unknown flags", () => {
    const { home, root } = legacy();
    const head = git(join(root, "handbook"), "rev-parse", "HEAD");
    for (const argv of [
      ["--home"],
      ["--apply", "--yes", "--home"],
      ["--home", "--apply", "--yes"],
      ["--home", ""],
      [`--home=${home}`],
      ["--home", home, "--home", home],
      ["--home", home, "--force"],
      ["--home", home, "--knowledge", root],
      ["--home", home, "extra"],
      ["--home", home, "--yes"],
    ]) {
      const r = run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out).toEqual([]);
    }
    expect(git(join(root, "handbook"), "rev-parse", "HEAD")).toBe(head);
    expect(parseArgs(["--home", home])).toEqual({ home, apply: false, yes: false });
    expect(parseArgs(["--home", home, "--apply", "--yes"])).toEqual({ home, apply: true, yes: true });
  });

  it("prints the resolved path and the repos before doing anything, and defaults to a dry run", () => {
    const { home, root } = legacy();
    const r = run(["--home", home]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`Dry run on ${join(home, "knowledge")}`);
    expect(r.out[1]).toBe(`  repo handbook  ${join(root, "handbook")}`);
    expect(r.out[2]).toBe(`  repo brain:ada  ${join(root, "brains", "ada")}`);
    expect(r.out.some((l) => l.includes("facts/gh-cli.md") && l.includes("needs-tidy"))).toBe(true);
    expect(r.out.at(-1)).toMatch(/Dry run: nothing was written/);
    expect(text(root, "handbook/facts/gh-cli.md")).not.toMatch(/^---/);
  });

  it("resolves a relative --home to an absolute path", () => {
    const { home } = legacy();
    const rel = relative(process.cwd(), home);
    const r = run(["--home", rel]);
    expect(r.out[0]).toBe(`Dry run on ${join(home, "knowledge")}`);
  });

  it("writes only with both --apply and --yes: --apply alone prints the repos, then refuses", () => {
    const { home, root } = legacy();
    const head = git(join(root, "handbook"), "rev-parse", "HEAD");
    const refused = run(["--home", home, "--apply"]);
    expect(refused.code).toBe(2);
    expect(refused.out.some((l) => l.includes("repo handbook"))).toBe(true);
    expect(refused.err.join("\n")).toMatch(/add --yes/);
    expect(git(join(root, "handbook"), "rev-parse", "HEAD")).toBe(head);
    expect(text(root, "handbook/facts/gh-cli.md")).not.toMatch(/^---/);

    const done = run(["--home", home, "--apply", "--yes"]);
    expect(done.code).toBe(0);
    expect(done.out[0]).toMatch(/^Applying to /);
    expect(done.out.some((l) => l.startsWith("committed handbook"))).toBe(true);
    expect(text(root, "handbook/facts/gh-cli.md")).toMatch(/^---/);
  });

  it("says so when the home has no knowledge directory", () => {
    const { home } = legacy();
    expect(run(["--home", join(home, "nope")]).code).toBe(1);
  });
});
