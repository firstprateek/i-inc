// The brain's copy in a sandbox and its retrieval into prompts (T57).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const tree = (dir: string, rel = ""): string[] =>
  readdirSync(`${dir}/${rel}`, { withFileTypes: true })
    .filter((e) => e.name !== ".git")
    .flatMap((e) => (e.isDirectory() ? tree(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]))
    .sort();

describe("the copy", () => {
  it("puts the readable scopes in the sandbox, with a map each, and a git baseline", async () => {
    const r = await brainRig();
    r.commit("handbook", {
      "facts/gh.md": page("GitHub CLI", "gh pr checks waits for CI", "Use gh pr checks --watch."),
      "projects/duet.md": page("Duet", "The couples' finance app", "Tauri and Lit."),
      "teams/engineering/release.md": page("Release", "How engineering releases", "Cut with release-please."),
    });
    r.commit("ada", {
      "tools/vitest.md": page("Vitest", "Reset mocks between tests", "Call restoreAllMocks."),
    });
    const report = await r.feed.sync("ada");
    expect(report).toMatchObject({ ok: true, how: "full" });
    expect(tree(r.copy("ada"))).toEqual([
      ".bin/brain",
      ".snapshot.id",
      ".snapshot.json",
      "company/INDEX.md",
      "company/facts/gh.md",
      "company/projects/duet.md",
      "personal/INDEX.md",
      "personal/personality.md",
      "personal/tools/vitest.md",
      "team-engineering/INDEX.md",
      "team-engineering/release.md",
    ]);
    expect(readFileSync(r.copy("ada", "company/INDEX.md"), "utf8")).toContain(
      "- [[facts/gh]] — gh pr checks waits for CI",
    );
    // The baseline commit is the snapshot, and nothing is changed against it.
    const git = (...a: string[]) => execFileSync("git", ["-C", r.copy("ada"), ...a], { encoding: "utf8" });
    expect(git("status", "--short")).toBe("");
    expect(git("diff", "--name-only", "refs/inc/baseline")).toBe("");
    expect(git("ls-tree", "-r", "--name-only", "refs/inc/baseline")).toContain("company/facts/gh.md");
    expect(git("ls-tree", "-r", "--name-only", "refs/inc/baseline")).not.toContain(".bin/brain");
  });
});
