// The `brain` command that ships with every copy: same query reduction as the daemon, BM25 over the
// files as they are (edits included), the scope boost, and no way out of the copy.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { buildQuery } from "@i-inc/core";
import { afterEach, describe, expect, it } from "vitest";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const cli = createRequire(import.meta.url)("../src/brain-cli.cjs") as {
  buildQuery: (t: string, o?: object) => string;
  parsePage: (
    t: string,
    slug: string,
  ) => { title: string; description: string; tags: string[]; body: string };
};

describe("the command's query", () => {
  it("reduces text to the same words as the daemon's, whatever the text", () => {
    const corpus = [
      "Fix the vitest mocks in apps/daemon/src/brain-index.ts",
      'NEAR(a b) OR "unbalanced AND * ( ) -col:x',
      "the and of to",
      "a".repeat(50),
      "0123456789012 deadbeefdeadbeefdead error TS2322 at line 12",
      "日本語のテキスト and mixed ünïcode words",
      "",
      "x ".repeat(5000),
    ];
    for (const t of corpus) expect(cli.buildQuery(t)).toBe(buildQuery(t));
  });

  it("reads a page's title, description and tags like the daemon does for the usual shapes", () => {
    const p = cli.parsePage(
      page("Vitest", "Reset mocks between tests", "Body here.", ["testing", "Mocks"]),
      "tools/vitest",
    );
    expect(p).toMatchObject({
      title: "Vitest",
      description: "Reset mocks between tests",
      tags: ["testing", "mocks"],
    });
    expect(cli.parsePage("# Heading\n\nFirst sentence. Second.\n", "x/y")).toMatchObject({
      title: "Heading",
      description: "First sentence.",
    });
  });
});

describe("the command in a copy", () => {
  async function copyWithPages() {
    const r = await brainRig();
    const same = (t: string) => page(t, "Rounding refunds", "banker's rounding for refunds");
    r.commit("handbook", {
      "facts/rounding.md": same("Rounding"),
      "facts/other.md": page("Other", "Something unrelated", "gardening tips"),
    });
    r.commit("ada", { "tools/rounding-notes.md": same("My rounding notes") });
    await r.feed.sync("ada");
    const dir = r.copy("ada");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [join(dir, ".bin/brain"), ...args], { encoding: "utf8" });
    return { r, dir, run };
  }

  it("searches the copy, own brain first, and shows the files as edited", async () => {
    const { dir, run } = await copyWithPages();
    const first = run("search", "refund", "rounding");
    // No warning on stderr (Node's own node:sqlite notice is silenced), and it starts with a plain `env node`.
    expect(first.stderr).toBe("");
    expect(readFileSync(join(dir, ".bin/brain"), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
    const out = first.stdout;
    expect(out.indexOf("personal/tools/rounding-notes")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("personal/tools/rounding-notes")).toBeLessThan(out.indexOf("company/facts/rounding"));
    expect(out).not.toContain("gardening");
    // The agent edits a page in its copy: the search sees the edit.
    writeFileSync(
      join(dir, "company/facts/other.md"),
      "---\ntitle: Other\ndescription: now about zucchini\n---\nzucchini\n",
    );
    expect(run("search", "zucchini").stdout).toContain("company/facts/other");
    const json = JSON.parse(run("search", "rounding", "--json", "--limit", "1").stdout);
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ folder: "personal", slug: "tools/rounding-notes" });
    expect(run("search", "--scope", "company", "rounding").stdout).not.toContain("personal/");
    expect(run("search", "xyzzy").stdout).toContain("No pages matched");
  });

  it("prints maps and pages, lists local edits, and reads nothing outside the copy", async () => {
    const { dir, run } = await copyWithPages();
    expect(run("map", "company").stdout).toContain("[[facts/rounding]]");
    expect(run("read", "company/facts/rounding").stdout).toContain("banker's rounding");
    expect(run("list", "personal").stdout).toContain("personal/tools/rounding-notes");
    expect(run("status").stdout).toContain("no changes");
    mkdirSync(join(dir, "personal/new"), { recursive: true });
    writeFileSync(join(dir, "personal/new/p.md"), "# P\n");
    expect(run("status").stdout).toContain("personal/new/");
    for (const target of ["../../../etc/passwd", "/etc/passwd", "company/../../x"]) {
      const r = run("read", target);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
    }
  });
});
