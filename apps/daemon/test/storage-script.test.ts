// The sandbox cleanup script, run for real with bash over a temp folder standing in for
// /home/employee/work. Nothing here touches a machine, a real home folder or the container CLI.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupScript, readCleanup } from "../src/storage-script.ts";

let root: string;
let work: string;
let home: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
    {
      encoding: "utf8",
    },
  );

/** Runs the script the way a machine does: `bash -s`, script on stdin, in a home of its own. */
function run(script: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-s"], {
    input: script,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
  });
  return readCleanup(r.stdout + r.stderr);
}

const base = () => ({
  work,
  ids: [] as string[],
  dryRun: false,
  cacheCapKb: 1_000_000,
  docker: false,
  trim: false,
});

/** A repo with an origin, and a worktree for a ticket next to it, like workspace.ts makes. */
function ticketCopy(id: string, { unpushed = false, dirty = false } = {}) {
  const origin = join(root, "origin.git");
  const repo = join(work, "app");
  if (!existsSync(origin)) {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, repo], { stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "a");
    // Like a real project: build output and the images' folder are ignored, so they aren't "changes".
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.inc/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "push", "-q", "origin", "HEAD:main");
    git(repo, "fetch", "-q");
  }
  const path = join(work, `inc-${id}`);
  git(repo, "worktree", "add", "-q", "-b", `inc/${id}`, path, "origin/main");
  mkdirSync(join(path, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(path, "node_modules", "pkg", "big.bin"), "x".repeat(200_000));
  mkdirSync(join(path, ".inc", "attachments"), { recursive: true });
  writeFileSync(join(path, ".inc", "attachments", "1-shot.png"), "png");
  if (unpushed) {
    writeFileSync(join(path, "work.txt"), "work");
    git(path, "add", "work.txt");
    git(path, "commit", "-q", "-m", "work");
  }
  if (dirty) writeFileSync(join(path, "scratch.txt"), "not committed");
  return path;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "i-inc-storage-")));
  work = join(root, "work");
  home = join(root, "home");
  mkdirSync(work, { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cleanupScript", () => {
  it("removes a closed ticket's worktree, its images and its reviewer's leftovers, and nothing else", () => {
    const one = ticketCopy("1");
    const two = ticketCopy("2");
    const other = join(work, "inc-9");
    mkdirSync(other);
    writeFileSync(join(other, "keep.txt"), "another ticket, still open");
    mkdirSync(`${one}.pre-checkout`);
    writeFileSync(join(work, "notes.txt"), "not a ticket folder");

    const r = run(cleanupScript({ ...base(), ids: ["1", "2"] }));

    expect(r.done).toBe(true);
    expect(r.removed.map((x) => x.ticket).sort()).toEqual(["1", "1", "2"]);
    expect(r.freed.worktrees).toBeGreaterThan(400_000);
    expect(existsSync(one)).toBe(false);
    expect(existsSync(`${one}.pre-checkout`)).toBe(false);
    expect(existsSync(two)).toBe(false);
    expect(existsSync(join(other, "keep.txt"))).toBe(true);
    expect(existsSync(join(work, "notes.txt"))).toBe(true);
    expect(existsSync(join(work, "app", ".git"))).toBe(true);
    // git forgot the removed worktrees; the branches stay in the repo (and on GitHub).
    expect(git(join(work, "app"), "worktree", "list")).not.toContain("inc-1");
    expect(git(join(work, "app"), "branch", "--list", "inc/1")).toContain("inc/1");
  });

  it("only touches tickets it was given", () => {
    const one = ticketCopy("1");
    const two = ticketCopy("2");
    run(cleanupScript({ ...base(), ids: ["1"] }));
    expect(existsSync(one)).toBe(false);
    expect(existsSync(two)).toBe(true);
  });

  it("keeps a copy with unpushed commits or uncommitted changes, unless forced", () => {
    const ahead = ticketCopy("1", { unpushed: true });
    const dirty = ticketCopy("2", { dirty: true });
    const r = run(cleanupScript({ ...base(), ids: ["1", "2"] }));
    expect(r.kept).toEqual([
      { ticket: "1", reason: "unpushed" },
      { ticket: "2", reason: "uncommitted" },
    ]);
    expect(existsSync(ahead)).toBe(true);
    expect(existsSync(dirty)).toBe(true);

    const forced = run(cleanupScript({ ...base(), ids: ["1", "2"], aged: ["1"] }));
    expect(forced.removed.map((x) => x.ticket)).toEqual(["1"]);
    expect(existsSync(ahead)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
  });

  it("refuses a symlink, and never follows it out of the work folder", () => {
    const outside = join(root, "precious");
    mkdirSync(outside);
    writeFileSync(join(outside, "file.txt"), "owner data");
    symlinkSync(outside, join(work, "inc-5"));
    symlinkSync(outside, join(work, "inc-6.pre-checkout"));

    const r = run(cleanupScript({ ...base(), ids: ["5", "6"] }));

    expect(r.refused).toEqual([
      { ticket: "5", reason: "symlink" },
      { ticket: "6", reason: "symlink" },
    ]);
    expect(r.removed).toEqual([]);
    expect(readFileSync(join(outside, "file.txt"), "utf8")).toBe("owner data");
    expect(existsSync(join(outside, "file.txt"))).toBe(true);
  });

  it("refuses when the work folder itself is a symlink", () => {
    const real = join(root, "elsewhere");
    mkdirSync(join(real, "inc-1"), { recursive: true });
    writeFileSync(join(real, "inc-1", "keep.txt"), "x");
    const linked = join(root, "linked-work");
    symlinkSync(real, linked);

    const r = run(cleanupScript({ ...base(), work: linked, ids: ["1"] }));

    expect(r.done).toBe(true);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(real, "inc-1", "keep.txt"))).toBe(true);
  });

  it("rejects ids and folders that could carry shell or climb out", () => {
    for (const id of ["1; rm -rf /", "../x", "a b", "", "$(id)", "x/y"]) {
      expect(() => cleanupScript({ ...base(), ids: [id] })).toThrow("not a ticket id");
      expect(() => cleanupScript({ ...base(), ids: ["1"], aged: [id] })).toThrow("not a ticket id");
      expect(() => cleanupScript({ ...base(), ids: ["1"], merged: [id] })).toThrow("not a ticket id");
    }
    for (const w of ["work", "/home/e/../etc", "/home/e work", "/home/e/work/", "/x;y", "/$(id)"]) {
      expect(() => cleanupScript({ ...base(), work: w })).toThrow("not a work folder");
    }
  });

  it("changes nothing in a dry run, and says what it would do", () => {
    const one = ticketCopy("1");
    mkdirSync(join(home, ".cache", "pip"), { recursive: true });
    writeFileSync(join(home, ".cache", "pip", "wheel"), "x".repeat(50_000));
    const r = run(cleanupScript({ ...base(), ids: ["1"], dryRun: true, cacheCapKb: 1 }));
    expect(r.removed.map((x) => x.ticket)).toEqual(["1"]);
    expect(r.freed["cache:pip"]).toBeGreaterThan(0);
    expect(existsSync(one)).toBe(true);
    expect(existsSync(join(home, ".cache", "pip", "wheel"))).toBe(true);
  });

  it("empties only the rebuildable cache folders, and only while ~/.cache is over the cap", () => {
    const cache = join(home, ".cache");
    for (const name of ["pip", "go-build", "ms-playwright", "mine"]) {
      mkdirSync(join(cache, name), { recursive: true });
      writeFileSync(join(cache, name, "blob"), "x".repeat(300_000));
    }
    // Under the cap: nothing goes.
    run(cleanupScript({ ...base(), cacheCapKb: 10_000_000 }));
    expect(existsSync(join(cache, "pip", "blob"))).toBe(true);

    // Over it: the rebuildable ones go, in order, and the rest stays.
    const r = run(cleanupScript({ ...base(), cacheCapKb: 500 }));
    expect(existsSync(join(cache, "pip"))).toBe(false);
    expect(existsSync(join(cache, "go-build"))).toBe(false);
    expect(existsSync(join(cache, "ms-playwright", "blob"))).toBe(true);
    expect(existsSync(join(cache, "mine", "blob"))).toBe(true);
    expect(r.freed["cache:pip"]).toBeGreaterThan(0);
    // Still over the cap, and it says so, for the owner.
    expect(r.cacheOver).toBeGreaterThan(500 * 1024);
  });

  it("stops removing caches as soon as ~/.cache is under the cap", () => {
    const cache = join(home, ".cache");
    for (const name of ["pip", "go-build"]) {
      mkdirSync(join(cache, name), { recursive: true });
      writeFileSync(join(cache, name, "blob"), "x".repeat(400_000));
    }
    run(cleanupScript({ ...base(), cacheCapKb: 500 }));
    expect(existsSync(join(cache, "pip"))).toBe(false);
    expect(existsSync(join(cache, "go-build", "blob"))).toBe(true);
  });

  it("empties npm's cache over the cap, and leaves a symlinked ~/.npm alone", () => {
    mkdirSync(join(home, ".npm", "_cacache"), { recursive: true });
    writeFileSync(join(home, ".npm", "_cacache", "blob"), "x".repeat(300_000));
    run(cleanupScript({ ...base(), cacheCapKb: 100 }));
    expect(existsSync(join(home, ".npm", "_cacache"))).toBe(false);

    const real = join(root, "real-npm");
    mkdirSync(join(real, "_cacache"), { recursive: true });
    writeFileSync(join(real, "_cacache", "blob"), "x".repeat(300_000));
    rmSync(join(home, ".npm"), { recursive: true, force: true });
    symlinkSync(real, join(home, ".npm"));
    run(cleanupScript({ ...base(), cacheCapKb: 100 }));
    expect(existsSync(join(real, "_cacache", "blob"))).toBe(true);
  });

  it("reports the disk before and after", () => {
    const r = run(cleanupScript({ ...base() }));
    expect(r.disk?.total).toBeGreaterThan(0);
    expect(r.diskAfter?.used).toBeGreaterThan(0);
    expect(r.done).toBe(true);
  });
});

/** A PATH with the tools the script needs and no git: symlinks to the real ones in a folder of its own. */
function pathWithoutGit(): string {
  const bin = join(root, "bin-nogit");
  mkdirSync(bin, { recursive: true });
  for (const tool of [
    "bash",
    "sh",
    "du",
    "cut",
    "awk",
    "df",
    "grep",
    "ls",
    "head",
    "rm",
    "chmod",
    "sed",
    "cat",
    "dirname",
  ]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
  return bin;
}

describe("a git failure always keeps the copy", () => {
  it("keeps a worktree whose .git is garbage", () => {
    const path = ticketCopy("1");
    writeFileSync(join(path, ".git"), "this is not a gitdir pointer\n");
    const r = run(cleanupScript({ ...base(), ids: ["1"] }));
    expect(r.kept).toEqual([{ ticket: "1", reason: "gitfail" }]);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(path, "a.txt"))).toBe(true);
  });

  it("keeps a worktree with a corrupt index and uncommitted edits, even for an aged or merged ticket", () => {
    const path = ticketCopy("1");
    writeFileSync(join(path, "a.txt"), "my only copy of an edit that was never committed");
    const index = execFileSync(
      "git",
      ["-C", path, "rev-parse", "--path-format=absolute", "--git-path", "index"],
      {
        encoding: "utf8",
      },
    ).trim();
    writeFileSync(index, "garbage, not an index");
    for (const lists of [{}, { aged: ["1"] }, { merged: ["1"] }, { aged: ["1"], merged: ["1"] }]) {
      const r = run(cleanupScript({ ...base(), ids: ["1"], ...lists }));
      expect(r.kept).toEqual([{ ticket: "1", reason: "gitfail" }]);
      expect(readFileSync(join(path, "a.txt"), "utf8")).toBe(
        "my only copy of an edit that was never committed",
      );
    }
  });

  it("keeps every checkout when git isn't on the PATH, and says why", () => {
    const one = ticketCopy("1");
    const two = ticketCopy("2", { unpushed: true });
    const r = run(cleanupScript({ ...base(), ids: ["1", "2"], aged: ["1", "2"], merged: ["1", "2"] }), {
      PATH: pathWithoutGit(),
    });
    expect(r.done).toBe(true);
    expect(r.kept).toEqual([
      { ticket: "1", reason: "nogit" },
      { ticket: "2", reason: "nogit" },
    ]);
    expect(existsSync(one)).toBe(true);
    expect(existsSync(two)).toBe(true);
  });

  it("keeps a copy when git status or rev-list fails with a non-zero exit", () => {
    const path = ticketCopy("1");
    // A git that works for rev-parse and fails for everything else.
    const bin = join(root, "bin-flaky");
    mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shim = join(bin, "git");
    writeFileSync(
      shim,
      `#!/bin/sh\ncase "$*" in *rev-parse*) exec ${real} "$@" ;; *) echo "boom" >&2; exit 128 ;; esac\n`,
    );
    chmodSync(shim, 0o755);
    const r = run(cleanupScript({ ...base(), ids: ["1"], aged: ["1"] }), {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    expect(r.kept).toEqual([{ ticket: "1", reason: "gitfail" }]);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a folder that has no .git but holds anything besides the images", () => {
    const keepers = join(work, "inc-3");
    mkdirSync(join(keepers, ".inc"), { recursive: true });
    writeFileSync(join(keepers, "notes.txt"), "someone's files");
    const images = join(work, "inc-4");
    mkdirSync(join(images, ".inc", "attachments"), { recursive: true });
    writeFileSync(join(images, ".inc", "attachments", "1-a.png"), "png");
    const r = run(cleanupScript({ ...base(), ids: ["3", "4"] }));
    expect(r.kept).toEqual([{ ticket: "3", reason: "notcheckout" }]);
    expect(r.removed.map((x) => x.ticket)).toEqual(["4"]);
    expect(existsSync(join(keepers, "notes.txt"))).toBe(true);
    expect(existsSync(images)).toBe(false);
  });
});

describe("the merged and aged lists", () => {
  it("never delete unpushed commits because the owner approved the ticket", () => {
    const path = ticketCopy("1", { unpushed: true });
    const r = run(cleanupScript({ ...base(), ids: ["1"], merged: ["1"] }));
    expect(r.kept).toEqual([{ ticket: "1", reason: "unpushed" }]);
    expect(existsSync(join(path, "work.txt"))).toBe(true);
    // Even with uncommitted files on top.
    writeFileSync(join(path, "scratch.txt"), "x");
    const again = run(cleanupScript({ ...base(), ids: ["1"], merged: ["1"] }));
    expect(again.kept).toEqual([{ ticket: "1", reason: "unpushed" }]);
  });

  it("let a merged ticket's uncommitted noise go only once a fresh fetch shows HEAD is on the remote", () => {
    const path = ticketCopy("1", { dirty: true });
    const r = run(cleanupScript({ ...base(), ids: ["1"], merged: ["1"] }));
    expect(r.removed.map((x) => x.ticket)).toEqual(["1"]);
    expect(existsSync(path)).toBe(false);
  });

  it("keep a merged ticket's copy when the fetch fails", () => {
    const path = ticketCopy("1", { dirty: true });
    rmSync(join(root, "origin.git"), { recursive: true, force: true });
    const r = run(cleanupScript({ ...base(), ids: ["1"], merged: ["1"] }));
    expect(r.kept).toEqual([{ ticket: "1", reason: "fetchfail" }]);
    expect(existsSync(path)).toBe(true);
  });

  it("keep a merged ticket's copy when the fetch works but HEAD is not on the remote", () => {
    // HEAD has a commit nobody pushed, and the tracking refs are stale, as if the push never happened.
    const path = ticketCopy("1", { dirty: true });
    writeFileSync(join(path, "extra.txt"), "x");
    git(path, "add", "extra.txt");
    git(path, "commit", "-q", "-m", "unpushed");
    const r = run(cleanupScript({ ...base(), ids: ["1"], merged: ["1"] }));
    expect(r.kept).toEqual([{ ticket: "1", reason: "unpushed" }]);
    expect(existsSync(path)).toBe(true);
  });

  it("remove an aged ticket's unpushed and uncommitted work, as the owner's setting says", () => {
    const path = ticketCopy("1", { unpushed: true, dirty: true });
    const r = run(cleanupScript({ ...base(), ids: ["1"], aged: ["1"] }));
    expect(r.removed.map((x) => x.ticket)).toEqual(["1"]);
    expect(existsSync(path)).toBe(false);
  });
});

describe("how the script reads its input", () => {
  it("gives every command /dev/null for stdin, so none can take the rest of the script", () => {
    ticketCopy("1");
    // A git that would eat whatever it is given on stdin, and report how much it got.
    const bin = join(root, "bin-greedy");
    mkdirSync(bin);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const shim = join(bin, "git");
    const seen = join(root, "stdin-bytes");
    writeFileSync(shim, `#!/bin/sh\ncat | wc -c >> ${seen}\nexec ${real} "$@"\n`);
    chmodSync(shim, 0o755);
    const script = `${cleanupScript({ ...base(), ids: ["1"] })}echo @@after-everything\n`;
    const r = spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
    });
    expect(readCleanup(r.stdout).done).toBe(true);
    expect(r.stdout).toContain("@@after-everything");
    expect(
      readFileSync(seen, "utf8")
        .split("\n")
        .filter(Boolean)
        .every((n) => Number(n) === 0),
    ).toBe(true);
  });

  it("does not name a folder when there are no tickets to clean", () => {
    const script = cleanupScript({ ...base(), ids: [] });
    expect(script).not.toContain("inc-none");
    expect(script).not.toContain("for id in");
    expect(run(script).done).toBe(true);
  });

  it("removes with rm's one-file-system flag where rm has it", () => {
    expect(cleanupScript({ ...base(), ids: ["1"] })).toContain("--one-file-system");
  });
});

describe("readCleanup", () => {
  it("ignores noise and reads each marker", () => {
    const r = readCleanup(
      [
        "some tool chatter",
        "@@df 20971520 8000000",
        "@@removed 7 2048",
        "@@kept 8 unpushed",
        "@@cache pip 1000",
        "@@pnpm-store 500",
        "@@docker 4096",
        "@@trimmed",
        "@@df-after 20971520 7000000",
        "@@done",
      ].join("\n"),
    );
    expect(r).toMatchObject({
      done: true,
      removed: [{ ticket: "7", bytes: 2048 * 1024 }],
      kept: [{ ticket: "8", reason: "unpushed" }],
      trimmed: true,
      disk: { total: 20971520 * 1024, used: 8000000 * 1024 },
    });
    expect(r.freed).toEqual({
      worktrees: 2048 * 1024,
      "cache:pip": 1000 * 1024,
      "pnpm-store": 500 * 1024,
      docker: 4096 * 1024,
    });
  });

  it("does not call a cut-off run done", () => {
    expect(readCleanup("@@df 1 1\n@@removed 1 5").done).toBe(false);
  });
});
