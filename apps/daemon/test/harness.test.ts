import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import {
  changedScript,
  isProtected,
  MachineHarness,
  pushMainScript,
  type RunScript,
  rebaseScript,
} from "../src/harness.ts";

// The scripts run in real bash with real git, standing in for `container machine run -i … bash -s`.
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const localScript: RunScript = (_employee, script) =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-s"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
    child.stdin.end(script);
  });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const ticket: Ticket = {
  id: "t7",
  title: "x",
  project: "duet",
  type: "fix",
  effort: "low",
  doneWhen: [],
  assignee: "ada",
};

function harness(worktree: string, recipe: string[]) {
  return new MachineHarness(
    { recipe: (project) => (project === "duet" ? recipe : undefined), worktree: () => worktree },
    localScript,
  );
}

/** An origin with main, and a worktree on a ticket branch that changed `file` to `ours`. */
function repos(ours: string, theirs?: string) {
  const root = mkdtempSync(join(tmpdir(), "inc-harness-"));
  const origin = join(root, "origin");
  const work = join(root, "work");
  git(root, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "file"), "base\n");
  git(origin, "add", "file");
  git(origin, "commit", "-q", "-m", "base");
  git(root, "clone", "-q", origin, work);
  git(work, "switch", "-q", "-c", "inc/t7-x");
  writeFileSync(join(work, "file"), `${ours}\n`);
  git(work, "commit", "-q", "-am", "ours");
  if (theirs !== undefined) {
    writeFileSync(join(origin, theirs === "other" ? "other" : "file"), `${theirs}\n`);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "theirs");
  }
  return work;
}

describe("the machine harness", () => {
  it("runs the recipe in the worktree and is green when every step passes", async () => {
    const work = mkdtempSync(join(tmpdir(), "inc-harness-"));
    const result = await harness(work, ["true", "test -d ."]).runChecks(ticket);
    expect(result).toEqual({ green: true, failures: [] });
  });

  it("stops at the first failing step and hands back its last lines", async () => {
    const work = mkdtempSync(join(tmpdir(), "inc-harness-"));
    const result = await harness(work, ["true", "echo 3 tests failing; false", "touch ran"]).runChecks(
      ticket,
    );
    expect(result.green).toBe(false);
    expect(result.failures[0]).toContain("echo 3 tests failing; false");
    expect(result.failures[0]).toContain("3 tests failing");
    expect(() => execFileSync("test", ["-e", join(work, "ran")])).toThrow();
  });

  it("refuses a project with no recipe, and an unsafe ticket id", async () => {
    await expect(harness("/tmp", []).runChecks(ticket)).rejects.toThrow("no check recipe for duet");
    await expect(harness("/tmp", ["true"]).runChecks({ ...ticket, id: "x; rm -rf /" })).rejects.toThrow(
      "not a ticket id",
    );
  });

  it("gates: rebases on main, then reruns the checks", async () => {
    const work = repos("ours", "other");
    const result = await harness(work, ["test -f other", "grep -q ours file"]).runGates(ticket);
    expect(result).toEqual({ ok: true });
    expect(git(work, "log", "--format=%s").trim().split("\n")).toEqual(["ours", "theirs", "base"]);
  });

  it("gates: a rebase conflict comes back as a conflict, with the rebase undone", async () => {
    const work = repos("ours", "theirs");
    const result = await harness(work, ["true"]).runGates(ticket);
    expect(result).toEqual({ ok: false, conflict: true, reason: "rebasing on main conflicts in file" });
    expect(git(work, "status", "--porcelain").trim()).toBe("");
    expect(git(work, "branch", "--show-current").trim()).toBe("inc/t7-x");
  });

  it("gates: with GitHub, pushes the rebased branch so the PR shows what passed", async () => {
    const work = repos("ours", "other");
    const origin = join(work, "..", "origin");
    const withGitHub = new MachineHarness(
      {
        recipe: () => ["true"],
        worktree: () => work,
        github: async () => ({ GH_TOKEN: "unused-locally" }),
      },
      localScript,
    );
    expect(await withGitHub.runGates(ticket)).toEqual({ ok: true });
    expect(git(origin, "rev-parse", "inc/t7-x").trim()).toBe(git(work, "rev-parse", "HEAD").trim());
  });

  it("gates: then waits for CI on the pushed commit, and fails with its reason", async () => {
    const work = repos("ours", "other");
    const seen: string[] = [];
    const redCi = new MachineHarness(
      {
        recipe: () => ["true"],
        worktree: () => work,
        github: async () => ({}),
        ci: async (_ticket, sha) => {
          seen.push(sha);
          return { ok: false, reason: "CI failed: Lint, types and tests (failure)" };
        },
      },
      localScript,
    );
    expect(await redCi.runGates(ticket)).toEqual({
      ok: false,
      conflict: false,
      reason: "CI failed: Lint, types and tests (failure)",
    });
    expect(seen).toEqual([git(work, "rev-parse", "HEAD").trim()]);
  });

  it("gates: uncommitted work and a branch with no changes are named, not called conflicts", async () => {
    const dirty = repos("ours", "other");
    writeFileSync(join(dirty, "notes.txt"), "half done\n");
    expect(await harness(dirty, ["true"]).runGates(ticket)).toEqual({
      ok: false,
      conflict: false,
      reason: "the worktree has uncommitted changes: ?? notes.txt",
    });
    // Only pick-up's empty commit on the branch.
    const empty = repos("ours", "other");
    git(empty, "reset", "-q", "--hard", "origin/main");
    git(empty, "commit", "-q", "--allow-empty", "-m", "chore: start work");
    expect(await harness(empty, ["true"]).runGates(ticket)).toEqual({
      ok: false,
      conflict: false,
      reason: "the branch has no changes beyond main",
    });
  });

  it("gates: never push over a commit someone else put on the PR's branch", async () => {
    const work = repos("ours", "other");
    const origin = join(work, "..", "origin");
    git(work, "push", "-q", "origin", "inc/t7-x");
    // The owner adds a commit to the PR from another clone.
    const owner = join(work, "..", "owner");
    git(join(work, ".."), "clone", "-q", "-b", "inc/t7-x", origin, owner);
    writeFileSync(join(owner, "owner.txt"), "a fix\n");
    git(owner, "add", "owner.txt");
    git(owner, "commit", "-q", "-m", "owner's fix");
    git(owner, "push", "-q", "origin", "inc/t7-x");
    const ownerSha = git(owner, "rev-parse", "HEAD").trim();
    const gated = new MachineHarness(
      { recipe: () => ["true"], worktree: () => work, github: async () => ({}) },
      localScript,
    );
    const result = await gated.runGates(ticket);
    expect(result).toMatchObject({ ok: false, conflict: false });
    expect(result.ok ? "" : result.reason).toContain(ownerSha);
    expect(git(origin, "rev-parse", "inc/t7-x").trim()).toBe(ownerSha);
  });

  it("gates: checks that fail after the rebase are not a conflict", async () => {
    const work = repos("ours", "other");
    const result = await harness(work, ["false"]).runGates(ticket);
    expect(result).toMatchObject({ ok: false, conflict: false });
  });
});

describe("the machine harness in direct mode", () => {
  const policy = { mode: "direct" as const, protectedPaths: [".github/"], followUpsPerDay: 3 };
  /** An origin that takes pushes to main, and a worktree on a ticket branch. */
  function directRepos(file = "file") {
    const work = repos("ours", "other");
    const origin = join(work, "..", "origin");
    git(origin, "config", "receive.denyCurrentBranch", "updateInstead");
    if (file !== "file") {
      execFileSync("mkdir", ["-p", join(work, file, "..")]);
      writeFileSync(join(work, file), "changed\n");
      git(work, "add", file);
      git(work, "commit", "-q", "-m", "touch a protected path");
    }
    return { work, origin };
  }
  const direct = (work: string, recipe = ["true"]) =>
    new MachineHarness(
      { recipe: () => recipe, worktree: () => work, github: async () => ({}), policy: () => policy },
      localScript,
    );

  it("rebases on main, runs the checks, and pushes to main", async () => {
    const { work, origin } = directRepos();
    const result = await direct(work).runGates(ticket);
    const head = git(work, "rev-parse", "HEAD").trim();
    expect(result).toEqual({ ok: true, pushed: head });
    expect(git(origin, "rev-parse", "main").trim()).toBe(head);
    expect(git(origin, "log", "--format=%s", "main").trim().split("\n")).toEqual(["ours", "theirs", "base"]);
  });

  it("holds a change to protected paths for the owner, and pushes it once approved", async () => {
    const { work, origin } = directRepos(".github/workflows/ci.yml");
    const before = git(origin, "rev-parse", "main").trim();
    expect(await direct(work).runGates(ticket)).toMatchObject({
      ok: false,
      protectedPaths: [".github/workflows/ci.yml"],
    });
    expect(git(origin, "rev-parse", "main").trim()).toBe(before);
    expect(await direct(work).runGates(ticket, { ownerApproved: true })).toMatchObject({ ok: true });
  });

  it("holds a file moved out of a protected folder, and a protected file with a quote in its name", async () => {
    const { work, origin } = directRepos();
    // main has a workflow; the ticket moves it out of .github/ (git sees a rename), and adds an odd name inside.
    execFileSync("mkdir", ["-p", join(origin, ".github/workflows")]);
    writeFileSync(join(origin, ".github/workflows/ci.yml"), "name: ci\n".repeat(20));
    git(origin, "add", "-A");
    git(origin, "-c", "user.name=o", "-c", "user.email=o@x.invalid", "commit", "-q", "-m", "workflow");
    git(work, "fetch", "-q", "origin");
    git(work, "rebase", "-q", "origin/main");
    execFileSync("mkdir", ["-p", join(work, "docs")]);
    git(work, "mv", ".github/workflows/ci.yml", "docs/ci.yml");
    writeFileSync(join(work, '.github/a"b\tc.txt'), "x\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "move a workflow out");
    const before = git(origin, "rev-parse", "main").trim();
    const held = await direct(work).runGates(ticket);
    expect(held).toMatchObject({ ok: false });
    expect(held.ok ? [] : (held.protectedPaths ?? [])).toEqual(
      expect.arrayContaining([".github/workflows/ci.yml", '.github/a"b\tc.txt']),
    );
    expect(git(origin, "rev-parse", "main").trim()).toBe(before);
  });

  it("rebases and tries again when main moves while the checks run", async () => {
    const { work, origin } = directRepos();
    const other = join(work, "..", "other-clone");
    git(join(work, ".."), "clone", "-q", origin, other);
    const flag = join(work, "..", "moved");
    // The first check run pushes someone else's commit to main, as another agent might.
    const sneak = `[ -f ${flag} ] || (cd ${other} && echo late > late.txt && git add late.txt && git commit -qm late && git push -q origin main && touch ${flag})`;
    const result = await direct(work, [sneak]).runGates(ticket);
    expect(result).toMatchObject({ ok: true });
    expect(git(origin, "log", "--format=%s", "main").trim().split("\n")).toEqual([
      "ours",
      "late",
      "theirs",
      "base",
    ]);
  });

  it("reverts a pushed commit on main", async () => {
    const { work, origin } = directRepos();
    const result = await direct(work).runGates(ticket);
    const sha = result.ok ? (result.pushed ?? "") : "";
    await direct(work).revert(ticket, sha);
    expect(git(origin, "log", "-1", "--format=%s", "main").trim()).toBe('Revert "ours"');
    expect(git(origin, "show", "main:file").trim()).toBe("base");
  });

  it("2.3 tells the runner which commit it is about to push, before it pushes, and takes a landed push as pushed on replay", async () => {
    const { work, origin } = directRepos();
    const before = git(origin, "rev-parse", "main").trim();
    const intended: string[] = [];
    const first = await direct(work).runGates(ticket, {
      // Called before the push: main has not moved yet.
      onPushIntended: async (sha) => {
        intended.push(sha);
        expect(git(origin, "rev-parse", "main").trim()).toBe(before);
      },
    });
    const head = git(work, "rev-parse", "HEAD").trim();
    expect(first).toEqual({ ok: true, pushed: head });
    expect(intended).toEqual([head]);

    // The daemon stopped before it wrote `pushed`. Run again: without the note it is "no changes"...
    const lost = await direct(work).runGates(ticket);
    expect(lost).toMatchObject({ ok: false, reason: expect.stringContaining("no changes") });
    // ...and with it, the commit is on main, so the ticket carries on to CI and the report.
    expect(await direct(work).runGates(ticket, { pushIntended: head })).toEqual({ ok: true, pushed: head });
  });

  it("2.3 does not take a commit that never reached main for pushed", async () => {
    const { work } = directRepos();
    const unpushed = git(work, "rev-parse", "HEAD").trim();
    const result = await direct(work).runGates(ticket, { pushIntended: unpushed });
    // It is pushed by this run, as for any ticket.
    expect(result.ok).toBe(true);
    expect(result.ok && result.pushed).toBe(git(work, "rev-parse", "HEAD").trim());
    expect(result.ok && result.pushed).not.toBe(unpushed);
  });

  it("6.1 lets through only the protected paths the owner OKed, and asks about a new one", async () => {
    const { work } = directRepos(".github/workflows/ci.yml");
    execFileSync("mkdir", ["-p", join(work, "docs")]);
    writeFileSync(join(work, "docs/x"), "x\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "docs");
    const both = new MachineHarness(
      {
        recipe: () => ["true"],
        worktree: () => work,
        github: async () => ({}),
        policy: () => ({ ...policy, protectedPaths: [".github/", "docs/x"] }),
      },
      localScript,
    );
    // The OK was for docs/x only: the workflow change is held, and only it is named.
    const held = await both.runGates(ticket, { ownerApproved: false, approvedPaths: ["docs/x"] });
    expect(held).toMatchObject({ ok: false, protectedPaths: [".github/workflows/ci.yml"] });
    expect(
      await both.runGates(ticket, { approvedPaths: ["docs/x", ".github/workflows/ci.yml"] }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("6.5 works on a default branch with a slash in its name", async () => {
    const root = mkdtempSync(join(tmpdir(), "inc-harness-"));
    const origin = join(root, "origin");
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "release/1.0", origin);
    writeFileSync(join(origin, "file"), "base\n");
    git(origin, "add", "file");
    git(origin, "commit", "-q", "-m", "base");
    git(origin, "config", "receive.denyCurrentBranch", "updateInstead");
    git(root, "clone", "-q", origin, work);
    git(work, "switch", "-q", "-c", "inc/t7-x");
    writeFileSync(join(work, "other"), "ours\n");
    git(work, "add", "other");
    git(work, "commit", "-q", "-m", "ours");
    const h = new MachineHarness(
      {
        recipe: () => ["true"],
        worktree: () => work,
        github: async () => ({}),
        policy: () => policy,
        defaultBranch: () => "release/1.0",
      },
      localScript,
    );
    const result = await h.runGates(ticket);
    const head = git(work, "rev-parse", "HEAD").trim();
    expect(result).toEqual({ ok: true, pushed: head });
    expect(git(origin, "rev-parse", "release/1.0").trim()).toBe(head);
    expect(() => rebaseScript("/w", "release/1.0")).not.toThrow();
    expect(() => changedScript("/w", "release/1.0")).not.toThrow();
    expect(() => pushMainScript("/w", "release/1.0")).not.toThrow();
    // Still refused: anything git or a shell would read as something else.
    for (const bad of ["a b", "x;rm", "-x", "a..b", "$(x)", "", "a'b"]) {
      expect(() => rebaseScript("/w", bad)).toThrow("not a branch name");
    }
  });
});

describe("protected paths match the exact path and everything under it", () => {
  it("6.4 treats an entry with or without a trailing slash alike", () => {
    expect(isProtected(".github/workflows/ci.yml", [".github/workflows"])).toBe(true);
    expect(isProtected(".github/workflows/ci.yml", [".github/workflows/"])).toBe(true);
    expect(isProtected(".github/workflows", [".github/workflows"])).toBe(true);
    expect(isProtected("package.json", ["package.json"])).toBe(true);
    // A longer name with the same start is not under it.
    expect(isProtected(".github/workflows-old/x", [".github/workflows"])).toBe(false);
    expect(isProtected("package.json.bak", ["package.json"])).toBe(false);
    expect(isProtected("src/a.ts", [""])).toBe(false);
  });
});
