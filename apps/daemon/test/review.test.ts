// The review pane's reads. The scripts run in real bash against real git, in a folder that stands in for the
// sandbox, because what matters is what git does there: what it lists, and that it writes nothing.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent, FakeChat, FakeClock, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { seedDemo } from "../src/demo.ts";
import { demoReview } from "../src/demo-review.ts";
import type { RunScript } from "../src/harness.ts";
import { MachineNotRunning } from "../src/machine-queue.ts";
import { defaultMachineSettings } from "../src/machines.ts";
import { realPorts } from "../src/real.ts";
import {
  ConversationReview,
  fileScript,
  isReviewPath,
  LIST_LIMIT,
  linkStaysInside,
  listScript,
  MAX_FILE_BYTES,
  MAX_FILES,
  type ReviewCopy,
  type ReviewPort,
  ReviewTimeout,
  readFile as readFileOutput,
  readList,
  reviewPort,
} from "../src/review.ts";
import { marker } from "../src/ship-git.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;
const NONCE = "0123456789abcdef";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();

const bash = (script: string) =>
  new Promise<{ code: number; output: string }>((resolve) => {
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

/** A working copy on `conv/ab12cd34`, with one commit on main and `origin/main` pointing at it. */
function rig(project = true) {
  const root = mkdtempSync(join(tmpdir(), "inc-review-"));
  const work = join(root, "work");
  const cwd = join(work, "conv-ab12cd34");
  mkdirSync(cwd, { recursive: true });
  const scripts: string[] = [];
  const run: RunScript = async (_who, script) => {
    scripts.push(script);
    return bash(script.replaceAll("/home/employee/work", work));
  };
  const copy: ReviewCopy = {
    employeeId: "ada",
    cwd: "/home/employee/work/conv-ab12cd34",
    base: project ? "main" : null,
  };
  const write = (p: string, t: string | Buffer) => {
    mkdirSync(join(cwd, p, ".."), { recursive: true });
    writeFileSync(join(cwd, p), t);
  };
  const commit = (m: string) => {
    git(cwd, "add", "-A");
    git(
      cwd,
      "-c",
      "user.name=a",
      "-c",
      "user.email=a@example.invalid",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      m,
    );
  };
  if (project) {
    git(cwd, "init", "-q", "-b", "main");
    write("keep.txt", "one\ntwo\nthree\n");
    write("gone.txt", "bye\n");
    commit("base");
    git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(cwd, "checkout", "-q", "-b", "conv/ab12cd34");
  }
  return { root, cwd, copy, port: reviewPort(run), write, commit, scripts };
}

/** Everything in the copy's .git, by name, size and time: if git wrote anything, this differs. */
function fingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.push(`${p} ${s.size} ${s.mtimeMs}`);
    }
  };
  walk(dir);
  return out.join("\n");
}

describe("what the list says", () => {
  it("lists committed, uncommitted, staged, untracked and deleted work, as shell commands leave it", async () => {
    const w = rig();
    w.write("committed.txt", "a\nb\n");
    w.commit("work");
    w.write("keep.txt", "one\n2\nthree\n");
    w.write("staged.txt", "s\n");
    git(w.cwd, "add", "staged.txt");
    w.write("sub/untracked.txt", "u\nu\nu\n");
    execFileSync("rm", [join(w.cwd, "gone.txt")]);
    const r = await w.port.list(w.copy);
    expect(r.present).toBe(true);
    expect(r.files).toEqual([
      { path: "committed.txt", added: 2, removed: 0, status: "added" },
      { path: "gone.txt", added: 0, removed: 1, status: "deleted" },
      { path: "keep.txt", added: 1, removed: 1, status: "modified" },
      { path: "staged.txt", added: 1, removed: 0, status: "added" },
      { path: "sub/untracked.txt", added: 3, removed: 0, status: "added" },
    ]);
  });

  it("marks a binary file and leaves ignored files and .inc out", async () => {
    const w = rig();
    w.write(".gitignore", "ignored.txt\n");
    w.write("ignored.txt", "x\n");
    w.write(".inc/shot.png", "x\n");
    w.write("logo.bin", Buffer.from([0, 1, 2, 0]));
    const paths = (await w.port.list(w.copy)).files;
    expect(paths.map((f) => f.path)).toEqual([".gitignore", "logo.bin"]);
    expect(paths[1]).toEqual({ path: "logo.bin", added: 0, removed: 0, binary: true, status: "added" });
  });

  it("measures from where the branch left main, not from where main is now", async () => {
    const w = rig();
    w.write("mine.txt", "m\n");
    w.commit("mine");
    git(w.cwd, "checkout", "-q", "main");
    w.write("theirs.txt", "t\n");
    w.commit("main moved");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(w.cwd, "checkout", "-q", "conv/ab12cd34");
    expect((await w.port.list(w.copy)).files.map((f) => f.path)).toEqual(["mine.txt"]);
  });

  it("still reads a copy the agent moved to another branch", async () => {
    const w = rig();
    git(w.cwd, "checkout", "-q", "-b", "elsewhere");
    w.write("a.txt", "a\n");
    expect((await w.port.list(w.copy)).files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("is nothing at all on a copy with no changes", async () => {
    const w = rig();
    expect(await w.port.list(w.copy)).toEqual({ present: true, files: [], skipped: 0, truncated: false });
  });

  it("says when the folder isn't there", async () => {
    const w = rig(false);
    execFileSync("rm", ["-rf", w.cwd]);
    expect((await w.port.list(w.copy)).present).toBe(false);
    expect((await w.port.list({ ...w.copy, base: "main" })).present).toBe(false);
  });
});

describe("it only reads", () => {
  it("changes nothing in the copy: not .git, the index, HEAD or a ref, however much it lists", async () => {
    const w = rig();
    w.write("keep.txt", "changed\n");
    w.write("new.txt", "new\n");
    const status = git(w.cwd, "status", "--porcelain");
    const before = fingerprint(join(w.cwd, ".git"));
    await w.port.list(w.copy);
    await w.port.file(w.copy, "new.txt");
    await w.port.file(w.copy, "keep.txt");
    expect(fingerprint(join(w.cwd, ".git"))).toBe(before);
    expect(git(w.cwd, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(w.cwd, "new.txt"), "utf8")).toBe("new\n");
  });

  it("never fetches, and takes no token", async () => {
    const w = rig();
    await w.port.list(w.copy);
    await w.port.file(w.copy, "keep.txt");
    for (const s of w.scripts) {
      expect(s.replaceAll("LAZY_FETCH", "")).not.toMatch(/ fetch | ls-remote | clone /);
      expect(s).toContain("GIT_OPTIONAL_LOCKS=0");
    }
  });

  it("runs none of what the copy's config or hooks ask for", async () => {
    const w = rig();
    const proof = join(w.root, "ran");
    const evil = join(w.root, "evil.sh");
    writeFileSync(evil, `#!/bin/sh\ntouch ${proof}\ncat\n`);
    chmodSync(evil, 0o755);
    w.write(".gitattributes", "* filter=evil diff=evil\n");
    git(w.cwd, "config", "filter.evil.clean", evil);
    git(w.cwd, "config", "filter.evil.smudge", evil);
    git(w.cwd, "config", "diff.evil.command", evil);
    git(w.cwd, "config", "diff.evil.textconv", evil);
    git(w.cwd, "config", "diff.external", evil);
    git(w.cwd, "config", "core.fsmonitor", evil);
    w.write("keep.txt", "x\n");
    await w.port.list(w.copy);
    await w.port.file(w.copy, "keep.txt");
    expect(() => statSync(proof)).toThrow();
  });
});

describe("a conversation with no project", () => {
  it("is an empty list in an empty folder, and makes no repository", async () => {
    const w = rig(false);
    expect(await w.port.list(w.copy)).toEqual({ present: true, files: [], skipped: 0, truncated: false });
    expect(readdirSync(w.cwd)).toEqual([]);
  });

  it("shows what the agent left there as new, and each file's text", async () => {
    const w = rig(false);
    w.write("notes.md", "one\ntwo\n");
    const r = await w.port.list(w.copy);
    expect(r.files).toEqual([{ path: "notes.md", added: 2, removed: 0, status: "added" }]);
    const f = await w.port.file(w.copy, "notes.md");
    expect(f.before).toEqual({ state: "none" });
    expect(f.after).toEqual({ state: "text", text: "one\ntwo\n" });
    expect(readdirSync(w.cwd)).toEqual(["notes.md"]);
  });
});

describe("one file", () => {
  it("gives both versions of a changed file, one side of a new or deleted one", async () => {
    const w = rig();
    w.write("keep.txt", "one\n2\nthree\n");
    w.write("new.txt", "fresh\n");
    execFileSync("rm", [join(w.cwd, "gone.txt")]);
    expect(await w.port.file(w.copy, "keep.txt")).toEqual({
      before: { state: "text", text: "one\ntwo\nthree\n" },
      after: { state: "text", text: "one\n2\nthree\n" },
    });
    expect((await w.port.file(w.copy, "new.txt")).before).toEqual({ state: "none" });
    expect((await w.port.file(w.copy, "gone.txt")).after).toEqual({ state: "none" });
  });

  it("handles a name with quotes, spaces and shell in it as a name", async () => {
    const w = rig();
    const name = "it's $(touch pwned) `x`.txt";
    w.write(name, "ok\n");
    const f = await w.port.file(w.copy, name);
    expect(f.after).toEqual({ state: "text", text: "ok\n" });
    expect(readdirSync(w.cwd)).not.toContain("pwned");
  });

  it("redacts tokens on both sides", async () => {
    const w = rig();
    w.write("keep.txt", `const t = "${TOKEN}";\n`);
    w.commit("oops");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    w.write("keep.txt", `const u = "${TOKEN}";\n`);
    const f = await w.port.file(w.copy, "keep.txt");
    expect(JSON.stringify(f)).not.toContain(TOKEN);
    expect(f.after.text).toContain("[redacted]");
  });

  it("calls a file with a NUL, or that isn't UTF-8, binary", async () => {
    const w = rig();
    w.write("a.bin", Buffer.from([65, 0, 66]));
    w.write("b.bin", Buffer.from([0xff, 0xfe, 0x41]));
    expect((await w.port.file(w.copy, "a.bin")).after).toEqual({ state: "binary" });
    expect((await w.port.file(w.copy, "b.bin")).after).toEqual({ state: "binary" });
  });

  it("doesn't read a file over the cap, on either side", async () => {
    const w = rig();
    w.write("big.txt", "x".repeat(MAX_FILE_BYTES + 1));
    w.commit("big");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    w.write("big.txt", "y".repeat(MAX_FILE_BYTES + 1));
    expect(await w.port.file(w.copy, "big.txt")).toEqual({
      before: { state: "too-big" },
      after: { state: "too-big" },
    });
  });

  it("doesn't follow a link out of the copy, at the end of the path or on the way", async () => {
    const w = rig();
    const secret = join(w.root, "secret.txt");
    writeFileSync(secret, "the sandbox's own secret\n");
    symlinkSync(secret, join(w.cwd, "out.txt"));
    symlinkSync("../../secret.txt", join(w.cwd, "rel.txt"));
    symlinkSync(w.root, join(w.cwd, "dir"));
    for (const p of ["out.txt", "rel.txt", "dir/secret.txt"]) {
      const f = await w.port.file(w.copy, p);
      expect(f.after).toEqual({ state: "outside" });
      expect(JSON.stringify(f)).not.toContain("own secret");
    }
  });

  it("shows a link that stays inside as its target, without following it", async () => {
    const w = rig();
    symlinkSync("keep.txt", join(w.cwd, "in.txt"));
    expect((await w.port.file(w.copy, "in.txt")).after).toEqual({ state: "link", text: "keep.txt" });
  });

  it("doesn't take a sibling folder that shares the copy's name for the copy", async () => {
    const w = rig();
    const sibling = `${w.cwd}-other`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "x.txt"), "next door\n");
    symlinkSync(sibling, join(w.cwd, "side"));
    expect((await w.port.file(w.copy, "side/x.txt")).after).toEqual({ state: "outside" });
  });

  it("doesn't hang on a pipe or read a folder", async () => {
    const w = rig();
    execFileSync("mkfifo", [join(w.cwd, "pipe")]);
    mkdirSync(join(w.cwd, "folder"));
    expect((await w.port.file(w.copy, "pipe")).after).toEqual({ state: "other" });
    expect((await w.port.file(w.copy, "folder")).after).toEqual({ state: "other" });
  });
});

describe("what comes out of a sandbox is not believed", () => {
  it("refuses a path that isn't a plain relative one", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "../secret",
      "a/../../b",
      "a/./b",
      "a//b",
      "-rf",
      "a\0b",
      "a\nb",
      ".git/config",
      "sub/.git/config",
      "sub/.GIT/config",
      ".inc/shot.png",
      "x".repeat(2000),
      `path/${TOKEN}.txt`,
      "bad�name",
      7,
      null,
    ]) {
      expect(isReviewPath(bad), String(bad)).toBe(false);
    }
    for (const good of ["a.txt", "src/a b.ts", "it's.txt", "a/-b", "a..b/c", ".github/x.yml", "ünï.md"]) {
      expect(isReviewPath(good), good).toBe(true);
    }
  });

  it("won't build a script for a bad path, folder or base", () => {
    const copy: ReviewCopy = { employeeId: "ada", cwd: "/home/employee/work/conv-ab12", base: "main" };
    expect(() => fileScript(copy, "../x", NONCE)).toThrow();
    expect(() => listScript({ ...copy, cwd: "/etc" }, NONCE)).toThrow();
    expect(() => listScript({ ...copy, base: "x; id" }, NONCE)).toThrow();
    expect(() => listScript(copy, "not a nonce")).toThrow();
    expect(fileScript(copy, "it's.txt", NONCE)).toContain(`P='it'\\''s.txt'`);
  });

  const listOutput = (numstat: string, raw = "") =>
    [
      marker(NONCE, "numstat-begin"),
      numstat,
      marker(NONCE, "numstat-end"),
      marker(NONCE, "raw-begin"),
      raw,
      marker(NONCE, "raw-end"),
      marker(NONCE, "done"),
    ].join("\n");

  it("leaves out rows with unsafe names and counts them", () => {
    const r = readList(
      listOutput("1\t0\t../../etc/passwd\x001\t0\t/abs\x001\t0\tfine.txt\x00junk\x00"),
      NONCE,
    );
    expect(r.files.map((f) => f.path)).toEqual(["fine.txt"]);
    expect(r.skipped).toBe(3);
  });

  it("reads a list cut at the cap as cut, without the row in two", () => {
    const row = "1\t0\tfile.txt\0";
    const r = readList(
      listOutput(row.repeat(Math.ceil(LIST_LIMIT / row.length)).slice(0, LIST_LIMIT)),
      NONCE,
    );
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBe(MAX_FILES);
  });

  it("doesn't take output without this run's markers", () => {
    expect(() => readList(listOutput("1\t0\tx\0").replaceAll(NONCE, "ffffffffffffffff"), NONCE)).toThrow();
    expect(() => readFileOutput("nothing", NONCE, "a.txt")).toThrow();
  });

  it("works out from the words alone whether a link stays inside", () => {
    expect(linkStaysInside("a/b.txt", "c.txt")).toBe(true);
    expect(linkStaysInside("a/b.txt", "../c.txt")).toBe(true);
    expect(linkStaysInside("a/b.txt", "../../c.txt")).toBe(false);
    expect(linkStaysInside("b.txt", "/etc/passwd")).toBe(false);
    expect(linkStaysInside("b.txt", "..")).toBe(false);
    expect(linkStaysInside("b.txt", "")).toBe(false);
  });

  it("turns a link a forged reply says is fine into outside, if its target leaves", () => {
    const out = [
      `${marker(NONCE, "before")} none`,
      `${marker(NONCE, "after")} link`,
      Buffer.from("../../etc/passwd").toString("base64"),
      marker(NONCE, "done"),
    ].join("\n");
    expect(readFileOutput(out, NONCE, "a.txt")?.after).toEqual({ state: "outside" });
  });

  it("refuses a reply bigger than the cap whatever the script was told", () => {
    const out = [
      `${marker(NONCE, "before")} none`,
      `${marker(NONCE, "after")} blob`,
      Buffer.alloc(MAX_FILE_BYTES + 1, 97).toString("base64"),
      marker(NONCE, "done"),
    ].join("\n");
    expect(readFileOutput(out, NONCE, "a.txt")?.after).toEqual({ state: "too-big" });
  });
});

const service = (port: ReviewPort, over: { project?: string | null; archivedAt?: number | null } = {}) =>
  new ConversationReview({
    conversations: {
      get: (id) =>
        id === "ab12"
          ? {
              employeeId: "ada",
              project: over.project === undefined ? "Duet" : over.project,
              archivedAt: over.archivedAt ?? null,
            }
          : undefined,
      machineFor: () => null,
    },
    registry: {
      project: () => ({ defaultBranch: "main" }) as never,
      employees: () => [{ id: "ada", name: "Ada" }] as never,
    },
    port,
    waitMs: 30,
  });

const stub = (over: Partial<ReviewPort>): ReviewPort => ({
  list: async () => ({ present: true, files: [], skipped: 0, truncated: false }),
  file: async () => ({ before: { state: "none" }, after: { state: "none" } }),
  ...over,
});

describe("how a read fails, in a sentence", () => {
  it("says the machine is asleep, and does not wake it", async () => {
    const asleep = () => Promise.reject(new MachineNotRunning("inc-ada"));
    const r = service(stub({ list: asleep, file: asleep }));
    expect(await r.changes("ab12")).toMatchObject({
      state: "asleep",
      reason: "Ada's machine is asleep, so the changes can't be read right now.",
      files: [],
    });
    expect(await r.file("ab12", "a.txt")).toMatchObject({ state: "asleep" });
  });

  it("says the machine is busy when the read outlasts its wait, or the script timed out", async () => {
    expect(await service(stub({ list: () => new Promise(() => {}) })).changes("ab12")).toMatchObject({
      state: "busy",
      reason: "Ada's machine is busy, so the changes can't be read right now.",
    });
    const timedOut = () => Promise.reject(new ReviewTimeout());
    expect(await service(stub({ list: timedOut })).changes("ab12")).toMatchObject({ state: "busy" });
    const run: RunScript = async () => ({ code: 124, output: "" });
    await expect(
      reviewPort(run).list({ employeeId: "a", cwd: "/home/employee/work/conv-x", base: null }),
    ).rejects.toBeInstanceOf(ReviewTimeout);
  });

  it("keeps what went wrong out of the sentence", async () => {
    const logs: string[] = [];
    const r = new ConversationReview({
      conversations: {
        get: () => ({ employeeId: "ada", project: null, archivedAt: null }),
        machineFor: () => null,
      },
      registry: { project: () => undefined, employees: () => [] },
      port: stub({ list: () => Promise.reject(new Error(`fatal: ${TOKEN}`)) }),
      log: (m) => logs.push(m),
    });
    const v = await r.changes("ab12");
    expect(v).toMatchObject({ state: "failed", noProject: true });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
  });

  it("tells a copy not made yet from one cleaned away", async () => {
    const list = async () => ({ present: false, files: [], skipped: 0, truncated: false });
    expect((await service(stub({ list })).changes("ab12")).reason).toBe("Nothing has changed yet.");
    expect((await service(stub({ list }), { archivedAt: 5 }).changes("ab12")).reason).toContain(
      "cleaned away",
    );
  });

  it("runs one listing at a time per conversation", async () => {
    let calls = 0;
    const r = service(
      stub({
        list: async () => {
          calls++;
          return { present: true, files: [], skipped: 0, truncated: false };
        },
      }),
    );
    await Promise.all([r.changes("ab12"), r.changes("ab12")]);
    expect(calls).toBe(1);
    await r.changes("ab12");
    expect(calls).toBe(2);
  });

  it("serves neither side of a file that usually holds secrets, without asking the machine", async () => {
    let asked = 0;
    const r = service(
      stub({
        file: async () => {
          asked++;
          return { before: { state: "none" }, after: { state: "text", text: "KEY=x" } };
        },
      }),
    );
    expect(await r.file("ab12", "config/.env")).toMatchObject({ withheld: true, after: { state: "none" } });
    expect(await r.file("ab12", "deploy/server.pem")).toMatchObject({ withheld: true });
    expect(asked).toBe(0);
  });

  it("reads an old conversation from the machine its copy is in", async () => {
    const seen: (string | undefined)[] = [];
    const run: RunScript = async (_e, _s, _env, o) => {
      seen.push(o?.machine);
      throw new MachineNotRunning("inc-old");
    };
    const r = new ConversationReview({
      conversations: {
        get: () => ({ employeeId: "ada", project: null, archivedAt: null }),
        machineFor: () => "inc-old",
      },
      registry: { project: () => undefined, employees: () => [] },
      port: reviewPort(run),
    });
    await r.changes("ab12");
    expect(seen).toEqual(["inc-old"]);
  });
});

describe("the routes", () => {
  async function app(port: ReviewPort | undefined) {
    const a = await createApp({
      dbPath: ":memory:",
      knowledgeDir: mkdtempSync(join(tmpdir(), "inc-review-k-")),
      clock: new FakeClock(),
      machines: new FakeMachines(),
      agent: new FakeAgent(),
      harness: {} as never,
      helper: new FakeHelper(),
      chat: new FakeChat(),
      ...(port ? { review: () => port } : {}),
    });
    seedDemo(a.deps.registry);
    return a;
  }
  const get = async (a: Awaited<ReturnType<typeof app>>, path: string) => {
    const res = await a.handle(new Request(`http://i.inc${path}`));
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  };

  it("answers 404 for a conversation that isn't there, on both routes", async () => {
    const a = await app(demoReview);
    expect((await get(a, "/api/conversations/nope/changes")).status).toBe(404);
    expect((await get(a, "/api/conversations/nope/changes/file?path=a.txt")).status).toBe(404);
  });

  const conversation = async (a: Awaited<ReturnType<typeof app>>) => {
    const res = await a.handle(
      new Request("http://i.inc/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employeeId: "ada" }),
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { conversation: { id: string } }).conversation.id;
  };

  it("lists, and serves one file", async () => {
    const a = await app(demoReview);
    const id = await conversation(a);
    const list = await get(a, `/api/conversations/${id}/changes`);
    expect(list.status).toBe(200);
    expect(list.body.changes).toMatchObject({ state: "ok", noProject: true });
    const file = await get(a, `/api/conversations/${id}/changes/file?path=notes.md`);
    expect(file.body.file).toMatchObject({ state: "ok", path: "notes.md", after: { state: "text" } });
  });

  it("refuses a bad path before anything reaches the machine", async () => {
    let asked = 0;
    const a = await app(
      stub({
        file: async () => {
          asked++;
          return { before: { state: "none" }, after: { state: "none" } };
        },
      }),
    );
    const id = await conversation(a);
    for (const bad of [
      "",
      "?path=",
      "?path=..%2Fx",
      "?path=%2Fetc%2Fpasswd",
      "?path=.git%2Fconfig",
      "?path=-x",
      "?path=a%00b",
    ]) {
      expect((await get(a, `/api/conversations/${id}/changes/file${bad}`)).status, bad).toBe(400);
    }
    expect(asked).toBe(0);
  });

  it("says so on a daemon with no way to read", async () => {
    const a = await app(undefined);
    const id = await conversation(a);
    expect((await get(a, `/api/conversations/${id}/changes`)).status).toBe(409);
    expect((await get(a, `/api/conversations/${id}/changes/file?path=a.txt`)).status).toBe(409);
  });
});

describe("a stopped machine", () => {
  it("is refused by the runner the real ports use: nothing is started", async () => {
    const seen: string[][] = [];
    const ports = realPorts({
      credentials: {},
      machine: noWalls,
      exec: async (_bin, args) => {
        seen.push(args);
        return "";
      },
    });
    const registry = {
      employees: () => [],
      teams: () => [],
      settings: () => ({}),
      teamOf: () => ({ id: "t" }),
    };
    const port = (ports.review as unknown as (r: never) => ReviewPort)(registry as never);
    await expect(
      port.list({ employeeId: "ada", cwd: "/home/employee/work/conv-ab12", base: null, machine: "inc-t" }),
    ).rejects.toBeInstanceOf(MachineNotRunning);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a[1] === "ls")).toBe(true);
  });
});
