// Every push to GitHub is made here, on the host (T68). A sandbox's agent can be prompt-injected and runs
// with bypassed permissions, so no credential that can write ever enters a sandbox. A sandbox hands the
// daemon a git bundle of exactly the commit the pipeline checked (bundle.ts); this module
//   1. keeps a bare mirror of the repo on the host (<mirrors>/<owner>/<repo>.git), fresh from GitHub;
//   2. verifies the bundle (`git bundle verify`, one head, its tip is the sha the caller expects, objects
//      checked as they come in) and unpacks it into the mirror;
//   3. scans what the push would publish for credentials: the same patterns and the same sentences as
//      shipping a conversation (ship-git.ts), on the host's own copy of the commits, never the sandbox's say-so;
//   4. pushes that sha with a write token held only in this process's memory: an `http.extraheader` in the
//      environment of that one git child, with an empty HOME, no system or global config and no hooks;
//   5. for the deployer's default branch, writes every commit it put there to a host ledger
//      (~/.i-inc/pushed-main.jsonl) *before* pushing, which the deployer checks (apps/deployer/src/review.ts).
// Anything it can't read or check is a refusal, never a push.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactTokens } from "./ahp/sanitize.ts";
import { MAX_BUNDLE_BYTES } from "./bundle.ts";
import { isValidRepo, type TokenSource } from "./github.ts";
import { isHostExecuted, isProtected } from "./paths.ts";
import {
  blockers,
  MAX_COMMITS,
  marker,
  SCAN_LIMIT,
  scanHistory,
  secretFile,
  secretsSentence,
} from "./ship-git.ts";
import { isSafeRefName } from "./workspace.ts";

export type PushFailure =
  | "bundle" // not a valid bundle, or not the commit expected
  | "prerequisites" // the bundle builds on commits the mirror lacks: ask for a full one
  | "too-big"
  | "secrets"
  | "behind" // GitHub's branch moved: not a fast-forward (or the lease is stale)
  | "workflow" // GitHub refuses the bot any change to workflows
  | "refused" // a rule of ours (a force push to the default branch)
  | "protected" // the push changes a protected path
  | "git";

export class HostPushError extends Error {
  constructor(
    message: string,
    readonly kind: PushFailure,
    /** For "secrets" and "protected": the files and commits it is about (names, never values). */
    readonly findings: string[] = [],
    /** For "protected": the change the owner is asked to approve. */
    readonly approval?: ApprovalCard,
  ) {
    super(message);
  }
}

/** What an owner's OK on a protected change is for, worked out on the host from the verified bundle. */
export interface ApprovalCard {
  /** The commit that would be pushed. */
  sha: string;
  /** A hash of the diff of the protected paths (git patch-id --stable of each, combined). */
  patchId: string;
  /** The diff of those paths, credentials redacted, cut at `DIFF_CAP`. */
  diff: string;
  diffTruncated: boolean;
}

/** The most of a protected diff kept for the card. */
export const DIFF_CAP = 100_000;
/** More protected files than this can't be bound to an OK one by one: the owner pushes it (push-for-owner.sh). */
const MAX_HELD_FILES = 200;

export interface PushRequest {
  /** "owner/name", from the project (never from the sandbox). */
  repo: string;
  /** The branch to push, from the ticket or conversation (never from the sandbox). */
  branch: string;
  /** The project's default branch: never force-pushed. */
  defaultBranch: string;
  /** The commit that was checked or scanned: the bundle's one tip must be this. */
  sha: string;
  bundle: Buffer;
  /**
   * Absent: the push must be a fast-forward, never forced. A commit sha (or "" for a branch GitHub doesn't
   * have): `--force-with-lease`, so the branch is replaced only if it is still there.
   */
  lease?: string;
  ticket?: string;
  /**
   * Paths the push must not change unless the owner approved: a project's protected paths, and, with
   * `hostExecuted`, every path the host could run (paths.ts: the repo the deployer deploys). The host reads the
   * change from the commits themselves, not from what the sandbox says.
   */
  protect?: { paths: string[]; hostExecuted?: boolean };
  /**
   * What the owner OKed on a card (T68): the commit and the hash of the diff of the protected paths. A protected
   * change goes only if the host, working it out from the bundle it verified, gets exactly this sha and this hash;
   * anything else (other content in the same paths, the same content in another commit) is refused with a new
   * card. Recorded in the ledger, which is what the deployer looks for.
   */
  approval?: { sha: string; patchId: string; paths: string[] };
  /** The owner said a finding of the credential scan is not a secret: push it anyway (recorded in the ledger). */
  overrideSecrets?: boolean;
  /** Only the direct-mode gates push to the default branch. Any other caller asking is refused. */
  allowDefaultBranch?: boolean;
}

export interface PushResult {
  sha: string;
  /** False when GitHub already had the commit on the branch. */
  pushed: boolean;
}

export interface HostPush {
  push(req: PushRequest): Promise<PushResult>;
  /**
   * Is `sha` on GitHub's `branch` now (an ancestor of the host's freshly fetched `origin/<branch>`)? Asked of the
   * host's own mirror, never of a machine. Null when GitHub could not be read.
   */
  landed(req: { repo: string; branch: string; sha: string }): Promise<boolean | null>;
  /** The commits GitHub has on these branches (a hint of what a bundle needn't repeat). Never throws. */
  tips(repo: string, branches: string[]): Promise<string[]>;
  /** Takes a commit back out of the branch with a new commit made here, and pushes it. */
  revert(req: {
    repo: string;
    branch: string;
    defaultBranch: string;
    sha: string;
    author: { name: string; email: string };
    ticket?: string;
  }): Promise<PushResult>;
}

/** Runs git; a test can watch every call (and the environment it got). */
export type GitRun = (
  args: string[],
  o: { env: Record<string, string>; cwd?: string; maxOutput?: number; timeoutMs?: number; input?: string },
) => Promise<{ code: number; stdout: string; stderr: string; truncated: boolean }>;

export const gitDefault: GitRun = (args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: o.env,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (o.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(o.input);
    }
    const max = o.maxOutput ?? 16_000_000;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? 5 * 60_000);
    child.stdout?.on("data", (c: Buffer) => {
      if (stdout.length >= max) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 64_000) stderr += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: truncated ? 1 : (code ?? 1), stdout, stderr, truncated });
    });
  });

export interface HostPushOptions {
  tokens: TokenSource;
  /** Where the bare mirrors live: `~/.i-inc/push-mirrors`. */
  mirrors: string;
  /** The ledger of what was pushed to a default branch: `~/.i-inc/pushed-main.jsonl`. Absent: none is kept. */
  ledger?: string;
  /** Where a repo is fetched from and pushed to; tests use a path. Default: github.com. */
  remote?: (repo: string) => string;
  git?: GitRun;
  now?: () => number;
  maxBundleBytes?: number;
  log?: (msg: string) => void;
}

const SAFE_REMOTE = /^(https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git|\/[A-Za-z0-9._/-]+)$/;
const SHA = /^[0-9a-f]{40}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** What a push's error text may not show: the token, in any form. */
function scrub(text: string, token: string): string {
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return text.replaceAll(token, "[token]").replaceAll(b64, "[token]");
}

export class HostPusher implements HostPush {
  private readonly git: GitRun;
  private readonly now: () => number;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly o: HostPushOptions) {
    this.git = o.git ?? gitDefault;
    this.now = o.now ?? Date.now;
  }

  /** One push at a time per repo. */
  private locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(repo) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chains.set(repo, tail);
    void tail.then(() => {
      if (this.chains.get(repo) === tail) this.chains.delete(repo);
    });
    return next;
  }

  private remoteOf(repo: string): string {
    const remote = this.o.remote?.(repo) ?? `https://github.com/${repo}.git`;
    if (!SAFE_REMOTE.test(remote)) throw new HostPushError(`not a remote: ${remote}`, "git");
    return remote;
  }

  /**
   * The environment of every git child: PATH and nothing of the daemon's own, an empty home, no system or global
   * config, no prompts. With `token`, the Authorization header for GitHub, for this one child, no credential helper.
   */
  private env(remote: string, token?: string): Record<string, string> {
    const home = join(this.o.mirrors, ".home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
      HOME: home,
      LC_ALL: "C",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(token
        ? {
            // Only GitHub's own protocol on the network (a bundle on disk is read with the plain environment).
            ...(remote.startsWith("https://") ? { GIT_ALLOW_PROTOCOL: "https" } : {}),
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            GIT_CONFIG_KEY_1: "credential.helper",
            GIT_CONFIG_VALUE_1: "",
          }
        : {}),
    };
  }

  private static readonly SAFE = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "gc.autoDetach=false",
    // Objects are checked as they come in, from GitHub and from a bundle alike.
    "-c",
    "transfer.fsckObjects=true",
    "-c",
    "fetch.fsckObjects=true",
    "-c",
    "push.followTags=false",
    "-c",
    "protocol.ext.allow=never",
  ];

  private async g(
    dir: string,
    args: string[],
    env: Record<string, string>,
    opts: { maxOutput?: number; timeoutMs?: number; input?: string } = {},
  ) {
    return this.git([...HostPusher.SAFE, ...args], { env, cwd: dir, ...opts });
  }

  /** The bare mirror of a repo, made if it isn't there. */
  private async mirror(repo: string, env: Record<string, string>): Promise<string> {
    if (!isValidRepo(repo)) throw new HostPushError(`not a repo: ${repo}`, "git");
    const [owner, name] = repo.split("/") as [string, string];
    const dir = join(this.o.mirrors, owner, `${name}.git`);
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    const head = await this.git([...HostPusher.SAFE, "--git-dir", dir, "rev-parse", "--git-dir"], { env });
    if (head.code !== 0) {
      const made = await this.git([...HostPusher.SAFE, "init", "--bare", "-q", "--template=", dir], { env });
      if (made.code !== 0) throw new HostPushError(`couldn't make the mirror: ${made.stderr.trim()}`, "git");
    }
    return dir;
  }

  /** Brings the mirror's view of GitHub's branches up to date (`refs/remotes/origin/*`). */
  private async refresh(dir: string, remote: string, env: Record<string, string>, token: string) {
    const r = await this.g(
      dir,
      [
        "--git-dir",
        dir,
        "fetch",
        "--quiet",
        "--no-tags",
        "--prune",
        "--force",
        remote,
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      env,
      { timeoutMs: 5 * 60_000 },
    );
    if (r.code !== 0) {
      throw new HostPushError(
        `couldn't read GitHub's branches: ${scrub(r.stderr, token).trim().slice(-300)}`,
        "git",
      );
    }
  }

  async landed(req: { repo: string; branch: string; sha: string }): Promise<boolean | null> {
    if (!isValidRepo(req.repo) || !isSafeRefName(req.branch) || !SHA.test(req.sha)) return null;
    try {
      return await this.locked(req.repo, async () => {
        const remote = this.remoteOf(req.repo);
        const token = await this.o.tokens.token(req.repo, "write");
        const env = this.env(remote, token);
        const plain = this.env(remote);
        const dir = await this.mirror(req.repo, plain);
        await this.refresh(dir, remote, env, token);
        // The mirror holds every commit GitHub's branches do: one it has never seen is not on GitHub.
        const known = await this.g(dir, ["--git-dir", dir, "cat-file", "-e", `${req.sha}^{commit}`], plain);
        if (known.code !== 0) return false;
        const r = await this.g(
          dir,
          ["--git-dir", dir, "merge-base", "--is-ancestor", req.sha, `refs/remotes/origin/${req.branch}`],
          plain,
        );
        // 0: it is on the branch; 1: it is not (or the mirror has never seen it); anything else: unknown.
        return r.code === 0 ? true : r.code === 1 ? false : null;
      });
    } catch (err) {
      this.o.log?.(
        `couldn't tell whether ${req.sha.slice(0, 7)} reached ${req.repo} ${req.branch}: ${String(err)}`,
      );
      return null;
    }
  }

  async tips(repo: string, branches: string[]): Promise<string[]> {
    try {
      return await this.locked(repo, async () => {
        const remote = this.remoteOf(repo);
        const token = await this.o.tokens.token(repo, "write");
        const env = this.env(remote, token);
        const dir = await this.mirror(repo, env);
        await this.refresh(dir, remote, env, token);
        const out: string[] = [];
        for (const b of branches) {
          if (!isSafeRefName(b)) continue;
          const r = await this.g(
            dir,
            ["--git-dir", dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}^{commit}`],
            env,
          );
          const sha = r.stdout.trim();
          if (r.code === 0 && SHA.test(sha) && !out.includes(sha)) out.push(sha);
        }
        return out;
      });
    } catch (err) {
      this.o.log?.(`couldn't read the tips of ${repo}: ${String(err)}`);
      return [];
    }
  }

  async push(req: PushRequest): Promise<PushResult> {
    if (!isValidRepo(req.repo)) throw new HostPushError(`not a repo: ${req.repo}`, "git");
    if (!isSafeRefName(req.branch) || !isSafeRefName(req.defaultBranch)) {
      throw new HostPushError(`not a branch name: ${req.branch}`, "git");
    }
    if (!SHA.test(req.sha)) throw new HostPushError(`not a commit: ${req.sha}`, "git");
    if (req.lease !== undefined && !/^(?:[0-9a-f]{40})?$/.test(req.lease)) {
      throw new HostPushError(`not a commit: ${req.lease}`, "git");
    }
    const max = this.o.maxBundleBytes ?? MAX_BUNDLE_BYTES;
    if (req.bundle.length === 0) throw new HostPushError("the bundle is empty", "bundle");
    if (req.bundle.length > max) throw new HostPushError("the bundle is too big", "too-big");
    // Only the direct-mode gates push to the default branch.
    if (req.branch === req.defaultBranch && req.allowDefaultBranch !== true) {
      throw new HostPushError(
        `${req.branch} is the default branch: only the direct-mode gates push to it`,
        "refused",
      );
    }
    // A force push to the default branch is never made, whoever asks.
    if (req.lease !== undefined && req.branch === req.defaultBranch) {
      throw new HostPushError(`${req.branch} is the default branch: it is never force-pushed`, "refused");
    }
    return this.locked(req.repo, () => this.pushLocked(req));
  }

  private async pushLocked(req: PushRequest): Promise<PushResult> {
    const remote = this.remoteOf(req.repo);
    const token = await this.o.tokens.token(req.repo, "write");
    const env = this.env(remote, token);
    const plain = this.env(remote);
    const dir = await this.mirror(req.repo, plain);
    await this.refresh(dir, remote, env, token);
    const file = join(dir, `incoming-${randomBytes(6).toString("hex")}.bundle`);
    const incoming = "refs/incoming/ship";
    const fail = (message: string, kind: PushFailure): never => {
      throw new HostPushError(message, kind);
    };
    try {
      writeFileSync(file, req.bundle, { mode: 0o600 });
      const verified = await this.g(dir, ["--git-dir", dir, "bundle", "verify", file], plain);
      if (verified.code !== 0) {
        const text = `${verified.stderr}\n${verified.stdout}`;
        if (/prerequisite|lacks these/i.test(text)) {
          fail("the bundle builds on commits the host doesn't have", "prerequisites");
        }
        fail("the bundle is not valid", "bundle");
      }
      const heads = await this.g(dir, ["--git-dir", dir, "bundle", "list-heads", file], plain);
      const lines = heads.stdout.split("\n").filter((l) => l.trim() !== "");
      const [headSha, headRef] = (lines[0] ?? "").split(" ");
      if (heads.code !== 0 || lines.length !== 1 || headRef !== "refs/heads/ship" || headSha !== req.sha) {
        fail("the bundle does not hold exactly the commit that was checked", "bundle");
      }
      const unpacked = await this.g(
        dir,
        ["--git-dir", dir, "fetch", "--quiet", "--no-tags", file, `+refs/heads/ship:${incoming}`],
        plain,
      );
      if (unpacked.code !== 0) fail("the bundle's objects are not valid", "bundle");
      const tip = await this.g(
        dir,
        ["--git-dir", dir, "rev-parse", "--verify", `${incoming}^{commit}`],
        plain,
      );
      if (tip.stdout.trim() !== req.sha)
        fail("the bundle does not hold exactly the commit that was checked", "bundle");

      const published = await this.publish(dir, req, remote, env, plain, token);
      return published;
    } finally {
      rmSync(file, { force: true });
      await this.g(dir, ["--git-dir", dir, "update-ref", "-d", incoming], plain).catch(() => {});
    }
  }

  /** Everything after the commit is in the mirror: the rules, the scan, the ledger, the push. */
  private async publish(
    dir: string,
    req: Pick<
      PushRequest,
      | "repo"
      | "branch"
      | "defaultBranch"
      | "sha"
      | "lease"
      | "ticket"
      | "protect"
      | "approval"
      | "overrideSecrets"
    > & { hostRevert?: string },
    remote: string,
    env: Record<string, string>,
    plain: Record<string, string>,
    token: string,
  ): Promise<PushResult> {
    const q = (args: string[], e = plain, opts: { maxOutput?: number } = {}) =>
      this.g(dir, ["--git-dir", dir, ...args], e, opts);
    const fail = (message: string, kind: PushFailure): never => {
      throw new HostPushError(message, kind);
    };
    const ref = `refs/remotes/origin/${req.branch}`;
    const tipRead = await q(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const remoteTip = tipRead.code === 0 ? tipRead.stdout.trim() : "";
    if (remoteTip === req.sha) return { sha: req.sha, pushed: false };
    if (req.lease === undefined) {
      if (remoteTip && (await q(["merge-base", "--is-ancestor", remoteTip, req.sha])).code !== 0) {
        fail(`GitHub's ${req.branch} has changes this commit doesn't: it is not a fast-forward`, "behind");
      }
    } else if (req.lease !== remoteTip) {
      fail(`GitHub's ${req.branch} is not where the checks found it`, "behind");
    }

    let approved: { patchId: string; paths: string[] } | undefined;
    if (req.protect) {
      const changed = await q([
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        remoteTip || EMPTY_TREE,
        req.sha,
      ]);
      if (changed.code !== 0) fail("couldn't read what the push changes", "git");
      const { paths, hostExecuted } = req.protect;
      const touched = changed.stdout
        .split("\0")
        .filter((f) => f !== "" && (isProtected(f, paths) || (hostExecuted === true && isHostExecuted(f))));
      if (touched.length) {
        // The owner's OK is for this commit and this diff of these paths, worked out here from the bundle that was
        // verified, never from anything the machine said.
        if (touched.length > MAX_HELD_FILES) {
          throw new HostPushError(
            `it changes ${touched.length} protected files, too many to show for an OK: the owner pushes this one (tools/host/push-for-owner.sh)`,
            "refused",
            touched.slice(0, 20),
          );
        }
        const held = await this.heldDiff(dir, remoteTip || EMPTY_TREE, req.sha, touched, plain);
        const a = req.approval;
        const covers =
          a !== undefined &&
          a.sha === req.sha &&
          a.patchId === held.patchId &&
          touched.every((f) => a.paths.includes(f));
        if (!covers) {
          throw new HostPushError(`it changes protected paths: ${touched.join(", ")}`, "protected", touched, {
            sha: req.sha,
            patchId: held.patchId,
            diff: held.diff,
            diffTruncated: held.truncated,
          });
        }
        approved = { patchId: held.patchId, paths: touched };
      }
    }

    // What a push would publish: every commit GitHub lacks, message and patch, and the names of the files.
    const count = Number(
      (await q(["rev-list", "--count", req.sha, "--not", "--remotes=origin"])).stdout.trim(),
    );
    if (!Number.isFinite(count)) fail("couldn't count the commits to push", "git");
    if (count > MAX_COMMITS) fail("too many commits to check for credentials", "too-big");
    const nonce = randomBytes(16).toString("hex");
    const log = await q(
      [
        "log",
        "-m",
        "-U0",
        "--no-color",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--text",
        `--max-count=${MAX_COMMITS + 1}`,
        `--format=${marker(nonce, "commit")} %H%n${marker(nonce, "msg-begin")}%n%B%n${marker(nonce, "msg-end")}`,
        req.sha,
        "--not",
        "--remotes=origin",
      ],
      plain,
      { maxOutput: SCAN_LIMIT + 1 },
    );
    if (log.code !== 0 && !log.truncated)
      fail("couldn't read the commits to check them for credentials", "git");
    const scanned = scanHistory(`@@total ${count}\n${log.stdout}`, nonce);
    const names = await q(
      [
        "log",
        "-m",
        "--name-only",
        "-z",
        "--no-renames",
        "--format=",
        "--diff-filter=ACMR",
        req.sha,
        "--not",
        "--remotes=origin",
      ],
      plain,
      { maxOutput: SCAN_LIMIT + 1 },
    );
    const report = {
      secrets: [
        ...scanned.secrets,
        ...names.stdout
          .split(/[\0\n]/)
          .filter((p) => p !== "" && secretFile.some((re) => re.test(p)))
          .map((path) => ({ path, kind: "a file that usually holds secrets" })),
      ],
      unscanned: [
        ...scanned.unscanned,
        ...(names.code !== 0 && !names.truncated ? ["the files of the push"] : []),
      ],
      unsafe: [],
      tooBig: scanned.tooBig || log.truncated || names.truncated,
    };
    let secretsOverridden = false;
    if (blockers(report).length) {
      // The owner can say a finding is not a secret; a change too big to read, or a file that could not be read,
      // is never waved through.
      if (req.overrideSecrets === true && !report.tooBig && report.unscanned.length === 0) {
        secretsOverridden = true;
      } else {
        throw new HostPushError(
          secretsSentence(report, "pushed"),
          report.tooBig ? "too-big" : "secrets",
          report.secrets.map((x) => x.path),
        );
      }
    }

    // The default branch: written down first, so a commit can't reach it unrecorded. Every commit this push puts
    // on the branch (not only those new to GitHub: one may be on another branch already).
    if (this.o.ledger && req.branch === req.defaultBranch) {
      const parents = await q(["rev-list", "--parents", req.sha, ...(remoteTip ? ["--not", ref] : [])]);
      const at = this.now();
      const isApproved = approved !== undefined || secretsOverridden;
      const entries = parents.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ...ps] = line.split(" ");
          return JSON.stringify({
            sha,
            repo: req.repo,
            branch: req.branch,
            ticket: req.ticket ?? null,
            at,
            parents: ps,
            tip: sha === req.sha,
            ...(isApproved
              ? {
                  ownerApproved: true,
                  approvedPaths: approved?.paths ?? [],
                  ...(approved ? { approvedSha: req.sha, approvedPatchId: approved.patchId } : {}),
                }
              : {}),
            ...(secretsOverridden ? { secretsOverridden: true } : {}),
            ...(req.hostRevert ? { hostRevert: req.hostRevert } : {}),
          });
        });
      if (entries.length) {
        mkdirSync(dirname(this.o.ledger), { recursive: true, mode: 0o700 });
        appendFileSync(this.o.ledger, `${entries.join("\n")}\n`, { mode: 0o600 });
      }
    }

    const pushed = await q(
      [
        "push",
        "--porcelain",
        ...(req.lease !== undefined ? [`--force-with-lease=refs/heads/${req.branch}:${req.lease}`] : []),
        remote,
        `${req.sha}:refs/heads/${req.branch}`,
      ],
      env,
    );
    if (pushed.code !== 0) {
      const text = scrub(`${pushed.stdout}\n${pushed.stderr}`, token);
      if (/\[rejected\]|fetch first|non-fast-forward|stale info|\(stale\)/i.test(text)) {
        fail(`GitHub's ${req.branch} moved while this was pushed`, "behind");
      }
      if (/workflow/i.test(text) && /refusing|permission|scope/i.test(text)) {
        fail("GitHub won't let the bot push changes to workflows", "workflow");
      }
      fail(
        `couldn't push to ${req.branch}: ${text.trim().split("\n").slice(-4).join(" ").slice(0, 300)}`,
        "git",
      );
    }
    await q(["update-ref", ref, req.sha]);
    this.o.log?.(
      `pushed ${req.sha.slice(0, 7)} to ${req.repo} ${req.branch}${req.ticket ? ` (ticket ${req.ticket})` : ""}`,
    );
    return { sha: req.sha, pushed: true };
  }

  /** Is this commit in the ledger as one this daemon pushed to the repo's branch (for this ticket, when given)? */
  private pushedByUs(repo: string, branch: string, sha: string, ticket?: string): boolean {
    if (!this.o.ledger || !existsSync(this.o.ledger)) return false;
    let text = "";
    try {
      text = readFileSync(this.o.ledger, "utf8");
    } catch {
      return false;
    }
    for (const line of text.split("\n")) {
      if (!line.includes(sha)) continue;
      try {
        const e = JSON.parse(line) as { sha?: unknown; repo?: unknown; branch?: unknown; ticket?: unknown };
        if (
          e.sha === sha &&
          typeof e.repo === "string" &&
          e.repo.toLowerCase() === repo.toLowerCase() &&
          e.branch === branch &&
          (ticket === undefined || e.ticket === ticket)
        ) {
          return true;
        }
      } catch {
        // a damaged line
      }
    }
    return false;
  }

  /**
   * The diff of the held files against what GitHub has, and a hash of it: `git patch-id --stable` of each file's
   * diff, combined in the files' order. The hash binds an OK to the content, not to the names.
   */
  private async heldDiff(
    dir: string,
    base: string,
    sha: string,
    files: string[],
    env: Record<string, string>,
  ): Promise<{ patchId: string; diff: string; truncated: boolean }> {
    const sorted = [...files].sort();
    const parts: string[] = [];
    let diff = "";
    for (const f of sorted) {
      const d = await this.g(
        dir,
        [
          "--git-dir",
          dir,
          "diff",
          "--no-color",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--text",
          base,
          sha,
          "--",
          f,
        ],
        env,
        { maxOutput: 4_000_000 },
      );
      if (d.code !== 0) throw new HostPushError(`couldn't read the diff of ${f}`, "git");
      const id = await this.g(dir, ["--git-dir", dir, "patch-id", "--stable"], env, { input: d.stdout });
      if (id.code !== 0) throw new HostPushError(`couldn't hash the diff of ${f}`, "git");
      parts.push(`${f}\0${id.stdout.trim().split(" ")[0] ?? ""}\0${d.truncated ? "cut" : ""}`);
      if (diff.length <= DIFF_CAP) diff += `${d.stdout}\n`;
    }
    const patchId = createHash("sha256").update(parts.join("\n")).digest("hex");
    const redacted = redactTokens(diff);
    return {
      patchId,
      diff: redacted.slice(0, DIFF_CAP),
      truncated: redacted.length > DIFF_CAP,
    };
  }

  async revert(req: {
    repo: string;
    branch: string;
    defaultBranch: string;
    sha: string;
    author: { name: string; email: string };
    ticket?: string;
  }): Promise<PushResult> {
    if (!isValidRepo(req.repo) || !isSafeRefName(req.branch) || !isSafeRefName(req.defaultBranch)) {
      throw new HostPushError("not a repo or branch", "git");
    }
    if (!SHA.test(req.sha)) throw new HostPushError(`not a commit: ${req.sha}`, "git");
    return this.locked(req.repo, async () => {
      const remote = this.remoteOf(req.repo);
      const token = await this.o.tokens.token(req.repo, "write");
      const env = this.env(remote, token);
      const plain = this.env(remote);
      const dir = await this.mirror(req.repo, plain);
      await this.refresh(dir, remote, env, token);
      // Only a commit this daemon pushed to the branch, for this ticket, and that is on GitHub's branch now. The sha
      // comes from the ticket's record, which a machine can influence, so it is not taken on its word.
      if (!this.pushedByUs(req.repo, req.branch, req.sha, req.ticket)) {
        throw new HostPushError(
          `${req.sha.slice(0, 7)} is not a commit this daemon pushed to ${req.branch} for this ticket: not reverted`,
          "refused",
        );
      }
      const onBranch = await this.g(
        dir,
        ["--git-dir", dir, "merge-base", "--is-ancestor", req.sha, `refs/remotes/origin/${req.branch}`],
        plain,
      );
      if (onBranch.code !== 0) {
        throw new HostPushError(`${req.sha.slice(0, 7)} is not on ${req.branch}: not reverted`, "refused");
      }
      const tmp = join(dir, `revert-${randomBytes(6).toString("hex")}`);
      const bare = (args: string[]) => this.g(dir, ["--git-dir", dir, ...args], plain);
      try {
        const added = await bare(["worktree", "add", "--detach", tmp, `refs/remotes/origin/${req.branch}`]);
        if (added.code !== 0) {
          throw new HostPushError(`couldn't check out ${req.branch}: ${added.stderr.trim()}`, "git");
        }
        const done = await this.g(
          tmp,
          [
            "-c",
            `user.name=${req.author.name}`,
            "-c",
            `user.email=${req.author.email}`,
            "-c",
            "commit.gpgsign=false",
            "revert",
            "--no-edit",
            req.sha,
          ],
          plain,
        );
        if (done.code !== 0) {
          throw new HostPushError(
            `couldn't revert ${req.sha.slice(0, 7)}: ${done.stderr.trim().slice(-200)}`,
            "git",
          );
        }
        const head = (await this.g(tmp, ["rev-parse", "HEAD"], plain)).stdout.trim();
        if (!SHA.test(head)) throw new HostPushError("couldn't read the revert commit", "git");
        return await this.publish(
          dir,
          {
            repo: req.repo,
            branch: req.branch,
            defaultBranch: req.defaultBranch,
            sha: head,
            hostRevert: req.sha,
            ...(req.ticket ? { ticket: req.ticket } : {}),
          },
          remote,
          env,
          plain,
          token,
        );
      } finally {
        await bare(["worktree", "remove", "--force", tmp]).catch(() => {});
        rmSync(tmp, { recursive: true, force: true });
        await bare(["worktree", "prune"]).catch(() => {});
      }
    });
  }
}
