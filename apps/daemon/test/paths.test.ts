// Which paths need the owner (T68). The table is the same as apps/deployer/test/review.test.ts: the daemon holds a
// push by this rule and the deployer checks the commit by its copy of it, so the two must agree.
import { describe, expect, it } from "vitest";
import { isDocument, isHostExecuted, isProtected } from "../src/paths.ts";

describe("the host-executed rule", () => {
  const table: [string, boolean][] = [
    ["README.md", false],
    ["NOTES.MD", false],
    ["docs/spec.md", false],
    ["docs/design/deep/x.md", false],
    ["docs/diagram.html", true],
    ["docs/run.mjs", true],
    ["docs/img/a.png", true],
    ["docs/CLAUDE.md", true],
    ["CLAUDE.md", true],
    ["AGENTS.md", true],
    ["apps/web/AGENTS.md", true],
    ["GEMINI.md", true],
    [".cursorrules", true],
    [".cursor/rules/x.md", true],
    [".claude/agents/x.md", true],
    ["docs/.cursor/x.md", true],
    [".github/workflows/ci.yml", true],
    ["pkg/NOTES.md", true],
    ["apps/daemon/src/real.ts", true],
    ["package.json", true],
    ["pnpm-lock.yaml", true],
    [".npmrc", true],
    ["tools/host/install.sh", true],
    ["scripts/docs/run.sh", true],
  ];
  it("calls only docs/**/*.md and top-level *.md documents, never an agent instruction file", () => {
    for (const [file, code] of table) {
      expect(isHostExecuted(file), file).toBe(code);
      expect(isDocument(file), file).toBe(!code);
    }
  });
});

describe("a project's protected paths", () => {
  it("an entry with or without a trailing slash is that path and everything under it", () => {
    expect(isProtected(".github/workflows/ci.yml", [".github/"])).toBe(true);
    expect(isProtected(".github", [".github/"])).toBe(true);
    expect(isProtected(".github-old/x", [".github/"])).toBe(false);
    expect(isProtected("release-please-config.json", ["release-please-config.json"])).toBe(true);
    expect(isProtected("tools/host/x.sh", ["tools"])).toBe(true);
    expect(isProtected("tools", ["tools"])).toBe(true);
    expect(isProtected("toolsmith/x.sh", ["tools"])).toBe(false);
    expect(isProtected("apps/x.ts", [".github/", "tools"])).toBe(false);
  });
});
