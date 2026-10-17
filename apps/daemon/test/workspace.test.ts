// Pick-up's branch and draft PR. The git script runs in real bash with real git, against a local
// origin, with HOME in a temp folder so it can't touch the real global git config.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Employee, Ticket } from "@i-inc/core";
import { defaultSwitchRules } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { FineGrainedToken, type PullRequests } from "../src/github.ts";
import type { RunScript } from "../src/harness.ts";
import { branchName, GitHubWorkspace, openScript } from "../src/workspace.ts";

const home = mkdtempSync(join(tmpdir(), "inc-home-"));
const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig") };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

const localScript: RunScript = (_employee, script, extra = {}) =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-s"], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
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

const ticket: Ticket = {
  id: "7",
  title: "Refunds are counted as spending!",
  project: "Duet",
  type: "fix",
  effort: "low",
  doneWhen: ["August drops by the refund"],
  assignee: "ada",
};
const ada: Employee = {
  id: "ada",
  name: "Ada",
  role: "Senior Engineer",
  duties: ["build"],
  engines: { default: "opus", fallbacks: [] },
  switchRules: defaultSwitchRules,
};

/** An origin with one commit on main, and a machine's work folder. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "inc-ws-"));
  const origin = join(root, "origin");
  git(root, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "README.md"), "duet\n");
  git(origin, "add", "README.md");
  git(origin, "-c", "user.name=o", "-c", "user.email=o@example.invalid", "commit", "-q", "-m", "base");
  return { root, origin };
}

const script = (origin: string, work: string) =>
  openScript({
    remote: origin,
    repoDir: join(work, "duet"),
    worktree: join(work, "inc-7"),
    branch: branchName(ticket),
    name: "Ada (i.inc)",
    email: "1+i-inc-bot[bot]@users.noreply.github.com",
    message: "chore: start work on Refunds are counted as spending!",
  });

describe("pick-up's git", () => {
  it("names the branch after the ticket", () => {
    expect(branchName(ticket)).toBe("inc/7-refunds-are-counted-as-spending");
    expect(branchName({ ...ticket, title: "!!!" })).toBe("inc/7-work");
  });

  it("clones once, makes the worktree and branch from main, starts it with an empty commit, and pushes", async () => {
    const { root, origin } = setup();
    const work = join(root, "machine-a");
    const first = await localScript("ada", script(origin, work));
    expect(first.output).toContain("@@pushed");
    const wt = join(work, "inc-7");
    expect(git(wt, "branch", "--show-current")).toBe("inc/7-refunds-are-counted-as-spending");
    expect(git(wt, "log", "--format=%an <%ae>|%s", "-1")).toBe(
      "Ada (i.inc) <1+i-inc-bot[bot]@users.noreply.github.com>|chore: start work on Refunds are counted as spending!",
    );
    expect(git(origin, "rev-parse", "inc/7-refunds-are-counted-as-spending")).toBe(
      git(wt, "rev-parse", "HEAD"),
    );

    // Again, as after a crash: nothing new.
    const again = await localScript("ada", script(origin, work));
    expect(again.output).toContain("@@pushed");
    expect(git(wt, "rev-list", "--count", "origin/main..HEAD")).toBe("1");

    // Another machine, as after a handoff: it checks out the branch that's on origin.
    const other = join(root, "machine-b");
    expect((await localScript("kit", script(origin, other))).output).toContain("@@pushed");
    expect(git(join(other, "inc-7"), "rev-parse", "HEAD")).toBe(git(wt, "rev-parse", "HEAD"));
  });
});

describe("the GitHub workspace", () => {
  function workspace(o: { run?: RunScript; existing?: boolean; draft?: boolean } = {}) {
    const calls: string[] = [];
    const seen: Record<string, string>[] = [];
    const prs = {
      find: async (repo: string, branch: string) => {
        calls.push(`find ${repo} ${branch}`);
        return o.existing ? { number: 3, url: "https://github.com/o/duet/pull/3", nodeId: "PR_3" } : null;
      },
      openDraft: async (repo: string, pr: { head: string; title: string; body: string }) => {
        calls.push(`open ${repo} ${pr.head} ${pr.title}`);
        return { number: 4, url: "https://github.com/o/duet/pull/4", nodeId: "PR_4" };
      },
      setBody: async (_repo: string, n: number) => {
        calls.push(`body ${n}`);
      },
      isDraft: async () => o.draft ?? true,
      markReady: async (_repo: string, id: string) => {
        calls.push(`ready ${id}`);
      },
    } as unknown as PullRequests;
    const ws = new GitHubWorkspace({
      project: (name) => (name === "Duet" ? { id: "Duet", repo: "o/duet", checks: ["true"] } : undefined),
      tokens: new FineGrainedToken("ghs_x"),
      prs,
      identity: async (e) => ({
        name: `${e.name} (i.inc)`,
        email: "1+i-inc-bot[bot]@users.noreply.github.com",
      }),
      worktree: (id) => `/home/employee/work/inc-${id}`,
      run:
        o.run ??
        (async (_e, _s, env = {}) => {
          seen.push(env);
          return { code: 0, output: "@@pushed\n" };
        }),
    });
    return { ws, calls, seen };
  }

  it("pushes the branch with the repo's token, then opens the draft", async () => {
    const { ws, calls, seen } = workspace();
    expect(await ws.open(ticket, ada)).toEqual({
      number: 4,
      url: "https://github.com/o/duet/pull/4",
      nodeId: "PR_4",
      branch: "inc/7-refunds-are-counted-as-spending",
    });
    expect(seen).toEqual([{ GH_TOKEN: "ghs_x" }]);
    expect(calls).toEqual([
      "find o/duet inc/7-refunds-are-counted-as-spending",
      "open o/duet inc/7-refunds-are-counted-as-spending fix: Refunds are counted as spending!",
    ]);
  });

  it("finds the PR it opened before a crash, and says what git said when it fails", async () => {
    expect((await workspace({ existing: true }).ws.open(ticket, ada)).number).toBe(3);
    const failing = workspace({ run: async () => ({ code: 128, output: "fatal: could not read Username" }) });
    await expect(failing.ws.open(ticket, ada)).rejects.toThrow(
      "git in Ada's machine failed: fatal: could not read Username",
    );
    await expect(workspace().ws.open({ ...ticket, project: "Nope" }, ada)).rejects.toThrow("no project Nope");
  });

  it("writes the report into the PR and marks it ready, once", async () => {
    const pr = { number: 4, url: "u", nodeId: "PR_4", branch: "b" };
    const draft = workspace();
    await draft.ws.ready(ticket, pr, "## report");
    expect(draft.calls).toEqual(["body 4", "ready PR_4"]);
    const done = workspace({ draft: false });
    await done.ws.ready(ticket, pr, "## report");
    expect(done.calls).toEqual(["body 4"]);
  });
});
