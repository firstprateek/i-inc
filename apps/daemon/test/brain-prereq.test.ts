// What copying the brain needs from a sandbox, and what happens when something is missing: a clear line in
// the log and no copy (the session goes on), never a broken session. And the index's cheap look at HEAD.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeStore } from "../src/knowledge.ts";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const tools =
  "git tar base64 comm sort find cp mv rm sed awk grep cut wc tr mkdir dirname chmod cat mktemp head ls date uname node".split(
    " ",
  );
const which = (t: string) => execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim();

/** A PATH holding every tool a copy needs except the ones named, or with a stand-in for them. */
function pathWith(o: { without?: readonly string[]; fake?: Readonly<Record<string, string>> }): string {
  const dir = mkdtempSync(join(tmpdir(), "i-inc-path-"));
  for (const t of tools) {
    if (o.without?.includes(t) || o.fake?.[t] !== undefined) continue;
    try {
      symlinkSync(which(t), join(dir, t));
    } catch {
      // a tool this machine lacks: the test that needs it will say so
    }
  }
  for (const [t, body] of Object.entries(o.fake ?? {})) {
    writeFileSync(join(dir, t), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, t), 0o755);
  }
  return dir;
}

/** A rig whose sandbox is bash with that PATH. */
async function rigWithPath(path: string) {
  const r = await brainRig();
  r.feed.deliver = async (employeeId, script) => {
    r.runs.push({ employeeId, script });
    const bash = which("bash");
    const out = spawnSync(bash, ["-s"], {
      input: script,
      encoding: "utf8",
      env: { PATH: path, HOME: tmpdir() },
    });
    return { code: out.status ?? 1, output: `${out.stdout}${out.stderr}` };
  };
  r.commit("handbook", { "facts/gh.md": page("GitHub CLI", "gh", "Use gh.") });
  return r;
}

describe("a sandbox missing something a copy needs", () => {
  for (const [name, o, saying] of [
    ["comm", { without: ["comm"] }, "the sandbox has no comm"],
    ["git", { without: ["git"] }, "the sandbox has no git"],
    ["tar", { without: ["tar"] }, "the sandbox has no tar"],
    ["base64", { without: ["base64"] }, "the sandbox has no base64"],
    [
      "a tar without the options (not GNU)",
      { fake: { tar: 'case "$*" in *--no-same-owner*) exit 2;; esac; exec ' + which("tar") + ' "$@"' } },
      "GNU tar is needed",
    ],
    [
      "a git before 2.28",
      { fake: { git: 'case "$*" in "init -q -b main "*) exit 129;; esac; exec ' + which("git") + ' "$@"' } },
      "older than 2.28",
    ],
  ] as const) {
    it(`copies nothing and says why when it has no ${name}`, async () => {
      const r = await rigWithPath(pathWith(o));
      const report = await r.feed.sync("ada");
      expect(report).toMatchObject({ ok: false, how: "failed" });
      expect(report.detail).toContain(saying);
      expect(r.logs.join("\n")).toContain(`couldn't copy ada's brain into inc-engineering: `);
      expect(existsSync(r.copy("ada", "company"))).toBe(false);
      // The session still gets its prompt, which says the copy isn't there.
      const ctx = await r.feed.forTicket({
        employeeId: "ada",
        sessionId: null,
        query: { title: "gh", project: "Duet", doneWhen: [] },
      });
      expect(ctx.copy).toBe(false);
      expect(ctx.text).toContain("not available this time");
      expect(ctx.text).toContain('slug="facts/gh"');
    });
  }

  it("copies the files but says search won't work when Node can't do SQLite FTS5", async () => {
    const r = await rigWithPath(pathWith({ fake: { node: "exit 1" } }));
    const report = await r.feed.sync("ada");
    expect(report).toMatchObject({ ok: true, how: "full", search: false });
    expect(existsSync(r.copy("ada", "company/facts/gh.md"))).toBe(true);
    expect(r.logs.join("\n")).toContain("no usable Node with SQLite FTS5");
    const ctx = await r.feed.forTicket({
      employeeId: "ada",
      sessionId: null,
      query: { title: "gh", project: "Duet", doneWhen: [] },
    });
    expect(ctx.text).toContain("`brain search` doesn't work in this machine");
    expect(ctx.text).not.toContain("Search it with");
  });

  it("is happy with the tools it was told it needs", async () => {
    const r = await rigWithPath(pathWith({}));
    expect(await r.feed.sync("ada")).toMatchObject({ ok: true, how: "full", search: true });
  });
});

describe("applying a copy while the agent works", () => {
  it("keeps an edit the agent makes after the first look, and replaces nothing it changed", async () => {
    const r = await brainRig();
    r.commit("handbook", {
      "facts/gh.md": page("GitHub CLI", "gh", "Use gh."),
      "facts/other.md": page("Other", "o", "Other."),
    });
    await r.feed.sync("ada");
    const file = r.copy("ada", "company/facts/gh.md");
    // A `cp` into the staging folder that, once done, plays the agent saving its edit of gh.md.
    const real = which("cp");
    const bin = pathWith({
      fake: { cp: `${real} "$@"; case "$*" in *.inc-stage*) echo "agent edit" > '${file}';; esac` },
    });
    r.feed.deliver = async (employeeId, script) => {
      r.runs.push({ employeeId, script });
      const out = spawnSync(which("bash"), ["-s"], {
        input: script,
        encoding: "utf8",
        env: { PATH: bin, HOME: tmpdir() },
      });
      return { code: out.status ?? 1, output: `${out.stdout}${out.stderr}` };
    };
    r.commit("handbook", {
      "facts/gh.md": page("GitHub CLI", "gh", "Upstream v2."),
      "facts/other.md": page("Other", "o", "Other v2."),
    });
    const report = await r.feed.sync("ada");
    expect(report).toMatchObject({ ok: true, how: "delta", kept: ["company/facts/gh.md"] });
    expect(execFileSync("cat", [file], { encoding: "utf8" })).toBe("agent edit\n");
    expect(execFileSync("cat", [r.copy("ada", "company/facts/other.md")], { encoding: "utf8" })).toContain(
      "Other v2.",
    );
    expect(existsSync(r.copy("ada", ".inc-stage"))).toBe(false);
    expect(execFileSync("git", ["-C", r.copy("ada"), "status", "--short"], { encoding: "utf8" })).toBe(
      " M company/facts/gh.md\n",
    );
  });
});

describe("the index's look at HEAD", () => {
  it("reads HEAD from the repo's files, loose or packed, and says nothing for an unborn repo", () => {
    const root = mkdtempSync(join(tmpdir(), "i-inc-head-"));
    try {
      const store = new KnowledgeStore(root);
      const repo = { kind: "handbook" } as const;
      expect(store.headSha(repo)).toBeNull();
      store.ensureHandbook();
      const real = execFileSync("git", ["-C", join(root, "handbook"), "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      expect(store.headSha(repo)).toBe(real);
      execFileSync("git", ["-C", join(root, "handbook"), "pack-refs", "--all"]);
      expect(existsSync(join(root, "handbook/.git/refs/heads/main"))).toBe(false);
      expect(store.headSha(repo)).toBe(real);
      mkdirSync(join(root, "brains/zed"), { recursive: true });
      execFileSync("git", ["-C", join(root, "brains/zed"), "init", "-q", "-b", "main"]);
      expect(store.headSha({ kind: "brain", id: "zed" })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sees every outside commit at once, however close together, with no clock involved", async () => {
    const r = await brainRig();
    const dir = join(r.knowledgeDir, "handbook");
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], {
        cwd: dir,
        stdio: "pipe",
      });
    const realNow = Date.now;
    try {
      for (let i = 0; i < 3; i++) {
        // the system clock goes backwards between looks
        Date.now = () => realNow() - i * 3_600_000;
        mkdirSync(join(dir, "facts"), { recursive: true });
        writeFileSync(join(dir, "facts", `o${i}.md`), page(`O${i}`, `outside ${i}`, `zebra${i}`));
        git("add", "-A");
        git("commit", "-q", "-m", `outside ${i}`);
        expect(r.app.deps.brain.refresh()).toBe(1);
        expect(r.app.deps.brain.pages(["company"]).map((p) => p.slug)).toContain(`facts/o${i}`);
      }
    } finally {
      Date.now = realNow;
    }
  });
});

describe("the removal script's guard", () => {
  it("removes exactly <base>/<copy>, for a production base and a Linux-style temp base", async () => {
    const { removeScript } = await import("../src/brain-snapshot.ts");
    expect(removeScript("/home/employee/brain", "pip")).toBe(
      "rm -rf -- '/home/employee/brain/pip' && echo @@removed\n",
    );
    expect(removeScript("/home/employee/brain", "pip.code")).toContain("'/home/employee/brain/pip.code'");
    expect(removeScript("/tmp/i-inc-sbx-abc123", "ada")).toContain("'/tmp/i-inc-sbx-abc123/ada'");
    expect(removeScript("/var/folders/gd/T/sbx/", "kit")).toContain("'/var/folders/gd/T/sbx/kit'");
  });

  it("refuses an empty, dotted, slashed or odd copy name, so the base itself can never be removed", async () => {
    const { removeScript } = await import("../src/brain-snapshot.ts");
    for (const copy of [
      "",
      ".",
      "..",
      "a/b",
      "../x",
      "/",
      "/x",
      "x/",
      ".code",
      "pip.code.code",
      "-x",
      "A",
      "a b",
      "a'b",
      "a;b",
      "x".repeat(70),
    ]) {
      expect(() => removeScript("/home/employee/brain", copy), JSON.stringify(copy)).toThrow(
        /not a copy name/,
      );
    }
    for (const base of ["", "/", "relative/brain", "/home/employee/../x", "/a b", "/x'y"]) {
      expect(() => removeScript(base, "pip"), JSON.stringify(base)).toThrow(/not a brain folder/);
    }
  });

  it("is what the feed sends: a copy removed from the configured base", async () => {
    const r = await brainRig();
    r.commit("ada", { "tools/x.md": page("X", "x", "x") });
    await r.feed.sync("ada");
    await r.feed.removeCopy("ada", "inc-engineering");
    expect(existsSync(r.copy("ada"))).toBe(false);
    expect(existsSync(r.sandbox)).toBe(true);
    // A bad copy name never reaches a machine.
    const runs = r.runs.length;
    expect(await r.feed.removeCopy("", "inc-engineering")).toBe(false);
    expect(await r.feed.removeCopy("../x", "inc-engineering")).toBe(false);
    expect(r.runs.length).toBe(runs);
    expect(existsSync(r.sandbox)).toBe(true);
  });
});
