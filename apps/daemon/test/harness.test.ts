import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ticket } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { MachineHarness, type RunScript } from "../src/harness.ts";

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

  it("gates: checks that fail after the rebase are not a conflict", async () => {
    const work = repos("ours", "other");
    const result = await harness(work, ["false"]).runGates(ticket);
    expect(result).toMatchObject({ ok: false, conflict: false });
  });
});
