// The Files and Search tabs' reads. As with the review's, the scripts run in real bash against real git and real
// grep, in a folder that stands in for the sandbox: what matters is what they find, and that they write nothing.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent, FakeChat, FakeClock, FakeHelper, FakeMachines } from "@i-inc/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import {
  fileScript,
  isSearchQuery,
  MAX_FILE_HITS,
  MAX_HITS,
  MAX_QUERY,
  MAX_TREE,
  readSearch,
  readTree,
  searchScript,
  treeScript,
} from "../src/copy-files.ts";
import { seedDemo } from "../src/demo.ts";
import { demoReview } from "../src/demo-review.ts";
import { machineScript, type RunScript } from "../src/harness.ts";
import { MachineNotRunning, queueFor } from "../src/machine-queue.ts";
import { defaultMachineSettings } from "../src/machines.ts";
import { ConversationReview, type ReviewCopy, type ReviewPort, reviewPort } from "../src/review.ts";
import { marker } from "../src/ship-git.ts";

const NONCE = "0123456789abcdef";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();

const bash = (script: string) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn("bash", ["-s"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => out.push(c));
    child.on("close", (code) => resolve({ code: code ?? 1, output: Buffer.concat(out).toString("utf8") }));
    child.stdin.end(script);
  });

/** A working copy with one commit on main, or (`project` false) a plain folder. */
function rig(project: boolean | "no-commit" = true) {
  const root = mkdtempSync(join(tmpdir(), "inc-files-"));
  const work = join(root, "work");
  const cwd = join(work, "conv-ab12cd34");
  mkdirSync(cwd, { recursive: true });
  const run: RunScript = async (_who, script) => bash(script.replaceAll("/home/employee/work", work));
  const copy: ReviewCopy = {
    employeeId: "ada",
    cwd: "/home/employee/work/conv-ab12cd34",
    base: project ? "main" : null,
  };
  const write = (p: string, t: string | Buffer) => {
    mkdirSync(join(cwd, p, ".."), { recursive: true });
    writeFileSync(join(cwd, p), t);
  };
  if (project === "no-commit") git(cwd, "init", "-q", "-b", "main");
  if (project === true) {
    git(cwd, "init", "-q", "-b", "main");
    write("keep.txt", "one\nThe Needle here\nthree\n");
    write("gone.txt", "needle in a file that goes\n");
    write(".gitignore", "ignored.txt\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", "base");
    git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  }
  return { root, cwd, copy, port: reviewPort(run), write };
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

describe("the file list", () => {
  it("has what is tracked and what is new, and not what is ignored or has gone", async () => {
    const w = rig();
    w.write("src/new.ts", "x\n");
    w.write("ignored.txt", "x\n");
    w.write(".inc/image.png", "x\n");
    execFileSync("rm", [join(w.cwd, "gone.txt")]);
    expect(await w.port.tree(w.copy)).toEqual({
      present: true,
      paths: [".gitignore", "keep.txt", "src/new.ts"],
      skipped: 0,
      truncated: false,
      partial: false,
    });
  });

  it("isn't told what to hide by the copy's own index or excludes", async () => {
    const w = rig();
    w.write("hidden.txt", "x\n");
    writeFileSync(join(w.cwd, ".git/info/exclude"), "hidden.txt\n");
    git(w.cwd, "update-index", "--skip-worktree", "keep.txt");
    const { paths } = await w.port.tree(w.copy);
    expect(paths).toContain("hidden.txt");
    expect(paths).toContain("keep.txt");
  });

  it("walks a folder that is no repository, past .git and dependencies, and makes no repository", async () => {
    const w = rig(false);
    w.write("notes.md", "x\n");
    w.write("deep/er/a.txt", "x\n");
    w.write("node_modules/dep/index.js", "x\n");
    symlinkSync("notes.md", join(w.cwd, "link"));
    expect((await w.port.tree(w.copy)).paths).toEqual(["deep/er/a.txt", "link", "notes.md"]);
    expect(existsSync(join(w.cwd, ".git"))).toBe(false);
  });

  it("walks a repository with no commit the same way", async () => {
    const w = rig("no-commit");
    w.write("a.txt", "x\n");
    expect((await w.port.tree(w.copy)).paths).toEqual(["a.txt"]);
  });

  it("leaves out and counts a name that isn't safe, and takes a shell word as a name", async () => {
    const w = rig();
    w.write("new\nline.txt", "x\n");
    w.write(`-rf`, "x\n");
    w.write(`$(touch pwned).txt`, "x\n");
    w.write(`${TOKEN}.txt`, "x\n");
    const t = await w.port.tree(w.copy);
    expect(t.skipped).toBe(3);
    expect(t.paths).toContain("$(touch pwned).txt");
    expect(existsSync(join(w.cwd, "pwned"))).toBe(false);
  });

  it("drops a nested repository's folder row without calling it unsafe", async () => {
    const w = rig();
    mkdirSync(join(w.cwd, "sub"));
    git(join(w.cwd, "sub"), "init", "-q");
    expect((await w.port.tree(w.copy)).skipped).toBe(0);
  });

  it("says when the list is cut", () => {
    const names = Array.from({ length: MAX_TREE + 1 }, (_, i) => `f${i}\0`).join("");
    const out = [
      marker(NONCE, "tracked-begin"),
      names,
      marker(NONCE, "tracked-end"),
      marker(NONCE, "gone-begin"),
      "",
      marker(NONCE, "gone-end"),
      marker(NONCE, "new-begin"),
      "",
      marker(NONCE, "new-end"),
      marker(NONCE, "done"),
    ].join("\n");
    const t = readTree(out, NONCE);
    expect(t.paths).toHaveLength(MAX_TREE);
    expect(t.truncated).toBe(true);
  });

  it("calls a dead script a failure, not an empty folder", () => {
    expect(() => readTree("@@fail the list could not be read\n", NONCE)).toThrow(/could not be read/);
  });

  it("says when the folder isn't there", async () => {
    const w = rig();
    execFileSync("rm", ["-rf", w.cwd]);
    expect((await w.port.tree(w.copy)).present).toBe(false);
  });

  it("refuses a nonce or a folder it can't trust", () => {
    const w = rig();
    expect(() => treeScript(w.copy, "x; rm -rf /")).toThrow(/nonce/);
    expect(() => treeScript({ ...w.copy, cwd: "/etc" }, NONCE)).toThrow(/safe folder/);
  });
});

describe("one file", () => {
  it("reads what is on disk, committed or not, with tokens redacted and lines kept", async () => {
    const w = rig();
    w.write("keep.txt", `a\n-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----\n${TOKEN}\nb\n`);
    const side = await w.port.read(w.copy, "keep.txt");
    expect(side?.state).toBe("text");
    expect(side?.text).not.toContain(TOKEN);
    expect(side?.text).not.toContain("abc");
    expect(side?.text?.split("\n").indexOf("b")).toBe(6);
  });

  it("says what a file is when it can't be shown", async () => {
    const w = rig();
    w.write("bin", Buffer.from([1, 0, 2]));
    w.write("big", "x".repeat(1_000_001));
    mkdirSync(join(w.cwd, "dir"));
    execFileSync("mkfifo", [join(w.cwd, "pipe")]);
    expect((await w.port.read(w.copy, "bin"))?.state).toBe("binary");
    expect((await w.port.read(w.copy, "big"))?.state).toBe("too-big");
    expect((await w.port.read(w.copy, "dir"))?.state).toBe("other");
    expect((await w.port.read(w.copy, "pipe"))?.state).toBe("other");
    expect((await w.port.read(w.copy, "nothing"))?.state).toBe("none");
  });

  it("doesn't follow a link out of the copy, at the end of the path or on the way", async () => {
    const w = rig();
    const outside = join(w.root, "secret.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(w.cwd, "out"));
    symlinkSync(w.root, join(w.cwd, "up"));
    expect(await w.port.read(w.copy, "out")).toEqual({ state: "outside" });
    expect(await w.port.read(w.copy, "up/secret.txt")).toEqual({ state: "outside" });
  });

  it("doesn't reach .git or .inc through a link to the folder", async () => {
    const w = rig();
    w.write(".inc/photo.txt", "private\n");
    symlinkSync(".git", join(w.cwd, "g"));
    symlinkSync(".inc", join(w.cwd, "i"));
    expect(await w.port.read(w.copy, "g/config")).toEqual({ state: "outside" });
    expect(await w.port.read(w.copy, "i/photo.txt")).toEqual({ state: "outside" });
  });

  it("shows a link that stays inside as its target", async () => {
    const w = rig();
    symlinkSync("keep.txt", join(w.cwd, "in"));
    expect(await w.port.read(w.copy, "in")).toEqual({ state: "link", text: "keep.txt" });
  });

  it("needs no repository", async () => {
    const w = rig(false);
    w.write("notes.md", "hello\n");
    expect(await w.port.read(w.copy, "notes.md")).toEqual({ state: "text", text: "hello\n" });
  });

  it("refuses a path that isn't a plain relative one", () => {
    const w = rig();
    for (const bad of ["/etc/passwd", "../x", "a/../b", "-x", ".git/config", ".inc/a.png", "a\0b"]) {
      expect(() => fileScript(w.copy, bad, NONCE)).toThrow(/not a path/);
    }
  });
});

describe("a search", () => {
  it("finds lines in tracked and new files, by path and line", async () => {
    const w = rig();
    w.write("src/new.ts", "first\nneedle\n");
    const r = await w.port.search(w.copy, "needle", false);
    expect(r.hits).toEqual([
      { path: "gone.txt", line: 1, text: "needle in a file that goes" },
      { path: "keep.txt", line: 2, text: "The Needle here" },
      { path: "src/new.ts", line: 2, text: "needle" },
    ]);
  });

  it("minds case when told to", async () => {
    const w = rig();
    expect((await w.port.search(w.copy, "Needle", true)).hits.map((h) => h.path)).toEqual(["keep.txt"]);
    expect((await w.port.search(w.copy, "needle", true)).hits.map((h) => h.path)).toEqual(["gone.txt"]);
  });

  it("sees what the file says now, not what the commit says", async () => {
    const w = rig();
    w.write("keep.txt", "changed\n");
    execFileSync("rm", [join(w.cwd, "gone.txt")]);
    expect((await w.port.search(w.copy, "needle", false)).hits).toEqual([]);
  });

  it("leaves out ignored files, binary files, .inc and links", async () => {
    const w = rig();
    w.write("ignored.txt", "needle\n");
    w.write("bin", Buffer.concat([Buffer.from("needle"), Buffer.from([0, 1])]));
    w.write(".inc/a.txt", "needle\n");
    symlinkSync(join(w.cwd, "keep.txt"), join(w.cwd, "link"));
    const paths = (await w.port.search(w.copy, "needle", false)).hits.map((h) => h.path);
    expect(paths).toEqual(["gone.txt", "keep.txt"]);
  });

  it("takes the query as words: never a flag, a pattern or a shell", async () => {
    const w = rig();
    w.write("odd.txt", "a.c\nabc\n--help\n'; touch pwned; '\n$(touch pwned)\n");
    const texts = async (q: string) => (await w.port.search(w.copy, q, false)).hits.map((h) => h.text);
    expect(await texts("a.c")).toEqual(["a.c"]);
    expect(await texts("--help")).toEqual(["--help"]);
    expect(await texts("'; touch pwned; '")).toEqual(["'; touch pwned; '"]);
    expect(await texts("$(touch pwned)")).toEqual(["$(touch pwned)"]);
    expect(existsSync(join(w.cwd, "pwned"))).toBe(false);
  });

  it("searches a folder with no repository with plain grep, and walks past .git and dependencies", async () => {
    const w = rig(false);
    w.write("notes.md", "one\nNeedle\n");
    w.write("node_modules/dep/index.js", "needle\n");
    w.write("bin", Buffer.concat([Buffer.from("needle"), Buffer.from([0, 1])]));
    const r = await w.port.search(w.copy, "needle", false);
    expect(r.hits).toEqual([{ path: "notes.md", line: 2, text: "Needle" }]);
    expect((await w.port.search(w.copy, "needle", true)).hits).toEqual([]);
    expect(existsSync(join(w.cwd, ".git"))).toBe(false);
  });

  it("finds a query that starts with a dash in plain grep too", async () => {
    const w = rig(false);
    w.write("notes.md", "--help\n");
    expect((await w.port.search(w.copy, "--help", false)).hits).toHaveLength(1);
  });

  it("redacts a line, and never says a line holds what redaction hid", async () => {
    const w = rig();
    w.write("cfg.txt", `key needle ${TOKEN}\n`);
    const shown = await w.port.search(w.copy, "key needle", false);
    expect(shown.hits[0]?.text).toBe("key needle [redacted]");
    const hidden = await w.port.search(w.copy, TOKEN.slice(0, 12), false);
    expect(hidden.hits).toEqual([]);
    expect(hidden.withheld).toBe(0);
  });

  it("gives away nothing about a secret by whether a guess at it matched", async () => {
    const w = rig();
    w.write("cfg.txt", `value ${TOKEN}\n`);
    w.write(".env", "API_KEY=hunter2hunter2\n");
    w.write("key.txt", "-----BEGIN PRIVATE KEY-----\nMIIabcdef\n-----END PRIVATE KEY-----\n");
    const guess = async (q: string) => {
      const { hits, withheld, skipped, truncated, partial } = await w.port.search(w.copy, q, true);
      return { hits, withheld, skipped, truncated, partial };
    };
    expect(await guess(TOKEN.slice(0, 8))).toEqual(await guess("ghp_zzzz"));
    expect(await guess("API_KEY=h")).toEqual(await guess("API_KEY=x"));
    expect(await guess("MIIabc")).toEqual(await guess("MIIabd"));
  });

  it("doesn't return a value that sits on the line after its label", async () => {
    const key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12";
    const pairs = [
      `aws_secret_access_key:\n  ${key}\n`,
      `Authorization: Bearer\n  ${key}\n`,
      `_authToken =\n  ${key}\n`,
      `machine h login joe password\n  ${key}\n`,
      `aws_secret_access_key:\n\n  ${key}\n`,
    ];
    for (const text of pairs) {
      const w = rig();
      w.write("deploy.yaml", text);
      expect((await w.port.search(w.copy, key.slice(0, 5), true)).hits, text).toEqual([]);
    }
  });

  it("still shows the line after a label that has nothing to do with it", async () => {
    const w = rig();
    w.write("a.yaml", "name:\n  needle\n");
    expect((await w.port.search(w.copy, "needle", true)).hits.map((h) => h.path)).toContain("a.yaml");
  });

  it("returns no line of a file whose secrets span lines, or that usually holds them", async () => {
    const w = rig();
    w.write("key.txt", "-----BEGIN PRIVATE KEY-----\nMIIneedleBODY\n-----END PRIVATE KEY-----\n");
    w.write("logins", "machine example.com\n  login ada\n  password needlepass\n");
    for (const name of [".env", "prod.env", ".envrc", ".PYPIRC", "certs/server.pem"])
      w.write(name, "needle\n");
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits.map((h) => h.path)).toEqual(["gone.txt"]);
    expect(r.withheld).toBe(2);
  });

  it("doesn't show a file with a NUL past where binary is looked for", async () => {
    const w = rig();
    writeFileSync(join(w.cwd, ".gitattributes"), "* diff\n");
    w.write("wide.txt", "n\0e\0needle\0\n");
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits.map((h) => h.path)).toEqual(["gone.txt"]);
  });

  it("does the same in plain grep", async () => {
    const w = rig(false);
    w.write("key.txt", "-----BEGIN PRIVATE KEY-----\nMIIneedleBODY\n-----END PRIVATE KEY-----\n");
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits).toEqual([]);
    expect(r.withheld).toBe(1);
  });

  it("cuts a long line around the match, and leaves out a match past what is read", async () => {
    const w = rig();
    w.write("min.js", `${"a ".repeat(500)}needle ${"b ".repeat(500)}\n`);
    const r = await w.port.search(w.copy, "needle", false);
    const hit = r.hits.find((h) => h.path === "min.js");
    expect(hit?.text.startsWith("…")).toBe(true);
    expect(hit?.text.length).toBeLessThan(410);
    expect(hit?.text).toContain("needle");
    w.write("min.js", `${"a".repeat(5000)}needle\n`);
    const past = await w.port.search(w.copy, "needle", false);
    expect(past.hits.map((h) => h.path)).not.toContain("min.js");
    expect(past.withheld).toBe(0);
  });

  it("doesn't show a credential the line's cut split in two", async () => {
    const fill = (n: number) => "x ".repeat(n / 2);
    const secrets = [
      "https://bot:Sup3rS3cretPassw0rd1234567890@example.com/",
      "aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
      "AKIAIOSFODNN7EXAMPLE",
      TOKEN,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ];
    for (const secret of secrets) {
      for (const offset of [8, 12, 15, 19]) {
        const w = rig();
        // The row is the path, its number and the line: the cut lands inside the secret.
        const before = 2000 - "s.txt".length - 3 - offset;
        w.write("s.txt", `${fill(before - 7)}needle ${secret}\n`);
        const r = await w.port.search(w.copy, "needle", true);
        const shown = r.hits.filter((h) => h.path === "s.txt").map((h) => h.text);
        expect(shown.join("\n"), `${secret} at ${offset}`).not.toContain(secret.slice(0, offset));
      }
    }
  });

  it("one enormous line doesn't use up the output", async () => {
    const w = rig();
    w.write("a-min.js", `needle${"a".repeat(3_000_000)}\n`);
    w.write("b.txt", "needle\n");
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits.map((h) => h.path)).toContain("b.txt");
    expect(r.truncated).toBe(false);
  });

  it("keeps to its limits, and says so", async () => {
    const w = rig();
    w.write("log.txt", "needle\n".repeat(MAX_FILE_HITS + 5));
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits.filter((h) => h.path === "log.txt")).toHaveLength(MAX_FILE_HITS);
    expect(r.truncated).toBe(true);
    const rows = Array.from({ length: MAX_HITS + 5 }, (_, i) => `f${i}.txt\x001\x00needle\n`).join("");
    const out = [
      marker(NONCE, "hits-begin"),
      rows,
      marker(NONCE, "hits-end"),
      marker(NONCE, "keys-begin"),
      "",
      marker(NONCE, "keys-end"),
      marker(NONCE, "done"),
    ].join("\n");
    const cut = readSearch(out, NONCE, "needle", true);
    expect(cut.hits).toHaveLength(MAX_HITS);
    expect(cut.truncated).toBe(true);
  });

  it("drops a row the cap cut in two", () => {
    const out = [
      marker(NONCE, "cut"),
      marker(NONCE, "hits-begin"),
      "a.txt\x001\x00needle\nb.txt\x002\x00nee",
      marker(NONCE, "hits-end"),
      marker(NONCE, "keys-begin"),
      "",
      marker(NONCE, "keys-end"),
      marker(NONCE, "done"),
    ].join("\n");
    const r = readSearch(out, NONCE, "needle", true);
    expect(r.hits.map((h) => h.path)).toEqual(["a.txt"]);
    expect(r.truncated).toBe(true);
  });

  it("says where a name with a newline can't pass as another file's, and counts it", async () => {
    const w = rig();
    w.write("zz\nREADME.md", "needle: this line is not in README.md\n");
    const r = await w.port.search(w.copy, "needle: this", true);
    expect(r.hits).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it("calls a search that failed a failure, not no results", async () => {
    const w = rig();
    // A git that dies on `grep`: on the PATH, since the script clears everything else from git's environment.
    const shim = join(w.root, "bin");
    mkdirSync(shim);
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh\ncase " $* " in *" grep "*) exit 2 ;; esac\nexec ${real} "$@"\n`,
      { mode: 0o755 },
    );
    const dead: RunScript = async (_who, script) =>
      bash(`export PATH=${shim}:$PATH\n${script.replaceAll("/home/employee/work", join(w.root, "work"))}`);
    await expect(reviewPort(dead).search(w.copy, "needle", false)).rejects.toThrow();
    expect(() => readSearch("@@fail the search could not be run\n", NONCE, "x", false)).toThrow(/could not/);
  });

  it("says when the folder isn't there", async () => {
    const w = rig();
    execFileSync("rm", ["-rf", w.cwd]);
    expect((await w.port.search(w.copy, "x", false)).present).toBe(false);
  });

  it("refuses what isn't a line of words", () => {
    const w = rig();
    for (const bad of ["", "   ", "a\nb", "a\0b", "x".repeat(MAX_QUERY + 1), 3, null]) {
      expect(isSearchQuery(bad)).toBe(false);
    }
    expect(() => searchScript(w.copy, "a\nb", false, NONCE)).toThrow(/search for/);
  });
});

describe("a failure isn't an answer", () => {
  /** A stand-in for a tool on the PATH: the script clears everything else from its environment. */
  function shim(w: ReturnType<typeof rig>, tool: string, body: string) {
    const dir = join(w.root, "bin");
    mkdirSync(dir, { recursive: true });
    const real = execFileSync("which", [tool], { encoding: "utf8" }).trim();
    writeFileSync(join(dir, tool), `#!/bin/bash\n${body.replaceAll("REAL", real)}\n`, { mode: 0o755 });
    const run: RunScript = async (_who, script) =>
      bash(`export PATH=${dir}:$PATH\n${script.replaceAll("/home/employee/work", join(w.root, "work"))}`);
    return reviewPort(run);
  }

  it("doesn't call a search whose `cut` died no results", async () => {
    const w = rig();
    await expect(shim(w, "cut", "kill -9 $$").search(w.copy, "needle", false)).rejects.toThrow();
  });

  it("doesn't call a search whose `head` failed no results", async () => {
    const w = rig();
    await expect(shim(w, "head", "exit 3").search(w.copy, "needle", false)).rejects.toThrow();
  });

  it("doesn't call a killed `find` an empty folder", async () => {
    const w = rig(false);
    w.write("a.txt", "x\n");
    await expect(shim(w, "find", "kill -9 $$").tree(w.copy)).rejects.toThrow();
  });

  it("says a folder it couldn't read may be missing files", async () => {
    const w = rig(false);
    w.write("a.txt", "x\n");
    const t = await shim(w, "find", 'REAL "$@"; exit 1').tree(w.copy);
    expect(t.paths).toEqual(["a.txt"]);
    expect(t.partial).toBe(true);
  });

  it("carries on past a file plain grep can't read, and says so", async () => {
    const w = rig(false);
    w.write("a.txt", "needle\n");
    w.write("b.txt", "needle\n");
    chmodSync(join(w.cwd, "b.txt"), 0);
    const r = await w.port.search(w.copy, "needle", false);
    chmodSync(join(w.cwd, "b.txt"), 0o644);
    expect(r.hits.map((h) => h.path)).toEqual(["a.txt"]);
    expect(r.partial).toBe(true);
  });

  it("doesn't call a file it can't read empty", async () => {
    const w = rig();
    w.write("locked.txt", "x\n");
    chmodSync(join(w.cwd, "locked.txt"), 0);
    const side = await w.port.read(w.copy, "locked.txt");
    chmodSync(join(w.cwd, "locked.txt"), 0o644);
    expect(side).toEqual({ state: "other" });
  });

  it("fails rather than search past a list of key files too long to read", async () => {
    const w = rig();
    const port = shim(
      w,
      "git",
      'case " $* " in *" -l "*) head -c 2100000 /dev/zero | tr "\\0" a; exit 0 ;; esac\nexec REAL "$@"',
    );
    await expect(port.search(w.copy, "needle", false)).rejects.toThrow();
  });

  it("limits a search's memory", () => {
    const w = rig();
    expect(searchScript(w.copy, "x", false, NONCE)).toContain("ulimit -v");
  });
});

describe("it only reads", () => {
  it("doesn't fetch a missing object on git older than GIT_NO_LAZY_FETCH", async () => {
    // A partial clone of a server: the old blob isn't here, so asking for it would fetch it and write to .git.
    const w = rig(false);
    const server = join(w.root, "server");
    mkdirSync(server);
    git(server, "init", "-q", "-b", "main");
    git(server, "config", "uploadpack.allowFilter", "true");
    git(server, "config", "uploadpack.allowAnySHA1InWant", "true");
    const save = (m: string) => {
      git(server, "add", "-A");
      git(server, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", m);
    };
    writeFileSync(join(server, "a.txt"), "old\n");
    save("old");
    git(server, "branch", "conv");
    git(server, "checkout", "-q", "conv");
    writeFileSync(join(server, "a.txt"), "new\n");
    save("new");
    execFileSync("rm", ["-rf", w.cwd]);
    git(w.root, "clone", "-q", "--filter=blob:none", "-b", "conv", `file://${server}`, w.cwd);
    const missing = git(server, "rev-parse", "main:a.txt");
    const has = () => {
      try {
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "cat-file", "-e", missing], {
          cwd: w.cwd,
          env: { ...env, GIT_NO_LAZY_FETCH: "1" },
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    };
    expect(has()).toBe(false);
    // Git 2.43, in the image, knows nothing of this variable.
    const old: RunScript = async (_who, script) =>
      bash(
        script
          .replaceAll("GIT_NO_LAZY_FETCH=1", "IGNORED=1")
          .replaceAll("/home/employee/work", join(w.root, "work")),
      );
    const port = reviewPort(old);
    const copy = { ...w.copy, base: "main" };
    expect((await port.file(copy, "a.txt")).after).toEqual({ state: "text", text: "new\n" });
    // The list needs that blob, so it says it can't be read: that, not a fetch.
    await expect(port.list(copy)).rejects.toThrow(/could not be read/);
    expect(has()).toBe(false);
  });

  it("changes nothing in the copy, however much it lists, opens and searches", async () => {
    const w = rig();
    w.write("new.txt", "needle\n");
    w.write("keep.txt", "edited needle\n");
    const status = git(w.cwd, "status", "--porcelain");
    const before = fingerprint(join(w.cwd, ".git"));
    await w.port.tree(w.copy);
    await w.port.read(w.copy, "keep.txt");
    await w.port.search(w.copy, "needle", false);
    expect(fingerprint(join(w.cwd, ".git"))).toBe(before);
    expect(git(w.cwd, "status", "--porcelain")).toBe(status);
  });

  it("writes nothing to .git with a split index on, and runs nothing of the copy's", async () => {
    const w = rig();
    const evil = `touch ${join(w.root, "ran")}`;
    git(w.cwd, "config", "core.splitIndex", "true");
    git(w.cwd, "update-index", "--split-index");
    git(w.cwd, "config", "core.fsmonitor", evil);
    git(w.cwd, "config", "filter.evil.clean", evil);
    git(w.cwd, "config", "core.pager", evil);
    writeFileSync(join(w.cwd, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(w.cwd, ".git/hooks/post-index-change"), `#!/bin/sh\n${evil}\n`, { mode: 0o755 });
    const before = readdirSync(join(w.cwd, ".git")).sort();
    await w.port.tree(w.copy);
    await w.port.search(w.copy, "needle", false);
    expect(readdirSync(join(w.cwd, ".git")).sort()).toEqual(before);
    expect(existsSync(join(w.root, "ran"))).toBe(false);
  });
});

const service = (port: ReviewPort, over: { archivedAt?: number | null } = {}) =>
  new ConversationReview({
    conversations: {
      get: (id) =>
        id === "ab12"
          ? { employeeId: "ada", project: "Duet", archivedAt: over.archivedAt ?? null }
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

const stub = (over: Partial<ReviewPort>): ReviewPort => ({ ...demoReview, ...over });

describe("how a read fails, in a sentence", () => {
  it("says the machine is asleep, and doesn't wake it", async () => {
    const asleep = () => Promise.reject(new MachineNotRunning("inc-ada"));
    const r = service(stub({ tree: asleep, read: asleep, search: asleep }));
    const reason = "Ada's machine is asleep, so the files can't be read right now.";
    expect(await r.files("ab12")).toMatchObject({ state: "asleep", reason, paths: [] });
    expect(await r.search("ab12", "x", false)).toMatchObject({ state: "asleep", reason, hits: [] });
    expect(await r.read("ab12", "a.txt")).toMatchObject({
      state: "asleep",
      reason: "Ada's machine is asleep, so this file can't be read right now.",
    });
  });

  it("says the machine is busy when a read outlasts its wait", async () => {
    const never = () => new Promise<never>(() => {});
    const r = service(stub({ tree: never, search: never }));
    expect((await r.files("ab12")).state).toBe("busy");
    expect((await r.search("ab12", "x", false)).state).toBe("busy");
  });

  it("says busy when a read is still queued behind a stop, through the real queue, and starts nothing", async () => {
    const { wallsMarker: _, ...noWalls } = defaultMachineSettings;
    const settings = { ...noWalls, machineFor: () => "inc-ada" };
    const started: string[][] = [];
    const run = machineScript(
      settings,
      async () => "NAME STATE\ninc-ada running\n",
      undefined,
      (_bin, args) => {
        started.push(args);
        throw new Error("no client here");
      },
    );
    // A stop in hand holds the machine: nothing else may start until it ends.
    let end = () => {};
    const stopping = queueFor(settings).stop("inc-ada", "a stop", () => new Promise<void>((r) => (end = r)));
    const r = service(reviewPort(run));
    expect(await r.files("ab12")).toMatchObject({
      state: "busy",
      reason: "Ada's machine is busy, so the files can't be read right now.",
    });
    expect(await r.search("ab12", "x", false)).toMatchObject({ state: "busy" });
    expect(started).toEqual([]);
    end();
    await stopping;
  });

  it("says a failure in a sentence, with nothing from the machine in it", async () => {
    const r = service(stub({ tree: () => Promise.reject(new Error("/home/employee: secrets")) }));
    expect(await r.files("ab12")).toMatchObject({
      state: "failed",
      reason: "Couldn't read the files in Ada's machine.",
    });
  });

  it("says when the copy was cleaned away, or isn't made yet", async () => {
    const gone = stub({
      tree: async () => ({ present: false, paths: [], skipped: 0, truncated: false, partial: false }),
      read: async () => null,
      search: async () => ({
        present: false,
        hits: [],
        skipped: 0,
        withheld: 0,
        truncated: false,
        partial: false,
      }),
    });
    expect((await service(gone).files("ab12")).reason).toBe("There are no files here yet.");
    expect((await service(gone, { archivedAt: 1 }).files("ab12")).reason).toMatch(/cleaned away/);
    expect((await service(gone).read("ab12", "a.txt")).state).toBe("no-copy");
    expect((await service(gone).search("ab12", "x", false)).state).toBe("no-copy");
  });

  it("names a file that usually holds secrets and never asks the machine for it", async () => {
    let asked = 0;
    const r = service(
      stub({
        read: async () => {
          asked++;
          return { state: "text", text: "x" };
        },
      }),
    );
    expect(await r.read("ab12", "deploy/.env")).toMatchObject({ state: "ok", withheld: true });
    expect(asked).toBe(0);
  });

  it("doesn't start a second list while one is going", async () => {
    let asked = 0;
    const r = service(
      stub({
        tree: async () => {
          asked++;
          return { present: true, paths: [], skipped: 0, truncated: false, partial: false };
        },
      }),
    );
    await Promise.all([r.files("ab12"), r.files("ab12")]);
    expect(asked).toBe(1);
  });
});

describe("the routes", () => {
  async function app(port: ReviewPort) {
    const a = await createApp({
      dbPath: ":memory:",
      knowledgeDir: mkdtempSync(join(tmpdir(), "inc-files-k-")),
      clock: new FakeClock(),
      machines: new FakeMachines(),
      agent: new FakeAgent(),
      harness: {} as never,
      helper: new FakeHelper(),
      chat: new FakeChat(),
      review: () => port,
    });
    seedDemo(a.deps.registry);
    const res = await a.handle(
      new Request("http://i.inc/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employeeId: "ada", project: "fintrack" }),
      }),
    );
    const id = ((await res.json()) as { conversation: { id: string } }).conversation.id;
    const get = async (path: string) => {
      const r = await a.handle(new Request(`http://i.inc/api/conversations/${path}`));
      return { status: r.status, body: (await r.json()) as Record<string, never> };
    };
    return { id, get };
  }

  it("answers 404 for a conversation that isn't there", async () => {
    const { get } = await app(demoReview);
    for (const p of ["files", "files/read?path=a.txt", "files/search?q=a"]) {
      expect((await get(`nope/${p}`)).status).toBe(404);
    }
  });

  it("lists, reads and searches the demo", async () => {
    const { id, get } = await app(demoReview);
    const { body: list } = await get(`${id}/files`);
    expect(list.files).toMatchObject({ state: "ok", noProject: false });
    expect((list.files as unknown as { paths: string[] }).paths).toContain("src/format.ts");
    const { body: read } = await get(`${id}/files/read?path=src%2Findex.ts`);
    expect(read.file).toMatchObject({ state: "ok", path: "src/index.ts", side: { state: "text" } });
    const { body: found } = await get(`${id}/files/search?q=MONEY`);
    expect((found.search as unknown as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    const { body: exact } = await get(`${id}/files/search?q=MONEY&case=1`);
    expect(exact.search).toMatchObject({ state: "ok", hits: [] });
  });

  it("refuses a bad path or query before anything reaches the machine", async () => {
    let asked = 0;
    const count = () => {
      asked++;
      return Promise.reject(new Error("asked"));
    };
    const { id, get } = await app(stub({ read: count, search: count }));
    expect((await get(`${id}/files/read`)).status).toBe(400);
    expect((await get(`${id}/files/read?path=..%2Fx`)).status).toBe(400);
    expect((await get(`${id}/files/read?path=.git%2Fconfig`)).status).toBe(400);
    expect((await get(`${id}/files/search`)).status).toBe(400);
    expect((await get(`${id}/files/search?q=a%0Ab`)).status).toBe(400);
    expect(asked).toBe(0);
  });
});
