// The git side of shipping, apart from the daemon: what the scan calls a credential (and what it lets be),
// how the inspect script's output is read, that nothing unsafe reaches a shell, and that a branch GitHub has
// moved on is never overwritten.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Employee } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import {
  commitScript,
  conversationShip,
  inspectScript,
  pushScript,
  readInspect,
  SCAN_LIMIT,
  type ShipCopy,
  ShipRefusal,
  scanDiff,
  secretsSentence,
} from "../src/ship-git.ts";

const ada = { id: "ada", name: "Ada" } as Employee;
const copy = (over: Partial<ShipCopy> = {}): ShipCopy => ({
  employee: ada,
  repo: "acme/duet",
  base: "main",
  protectedPaths: [".github/"],
  branch: "conv/ab12cd34",
  cwd: "/home/employee/work/conv-ab12cd34",
  ...over,
});

const diffOf = (files: Record<string, string>) =>
  Object.entries(files)
    .map(
      ([path, text]) =>
        `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${text
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")}`,
    )
    .join("\n");

describe("the scan for credentials", () => {
  it("finds tokens, keys and passwords in URLs, by file", () => {
    const found = scanDiff(
      diffOf({
        "a.ts": 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
        "b.ts": 'const k = "sk-ant-api03-abcdefghijklmnop";',
        "c.sh": "curl https://user:hunter2secret@example.com/x",
        "d.pem":
          "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLI\n-----END RSA PRIVATE KEY-----",
        "e.ts": "export const fine = 1;",
      }),
    );
    expect(found.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts", "c.sh", "d.pem"]);
  });

  it("lets ordinary code through, even code that talks about tokens", () => {
    expect(
      scanDiff(
        diffOf({
          "types.ts":
            "export interface Session {\n  token: string;\n  password?: string;\n  apiKey: string;\n}",
          "doc.md": "Set GH_TOKEN in the environment. Never commit a key.",
          "hash.ts": 'const sha = "0123456789abcdef0123456789abcdef01234567";',
        }),
      ),
    ).toEqual([]);
  });

  it("reads a long file in pieces, so a credential late in it is still found and a big clean one is clean", () => {
    const clean = Array.from({ length: 60_000 }, (_, i) => `export const n${i} = ${i};`).join("\n");
    expect(scanDiff(diffOf({ "big.ts": clean }))).toEqual([]);
    expect(
      scanDiff(diffOf({ "big.ts": `${clean}\nconst t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";` })).map(
        (f) => f.path,
      ),
    ).toEqual(["big.ts"]);
  });

  it("only looks at what is added, not at the lines a change takes out", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      '-const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
      "+const t = process.env.TOKEN;",
    ].join("\n");
    expect(scanDiff(diff)).toEqual([]);
  });

  it("says which files and never what is in them", () => {
    const s = secretsSentence({
      secrets: [{ path: "a.ts", kind: "a token, key or password" }],
      tooBig: false,
    });
    expect(s).toBe(
      "Nothing was committed: a.ts looks like it holds a credential. Take it out (keep secrets in the environment, never in files), then try again.",
    );
    expect(secretsSentence({ secrets: [], tooBig: true })).toMatch(/too big/);
  });
});

describe("reading the inspect script's output", () => {
  const out = [
    "@@head 0123456789abcdef0123456789abcdef01234567",
    "@@ahead 2",
    "@@remote ",
    "@@dirty  M src/a.ts",
    "@@dirty ?? new file.txt",
    "@@file 12\t3\tsrc/a.ts",
    "@@file -\t-\tlogo.png",
    "@@file 1\t0\t.github/workflows/ci.yml",
    "@@file 1\t0\t.env",
    "@@file 1\t0\t.env.example",
    "@@file 1\t0\tkeys/server.pem",
    "@@diff-begin",
    diffOf({ "src/a.ts": "export const a = 1;" }),
    "",
    "@@diff-end",
  ].join("\n");

  it("lists the files with their counts, the uncommitted paths, and the protected and secret-bearing ones", () => {
    const r = readInspect(copy(), out);
    expect(r.head).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(r.ahead).toBe(2);
    expect(r.remote).toBe("");
    expect(r.uncommitted).toEqual(["src/a.ts", "new file.txt"]);
    expect(r.files[0]).toEqual({ path: "src/a.ts", added: 12, removed: 3 });
    expect(r.files[1]).toEqual({ path: "logo.png", added: 0, removed: 0, binary: true });
    expect(r.protectedPaths).toEqual([".github/workflows/ci.yml"]);
    expect(r.secrets.map((s) => s.path)).toEqual([".env", "keys/server.pem"]);
    expect(r.tooBig).toBe(false);
  });

  it("calls a change too big to read, too big", () => {
    const big = `@@diff-begin\n${"x".repeat(SCAN_LIMIT + 5)}\n@@diff-end\n`;
    expect(readInspect(copy(), big).tooBig).toBe(true);
  });
});

describe("what reaches a shell", () => {
  it("refuses an unsafe folder, branch or base before building any script", () => {
    for (const bad of [
      copy({ branch: "x; rm -rf ~" }),
      copy({ branch: "../x" }),
      copy({ cwd: "/etc" }),
      copy({ cwd: "/home/employee/work/../../etc" }),
      copy({ base: "main; id" }),
    ]) {
      expect(() => inspectScript(bad)).toThrow();
      expect(() => commitScript(bad, "m")).toThrow();
      expect(() => pushScript(bad)).toThrow();
    }
  });

  it("carries the commit message as base64, so no message can break out of the script", () => {
    const message = 'feat: it\'s "quoted" $(touch /tmp/x) `id`\n\nbody';
    const script = commitScript(copy(), message);
    expect(script).not.toContain("touch /tmp/x");
    expect(script).toContain(Buffer.from(message).toString("base64"));
    expect(script).toContain("--no-verify");
  });
});

describe("pushing", () => {
  const root = mkdtempSync(join(tmpdir(), "inc-shipgit-"));
  const home = join(root, "home");
  mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();
  const bash = (script: string) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const c = spawn("bash", ["-s"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      c.stdout.on("data", (d) => {
        output += d;
      });
      c.stderr.on("data", (d) => {
        output += d;
      });
      c.on("exit", (code) => resolve({ code: code ?? 1, output }));
      c.stdin.end(script);
    });

  it("never overwrites a branch GitHub has moved on, and says so", async () => {
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    git(root, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "a"), "a\n");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=o", "-c", "user.email=o@x.invalid", "commit", "-q", "-m", "base");
    git(root, "clone", "-q", "--bare", seed, origin);
    // The conversation's copy, in a folder shaped like the machine's.
    const work = join(root, "work", "home", "employee", "work");
    mkdirSync(work, { recursive: true });
    const cwd = join(work, "conv-ab12cd34");
    git(root, "clone", "-q", origin, cwd);
    git(cwd, "checkout", "-q", "-b", "conv/ab12cd34");
    writeFileSync(join(cwd, "mine"), "mine\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-q", "-m", "mine");
    // Someone else put a commit on the same branch name in GitHub.
    const other = join(root, "other");
    git(root, "clone", "-q", origin, other);
    git(other, "checkout", "-q", "-b", "conv/ab12cd34");
    writeFileSync(join(other, "theirs"), "theirs\n");
    git(other, "add", "-A");
    git(other, "-c", "user.name=b", "-c", "user.email=b@x.invalid", "commit", "-q", "-m", "theirs");
    git(other, "push", "-q", "origin", "conv/ab12cd34");
    const theirs = git(other, "rev-parse", "HEAD");

    const ship = conversationShip({
      tokens: { token: async () => "ghs_x" },
      run: async (_e, script) => bash(script.replaceAll("/home/employee/work", work)),
      prs: {} as never,
    });
    await expect(ship.push(copy())).rejects.toMatchObject({
      code: "diverged",
      message: expect.stringContaining("has changes this working copy doesn't"),
    });
    expect(ShipRefusal.name).toBe("ShipRefusal");
    expect(git(origin, "rev-parse", "conv/ab12cd34")).toBe(theirs);
  });
});
