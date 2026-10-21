// The git side of shipping, apart from the daemon: what the scan calls a credential (and what it lets be),
// how the inspect script's output is read, that nothing unsafe reaches a shell, that a hook, a filter or an odd
// file name can't get past the scan, and that a branch GitHub has moved on is never overwritten. The scripts
// run in real bash against real git.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Employee } from "@i-inc/core";
import { describe, expect, it } from "vitest";
import {
  addedLines,
  blockers,
  commitScript,
  conversationShip,
  inspectScript,
  pushScript,
  readInspect,
  SCAN_LIMIT,
  type ShipCopy,
  scanPatch,
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
const REMOTE = "https://github.com/acme/duet.git";

const patchOf = (files: Record<string, string>) =>
  Object.entries(files)
    .map(
      ([path, text]) =>
        `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n${text
          .split("\n")
          .map((l) => `+${l}`)
          .join("\n")}`,
    )
    .join("\n");

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("the scan for credentials", () => {
  it("finds tokens, keys, passwords in URLs, live payment keys, npm auth and .netrc logins", () => {
    for (const text of [
      'const t = "gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789";',
      'const k = "s\u006b-ant-api03-abcdefghijklmnop";',
      "curl https://user:hunter2secret@example.com/x",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLI\n-----END RSA PRIVATE KEY-----",
      'const stripe = "sk_li\u0076e_abcdefghijklmnopqrstuvwx";',
      "//registry.npmjs.org/:_authToken=n\u0070m_abcdefghijklmnop",
      "machine api.example.com login me password hunter2secret",
    ]) {
      expect(scanPatch(patchOf({ "a.txt": text })), text).toBe(true);
    }
  });

  it("lets ordinary code through, even code that talks about tokens", () => {
    for (const text of [
      "export interface Session {\n  token: string;\n  password?: string;\n  apiKey: string;\n}",
      "Set GH_TOKEN in the environment. Never commit a key.",
      'const sha = "0123456789abcdef0123456789abcdef01234567";',
      ["//registry.npmjs.org/:_authToken=", "$", "{NPM_TOKEN}"].join(""),
    ]) {
      expect(scanPatch(patchOf({ "a.txt": text })), text).toBe(false);
    }
  });

  it("reads a long file in pieces, and only what is added, not what a change takes out", () => {
    const clean = Array.from({ length: 60_000 }, (_, i) => `export const n${i} = ${i};`).join("\n");
    expect(scanPatch(patchOf({ "big.ts": clean }))).toBe(false);
    expect(
      scanPatch(
        patchOf({ "big.ts": `${clean}\nconst t = "gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789";` }),
      ),
    ).toBe(true);
    const removing = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      '-const t = "gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789";',
      "+const t = process.env.TOKEN;",
    ].join("\n");
    expect(scanPatch(removing)).toBe(false);
  });

  it("tells headers from content by where they are, so no content can pass as a header", () => {
    // An added line that looks like a file header ("+++ b/x") is an added line, and is read.
    const tricky = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -0,0 +1,2 @@",
      "+++ b/not-a-header",
      "+gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");
    expect(addedLines(tricky)).toContain("gh\u0070_");
    expect(scanPatch(tricky)).toBe(true);
    // And the lines before a hunk are never read as added.
    expect(
      addedLines("diff --git a/x b/x\n--- a/x\n+++ b/gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789\n"),
    ).toBe("");
  });

  it("says which files and commits and never what is in them", () => {
    const r = {
      secrets: [
        { path: "a.ts", kind: "a token, key or password" },
        { path: "commit 1234abc", kind: "a commit in the branch's history" },
      ],
      unscanned: [],
      unsafe: [],
      tooBig: false,
    };
    expect(blockers(r)).toEqual([
      "a.ts looks like it holds a credential",
      "commit 1234abc in the branch's history holds a credential (a push publishes every commit, even one a later commit undid)",
    ]);
    expect(secretsSentence(r)).toContain("revoke it");
    expect(secretsSentence({ secrets: [], unscanned: [], unsafe: [], tooBig: true })).toMatch(/too big/);
  });
});

describe("reading the inspect script's output", () => {
  const out = (net: string[], hist: string[] = ["@@commits-total 0"]) =>
    [
      "@@head 0123456789abcdef0123456789abcdef01234567",
      "@@ahead 2",
      "@@remote ",
      `@@dirty ${b64("src/a.ts")}`,
      `@@dirty ${b64("new file.txt")}`,
      "@@net-begin",
      ...net,
      "",
      "@@net-end",
      "@@hist-begin",
      ...hist,
      "",
      "@@hist-end",
    ].join("\n");
  const file = (path: string, a: number | "-" = 1, d: number | "-" = 0) => `@@file ${a} ${d} ${b64(path)}`;
  const scan = (path: string, text: string) => `@@scan ${b64(path)}\n${patchOf({ [path]: text })}`;

  it("lists the files with their counts, the uncommitted paths, and the protected and secret-bearing ones", () => {
    const r = readInspect(
      copy(),
      out([
        file("src/a.ts", 12, 3),
        scan("src/a.ts", "export const a = 1;"),
        file("logo.png", "-", "-"),
        `@@binary ${b64("logo.png")} 20000`,
        file(".github/workflows/ci.yml"),
        scan(".github/workflows/ci.yml", "name: ci"),
        file(".env"),
        scan(".env", "A=1"),
        file(".env.example"),
        scan(".env.example", "A="),
        file("keys/server.pem"),
        scan("keys/server.pem", "x"),
        file("deploy/.netrc"),
        scan("deploy/.netrc", "x"),
        file("tiny.ico", "-", "-"),
        `@@binary ${b64("tiny.ico")} 300`,
      ]),
    );
    expect(r.head).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(r.ahead).toBe(2);
    expect(r.uncommitted).toEqual(["src/a.ts", "new file.txt"]);
    expect(r.files[0]).toEqual({ path: "src/a.ts", added: 12, removed: 3 });
    expect(r.files[1]).toEqual({ path: "logo.png", added: 0, removed: 0, binary: true });
    expect(r.protectedPaths).toEqual([".github/workflows/ci.yml"]);
    expect(r.secrets.map((s) => s.path).sort()).toEqual([".env", "deploy/.netrc", "keys/server.pem"]);
    expect(r.binaries).toEqual([{ path: "logo.png", size: 20000 }]);
    expect(r.unscanned).toEqual([]);
    expect(r.tooBig).toBe(false);
  });

  it("fails closed: a changed file with no scan, an unreadable name, or a missing section is a reason to stop", () => {
    const missing = readInspect(copy(), out([file("src/a.ts", 3, 0)]));
    expect(missing.unscanned).toEqual(["src/a.ts"]);
    expect(blockers(missing)[0]).toContain("could not be read to check for credentials");
    const badName = readInspect(copy(), out(["@@file 1 0 ***not-base64***", "@@scan ***"]));
    expect(badName.unscanned.length).toBeGreaterThan(0);
    const noSections = readInspect(copy(), "@@head abc\n@@ahead 1\n");
    expect(noSections.tooBig).toBe(true);
    expect(blockers(noSections)).toHaveLength(1);
    // A pure deletion or a mode change has nothing to scan.
    expect(readInspect(copy(), out([file("gone.ts", 0, 9), file("run.sh", 0, 0)])).unscanned).toEqual([]);
  });

  it("flags an absolute link, and reads names with quotes, tabs and newlines exactly", () => {
    const odd = 'a"b\tc\nd.txt';
    const r = readInspect(
      copy(),
      out([
        file(odd),
        scan(odd, 'const t = "gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789";'),
        `@@abslink ${b64("link")}`,
      ]),
    );
    expect(r.files[0]?.path).toBe(odd);
    expect(r.secrets).toEqual([{ path: odd, kind: "a token, key or password" }]);
    expect(r.unsafe).toEqual([{ path: "link", why: "is a link to an absolute path outside the project" }]);
  });

  it("finds a credential in a commit's message or patch, by commit and never by value", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const r = readInspect(
      copy(),
      out(
        [],
        [
          "@@commits-total 2",
          `@@commit ${sha}`,
          `@@msg ${b64("feat: add it\n\nthe key is gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789")}`,
          `@@commit ${"f".repeat(40)}`,
          `@@msg ${b64("fine")}`,
          patchOf({ "x.ts": 'const t = "s\u006b-ant-api03-abcdefghijklmnop";' }),
        ],
      ),
    );
    expect(r.secrets.map((s) => s.path)).toEqual(["commit 0123456", "commit fffffff"]);
    expect(JSON.stringify(r)).not.toContain("gh\u0070_abc");
    expect(readInspect(copy(), out([], ["@@commits-total 501"])).tooBig).toBe(true);
  });

  it("calls a change too big to read, too big", () => {
    const big = out([`@@scan ${b64("x")}`, "x".repeat(SCAN_LIMIT + 5)]);
    expect(readInspect(copy(), big).tooBig).toBe(true);
  });
});

describe("what reaches a shell", () => {
  it("refuses an unsafe folder, branch, base or remote before building any script", () => {
    for (const [bad, remote] of [
      [copy({ branch: "x; rm -rf ~" }), REMOTE],
      [copy({ branch: "../x" }), REMOTE],
      [copy({ cwd: "/etc" }), REMOTE],
      [copy({ cwd: "/home/employee/work/../../etc" }), REMOTE],
      [copy({ base: "main; id" }), REMOTE],
      [copy(), "https://evil.example/x.git"],
      [copy(), "https://github.com/a/b.git; id"],
    ] as const) {
      expect(() => inspectScript(bad, remote)).toThrow();
      expect(() => commitScript(bad, remote, "m")).toThrow();
      expect(() => pushScript(bad, remote, "a".repeat(40))).toThrow();
    }
    expect(() => pushScript(copy(), REMOTE, "not-a-sha")).toThrow();
  });

  it("carries the commit message as base64, so no message can break out of the script", () => {
    const message = 'feat: it\'s "quoted" $(touch /tmp/x) `id`\n\nbody';
    const script = commitScript(copy(), REMOTE, message);
    expect(script).not.toContain("touch /tmp/x");
    expect(script).toContain(Buffer.from(message).toString("base64"));
    expect(script).toContain("--no-verify");
  });

  it("takes the token out of the environment first, and uses it only in the network function", () => {
    for (const script of [
      inspectScript(copy(), REMOTE),
      commitScript(copy(), REMOTE, "m"),
      pushScript(copy(), REMOTE, "a".repeat(40)),
    ]) {
      const at = script.indexOf("unset GH_TOKEN");
      expect(at).toBeGreaterThan(0);
      expect(script.slice(0, at)).not.toContain("git ");
    }
    // The only mention of the token after that is the N function; commit never talks to the network.
    expect(
      commitScript(copy(), REMOTE, "m")
        .split("\n")
        .filter((l) => /(^|\s)N /.test(l) && !l.startsWith("N()")),
    ).toEqual([]);
  });
});

// ── real git ──

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
const bash = (script: string, extra: Record<string, string> = {}) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    const c = spawn("bash", ["-s"], { env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
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

let n = 0;
/** An origin, the conversation's copy of it in a folder shaped like the machine's, and a ship port over them. */
function world() {
  const dir = join(root, `w${n++}`);
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "a"), "a\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=o", "-c", "user.email=o@x.invalid", "commit", "-q", "-m", "base");
  git(dir, "clone", "-q", "--bare", seed, origin);
  const work = join(dir, "home", "employee", "work");
  mkdirSync(work, { recursive: true });
  const cwd = join(work, "conv-ab12cd34");
  git(dir, "clone", "-q", origin, cwd);
  git(cwd, "checkout", "-q", "-b", "conv/ab12cd34");
  git(cwd, "config", "user.name", "Ada (i.inc)");
  git(cwd, "config", "user.email", "bot@x.invalid");
  const seen: Record<string, string>[] = [];
  const ship = conversationShip({
    tokens: { token: async () => "ghs_secret_token_value" },
    run: async (_e, script, extra) => {
      seen.push(extra ?? {});
      return bash(script.replaceAll("/home/employee/work", work).replaceAll(REMOTE, origin), extra);
    },
    prs: {} as never,
  });
  const commit = (msg: string, files: Record<string, string> = {}) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(cwd, p, ".."), { recursive: true });
      writeFileSync(join(cwd, p), t);
    }
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "--no-verify", "-m", msg);
  };
  return { dir, origin, cwd, ship, seen, commit };
}
const TOKEN = "gh\u0070_abcdefghijklmnopqrstuvwxyz0123456789";

describe("real git", () => {
  it("never overwrites a branch GitHub has moved on, and says so", async () => {
    const w = world();
    w.commit("mine", { mine: "mine\n" });
    const other = join(w.dir, "other");
    git(w.dir, "clone", "-q", w.origin, other);
    git(other, "checkout", "-q", "-b", "conv/ab12cd34");
    writeFileSync(join(other, "theirs"), "theirs\n");
    git(other, "add", "-A");
    git(other, "-c", "user.name=b", "-c", "user.email=b@x.invalid", "commit", "-q", "-m", "theirs");
    git(other, "push", "-q", "origin", "conv/ab12cd34");
    const theirs = git(other, "rev-parse", "HEAD");
    await expect(w.ship.push(copy())).rejects.toMatchObject({
      code: "diverged",
      message: expect.stringContaining("has changes this working copy doesn't"),
    });
    expect(git(w.origin, "rev-parse", "conv/ab12cd34")).toBe(theirs);
  });

  it("refuses to push a token that was committed and then taken out, and pushes nothing", async () => {
    const w = world();
    w.commit("add config", { "config.ts": `export const token = "${TOKEN}";\n` });
    w.commit("remove the token", { "config.ts": "export const token = process.env.TOKEN;\n" });
    // The branch ends clean: the net change has no credential, but the history does.
    const report = await w.ship.inspect(copy());
    expect(report.secrets.map((s) => s.path)).toEqual([expect.stringMatching(/^commit [0-9a-f]{7}$/)]);
    await expect(w.ship.push(copy())).rejects.toMatchObject({
      code: "secrets",
      message: expect.stringContaining("in the branch's history"),
    });
    expect(() => git(w.origin, "rev-parse", "conv/ab12cd34")).toThrow();
    await expect(w.ship.verify(copy())).rejects.toMatchObject({ code: "secrets" });
  });

  it("finds a credential in a commit message, and never prints it", async () => {
    const w = world();
    w.commit(`fix: use ${TOKEN}`, { b: "b\n" });
    const err = await w.ship.push(copy()).catch((e) => e);
    expect(err.code).toBe("secrets");
    expect(err.message).not.toContain(TOKEN);
  });

  it("scans files with a quote, a backslash, a tab or a newline in the name", async () => {
    const w = world();
    const names = ['a"b.txt', "a\\b.txt", "a\tb.txt", "a\nb.txt"];
    for (const name of names) writeFileSync(join(w.cwd, name), `const t = "${TOKEN}";\n`);
    const report = await w.ship.inspect(copy());
    expect(report.unscanned).toEqual([]);
    expect(report.secrets.map((s) => s.path).sort()).toEqual([...names].sort());
    await expect(w.ship.commit(copy(), "m")).rejects.toMatchObject({ code: "secrets" });
    // The same names, clean, are listed exactly and can be committed.
    for (const name of names) writeFileSync(join(w.cwd, name), "fine\n");
    const clean = await w.ship.inspect(copy());
    expect(clean.files.map((f) => f.path).sort()).toEqual([...names].sort());
    expect(blockers(clean)).toEqual([]);
    expect((await w.ship.commit(copy(), "m")).committed).toBe(true);
  });

  it("runs no hook of the repo's: a post-commit that amends a token in never runs, and never sees the bot's token", async () => {
    const w = world();
    const marker = join(w.dir, "hook-ran");
    for (const hook of [
      "post-commit",
      "prepare-commit-msg",
      "pre-commit",
      "commit-msg",
      "pre-push",
      "reference-transaction",
      "post-checkout",
    ]) {
      const file = join(
        git(w.cwd, "rev-parse", "--git-common-dir").startsWith("/")
          ? git(w.cwd, "rev-parse", "--git-common-dir")
          : join(w.cwd, ".git"),
        "hooks",
        hook,
      );
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(
        file,
        `#!/bin/sh\necho "${hook} $GH_TOKEN" >> ${marker}\necho 'const t = "${TOKEN}";' > leak.ts\ngit add leak.ts\ngit commit --amend --no-edit --no-verify -q\n`,
      );
      chmodSync(file, 0o755);
    }
    writeFileSync(join(w.cwd, "x.txt"), "x\n");
    expect((await w.ship.commit(copy(), "feat: x")).committed).toBe(true);
    expect(await w.ship.push(copy())).toMatchObject({ head: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(w.cwd, "leak.ts"))).toBe(false);
    expect(git(w.origin, "rev-parse", "conv/ab12cd34")).toBe(git(w.cwd, "rev-parse", "HEAD"));
    expect(() => git(w.origin, "show", "conv/ab12cd34:leak.ts")).toThrow();
  });

  it("runs no clean or smudge filter of the repo's, however it is named", async () => {
    const w = world();
    const marker = join(w.dir, "filter-ran");
    writeFileSync(join(w.cwd, ".gitattributes"), "*.txt filter=sneaky\n*.dat filter=lfsish\n");
    git(w.cwd, "config", "filter.sneaky.clean", `sh -c 'echo clean >> ${marker}; cat'`);
    git(w.cwd, "config", "filter.sneaky.smudge", `sh -c 'echo smudge >> ${marker}; cat'`);
    git(w.cwd, "config", "filter.sneaky.required", "true");
    git(w.cwd, "config", "filter.lfsish.process", `sh -c 'echo process >> ${marker}'`);
    git(w.cwd, "config", "filter.lfsish.required", "true");
    writeFileSync(join(w.cwd, "x.txt"), "x\n");
    writeFileSync(join(w.cwd, "y.dat"), "y\n");
    const report = await w.ship.inspect(copy());
    expect(report.files.map((f) => f.path).sort()).toEqual([".gitattributes", "x.txt", "y.dat"]);
    expect((await w.ship.commit(copy(), "feat: x")).committed).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("gives the bot's token only to the scripts that talk to GitHub", async () => {
    const w = world();
    writeFileSync(join(w.cwd, "x.txt"), "x\n");
    await w.ship.commit(copy(), "feat: x");
    await w.ship.push(copy());
    // inspect (to fetch) and push carry it; the commit script never does.
    const withToken = w.seen.filter((e) => e.GH_TOKEN === "ghs_secret_token_value").length;
    const without = w.seen.filter((e) => e.GH_TOKEN === undefined).length;
    expect(withToken).toBeGreaterThanOrEqual(2);
    expect(without).toBe(1);
  });

  it("flags absolute links and binaries over a few KB, and not small ones", async () => {
    const w = world();
    execFileSync("ln", ["-s", "/etc/passwd", join(w.cwd, "pw")]);
    execFileSync("ln", ["-s", "a", join(w.cwd, "rel")]);
    writeFileSync(join(w.cwd, "big.bin"), Buffer.alloc(20_000, 0));
    writeFileSync(join(w.cwd, "tiny.bin"), Buffer.from([0, 1, 2, 3, 0]));
    const r = await w.ship.inspect(copy());
    expect(r.unsafe.map((u) => u.path)).toEqual(["pw"]);
    expect(r.binaries).toEqual([{ path: "big.bin", size: 20000 }]);
    await expect(w.ship.verify(copy())).rejects.toMatchObject({ code: "secrets" });
  });
});
