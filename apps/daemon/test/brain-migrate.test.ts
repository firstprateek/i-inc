// The migration of existing pages to the V1 format: dry run by default, --apply commits, no text lost.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProposedEdit } from "@i-inc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, migrateKnowledge } from "../scripts/brain-migrate.ts";
import { BrainIndex } from "../src/brain-index.ts";
import { KnowledgeStore } from "../src/knowledge.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
    encoding: "utf8",
  });

/** Today's knowledge directory: appended pages, one with a pile of fragments, and one with frontmatter. */
function legacy() {
  const root = mkdtempSync(join(tmpdir(), "i-inc-migrate-"));
  roots.push(root);
  const store = new KnowledgeStore(root);
  const who = () => ({ name: "Ada", role: "Engineer" });
  const edit = (
    n: number,
    ticket: string,
    layer: "fact" | "brain",
    page: string,
    text: string,
  ): ProposedEdit => ({
    id: `${ticket}:${n}:a0`,
    ticketId: ticket,
    author: "ada",
    at: 0,
    edit: { layer, page, text },
  });
  store.apply(edit(0, "3", "fact", "gh-cli", "gh pr checks --watch waits for CI."), who);
  store.apply(edit(1, "5", "fact", "gh-cli", "Use --fail-fast to stop early."), who);
  store.apply(edit(2, "9", "fact", "gh-cli", "It needs a token with checks:read."), who);
  store.apply(edit(3, "5", "fact", "merging", "Squash-merge every PR."), who);
  store.apply(edit(4, "7", "brain", "tools/vitest", "Reset mocks between tests."), who);

  const hb = join(root, "handbook");
  mkdirSync(join(hb, "teams", "eng"), { recursive: true });
  writeFileSync(join(hb, "teams", "eng", "release.md"), "# Release\n\nEng cuts releases on Fridays.\n");
  writeFileSync(
    join(hb, "projects.md"),
    "---\ntitle: Projects\ndescription: All projects\ntags: [x]\nupdated: 2026-01-01\nsources: [ticket-1]\n---\nBody stays.\n",
  );
  git(hb, "add", "-A");
  git(hb, "commit", "-q", "-m", "hand-written pages");
  return { root, store };
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

  it("the command defaults to a dry run and prints a summary", () => {
    const { root } = legacy();
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    expect(main(["--knowledge", root])).toBe(0);
    expect(out[0]).toMatch(/^Dry run on /);
    expect(out.some((l) => l.includes("facts/gh-cli.md") && l.includes("needs-tidy"))).toBe(true);
    expect(out.at(-1)).toMatch(/Dry run: nothing was written/);
    expect(text(root, "handbook/facts/gh-cli.md")).not.toMatch(/^---/);

    out.length = 0;
    expect(main(["--knowledge", root, "--apply"])).toBe(0);
    expect(out[0]).toMatch(/^Applying to /);
    expect(out.some((l) => l.startsWith("committed handbook"))).toBe(true);
    expect(text(root, "handbook/facts/gh-cli.md")).toMatch(/^---/);

    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(["--bogus"])).toBe(2);
    expect(main(["--knowledge", join(root, "nope")])).toBe(1);
  });
});
