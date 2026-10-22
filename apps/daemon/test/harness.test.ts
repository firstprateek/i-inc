import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatesResult, Ticket } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import {
  changedScript,
  type HarnessSettings,
  MachineHarness,
  type RunScript,
  rebaseScript,
} from "../src/harness.ts";
import { HostPusher } from "../src/host-push.ts";
import { isProtected } from "../src/paths.ts";
import { fakeTokens, leaksOf, READ_TOKEN, type SandboxCall, WRITE_TOKEN } from "./fake-tokens.ts";

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
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
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

/** Where the sandbox keeps the ticket's worktree (the scripts only accept this shape); the test maps it to `work`. */
const SANDBOX_WORKTREE = "/home/employee/work/inc-t7";

/**
 * A harness with GitHub: reads with a read-only token, and pushes through the host, to the local "origin" next to
 * the worktree. `calls` is every script that went into the "sandbox", for looking for a write token.
 */
function withGitHub(work: string, settings: Partial<HarnessSettings> = {}, hideChanges = false) {
  const origin = join(work, "..", "origin");
  const calls: SandboxCall[] = [];
  const run: RunScript = (employeeId, script, extra) => {
    calls.push({ via: "run", employeeId, script, env: extra });
    // A machine that says nothing changed, whatever did.
    if (hideChanges && script.includes("@@changed64")) return Promise.resolve({ code: 0, output: "" });
    return localScript(employeeId, script.replaceAll(SANDBOX_WORKTREE, work), extra);
  };
  const host = new HostPusher({
    tokens: fakeTokens(),
    mirrors: join(work, "..", "mirrors"),
    ledger: join(work, "..", "ledger", "pushed-main.jsonl"),
    remote: () => origin,
  });
  const harness = new MachineHarness(
    {
      recipe: () => ["true"],
      worktree: () => SANDBOX_WORKTREE,
      github: async () => ({ GH_TOKEN: READ_TOKEN }),
      host,
      repo: () => "acme/duet",
      author: async () => ({ name: "Ada (i.inc)", email: "bot@example.invalid" }),
      ...settings,
    },
    run,
  );
  return { harness, calls, origin, ledger: join(work, "..", "ledger", "pushed-main.jsonl") };
}

/** The options the runner passes after the owner OKs the card a held run produced (state.ts: the OK is for that change). */
function okOf(held: GatesResult) {
  if (held.ok || !held.approval || !held.protectedPaths)
    throw new Error(`not a card: ${JSON.stringify(held)}`);
  return {
    ownerApproved: true,
    approvedPaths: held.protectedPaths,
    approval: { sha: held.approval.sha, patchId: held.approval.patchId, paths: held.protectedPaths },
  };
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

  it("gates: with GitHub, the host pushes the rebased branch so the PR shows what passed", async () => {
    const work = repos("ours", "other");
    const { harness: gh, calls, origin } = withGitHub(work);
    expect(await gh.runGates(ticket)).toEqual({ ok: true });
    expect(git(origin, "rev-parse", "inc/t7-x").trim()).toBe(git(work, "rev-parse", "HEAD").trim());
    // The sandbox's scripts never held a write credential, and none of them pushes.
    expect(leaksOf(calls)).toEqual([]);
    expect(calls.map((c) => c.script).join("\n")).not.toMatch(/git push/);
    expect(JSON.stringify(calls.map((c) => c.env))).not.toContain(WRITE_TOKEN);
  });

  it("gates: then waits for CI on the pushed commit, and fails with its reason", async () => {
    const work = repos("ours", "other");
    const seen: string[] = [];
    const { harness: redCi } = withGitHub(work, {
      ci: async (_ticket, sha) => {
        seen.push(sha);
        return { ok: false, reason: "CI failed: Lint, types and tests (failure)" };
      },
    });
    expect(await redCi.runGates(ticket)).toEqual({
      ok: false,
      conflict: false,
      reason: "CI failed: Lint, types and tests (failure)",
    });
    expect(seen).toEqual([git(work, "rev-parse", "HEAD").trim()]);
  });

  it("gates: pushes the commit that was rebased, even if a check moves the branch afterwards", async () => {
    const work = repos("ours", "other");
    const origin = join(work, "..", "origin");
    // A check (arbitrary code the project runs) adds a commit with a credential on the branch.
    const sneaky = `git commit -q --allow-empty -m 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'`;
    const { harness: gh } = withGitHub(work, { recipe: () => [`cd '${work}' && ${sneaky}`] });
    const result = await gh.runGates(ticket);
    expect(result).toEqual({ ok: true });
    const pushed = git(origin, "rev-parse", "inc/t7-x").trim();
    expect(git(work, "rev-list", "--count", `${pushed}..HEAD`).trim()).toBe("1");
    expect(git(origin, "log", "--format=%s", "inc/t7-x")).not.toContain("ghp_");
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
    const { harness: gated } = withGitHub(work);
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
    withGitHub(work, { recipe: () => recipe, policy: () => policy }).harness;

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
    const held = await direct(work).runGates(ticket);
    expect(held).toMatchObject({ ok: false, protectedPaths: [".github/workflows/ci.yml"] });
    // The card carries the commit and the diff of the protected paths, from the host.
    expect(held.ok ? "" : held.approval?.diff).toContain("+changed");
    expect(held.ok ? "" : held.approval?.sha).toBe(git(work, "rev-parse", "HEAD").trim());
    expect(git(origin, "rev-parse", "main").trim()).toBe(before);
    expect(await direct(work).runGates(ticket, okOf(held))).toMatchObject({ ok: true });
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

  it("an OK does not carry over to a new run: a new commit, or other content in the same paths, asks again", async () => {
    const { work, origin } = directRepos(".github/workflows/ci.yml");
    const gh = withGitHub(work, { policy: () => policy }).harness;
    const held = await gh.runGates(ticket);
    const ok = okOf(held);
    // The builder changes the workflow after the owner's OK (a new run).
    writeFileSync(join(work, ".github/workflows/ci.yml"), "name: evil\n");
    git(work, "commit", "-q", "-am", "swap the workflow");
    const before = git(origin, "rev-parse", "main").trim();
    const again = await gh.runGates(ticket, ok);
    expect(again).toMatchObject({ ok: false, protectedPaths: [".github/workflows/ci.yml"] });
    expect(again.ok ? "" : again.approval?.diff).toContain("name: evil");
    expect(git(origin, "rev-parse", "main").trim()).toBe(before);
  });

  it("holds protected paths itself: a machine that hides what changed can't push them without the owner", async () => {
    const { work, origin } = directRepos(".github/workflows/ci.yml");
    const before = git(origin, "rev-parse", "main").trim();
    const { harness: liar } = withGitHub(work, { policy: () => policy }, true);
    const held = await liar.runGates(ticket);
    expect(held).toMatchObject({ ok: false, protectedPaths: [".github/workflows/ci.yml"] });
    expect(git(origin, "rev-parse", "main").trim()).toBe(before);
    // Once the owner approves, it goes; an OK is not enough without what it was for.
    expect(await liar.runGates(ticket, { ownerApproved: true })).toMatchObject({ ok: false });
    expect(await liar.runGates(ticket, okOf(held))).toMatchObject({ ok: true });
  });

  it("holds code the host could run for the owner in the repo the deployer deploys, whatever the project's protected paths say", async () => {
    const { work, origin } = directRepos("apps/daemon/src/x.ts");
    const before = git(origin, "rev-parse", "main").trim();
    const { harness: gh, ledger } = withGitHub(work, {
      policy: () => ({ ...policy, protectedPaths: [] }),
      hostExecuted: () => true,
    });
    const held = await gh.runGates(ticket);
    expect(held).toMatchObject({
      ok: false,
      protectedPaths: expect.arrayContaining(["apps/daemon/src/x.ts"]),
    });
    expect(git(origin, "rev-parse", "main").trim()).toBe(before);
    // The owner's OK: it goes, and the ledger says so, with the paths.
    expect(await gh.runGates(ticket, okOf(held))).toMatchObject({ ok: true });
    const line = JSON.parse(readFileSync(ledger, "utf8").trim().split("\n")[0] ?? "{}");
    expect(line).toMatchObject({
      ownerApproved: true,
      approvedPaths: ["apps/daemon/src/x.ts", "file"],
      ticket: "t7",
    });
  });

  it("does not hold a document in that repo, and the host holds code even when the machine hides it", async () => {
    const docs = directRepos("docs/guide.md");
    // The repos' first change is to a file named "file"; put it back, so the change is a document alone.
    writeFileSync(join(docs.work, "file"), git(docs.work, "show", "origin/main:file"));
    git(docs.work, "commit", "-q", "-am", "put file back");
    const a = withGitHub(docs.work, {
      policy: () => ({ ...policy, protectedPaths: [] }),
      hostExecuted: () => true,
    });
    expect(await a.harness.runGates(ticket)).toMatchObject({ ok: true });
    const code = directRepos("apps/web/x.ts");
    const b = withGitHub(
      code.work,
      { policy: () => ({ ...policy, protectedPaths: [] }), hostExecuted: () => true },
      true,
    );
    expect(await b.harness.runGates(ticket)).toMatchObject({
      ok: false,
      protectedPaths: expect.arrayContaining(["apps/web/x.ts"]),
    });
  });

  it("asks the owner about a credential the scan found, and pushes it only after the owner says it is not one", async () => {
    const { work, origin } = directRepos("fixtures.ts");
    writeFileSync(
      join(work, "fixtures.ts"),
      'export const fake = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n',
    );
    git(work, "commit", "-q", "-am", "fixture");
    const before = git(origin, "rev-parse", "main").trim();
    const { harness: gh, ledger } = withGitHub(work, { policy: () => ({ ...policy, protectedPaths: [] }) });
    const asked = await gh.runGates(ticket);
    expect(asked).toMatchObject({
      ok: false,
      protectedPaths: [expect.stringMatching(/^commit [0-9a-f]{7} \(looks like a credential\)$/)],
    });
    expect(JSON.stringify(asked)).not.toContain("ghp_");
    expect(git(origin, "rev-parse", "main").trim()).toBe(before);
    // Approved without having been asked about a credential first (another harness): still refused.
    const fresh = withGitHub(work, { policy: () => ({ ...policy, protectedPaths: [] }) }).harness;
    expect(await fresh.runGates(ticket, { ownerApproved: true })).toMatchObject({ ok: false });
    // The owner says it is not a secret.
    expect(await gh.runGates(ticket, { ownerApproved: true })).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(ledger, "utf8").trim().split("\n")[0] ?? "{}")).toMatchObject({
      ownerApproved: true,
      secretsOverridden: true,
    });
  });

  it("writes what it pushed to main in the deployer's ledger", async () => {
    const { work } = directRepos();
    const { harness: gh, ledger } = withGitHub(work, { policy: () => policy });
    const result = await gh.runGates(ticket);
    const head = git(work, "rev-parse", "HEAD").trim();
    expect(result).toEqual({ ok: true, pushed: head });
    const lines = readFileSync(ledger, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({ sha: head, tip: true, ticket: "t7", repo: "acme/duet", branch: "main" }),
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
    const both = withGitHub(work, {
      policy: () => ({ ...policy, protectedPaths: [".github/", "docs/x"] }),
    }).harness;
    // The OK was for docs/x only: the workflow change is held, and only it is named.
    const first = await both.runGates(ticket);
    expect(first).toMatchObject({ ok: false, protectedPaths: [".github/workflows/ci.yml", "docs/x"] });
    // An OK for docs/x alone (a card that named only it) leaves the workflow change held, and only it is named.
    const held = await both.runGates(ticket, {
      ownerApproved: true,
      approvedPaths: ["docs/x"],
      approval: { sha: first.ok ? "" : (first.approval?.sha ?? ""), patchId: "x", paths: ["docs/x"] },
    });
    expect(held).toMatchObject({ ok: false, protectedPaths: [".github/workflows/ci.yml", "docs/x"] });
    expect(await both.runGates(ticket, okOf(first))).toMatchObject({ ok: true });
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
    const h = withGitHub(work, { policy: () => policy, defaultBranch: () => "release/1.0" }).harness;
    const result = await h.runGates(ticket);
    const head = git(work, "rev-parse", "HEAD").trim();
    expect(result).toEqual({ ok: true, pushed: head });
    expect(git(origin, "rev-parse", "release/1.0").trim()).toBe(head);
    expect(() => rebaseScript("/w", "release/1.0")).not.toThrow();
    expect(() => changedScript("/w", "release/1.0")).not.toThrow();
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

describe("a script that prints without end", () => {
  it("is stopped at the cap and says so, instead of filling the daemon's memory", async () => {
    const { chmodSync, writeFileSync: write } = await import("node:fs");
    const bin = join(mkdtempSync(join(tmpdir(), "inc-bin-")), "container");
    write(bin, "#!/bin/sh\nexec yes 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\n");
    chmodSync(bin, 0o755);
    const { machineScript, MAX_SCRIPT_OUTPUT } = await import("../src/harness.ts");
    const { defaultMachineSettings } = await import("../src/machines.ts");
    const { wallsMarker: _, ...noWalls } = defaultMachineSettings;
    const run = machineScript({ ...noWalls, bin }, async () => "");
    const r = await run("ada", "true");
    expect(r.code).toBe(1);
    expect(r.output).toContain("@@output-limit");
    expect(r.output.length).toBeLessThan(10_000);
    expect(MAX_SCRIPT_OUTPUT).toBe(16 * 1024 * 1024);
  });
});

describe("what a machine says is on main", () => {
  it("is not taken for pushed: the sha it names on an empty rebase must be on main in the host's mirror", async () => {
    const claimed = "c".repeat(40);
    let asked: string | undefined;
    const run: RunScript = async (_e, script) => {
      if (script.includes("@@changed64")) return { code: 0, output: "" };
      if (script.includes("git rebase")) return { code: 5, output: `@@empty ${claimed}\n` };
      return { code: 0, output: "" };
    };
    const harness = (landed: boolean) =>
      new MachineHarness(
        {
          recipe: () => ["true"],
          worktree: () => "/home/employee/work/inc-t7",
          github: async () => ({}),
          policy: () => ({ mode: "direct" as const, protectedPaths: [], followUpsPerDay: 3 }),
          repo: () => "acme/duet",
          host: {
            push: async () => {
              throw new Error("no push");
            },
            tips: async () => [],
            revert: async () => {
              throw new Error("no revert");
            },
            landed: async (r) => {
              asked = r.sha;
              return landed;
            },
          },
        },
        run,
      );
    // The host's mirror has not got it on main: it is not "pushed", and nothing downstream runs CI on or reverts it.
    expect(await harness(false).runGates(ticket, { ownerApproved: true })).toMatchObject({ ok: false });
    expect(asked).toBe(claimed);
    expect(await harness(true).runGates(ticket, { ownerApproved: true })).toEqual({
      ok: true,
      pushed: claimed,
    });
  });
});
