// Applied edits keep a page's frontmatter current: `updated` moves, the ticket is recorded, and a page
// from before frontmatter gets one without losing a word.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQuery, type ProposedEdit, parsePage } from "@i-inc/core";
import { afterEach, describe, expect, it } from "vitest";
import { BrainIndex } from "../src/brain-index.ts";
import { KnowledgeStore } from "../src/knowledge.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const who = () => ({ name: "Ada", role: "Engineer" });
let n = 0;
const edit = (
  ticket: string,
  page: string,
  text: string,
  layer: "fact" | "brain" = "fact",
): ProposedEdit => ({
  id: `${ticket}:${n++}:a0`,
  ticketId: ticket,
  author: "ada",
  at: 0,
  edit: { layer, page, text },
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "i-inc-fm-"));
  roots.push(root);
  let now = day("2026-10-01");
  const store = new KnowledgeStore(root, () => now);
  return {
    root,
    store,
    setDay: (iso: string) => {
      now = day(iso);
    },
    read: (p: string) => readFileSync(join(root, p), "utf8"),
  };
}

describe("applying an edit", () => {
  it("creates a new page with frontmatter: title, description, tag, today's date and the ticket", () => {
    const { store, read } = setup();
    store.apply(edit("3", "gh-cli", "gh pr checks --watch waits for CI. It exits non-zero on failure."), who);
    const text = read("handbook/facts/gh-cli.md");
    expect(text).toMatch(/^---\n/);
    const p = parsePage(text, "facts/gh-cli");
    expect(p.meta).toMatchObject({
      title: "Gh cli",
      description: "gh pr checks --watch waits for CI.",
      tags: ["facts"],
      updated: "2026-10-01",
      sources: ["ticket-3"],
    });
    expect(p.body).toBe("# Gh cli\n\ngh pr checks --watch waits for CI. It exits non-zero on failure.\n");
  });

  it("bumps `updated`, adds the ticket once, appends the text and keeps everything else", () => {
    const { store, read, setDay } = setup();
    store.apply(edit("3", "gh-cli", "First lesson."), who);
    setDay("2026-10-15");
    store.apply(edit("5", "gh-cli", "Second lesson."), who);
    setDay("2026-10-20");
    store.apply(edit("5", "gh-cli", "Third lesson."), who);
    const p = parsePage(read("handbook/facts/gh-cli.md"), "facts/gh-cli");
    expect(p.meta.updated).toBe("2026-10-20");
    expect(p.meta.sources).toEqual(["ticket-3", "ticket-5"]);
    expect(p.meta.description).toBe("First lesson.");
    expect(p.body).toBe("# Gh cli\n\nFirst lesson.\n\nSecond lesson.\n\nThird lesson.\n");
  });

  it("keeps an agent's own frontmatter (block scalars, other keys, tags) while bumping the date", () => {
    const { store, root, read, setDay } = setup();
    store.apply(edit("1", "merging", "Squash."), who);
    const file = join(root, "handbook/facts/merging.md");
    writeFileSync(
      file,
      "---\ntitle: Merging PRs\ndescription: >\n  How we merge.\n  Squash only.\ntags: [git]\nupdated: 2026-01-01\nsources: [ticket-1]\nOwner: Kit\nnotes: |\n  keep\n  me\n---\nBody.\n",
    );
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "agent edit"], {
      cwd: join(root, "handbook"),
    });
    setDay("2026-10-09");
    store.apply(edit("2", "merging", "Never rebase."), who);
    const text = read("handbook/facts/merging.md");
    const p = parsePage(text, "facts/merging");
    expect(p.meta).toMatchObject({
      title: "Merging PRs",
      description: "How we merge. Squash only.",
      tags: ["git"],
      updated: "2026-10-09",
      sources: ["ticket-1", "ticket-2"],
      extra: { Owner: "Kit", notes: "keep\nme\n" },
    });
    expect(p.body).toBe("Body.\n\nNever rebase.\n");
  });

  it("adds frontmatter to a page that predates it, without losing a word", () => {
    const { store, root, read } = setup();
    store.apply(edit("1", "merging", "Squash."), who);
    const old = "# Merging\n\nSquash-merge every PR. Always.\n\nSecond old paragraph.\n";
    writeFileSync(join(root, "handbook/facts/merging.md"), old);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "old"], {
      cwd: join(root, "handbook"),
    });
    store.apply(edit("9", "merging", "New lesson."), who);
    const p = parsePage(read("handbook/facts/merging.md"), "facts/merging");
    expect(p.hasFrontmatter).toBe(true);
    expect(p.meta).toMatchObject({
      title: "Merging",
      description: "Squash-merge every PR.",
      tags: ["facts"],
      updated: "2026-10-01",
      sources: ["ticket-9"],
    });
    expect(p.body).toBe(`${old}\nNew lesson.\n`);
  });

  it("reaches the index: the date a search shows is the date of the last applied edit", async () => {
    const { store, setDay } = setup();
    const index = await BrainIndex.open(":memory:", store);
    store.onCommit = (r) => index.follow(r);
    store.apply(edit("1", "merging", "Squash every PR."), who);
    expect(index.search(buildQuery("squash"), ["company"], 5)[0]?.updated).toBe("2026-10-01");
    setDay("2026-10-22");
    store.apply(edit("2", "merging", "Rebase never."), who);
    expect(index.search(buildQuery("squash"), ["company"], 5)[0]?.updated).toBe("2026-10-22");
    expect(index.pages(["company"])[0]?.updated).toBe("2026-10-22");
  });

  it("applying the same edit twice still changes nothing", () => {
    const { store, read } = setup();
    const e = edit("1", "merging", "Squash.");
    expect(store.apply(e, who)).toBe(true);
    const once = read("handbook/facts/merging.md");
    expect(store.apply(e, who)).toBe(false);
    expect(read("handbook/facts/merging.md")).toBe(once);
  });
});
