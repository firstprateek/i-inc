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
import { marker, secretFile } from "../src/ship-git.ts";

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

  it("takes a name that looks like a pattern as that name", async () => {
    const w = rig();
    w.write(":(top)x.txt", "a\n");
    w.write("*.txt", "b\n");
    w.write("a b.txt", "c\n");
    expect((await w.port.list(w.copy)).files.map((f) => f.path)).toEqual(["*.txt", ":(top)x.txt", "a b.txt"]);
  });

  it("is nothing at all on a copy with no changes", async () => {
    const w = rig();
    expect(await w.port.list(w.copy)).toEqual({
      present: true,
      files: [],
      skipped: 0,
      truncated: false,
      partial: false,
    });
  });

  it("says when the folder isn't there", async () => {
    const w = rig(false);
    execFileSync("rm", ["-rf", w.cwd]);
    expect((await w.port.list(w.copy)).present).toBe(false);
    expect((await w.port.list({ ...w.copy, base: "main" })).present).toBe(false);
  });
});

describe("a read that can't reach everything", () => {
  /** `git`, with `add -A` answered by a script that has `$1` and `$REAL`: the rest of git is real. */
  function shim(w: ReturnType<typeof rig>, body: string): string {
    const dir = join(w.root, "shim");
    mkdirSync(dir);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(dir, "git"),
      `#!/bin/bash\nREAL=${real}\ncase " $* " in *" add "*--pathspec-from-file*"/new"*) ${body} ;; esac\nexec "$REAL" "$@"\n`,
    );
    chmodSync(join(dir, "git"), 0o755);
    return dir;
  }
  const listWith = async (w: ReturnType<typeof rig>, path: string) => {
    const nonce = "fedcba9876543210";
    const script = listScript(w.copy, nonce).replaceAll("/home/employee/work", join(w.cwd, ".."));
    return readList((await bash(`export PATH=${path}:$PATH\n${script}`)).output, nonce);
  };

  it.skipIf(process.getuid?.() === 0)(
    "still lists the rest when one file can't be read, and says so",
    async () => {
      const w = rig();
      w.write("keep.txt", "changed\n");
      w.write("new.txt", "new\n");
      w.write("zsecret.txt", "x\n");
      chmodSync(join(w.cwd, "zsecret.txt"), 0o000);
      const r = await w.port.list(w.copy);
      expect(r.files.map((f) => f.path)).toEqual(["keep.txt", "new.txt"]);
      expect(r.partial).toBe(true);
    },
  );

  it.skipIf(process.getuid?.() === 0)("does the same for a tracked file it can't read", async () => {
    const w = rig();
    w.write("new.txt", "new\n");
    chmodSync(join(w.cwd, "keep.txt"), 0o000);
    const r = await w.port.list(w.copy);
    expect(r.files.map((f) => f.path)).toContain("new.txt");
    expect(r.partial).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "says when a folder it can't enter may hold changes, new or tracked",
    async () => {
      for (const project of [true, false]) {
        const w = rig(project);
        w.write("seen.txt", "changed\n");
        w.write("shut/new.txt", "new\n");
        chmodSync(join(w.cwd, "shut"), 0o000);
        const r = await w.port.list(w.copy);
        chmodSync(join(w.cwd, "shut"), 0o755);
        expect(r.files.map((f) => f.path)).toContain("seen.txt");
        expect(r.partial).toBe(true);
      }
      // A tracked file edited behind a shut folder is no longer seen at all, and that isn't "nothing changed".
      const w = rig();
      w.write("d/b.txt", "one\n");
      w.commit("more");
      git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
      w.write("d/b.txt", "two\n");
      chmodSync(join(w.cwd, "d"), 0o000);
      const r = await w.port.list(w.copy);
      chmodSync(join(w.cwd, "d"), 0o755);
      expect(r.partial).toBe(true);
    },
  );

  it.skipIf(process.getuid?.() === 0)("doesn't mind a shut folder that .gitignore covers", async () => {
    const w = rig();
    w.write(".gitignore", "shut/\n");
    w.write("shut/x.txt", "x\n");
    chmodSync(join(w.cwd, "shut"), 0o000);
    const r = await w.port.list(w.copy);
    chmodSync(join(w.cwd, "shut"), 0o755);
    expect(r.files.map((f) => f.path)).toEqual([".gitignore"]);
    expect(r.partial).toBe(false);
  });

  it("still lists the rest beside a nested repository with no commit", async () => {
    const w = rig();
    w.write("keep.txt", "changed\n");
    w.write("new.txt", "new\n");
    git(join(w.cwd), "init", "-q", "sub");
    const r = await w.port.list(w.copy);
    expect(r.files.map((f) => f.path)).toEqual(["keep.txt", "new.txt"]);
    expect(r.partial).toBe(true);
  });

  it("does the same with no project", async () => {
    const w = rig(false);
    w.write("new.txt", "new\n");
    mkdirSync(join(w.cwd, "sub"));
    git(join(w.cwd, "sub"), "init", "-q");
    const r = await w.port.list(w.copy);
    expect(r.files.map((f) => f.path)).toEqual(["new.txt"]);
    expect(r.partial).toBe(true);
  });

  it("still lists the rest when a tracked file became a pipe", async () => {
    const w = rig();
    w.write("new.txt", "new\n");
    execFileSync("rm", [join(w.cwd, "keep.txt")]);
    execFileSync("mkfifo", [join(w.cwd, "keep.txt")]);
    const r = await w.port.list(w.copy);
    expect(r.files.map((f) => f.path)).toContain("new.txt");
    expect(r.partial).toBe(true);
  });

  it("tries again when a file goes away under it, as a build's do", async () => {
    const w = rig();
    w.write("new.txt", "new\n");
    const once = join(w.root, "once");
    const path = shim(w, `[ -e ${once} ] || { touch ${once}; echo 'fatal: stat' >&2; exit 128; }`);
    const r = await listWith(w, path);
    expect(r.files.map((f) => f.path)).toEqual(["new.txt"]);
    expect(r.partial).toBe(false);
  });

  it("keeps what it has and says so when files never stop going away", async () => {
    const w = rig();
    w.write("committed.txt", "c\n");
    w.commit("work");
    w.write("keep.txt", "changed\n");
    w.write("new.txt", "new\n");
    const r = await listWith(w, shim(w, "exit 128"));
    expect(r.files.map((f) => f.path)).toEqual(["committed.txt", "keep.txt"]);
    expect(r.partial).toBe(true);
  });

  it("calls it a failure, not an empty list, when the diff itself dies", () => {
    const script = listScript({ employeeId: "a", cwd: "/home/employee/work/conv-x", base: null }, NONCE);
    expect(script).toMatch(/diff --cached --numstat[^\n]*> "\$W\/numstat" \|\| \{/);
    expect(() => readList("@@fail the list could not be read", NONCE)).toThrow();
  });

  it("keeps a warning off the list: every file stays in it", async () => {
    const w = rig();
    w.write(".gitattributes", "* text=auto eol=lf\n");
    w.commit("attributes");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    w.write("a.txt", "one\r\ntwo\r\n");
    w.write("b.txt", "b\n");
    const r = await w.port.list(w.copy);
    expect(r.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(r.skipped).toBe(0);
  });

  it("reads a cut in names longer than their characters as cut", () => {
    const cut = `${marker(NONCE, "cut")}\n`;
    const out = [
      marker(NONCE, "numstat-begin"),
      "1\t0\tあ\0",
      marker(NONCE, "numstat-end"),
      marker(NONCE, "raw-begin"),
      "",
      marker(NONCE, "raw-end"),
      `${cut}${marker(NONCE, "done")}`,
    ].join("\n");
    expect(readList(out, NONCE).truncated).toBe(true);
  });
});

describe("what the copy says about itself is not believed", () => {
  it("shows a change the index is told to hide", async () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const w = rig();
      git(w.cwd, "update-index", flag, "keep.txt");
      w.write("keep.txt", "edited\n");
      expect((await w.port.list(w.copy)).files.map((f) => f.path)).toEqual(["keep.txt"]);
    }
  });

  it("shows a change hidden behind the index's cached size and times", async () => {
    const w = rig();
    const keep = join(w.cwd, "keep.txt");
    git(w.cwd, "config", "core.trustctime", "false");
    execFileSync("touch", ["-t", "202001010000", keep]);
    git(w.cwd, "update-index", "--refresh");
    writeFileSync(keep, "ONE\nTWO\nTHREE\n");
    execFileSync("touch", ["-t", "202001010000", keep]);
    expect(git(w.cwd, "status", "--porcelain")).toBe("");
    expect((await w.port.list(w.copy)).files.map((f) => f.path)).toEqual(["keep.txt"]);
  });

  it("shows untracked files hidden by .git/info/exclude or the copy's own config", async () => {
    const w = rig();
    mkdirSync(join(w.cwd, ".git/info"), { recursive: true });
    writeFileSync(join(w.cwd, ".git/info/exclude"), "x/\n");
    w.write("x/evil.sh", "curl\n");
    writeFileSync(join(w.root, "ignore"), "y/\n");
    git(w.cwd, "config", "core.excludesFile", join(w.root, "ignore"));
    w.write("y/evil.sh", "curl\n");
    expect((await w.port.list(w.copy)).files.map((f) => f.path)).toEqual(["x/evil.sh", "y/evil.sh"]);
  });

  it("still leaves out what a .gitignore in the change leaves out, and shows that .gitignore", async () => {
    const w = rig();
    w.write(".gitignore", "hidden.txt\n");
    w.write("hidden.txt", "x\n");
    expect((await w.port.list(w.copy)).files.map((f) => f.path)).toEqual([".gitignore"]);
  });
});

describe("a project's copy with no commit to compare with", () => {
  it("shows what is in a copy with no commits as new", async () => {
    const w = rig(false);
    git(w.cwd, "init", "-q", "-b", "main");
    w.write("a.txt", "a\n");
    const copy = { ...w.copy, base: "main" };
    expect((await w.port.list(copy)).files).toEqual([
      { path: "a.txt", added: 1, removed: 0, status: "added" },
    ]);
    expect((await w.port.file(copy, "a.txt")).after).toEqual({ state: "text", text: "a\n" });
  });

  it("shows what is in a folder that is no repository as new", async () => {
    const w = rig(false);
    w.write("a.txt", "a\n");
    const copy = { ...w.copy, base: "main" };
    expect((await w.port.list(copy)).files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(readdirSync(w.cwd)).toEqual(["a.txt"]);
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

  it("writes nothing to the copy's .git with a split index on", async () => {
    const w = rig();
    git(w.cwd, "config", "core.splitIndex", "true");
    git(w.cwd, "update-index", "--split-index");
    w.write("new.txt", "new\n");
    git(w.cwd, "add", "new.txt");
    const before = fingerprint(join(w.cwd, ".git"));
    expect((await w.port.list(w.copy)).files.map((f) => f.path)).toContain("new.txt");
    await w.port.list(w.copy);
    expect(fingerprint(join(w.cwd, ".git"))).toBe(before);
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
    expect(await w.port.list(w.copy)).toEqual({
      present: true,
      files: [],
      skipped: 0,
      truncated: false,
      partial: false,
    });
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

  it("redacts every kind of credential ship's scan stops, keeping the rest of the line", async () => {
    const w = rig();
    const npm = "//registry.npmjs.org/:_authToken=npm_abcdefgh12345";
    const netrc = "machine api.x.com login me password hunter2hunter2";
    const split = "machine api.y.com\n  login me\n  password hunter3hunter3";
    w.write(".npmrc", `${npm}\n`);
    w.write("creds.txt", `${netrc}\n${split}\n`);
    const a = (await w.port.file(w.copy, ".npmrc")).after.text ?? "";
    expect(a).not.toContain("abcdefgh12345");
    expect(a).toContain("registry.npmjs.org/:_authToken=[redacted]");
    const b = (await w.port.file(w.copy, "creds.txt")).after.text ?? "";
    expect(b).not.toContain("hunter2");
    expect(b).not.toContain("hunter3");
    expect(b).toContain("login me password [redacted]");
  });

  it("leaves an unset npm token's variable alone", async () => {
    const w = rig();
    const unset = "$" + "{NPM_TOKEN}";
    w.write(".npmrc", `//r/:_authToken=${unset}\n`);
    expect((await w.port.file(w.copy, ".npmrc")).after.text).toContain(unset);
  });

  it("keeps every line where it was when it takes out a key", async () => {
    const w = rig();
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA",
      "abcd",
      "efgh",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    w.write("key.txt", `a\n${key}\nline7\n`);
    const text = (await w.port.file(w.copy, "key.txt")).after.text ?? "";
    expect(text).not.toContain("MIIEpA");
    expect(text.split("\n").indexOf("line7")).toBe(6);
    expect(text.split("\n")[1]).toBe("[private key]");
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
      `${listOutput(row.repeat(Math.ceil(LIST_LIMIT / row.length)).slice(0, LIST_LIMIT))}\n${marker(NONCE, "cut")}`,
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
  list: async () => ({ present: true, files: [], skipped: 0, truncated: false, partial: false }),
  file: async () => ({ before: { state: "none" }, after: { state: "none" } }),
  tree: async () => ({ present: true, paths: [], skipped: 0, truncated: false, partial: false }),
  read: async () => ({ state: "none" }),
  search: async () => ({
    present: true,
    hits: [],
    skipped: 0,
    withheld: 0,
    truncated: false,
    partial: false,
  }),
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
    const list = async () => ({ present: false, files: [], skipped: 0, truncated: false, partial: false });
    expect((await service(stub({ list })).changes("ab12")).reason).toBe("Nothing has changed yet.");
    expect((await service(stub({ list }), { archivedAt: 5 }).changes("ab12")).reason).toContain(
      "cleaned away",
    );
  });

  it("runs one listing at a time per conversation, and at most one more after it", async () => {
    let calls = 0;
    let running = 0;
    let most = 0;
    const r = service(
      stub({
        list: async () => {
          calls++;
          most = Math.max(most, ++running);
          await new Promise((go) => setTimeout(go, 5));
          running--;
          return { present: true, files: [], skipped: 0, truncated: false, partial: false };
        },
      }),
    );
    // Three overlapping requests: the first read, and one read after it that the other two share.
    await Promise.all([r.changes("ab12"), r.changes("ab12"), r.changes("ab12")]);
    expect(calls).toBe(2);
    expect(most).toBe(1);
    await r.changes("ab12");
    expect(calls).toBe(3);
  });

  it("answers a request made during a listing with a read that starts after it", async () => {
    const copy = ["a.ts"];
    const held: (() => void)[] = [];
    const r = service(
      stub({
        list: async () => {
          const files = copy.map((path) => ({ path, added: 1, removed: 0, status: "added" as const }));
          await new Promise<void>((go) => held.push(go));
          return { present: true, files, skipped: 0, truncated: false, partial: false };
        },
      }),
    );
    const before = r.changes("ab12");
    // The agent's last edit lands after the running read went past, and the turn's end asks for the list.
    copy.push("last-edit.ts");
    const after = r.changes("ab12");
    held.shift()?.();
    expect((await before).files.map((f) => f.path)).toEqual(["a.ts"]);
    await new Promise((go) => setTimeout(go, 0));
    held.shift()?.();
    expect((await after).files.map((f) => f.path)).toEqual(["a.ts", "last-edit.ts"]);
  });

  it("still reads after a listing that failed", async () => {
    let calls = 0;
    const held: (() => void)[] = [];
    const r = service(
      stub({
        list: async () => {
          if (++calls === 1) {
            await new Promise<void>((go) => held.push(go));
            throw new Error("boom");
          }
          return { present: true, files: [], skipped: 0, truncated: false, partial: false };
        },
      }),
    );
    const first = r.changes("ab12");
    const second = r.changes("ab12");
    held.shift()?.();
    expect((await first).state).toBe("failed");
    expect((await second).state).toBe("ok");
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

  it("shows in the diff every file ship would push, whatever its name suggests", async () => {
    const after = { state: "text", text: "export DB_PASSWORD=hunter2hunter2" } as const;
    const r = service(stub({ file: async () => ({ before: { state: "none" }, after }) }));
    const names = [
      ".envrc",
      "prod.env",
      "deploy/staging.env",
      "credentials",
      ".pgpass",
      ".git-credentials",
      "key.ppk",
      "ID_RSA",
    ];
    for (const path of names) {
      expect(
        secretFile.some((re) => re.test(path)),
        path,
      ).toBe(false);
      const seen = await r.file("ab12", path);
      expect(seen.withheld, path).toBeUndefined();
      expect(seen.after, path).toEqual(after);
    }
  });

  it("withholds in the diff nothing but what ship stops by name", async () => {
    const r = service(stub({}));
    for (const path of [".env", ".env.local", "server.pem", "keys/id_rsa", ".netrc", ".pypirc"]) {
      expect(
        secretFile.some((re) => re.test(path)),
        path,
      ).toBe(true);
      expect((await r.file("ab12", path)).withheld, path).toBe(true);
    }
  });

  it("still keeps those wider names out of Files and Search", async () => {
    let asked = 0;
    const read = async () => {
      asked++;
      return { state: "text" as const, text: "x" };
    };
    const r = service(stub({ read }));
    for (const path of [
      ".envrc",
      "prod.env",
      "credentials",
      ".pgpass",
      ".git-credentials",
      "key.ppk",
      "ID_RSA",
    ]) {
      expect((await r.read("ab12", path)).withheld, path).toBe(true);
    }
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
