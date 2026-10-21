// The real release folders, against a real git repository in a temp directory (no network, no pnpm).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsReleases } from "../src/releases.ts";
import { GitRemote } from "../src/remote.ts";
import { run } from "../src/shell.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

let dir: string;
let origin: string;
let checkout: string;
let root: string;
let first: string;
let second: string;

const makeReleases = (steps?: Array<{ cmd: string; args: string[]; timeoutMs: number }>) =>
  new FsReleases({
    root,
    checkout,
    originUrl: () => new GitRemote(checkout, run).originUrl(),
    shell: run,
    steps: steps ?? [
      {
        cmd: "sh",
        args: ["-c", "mkdir -p apps/web/dist && echo '<html></html>' > apps/web/dist/index.html"],
        timeoutMs: 20_000,
      },
    ],
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-deployer-rel-"));
  origin = join(dir, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "a.txt"), "one");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "one");
  first = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "a.txt"), "two");
  git(origin, "commit", "-q", "-am", "two");
  second = git(origin, "rev-parse", "HEAD");
  checkout = join(dir, "checkout");
  git(dir, "clone", "-q", origin, checkout);
  root = join(dir, "releases");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("release folders", () => {
  it("clones, checks out the sha, builds, and lists only finished releases", async () => {
    const r = makeReleases();
    await r.build(first);
    expect(readFileSync(join(root, first, "a.txt"), "utf8")).toBe("one");
    expect(git(join(root, first), "rev-parse", "HEAD")).toBe(first);
    expect(existsSync(join(root, first, "apps/web/dist/index.html"))).toBe(true);
    expect(await r.has(first)).toBe(true);
    expect((await r.list()).map((x) => x.sha)).toEqual([first]);
    // The owner's checkout was only read from: no worktree, no new refs, nothing dirty.
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(existsSync(join(checkout, ".git/worktrees"))).toBe(false);
  });

  it("a failed build leaves nothing listed, and a retry starts clean", async () => {
    const bad = makeReleases([{ cmd: "sh", args: ["-c", "echo boom >&2; exit 3"], timeoutMs: 20_000 }]);
    await expect(bad.build(second)).rejects.toThrow(/exit 3.*boom/);
    expect(await bad.has(second)).toBe(false);
    expect(await bad.list()).toEqual([]);
    expect(await bad.sweep([])).toEqual([second]);
    expect(existsSync(join(root, second))).toBe(false);
    await makeReleases().build(second);
    expect(await bad.has(second)).toBe(true);
  });

  it("fails when the build produces no web app", async () => {
    const r = makeReleases([{ cmd: "true", args: [], timeoutMs: 5000 }]);
    await expect(r.build(first)).rejects.toThrow(/apps\/web\/dist\/index.html/);
  });

  it("fails on a sha origin does not have", async () => {
    await expect(makeReleases().build("f".repeat(40))).rejects.toThrow(/checkout/);
  });

  it("times out a build step", async () => {
    const slow = makeReleases([{ cmd: "sleep", args: ["5"], timeoutMs: 200 }]);
    await expect(slow.build(first)).rejects.toThrow(/timed out/);
  });

  it("repoints current atomically and reads it back", async () => {
    const r = makeReleases();
    expect(await r.current()).toBeNull();
    await r.build(first);
    await r.build(second);
    await r.point(first);
    expect(await r.current()).toBe(first);
    expect(lstatSync(join(root, "current")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "current"))).toBe(join(root, first));
    await r.point(second);
    expect(await r.current()).toBe(second);
    expect(readFileSync(join(root, "current", "a.txt"), "utf8")).toBe("two");
    // No temporary links are left behind.
    expect(existsSync(join(root, `.current.${process.pid}.tmp`))).toBe(false);
  });

  it("refuses to point at a release that is not there, and to remove the current one", async () => {
    const r = makeReleases();
    await expect(r.point(first)).rejects.toThrow(/no release/);
    await r.build(first);
    await r.point(first);
    await expect(r.remove(first)).rejects.toThrow(/current/);
    await r.build(second);
    await r.remove(second);
    expect(await r.has(second)).toBe(false);
  });

  it("seeds from the owner's checkout, which may have commits origin lacks", async () => {
    writeFileSync(join(checkout, "local.txt"), "x");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "local only");
    const local = git(checkout, "rev-parse", "HEAD");
    const r = makeReleases();
    await r.build(local, checkout);
    expect(git(join(root, local), "rev-parse", "HEAD")).toBe(local);
  });

  it("remote: reads the tip of main and the origin url", async () => {
    const remote = new GitRemote(checkout, run);
    expect(await remote.head()).toBe(second);
    expect(await remote.originUrl()).toBe(origin);
    await expect(new GitRemote(checkout, run, "nope").head()).rejects.toThrow(/no sha/);
  });
});
