// A conversation comes back after its working copy was cleaned up while it was archived, a
// conversation is made while the sandbox is being cleaned, and a copy made for a session that
// failed to open does not stay behind. The scripts run for real, with git, in temporary folders.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoSlotError } from "../../src/ahp/session-host.ts";
import { branchName, GitHubWorkspace, openScript, removeCopyScript } from "../../src/workspace.ts";
import { sessionRig, until } from "./session-rig.ts";
import { type Any, turnStarted } from "./support.ts";

let root: string;
let work: string;
let remote: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    { encoding: "utf8" },
  );

const bash = (script: string): string => {
  const r = spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, HOME: root },
  });
  if (r.status !== 0) throw new Error(`script failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
};

const open = (branch = "conv/c1", cwd = join(work, "conv-c1")) =>
  bash(
    openScript({
      remote,
      repoDir: join(work, "repo"),
      worktree: cwd,
      branch,
      name: "Ada (i.inc)",
      email: "bot@example.com",
      message: "",
      push: false,
      local: "keep", // a conversation's
    }),
  );

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inc-reopen-")));
  work = join(root, "work");
  remote = join(root, "remote.git");
  mkdirSync(work);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "first");
  git(seed, "push", "--quiet", remote, "main");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** What the storage cleanup does to a copy: the folder goes, then git forgets the worktree. */
const cleanedUp = (cwd: string) => {
  rmSync(cwd, { recursive: true, force: true });
  git(join(work, "repo"), "worktree", "prune");
};

describe("a conversation's working copy made again after the cleanup", () => {
  it("checks the branch out again with its unpushed commits, instead of failing on every message", () => {
    const cwd = join(work, "conv-c1");
    expect(open()).toContain("@@copy fresh");
    writeFileSync(join(cwd, "notes.txt"), "work in progress\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "wip");
    writeFileSync(join(cwd, "scratch.txt"), "never committed\n");
    cleanedUp(cwd);
    expect(existsSync(cwd)).toBe(false);

    const out = open();
    expect(out).toContain("@@copy restored");
    expect(out).toContain("@@ready");
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("work in progress\n"); // the commit is back
    expect(existsSync(join(cwd, "scratch.txt"))).toBe(false); // what was never committed is not
    expect(git(cwd, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("conv/c1");
    // and again: now it is simply there
    expect(open()).toContain("@@copy existing");
  });

  it("makes a branch with no commits of its own again from where it was, and a missing one from the main branch", () => {
    const cwd = join(work, "conv-c1");
    open();
    cleanedUp(cwd);
    expect(open()).toContain("@@copy restored");
    expect(git(cwd, "log", "--format=%s").trim()).toBe("first");
    // the branch itself gone (deleted by hand): a new one
    cleanedUp(cwd);
    git(join(work, "repo"), "branch", "-D", "conv/c1");
    expect(open()).toContain("@@copy fresh");
  });

  it("recreates the copy from GitHub's branch when it is there, and never resets a local branch that is ahead of it", () => {
    const cwd = join(work, "conv-c1");
    open();
    writeFileSync(join(cwd, "a.txt"), "pushed\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "pushed");
    git(cwd, "push", "--quiet", "origin", "conv/c1");
    cleanedUp(cwd);
    expect(open()).toContain("@@copy remote");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("pushed\n");
    // a commit after the push, then the cleanup: the local branch is ahead of GitHub's and is kept as it is
    writeFileSync(join(cwd, "b.txt"), "not pushed\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "local only");
    const tip = git(cwd, "rev-parse", "HEAD").trim();
    cleanedUp(cwd);
    expect(open()).toContain("@@copy restored");
    expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("not pushed\n");
  });
});

describe("a ticket's worktree made again over a diverged local branch", () => {
  it("is reset to GitHub's, as before, after the local one is saved where it can be found, and the ticket says so", async () => {
    const logs: string[] = [];
    const ticket = {
      id: "7",
      title: "Fix refunds",
      project: "Duet",
      type: "fix",
      effort: "medium",
      doneWhen: [],
    } as never;
    const ada = { id: "ada", name: "Ada" } as never;
    const worktree = join(work, "inc-7");
    const ws = new GitHubWorkspace({
      project: () => ({ id: "Duet", repo: "o/repo", checks: [] }) as never,
      tokens: { token: async () => "t" },
      prs: {} as never,
      identity: async () => ({ name: "Ada (i.inc)", email: "bot@example.com" }),
      worktree: () => worktree,
      policy: () => ({ mode: "direct" }) as never,
      remote: () => remote,
      run: async (_e, script) => {
        const r = spawnSync("bash", ["-s"], {
          input: script,
          encoding: "utf8",
          env: { ...process.env, HOME: root },
        });
        return { code: r.status ?? 1, output: r.stdout + r.stderr };
      },
      log: (m) => logs.push(m),
    });
    const branch = branchName(ticket);
    expect((await ws.open(ticket, ada)).note).toBeUndefined();
    // GitHub has the branch at one commit; the machine's has a second, never pushed
    writeFileSync(join(worktree, "a.txt"), "pushed\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "--quiet", "-m", "pushed");
    git(worktree, "push", "--quiet", "origin", branch);
    writeFileSync(join(worktree, "b.txt"), "only here\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "--quiet", "-m", "local only");
    const lost = git(worktree, "rev-parse", "HEAD").trim();
    const onGithub = git(worktree, "rev-parse", `origin/${branch}`).trim();
    cleanedUp(worktree);

    const ref = await ws.open(ticket, ada);
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(onGithub); // as before: GitHub's
    expect(existsSync(join(worktree, "b.txt"))).toBe(false);
    const backups = git(
      join(work, "repo"),
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/inc-backup/",
    ).trim();
    expect(backups).toMatch(new RegExp(`^refs/inc-backup/${branch}-\\d+ ${lost}$`));
    expect(ref.note).toContain(backups.split(" ")[0] as string);
    expect(ref.note).toContain("had commits GitHub's copy lacked");
    expect(logs.some((l) => l.includes("inc-backup"))).toBe(true);
    // behind only (nothing local that GitHub lacks): reset without a backup
    cleanedUp(worktree);
    expect((await ws.open(ticket, ada)).note).toBeUndefined();
  });
});

describe("a copy made for a session that failed to open", () => {
  it("is removed when nothing is in it, with its new branch", () => {
    const cwd = join(work, "conv-c1");
    open();
    expect(bash(removeCopyScript({ worktree: cwd, branch: "conv/c1" }))).toContain("@@removed");
    expect(existsSync(cwd)).toBe(false);
    expect(git(join(work, "repo"), "branch", "--list", "conv/c1").trim()).toBe("");
    expect(git(join(work, "repo"), "worktree", "list").trim().split("\n")).toHaveLength(1);
    // and again: already gone
    expect(bash(removeCopyScript({ worktree: cwd, branch: "conv/c1" }))).toContain("@@gone");
  });

  it("is left alone when there is a commit or a change in it", () => {
    const cwd = join(work, "conv-c1");
    open();
    writeFileSync(join(cwd, "x"), "change\n");
    expect(bash(removeCopyScript({ worktree: cwd, branch: "conv/c1" }))).toContain("@@kept work");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "mine");
    expect(bash(removeCopyScript({ worktree: cwd, branch: "conv/c1" }))).toContain("@@kept work");
    expect(existsSync(join(cwd, "x"))).toBe(true);
  });

  it("is an empty folder when there is no project, and only an empty one goes", () => {
    const cwd = join(work, "conv-c2");
    mkdirSync(cwd);
    expect(bash(removeCopyScript({ worktree: cwd, branch: null }))).toContain("@@removed");
    expect(existsSync(cwd)).toBe(false);
    mkdirSync(cwd);
    writeFileSync(join(cwd, "file"), "x");
    expect(bash(removeCopyScript({ worktree: cwd, branch: null }))).toContain("@@kept files");
    expect(existsSync(join(cwd, "file"))).toBe(true);
  });

  it("is taken away by the session host when the agent needs a sign-in or will not start, and not when no slot was free", async () => {
    const removed: string[] = [];
    const t = await sessionRig({
      host: {
        workingCopy: async () => "fresh",
        removeCopy: async (c) => {
          removed.push(c.cwd);
        },
        perTeamCap: 1,
      },
    });
    t.sandbox.options = { authRequired: true };
    await expect(t.create("c1")).rejects.toThrow(/sign-in/);
    expect(removed).toEqual(["/home/employee/work/conv-c1"]);
    t.sandbox.options = {};
    t.sandbox.failLaunch = new Error("the walls aren't up");
    await expect(t.create("c2")).rejects.toThrow(/walls/);
    expect(removed).toEqual(["/home/employee/work/conv-c1", "/home/employee/work/conv-c2"]);
    t.sandbox.failLaunch = undefined;
    // one that works takes the only slot; the next finds none, and made no copy to remove
    const busy = await t.create("c3");
    (await t.client(busy)).dispatch(busy.chat, turnStarted("slow forever", "t-slow"));
    await until(() => t.host.chatState(busy.chat)?.activeTurn);
    await expect(t.create("c4")).rejects.toBeInstanceOf(NoSlotError);
    expect(removed).toHaveLength(2);
  });
});

describe("a conversation back after its copy was cleaned up", () => {
  it("says so in the chat, once, with what became of the copy", async () => {
    let state: "existing" | "restored" | "fresh" | "remote" = "fresh";
    const t = await sessionRig({
      host: { workingCopy: async () => state, idleMs: 60_000 },
    });
    const c = await t.create("c1", { project: "Duet" });
    const a = await t.client(c);
    await t.say(a, c.chat, "plain hello");
    expect(JSON.stringify(t.host.chatState(c.chat)?.turns)).not.toContain("cleaned up"); // the first copy is no news
    // archived, cleaned up, unarchived: the agent is gone and the copy is made again
    t.time.now += 120_000;
    t.sessions.sweep();
    await until(() => t.sandbox.agents[0]?.exitCode !== undefined);
    state = "restored";
    const id = await t.say(a, c.chat, "plain hello again");
    const turn = t.host.chatState(c.chat)?.turns.find((x: Any) => x.id === id) as Any;
    const notes = turn.responseParts.filter((p: Any) => p.kind === "systemNotification");
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain("cleaned up while it was archived");
    expect(notes[0].content).toContain("conv/c1");
    expect(notes[0].content).toContain("commits it had");
    // a copy that was simply still there needs no note
    t.time.now += 120_000;
    t.sessions.sweep();
    await until(() => t.sandbox.agents[1]?.exitCode !== undefined);
    state = "existing";
    const again = await t.say(a, c.chat, "plain and again");
    const turn3 = t.host.chatState(c.chat)?.turns.find((x: Any) => x.id === again) as Any;
    expect(turn3.responseParts.filter((p: Any) => p.kind === "systemNotification")).toHaveLength(0);
  });
});

describe("a conversation made while the sandbox is being cleaned up", () => {
  it("returns at once, without an agent, and the first message waits for the cleanup and says so", async () => {
    let held = false;
    let release!: () => void;
    const freed = new Promise<boolean>((r) => {
      release = () => {
        held = false;
        r(true);
      };
    });
    const t = await sessionRig();
    t.sessions.attachApp({
      storage: { machineOf: () => "inc-engineering", holding: () => held, untilFree: () => freed },
      awake: () => {},
    });
    // the agent's settings are learned from one session made earlier
    await t.create("c0");
    const launches = t.sandbox.launches.length;
    held = true;
    const t0 = Date.now();
    const c = await t.create("c1", { mode: "plan" });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(t.sandbox.launches).toHaveLength(launches); // no agent, no waiting
    expect(t.host.sessionState(c.session)?.config?.values.mode).toBe("plan");
    expect(t.host.sessionState(c.session)?.config?.schema).toBeTruthy();

    const a = await t.client(c);
    a.dispatch(c.chat, turnStarted("plain hello", "t1"));
    await until(() =>
      t.host.chatState(c.chat)?.activity?.includes("Waiting for the sandbox cleanup to finish"),
    );
    expect(t.sandbox.launches).toHaveLength(launches);
    release();
    await until(() => t.host.chatState(c.chat)?.turns.length === 1);
    expect(t.host.chatState(c.chat)?.turns[0]?.state).toBe("complete");
    // the agent started as a first session, in the mode that was asked for
    expect(t.sandbox.launches).toHaveLength(launches + 1);
    expect(t.sandbox.last.received.some((m) => m.method === "session/new")).toBe(true);
    expect(t.sandbox.last.received.find((m) => m.method === "session/set_mode")?.params).toMatchObject({
      modeId: "plan",
    });
  });

  it("tells the owner at once if it has never seen the agent's settings", async () => {
    const t = await sessionRig();
    t.sessions.attachApp({
      storage: {
        machineOf: () => "inc-engineering",
        holding: () => true,
        untilFree: () => new Promise(() => {}),
      },
      awake: () => {},
    });
    const t0 = Date.now();
    await expect(t.create("c1")).rejects.toThrow(/sandbox is being cleaned up/);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
