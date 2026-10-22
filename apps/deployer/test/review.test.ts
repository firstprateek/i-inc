// The deployer's guard (T68): host code deploys only with the owner's approval or from a pull request the owner
// merged. A fake GitHub API and a real git repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDocument, isHostExecuted } from "../src/paths.ts";
import { GitRemote } from "../src/remote.ts";
import { LedgerReview, MAX_RANGE } from "../src/review.ts";
import { run } from "../src/shell.ts";
import type { Remote } from "../src/types.ts";
import { FakeClock } from "./fakes.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const REPO = "firstprateek/i-inc";
const CODE = ["apps/daemon/src/x.ts"];

/** A GitHub that answers the calls the guard makes, from tables, and counts them. */
function fakeGitHub() {
  const state = {
    pulls: {} as Record<string, { number: number; merged_at: string | null; base: { ref: string } }[]>,
    prs: {} as Record<number, { merged_by: { login: string } | null; merge_commit_sha?: string }>,
    prCommits: {} as Record<number, string[]>,
    calls: [] as string[],
    auth: [] as (string | null)[],
    status: 200,
    headers: {} as Record<string, string>,
  };
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    state.calls.push(u.replace("https://api.github.com/repos/", ""));
    state.auth.push(new Headers(init?.headers).get("authorization"));
    if (state.status !== 200) return new Response("{}", { status: state.status, headers: state.headers });
    const commit = /\/commits\/([0-9a-f]{40})\/pulls/.exec(u)?.[1];
    if (commit) return Response.json(state.pulls[commit] ?? []);
    const prc = /\/pulls\/(\d+)\/commits/.exec(u)?.[1];
    if (prc) return Response.json((state.prCommits[Number(prc)] ?? []).map((s) => ({ sha: s })));
    const pr = /\/pulls\/(\d+)$/.exec(u)?.[1];
    if (pr) return Response.json(state.prs[Number(pr)] ?? {});
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { state, f };
}

function guard(o: {
  range: string[];
  /** What each commit changes; absent: code. */
  files?: Record<string, string[] | null>;
  ledger?: { sha: string; extra?: Record<string, unknown>; repo?: string }[];
  truncated?: boolean;
  token?: string;
  cachePath?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "inc-review-"));
  const ledgerPath = join(dir, "pushed-main.jsonl");
  if (o.ledger) {
    writeFileSync(
      ledgerPath,
      `${o.ledger
        .map((e) =>
          JSON.stringify({ sha: e.sha, repo: e.repo ?? REPO, branch: "main", at: 1, tip: true, ...e.extra }),
        )
        .join("\n")}\n`,
    );
  }
  const remote: Pick<Remote, "range" | "changedFiles"> = {
    range: async () => ({ shas: o.range, truncated: o.truncated ?? false }),
    changedFiles: async (s) => (o.files && s in o.files ? (o.files[s] ?? null) : CODE),
  };
  const gh = fakeGitHub();
  const clock = new FakeClock();
  const review = new LedgerReview({
    repo: REPO,
    ledgerPath,
    remote,
    clock,
    fetch: gh.f,
    ...(o.token ? { token: () => o.token } : {}),
    ...(o.cachePath ? { cachePath: o.cachePath } : {}),
  });
  return { review, gh, clock, ledgerPath, dir };
}

const merged = (n: number, base = "main") => ({
  number: n,
  merged_at: "2026-10-21T10:00:00Z",
  base: { ref: base },
});

describe("which paths the host could run", () => {
  // The same table is in apps/daemon/test/paths.test.ts: the two rules must agree.
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

describe("which commits count as reviewed", () => {
  it("a commit that changes only documents is fine, with no ledger and no call to GitHub", async () => {
    const g = guard({ range: [sha(1)], files: { [sha(1)]: ["docs/a.md", "README.md"] } });
    expect(await g.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    expect(g.gh.state.calls).toEqual([]);
  });

  it("a plain ledgered commit is NOT enough for code: only the owner's approval is", async () => {
    const g = guard({ range: [sha(1)], ledger: [{ sha: sha(1) }] });
    expect(await g.review.check(sha(0), sha(1))).toMatchObject({ state: "unreviewed", shas: [sha(1)] });
    const approved = guard({
      range: [sha(1)],
      ledger: [{ sha: sha(1), extra: { ownerApproved: true, approvedPaths: CODE } }],
    });
    expect(await approved.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    expect(approved.gh.state.calls).toEqual([]);
    // Not an "ownerApproved" that is anything but true.
    const odd = guard({ range: [sha(1)], ledger: [{ sha: sha(1), extra: { ownerApproved: "yes" } }] });
    expect((await odd.review.check(sha(0), sha(1))).state).toBe("unreviewed");
  });

  it("a revert the host made is accepted, and a ledger line is read case-insensitively, per repo and branch", async () => {
    const g = guard({ range: [sha(1)], ledger: [{ sha: sha(1), extra: { hostRevert: sha(9) } }] });
    expect(await g.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    const upper = guard({
      range: [sha(1)],
      ledger: [{ sha: sha(1), repo: "FirstPrateek/I-Inc", extra: { ownerApproved: true } }],
    });
    expect(await upper.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    const other = guard({
      range: [sha(1)],
      ledger: [{ sha: sha(1), repo: "someone/else", extra: { ownerApproved: true } }],
    });
    expect((await other.review.check(sha(0), sha(1))).state).toBe("unreviewed");
    writeFileSync(
      other.ledgerPath,
      `not json\n${JSON.stringify({ sha: sha(1), repo: REPO, branch: "dev", ownerApproved: true })}\n{"sha":1}\n`,
    );
    expect((await other.review.check(sha(0), sha(1))).state).toBe("unreviewed");
  });

  it("the merge commit of a pull request the repo's owner merged", async () => {
    const g = guard({ range: [sha(1)] });
    g.gh.state.pulls[sha(1)] = [merged(7)];
    g.gh.state.prs[7] = { merged_by: { login: "FirstPrateek" }, merge_commit_sha: sha(1) };
    expect(await g.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    expect(g.gh.state.calls).toEqual([`${REPO}/commits/${sha(1)}/pulls?per_page=30`, `${REPO}/pulls/7`]);
    // Said once: asked of GitHub no more.
    expect(await g.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    expect(g.gh.state.calls).toHaveLength(2);
  });

  it("a commit that is only associated with a merged pull request is not enough: it must be the merge commit or one of its commits", async () => {
    const g = guard({ range: [sha(1)] });
    g.gh.state.pulls[sha(1)] = [merged(7)];
    g.gh.state.prs[7] = { merged_by: { login: "firstprateek" }, merge_commit_sha: sha(2) };
    g.gh.state.prCommits[7] = [sha(3)];
    expect(await g.review.check(sha(0), sha(1))).toMatchObject({ state: "unreviewed", shas: [sha(1)] });
    // The same commit, once it is one of the pull request's commits (the merge-commit method).
    g.gh.state.prCommits[7] = [sha(3), sha(1)];
    const again = guard({ range: [sha(1)] });
    again.gh.state.pulls[sha(1)] = [merged(7)];
    again.gh.state.prs[7] = { merged_by: { login: "firstprateek" }, merge_commit_sha: sha(2) };
    again.gh.state.prCommits[7] = [sha(3), sha(1)];
    expect(await again.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
  });

  it("not a pull request merged by somebody else (the bot), not one still open or closed, not one into another branch", async () => {
    for (const [pull, by] of [
      [merged(7), "i-inc-bot[bot]"],
      [{ number: 7, merged_at: null, base: { ref: "main" } }, "firstprateek"],
      [merged(7, "release"), "firstprateek"],
    ] as const) {
      const g = guard({ range: [sha(1)] });
      g.gh.state.pulls[sha(1)] = [pull];
      g.gh.state.prs[7] = { merged_by: { login: by }, merge_commit_sha: sha(1) };
      expect(await g.review.check(sha(0), sha(1))).toMatchObject({ state: "unreviewed", shas: [sha(1)] });
    }
    const g = guard({ range: [sha(1)] });
    g.gh.state.pulls[sha(1)] = [merged(7)];
    g.gh.state.prs[7] = { merged_by: null, merge_commit_sha: sha(1) };
    expect((await g.review.check(sha(0), sha(1))).state).toBe("unreviewed");
  });

  it("names the commit that is none of these, and the rest are fine", async () => {
    const g = guard({
      range: [sha(3), sha(2), sha(1)],
      files: { [sha(2)]: ["docs/x.md"] },
      ledger: [{ sha: sha(1), extra: { ownerApproved: true } }],
    });
    const r = await g.review.check(sha(0), sha(3));
    expect(r).toMatchObject({ state: "unreviewed", shas: [sha(3)] });
    expect(r.state === "unreviewed" ? r.reason : "").toContain(sha(3).slice(0, 7));
  });

  it("waits out a rate limit and never calls it reviewed", async () => {
    const g = guard({ range: [sha(1)] });
    g.gh.state.status = 403;
    g.gh.state.headers = {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(g.clock.t / 1000 + 1200),
    };
    expect(await g.review.check(sha(0), sha(1))).toEqual({
      state: "rate-limited",
      until: g.clock.t + 1_200_000,
    });
    expect((await g.review.check(sha(0), sha(1))).state).toBe("rate-limited");
    expect(g.gh.state.calls).toHaveLength(1);
    g.clock.t += 1_300_000;
    g.gh.state.status = 200;
    expect((await g.review.check(sha(0), sha(1))).state).toBe("unreviewed");
  });

  it("an unreachable or failing GitHub, or a commit it can't read, is an error, not a pass", async () => {
    const g = guard({ range: [sha(1)] });
    g.gh.state.status = 500;
    expect((await g.review.check(sha(0), sha(1))).state).toBe("error");
    expect(
      (await guard({ range: [sha(1)], files: { [sha(1)]: null } }).review.check(sha(0), sha(1))).state,
    ).toBe("error");
    const none = new LedgerReview({
      repo: REPO,
      ledgerPath: g.ledgerPath,
      remote: { range: async () => null, changedFiles: async () => [] },
      clock: g.clock,
      fetch: g.gh.f,
    });
    expect((await none.check(sha(0), sha(1))).state).toBe("error");
  });

  it("a jump of more commits than it can check is left to the owner", async () => {
    const g = guard({ range: Array.from({ length: MAX_RANGE }, (_, i) => sha(i + 1)), truncated: true });
    expect((await g.review.check(sha(0), sha(1))).state).toBe("unreviewed");
  });

  it("uses a token when the host has one, and keeps verdicts by pull request on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inc-review-cache-"));
    const cachePath = join(dir, "review-cache.json");
    const g = guard({ range: [sha(1)], token: "ghs_readonly", cachePath });
    g.gh.state.pulls[sha(1)] = [merged(7)];
    g.gh.state.prs[7] = { merged_by: { login: "firstprateek" }, merge_commit_sha: sha(1) };
    expect(await g.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    expect(new Set(g.gh.state.auth)).toEqual(new Set(["Bearer ghs_readonly"]));
    expect(existsSync(cachePath)).toBe(true);
    // A restarted deployer (a new instance) doesn't ask GitHub again.
    const again = guard({ range: [sha(1)], cachePath });
    expect(await again.review.check(sha(0), sha(1))).toEqual({ state: "ok" });
    expect(again.gh.state.calls).toEqual([]);
    // Without a token the calls carry no authorization.
    const plain = guard({ range: [sha(1)] });
    plain.gh.state.pulls[sha(1)] = [merged(7)];
    plain.gh.state.prs[7] = { merged_by: { login: "firstprateek" }, merge_commit_sha: sha(1) };
    await plain.review.check(sha(0), sha(1));
    expect(new Set(plain.gh.state.auth)).toEqual(new Set([null]));
  });
});

// ── real git: the range and the changed files ──

describe("reading the range and the changed files from git", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      {
        cwd,
        encoding: "utf8",
      },
    ).trim();
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "inc-review-git-"));
    git(dir, "init", "-q", "-b", "main");
    const commit = (files: Record<string, string>, msg: string) => {
      for (const [p, t] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", msg);
      return git(dir, "rev-parse", "HEAD");
    };
    return { dir, commit };
  }

  it("lists what main brought since the release, in full, and says when the list was cut", async () => {
    const r = repo();
    const base = r.commit({ "a.ts": "1" }, "base");
    const c1 = r.commit({ "b.ts": "1" }, "one");
    const c2 = r.commit({ "c.ts": "1" }, "two");
    const remote = new GitRemote(r.dir, run, "main", () => r.dir);
    expect(await remote.range(base, c2, 10)).toEqual({ shas: [c2, c1], truncated: false });
    expect(await remote.range(base, c2, 1)).toEqual({ shas: [c2], truncated: true });
    expect(await remote.range(base, "nope", 10)).toBeNull();
  });

  it("reads a long list in full: 100 commits (more than the shell keeps) and a commit of 300 files, nothing cut from the start", {
    timeout: 60_000,
  }, async () => {
    const r = repo();
    const base = r.commit({ "a.ts": "1" }, "base");
    for (let i = 0; i < 100; i++) git(r.dir, "commit", "-q", "--allow-empty", "-m", `c${i}`);
    const files: Record<string, string> = { "docs/first.md": "x" };
    for (let i = 0; i < 300; i++) files[`apps/pkg/file-number-${i}.ts`] = "x";
    const big = r.commit(files, "big");
    const tip = git(r.dir, "rev-parse", "HEAD");
    const remote = new GitRemote(r.dir, run, "main", () => r.dir);
    const range = await remote.range(base, tip, 200);
    expect(range?.shas).toHaveLength(101);
    expect(range?.truncated).toBe(false);
    expect(range?.shas.at(-1)).toMatch(/^[0-9a-f]{40}$/);
    const changed = await remote.changedFiles(big, base);
    expect(changed).toHaveLength(301);
    expect(changed).toContain("docs/first.md");
  });

  it("lists the files a commit changes, both sides of a rename and of a merge", async () => {
    const r = repo();
    const base = r.commit({ "a.ts": "1", "docs/a.md": "1" }, "base");
    const remote = new GitRemote(r.dir, run, "main", () => r.dir);
    git(r.dir, "mv", "docs/a.md", "src.md");
    git(r.dir, "commit", "-q", "-m", "moves a doc");
    const moved = git(r.dir, "rev-parse", "HEAD");
    expect((await remote.changedFiles(moved, base))?.sort()).toEqual(["docs/a.md", "src.md"]);
    git(r.dir, "checkout", "-q", "-b", "side");
    r.commit({ "apps/evil.ts": "x" }, "side code");
    git(r.dir, "checkout", "-q", "main");
    r.commit({ "docs/b.md": "1" }, "docs on main");
    git(r.dir, "merge", "-q", "--no-ff", "side", "-m", "merge side");
    const merge = git(r.dir, "rev-parse", "HEAD");
    expect(await remote.changedFiles(merge, base)).toContain("apps/evil.ts");
    expect(await remote.changedFiles("nope", base)).toBeNull();
    expect(readFileSync(join(r.dir, "src.md"), "utf8")).toBe("1");
  });
});
