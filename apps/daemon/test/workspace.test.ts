// Pick-up's branch and draft PR. The git script runs in real bash with real git, against a local
// origin, with HOME in a temp folder so it can't touch the real global git config.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Employee, Ticket } from "@i-inc/core";
import { defaultProjectPolicy, defaultSwitchRules } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import { createApi, imageLimits } from "../src/api.ts";
import type { PullRequests } from "../src/github.ts";
import type { RunScript } from "../src/harness.ts";
import { HostPusher } from "../src/host-push.ts";
import type { AttachmentFile } from "../src/tickets.ts";
import {
  attachmentScript,
  branchName,
  checkoutScript,
  GitHubWorkspace,
  openScript,
} from "../src/workspace.ts";
import { fakeTokens, READ_TOKEN } from "./fake-tokens.ts";
import { refunds, testApp } from "./setup.ts";

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
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
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
const kit: Employee = { ...ada, id: "kit", name: "Kit" };

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

/**
 * Pick-up's script in a machine, then what the host does with it: when the script says `@@needpush 1`, a push of
 * the commit it names (here a plain git push, standing in for the host's push of a verified bundle).
 */
async function pickUp(employee: string, origin: string, work: string) {
  const r = await localScript(employee, script(origin, work));
  if (r.output.includes("@@needpush 1")) {
    const head = /^@@head (\w+)$/m.exec(r.output)?.[1] ?? "";
    git(origin, "config", "receive.denyCurrentBranch", "ignore");
    git(join(work, "inc-7"), "push", "-q", "origin", `${head}:refs/heads/${branchName(ticket)}`);
  }
  return r;
}

describe("pick-up's git", () => {
  it("names the branch after the ticket", () => {
    expect(branchName(ticket)).toBe("inc/7-refunds-are-counted-as-spending");
    expect(branchName({ ...ticket, title: "!!!" })).toBe("inc/7-work");
  });

  it("clones once, makes the worktree and branch from main, starts it with an empty commit, and pushes", async () => {
    const { root, origin } = setup();
    const work = join(root, "machine-a");
    const first = await pickUp("ada", origin, work);
    expect(first.output).toContain("@@ready");
    expect(first.output).toContain("@@needpush 1");
    // The machine itself never pushes: the script holds no push, only the commit to hand over.
    expect(script(origin, work)).not.toContain("git push");
    const wt = join(work, "inc-7");
    expect(git(wt, "branch", "--show-current")).toBe("inc/7-refunds-are-counted-as-spending");
    expect(git(wt, "log", "--format=%an <%ae>|%s", "-1")).toBe(
      "Ada (i.inc) <1+i-inc-bot[bot]@users.noreply.github.com>|chore: start work on Refunds are counted as spending!",
    );
    expect(git(origin, "rev-parse", "inc/7-refunds-are-counted-as-spending")).toBe(
      git(wt, "rev-parse", "HEAD"),
    );

    // Again, as after a crash: nothing new.
    const again = await pickUp("ada", origin, work);
    expect(again.output).toContain("@@needpush 0");
    expect(git(wt, "rev-list", "--count", "origin/main..HEAD")).toBe("1");

    // Another machine, as after a handoff: it checks out the branch that's on origin.
    const other = join(root, "machine-b");
    expect((await pickUp("kit", origin, other)).output).toContain("@@needpush 0");
    expect(git(join(other, "inc-7"), "rev-parse", "HEAD")).toBe(git(wt, "rev-parse", "HEAD"));
  });

  it("writes the owner's images into the worktree, out of git's sight, and is safe to repeat", async () => {
    const { root, origin } = setup();
    const work = join(root, "machine-a");
    await pickUp("ada", origin, work);
    const wt = join(work, "inc-7");
    // Bigger than one base64 line, with every byte value, so the wrapping and decoding are both tried.
    const data = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));
    const file = { n: 1, name: "chart.png", mime: "image/png", size: data.byteLength, data };
    for (let i = 0; i < 2; i++) {
      const r = await localScript("ada", attachmentScript({ worktree: wt, file }));
      expect(r.code, r.output).toBe(0);
      expect(r.output).toContain("@@attached");
    }
    expect(new Uint8Array(readFileSync(join(wt, ".inc/attachments/1-chart.png")))).toEqual(data);
    expect(git(wt, "status", "--porcelain")).toBe("");
    const exclude = readFileSync(
      git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"),
      "utf8",
    );
    expect(exclude.split("\n").filter((l) => l === ".inc/")).toHaveLength(1);

    // Damaged on the way in: the script fails, and no image is left behind under its name.
    const broken = attachmentScript({ worktree: wt, file: { ...file, n: 2 } }).replace(/\n[^\n]*$/, "\n!!!!");
    const r = await localScript("ada", broken);
    expect(r.code).not.toBe(0);
    expect(r.output).not.toContain("@@attached");
    expect(existsSync(join(wt, ".inc/attachments/2-chart.png"))).toBe(false);
  });

  // #14: the biggest ticket the form takes, from the upload to the worktree, through stdin as
  // `machine run -i -- bash -s` sends it.
  it("lands six images of 10 MB each in the worktree with the same bytes", { timeout: 60_000 }, async () => {
    const { root, origin } = setup();
    const work = join(root, "machine-a");
    await pickUp("ada", origin, work);
    const wt = join(work, "inc-7");

    const app = await testApp();
    const handle = createApi(app.daemon, app.deps, { token: "t0ken", hosts: ["127.0.0.1:7420"] });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1]);
    const images = Array.from({ length: imageLimits.count }, () =>
      Buffer.concat([jpeg, randomBytes(imageLimits.bytes - jpeg.length)]),
    );
    const form = new FormData();
    form.set("ticket", JSON.stringify(refunds));
    images.forEach((data, i) => {
      form.append("image", new Blob([data as BlobPart], { type: "image/jpeg" }), `IMG_000${i + 1}.jpeg`);
    });
    const res = await handle(
      new Request("http://127.0.0.1:7420/api/tickets", {
        method: "POST",
        body: form,
        headers: { host: "127.0.0.1:7420", authorization: "Bearer t0ken", "x-i-inc-upload": "1" },
      }),
    );
    expect(res.status).toBe(201);
    const { ticket: filed } = (await res.json()) as { ticket: { id: string } };

    const files = app.deps.tickets.attachments(filed.id);
    expect(files).toHaveLength(imageLimits.count);
    for (const file of files) {
      const r = await localScript("ada", attachmentScript({ worktree: wt, file }));
      expect(r.code, r.output).toBe(0);
    }
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    images.forEach((data, i) => {
      const landed = readFileSync(join(wt, `.inc/attachments/${i + 1}-IMG_000${i + 1}.jpg`));
      expect(landed.byteLength).toBe(imageLimits.bytes);
      expect(sha(landed)).toBe(sha(data));
    });
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("refuses a name that isn't safe in a path", () => {
    const data = new Uint8Array([1]);
    expect(() =>
      attachmentScript({
        worktree: "/w",
        file: { n: 1, name: "../x.png", mime: "image/png", size: 1, data },
      }),
    ).toThrow(/not a safe path/);
  });
});

describe("the GitHub workspace", () => {
  function workspace(
    o: {
      run?: RunScript;
      existing?: boolean;
      draft?: boolean;
      attachments?: () => AttachmentFile[];
      state?: "open" | "closed" | "merged";
    } = {},
  ) {
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
      get: async (_repo: string, n: number) => {
        calls.push(`get ${n}`);
        return { number: n, state: o.state ?? "open" };
      },
      close: async (_repo: string, n: number) => {
        calls.push(`close ${n}`);
      },
    } as unknown as PullRequests;
    const ws = new GitHubWorkspace({
      project: (name) => (name === "Duet" ? { id: "Duet", repo: "o/duet", checks: ["true"] } : undefined),
      tokens: fakeTokens(),
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
          return { code: 0, output: "@@ready\n@@needpush 0\n" };
        }),
      ...(o.attachments ? { attachments: o.attachments } : {}),
    });
    return { ws, calls, seen };
  }

  it("reads with a read-only token (the host pushes), then opens the draft", async () => {
    const { ws, calls, seen } = workspace();
    expect(await ws.open(ticket, ada)).toEqual({
      number: 4,
      url: "https://github.com/o/duet/pull/4",
      nodeId: "PR_4",
      branch: "inc/7-refunds-are-counted-as-spending",
    });
    expect(seen).toEqual([{ GH_TOKEN: READ_TOKEN }]);
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

  it("copies each of the owner's images in after the worktree is made, without the token", async () => {
    const scripts: { script: string; env: Record<string, string> }[] = [];
    const data = new Uint8Array([0x89, 0x50]);
    const { ws } = workspace({
      run: async (_e, script, env = {}) => {
        scripts.push({ script, env });
        return { code: 0, output: scripts.length === 1 ? "@@ready\n@@needpush 0\n" : "@@attached\n" };
      },
      attachments: () => [
        { n: 1, name: "a.png", mime: "image/png", size: 2, data },
        { n: 2, name: "b.png", mime: "image/png", size: 2, data },
      ],
    });
    await ws.open(ticket, ada);
    expect(scripts).toHaveLength(3);
    expect(scripts[1]?.script).toContain(".inc/attachments/1-a.png");
    expect(scripts[2]?.script).toContain(".inc/attachments/2-b.png");
    expect(scripts[1]?.env).toEqual({});

    const failing = workspace({
      run: async (_e, script) => ({
        code: script.includes("base64 -d") ? 1 : 0,
        output: "@@ready\n@@needpush 0\ndisk full",
      }),
      attachments: () => [{ n: 1, name: "a.png", mime: "image/png", size: 2, data }],
    });
    await expect(failing.ws.open(ticket, ada)).rejects.toThrow("couldn't copy a.png into Ada's machine");
  });

  it("copies only the images it's given into a worktree that's already there, in that machine", async () => {
    const runs: { employee: string; script: string }[] = [];
    const data = new Uint8Array([0x89, 0x50]);
    const { ws } = workspace({
      run: async (employee, script) => {
        runs.push({ employee, script });
        return { code: 0, output: "@@attached\n" };
      },
      attachments: () => [1, 2, 3].map((n) => ({ n, name: `${n}.png`, mime: "image/png", size: 2, data })),
    });
    // Twice, as after a crash between the copy and its event: the script leaves a file that's there.
    for (let i = 0; i < 2; i++) await ws.attach(ticket, kit, [2, 3]);
    expect(runs.map((r) => r.employee)).toEqual(["kit", "kit", "kit", "kit"]);
    expect(runs[0]?.script).toContain("cd '/home/employee/work/inc-7'");
    expect(runs.map((r) => r.script.match(/attachments\/(\d)-/)?.[1])).toEqual(["2", "3", "2", "3"]);
    expect(runs.every((r) => r.script.includes("then cat > /dev/null"))).toBe(true);
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

  // T63 7.1: "merged" is what GitHub says, and a rejected PR is closed there.
  it("reads where the PR stands on GitHub, and closes only an open one", async () => {
    const pr = { number: 4, url: "u", nodeId: "PR_4", branch: "b" };
    for (const state of ["open", "closed", "merged"] as const) {
      const w = workspace({ state });
      expect(await w.ws.prState(ticket, pr)).toBe(state);
      await w.ws.closePr(ticket, pr);
      expect(w.calls.filter((c) => c.startsWith("close"))).toEqual(state === "open" ? ["close 4"] : []);
    }
    // Direct mode has no PR: nothing to ask, nothing to close.
    const none = workspace();
    expect(await none.ws.prState(ticket, { branch: "b" })).toBe("merged");
    await none.ws.closePr(ticket, { branch: "b" });
    expect(none.calls).toEqual([]);
  });
});

// #17: a reviewer or verifier on another team works in another machine. Each machine has its own
// work folder at the same path; here, a root per machine stands in for it.
describe("a reviewer's machine", () => {
  const grace: Employee = { ...ada, id: "grace", name: "Grace", duties: ["review"] };
  const branch = branchName(ticket);
  const png = (n: number) => new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * n) % 256));
  const files: AttachmentFile[] = [1, 2].map((n) => ({
    n,
    name: `${n}.png`,
    mime: "image/png",
    size: 300,
    data: png(n),
  }));

  /** Ada's machine, and a machine per employee in `machines` (Ada's by default). */
  function office(machines: Record<string, string> = {}, mode: "owner-merges" | "direct" = "owner-merges") {
    const { root, origin } = setup();
    const machine = (id: string) => join(root, machines[id] ?? "machine-a");
    const runs: string[] = [];
    const ws = new GitHubWorkspace({
      project: () => ({ id: "Duet", repo: "o/duet", checks: ["true"] }),
      tokens: fakeTokens(),
      prs: {
        find: async () => ({ number: 4, url: "https://github.com/o/duet/pull/4", nodeId: "PR_4" }),
      } as unknown as PullRequests,
      identity: async (e) => ({
        name: `${e.name} (i.inc)`,
        email: "1+i-inc-bot[bot]@users.noreply.github.com",
      }),
      worktree: (id) => `/home/employee/work/inc-${id}`,
      remote: () => origin,
      host: new HostPusher({ tokens: fakeTokens(), mirrors: join(root, "mirrors"), remote: () => origin }),
      policy: () => ({ ...defaultProjectPolicy, mode }),
      run: (employee, script, extra) => {
        runs.push(employee);
        return localScript(employee, script.replaceAll("/home/employee", machine(employee)), extra);
      },
      attachments: () => files,
    });
    const wt = (id: string) => join(machine(id), "work/inc-7");
    return { ws, wt, origin, runs };
  }

  it("gets the branch and the ticket's images, out of git's sight", async () => {
    const { ws, wt } = office({ grace: "machine-b" });
    await ws.open({ ...ticket, attachments: files }, ada);
    await ws.checkout(ticket, grace);
    await ws.attach(ticket, grace, [1, 2]);

    const b = wt("grace");
    expect(b).not.toBe(wt("ada"));
    expect(git(b, "rev-parse", "HEAD")).toBe(git(wt("ada"), "rev-parse", "HEAD"));
    expect(git(b, "branch", "--show-current")).toBe(branch);
    for (const f of files) {
      expect(new Uint8Array(readFileSync(join(b, `.inc/attachments/${f.n}-${f.n}.png`)))).toEqual(f.data);
    }
    expect(git(b, "status", "--porcelain")).toBe("");
    // It never commits, so it carries no author.
    expect(() => git(b, "config", "--worktree", "--get", "user.name")).toThrow();
  });

  it("moves to the builder's next push on a later round, and is safe to repeat", async () => {
    const { ws, wt } = office({ grace: "machine-b" });
    await ws.open(ticket, ada);
    for (let i = 0; i < 2; i++) await ws.checkout(ticket, grace);
    await ws.attach(ticket, grace, [1]);

    writeFileSync(join(wt("ada"), "fix.ts"), "export {};\n");
    git(wt("ada"), "add", "fix.ts");
    git(wt("ada"), "commit", "-q", "-m", "fix: the findings");
    git(wt("ada"), "push", "-q", "origin", branch);
    await ws.checkout(ticket, grace);
    await ws.attach(ticket, grace, [2]);

    const b = wt("grace");
    expect(git(b, "rev-parse", "HEAD")).toBe(git(wt("ada"), "rev-parse", "HEAD"));
    expect(existsSync(join(b, "fix.ts"))).toBe(true);
    expect(existsSync(join(b, ".inc/attachments/1-1.png"))).toBe(true);
    expect(existsSync(join(b, ".inc/attachments/2-2.png"))).toBe(true);
    expect(git(b, "status", "--porcelain")).toBe("");
  });

  it("leaves the builder's own worktree alone on a shared machine, author and unpushed work too", async () => {
    const { ws, wt } = office();
    await ws.open(ticket, ada);
    const a = wt("ada");
    writeFileSync(join(a, "wip.ts"), "export {};\n");
    git(a, "add", "wip.ts");
    git(a, "commit", "-q", "-m", "wip");
    const head = git(a, "rev-parse", "HEAD");

    await ws.checkout(ticket, grace);
    await ws.attach(ticket, grace, [1]);
    expect(wt("grace")).toBe(a);
    expect(git(a, "rev-parse", "HEAD")).toBe(head);
    expect(git(a, "config", "--worktree", "--get", "user.name")).toBe("Ada (i.inc)");
    expect(() => git(a, "config", "--worktree", "--get", "i-inc.copy")).toThrow();
    expect(existsSync(join(a, ".inc/attachments/1-1.png"))).toBe(true);
  });

  it("keeps images already copied into a plain folder, and stops resetting a copy once it's handed to a builder", async () => {
    const { ws, wt, origin } = office({ grace: "machine-b", kit: "machine-b" });
    await ws.open(ticket, ada);
    // The launcher's folder, holding an image from before the checkout.
    await ws.attach(ticket, grace, [1]);
    expect(existsSync(join(wt("grace"), ".git"))).toBe(false);
    await ws.checkout(ticket, grace);
    const b = wt("grace");
    expect(git(b, "rev-parse", "HEAD")).toBe(git(wt("ada"), "rev-parse", "HEAD"));
    expect(new Uint8Array(readFileSync(join(b, ".inc/attachments/1-1.png")))).toEqual(files[0]?.data);
    expect(existsSync(`${b}.pre-checkout`)).toBe(false);
    expect(git(b, "status", "--porcelain")).toBe("");

    // Handed to Kit, on the same machine: the copy becomes his worktree, and a review leaves it alone.
    await ws.open(ticket, kit);
    expect(git(b, "config", "--worktree", "--get", "user.name")).toBe("Kit (i.inc)");
    writeFileSync(join(b, "wip.ts"), "export {};\n");
    git(b, "add", "wip.ts");
    git(b, "commit", "-q", "-m", "wip");
    const head = git(b, "rev-parse", "HEAD");
    await ws.checkout(ticket, grace);
    expect(git(b, "rev-parse", "HEAD")).toBe(head);
    expect(git(origin, "rev-parse", branch)).not.toBe(head);
  });

  it("in direct mode, fetches nothing and copies the images into a plain folder", async () => {
    const { ws, wt, runs } = office({ grace: "machine-b" }, "direct");
    await ws.open(ticket, ada);
    runs.length = 0;
    await ws.checkout(ticket, grace);
    expect(runs).toEqual([]);
    await ws.attach(ticket, grace, [1, 2]);
    expect(existsSync(join(wt("grace"), ".inc/attachments/2-2.png"))).toBe(true);
  });

  it("says what git said when the checkout fails, and refuses a branch name that isn't safe", async () => {
    const { ws } = office({ grace: "machine-b" });
    // No pick-up: the branch isn't on origin.
    await expect(ws.checkout(ticket, grace)).rejects.toThrow("git in Grace's machine failed");
    expect(() => checkoutScript({ remote: "o", repoDir: "/r", worktree: "/w", branch: "a b" })).toThrow(
      /not a branch name/,
    );
  });
});

describe("2.5 looking for a ticket's worktree", () => {
  it("says whether it is a git worktree, and a bare folder (what cleanup leaves) is not", async () => {
    const { root, origin } = setup();
    const work = join(root, "machine-a");
    expect((await localScript("ada", script(origin, work))).output).toContain("@@ready");
    const ws = new GitHubWorkspace({
      project: () => ({ id: "Duet", repo: "o/duet", checks: ["true"] }),
      tokens: fakeTokens(),
      prs: {} as unknown as PullRequests,
      identity: async () => ({ name: "Ada (i.inc)", email: "1+i-inc-bot[bot]@users.noreply.github.com" }),
      worktree: () => join(work, "inc-7"),
      run: localScript,
    });
    expect(await ws.present(ticket, ada)).toBe(true);
    // Cleanup removes the worktree; a later copy of the images makes the folder again, empty.
    rmSync(join(work, "inc-7"), { recursive: true });
    mkdirSync(join(work, "inc-7", ".inc"), { recursive: true });
    expect(await ws.present(ticket, ada)).toBe(false);
  });
});
