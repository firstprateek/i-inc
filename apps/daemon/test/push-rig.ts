// A local stand-in for GitHub and for a sandbox, for the host's push (T68): a bare repo is "GitHub", a clone
// is the sandbox's working copy, and bundling runs the real script in real bash.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleScript, newNonce, readBundle } from "../src/bundle.ts";
import { type GitRun, gitDefault, HostPusher } from "../src/host-push.ts";
import { fakeTokens } from "./fake-tokens.ts";

export interface GitCall {
  args: string[];
  env: Record<string, string>;
}

export function pushRig(o: { files?: Record<string, string>; ledger?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "inc-push-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  for (const [p, text] of Object.entries({ "README.md": "hello\n", ...o.files })) {
    mkdirSync(dirname(join(seed, p)), { recursive: true });
    writeFileSync(join(seed, p), text);
  }
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=o", "-c", "user.email=o@example.invalid", "commit", "-q", "-m", "base");
  git(root, "clone", "-q", "--bare", seed, origin);
  // The sandbox's working copy, at a path the bundle script accepts once /home/employee/work is swapped.
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const wt = join(work, "inc-1");
  git(root, "clone", "-q", origin, wt);
  git(wt, "config", "user.name", "Ada");
  git(wt, "config", "user.email", "ada@example.invalid");

  const tokens = fakeTokens();
  const gitCalls: GitCall[] = [];
  const watched: GitRun = (args, opts) => {
    gitCalls.push({ args, env: opts.env });
    return gitDefault(args, opts);
  };
  const ledger = o.ledger === false ? undefined : join(root, "ledger", "pushed-main.jsonl");
  const mirrors = join(root, "mirrors");
  const host = new HostPusher({
    tokens,
    mirrors,
    ...(ledger ? { ledger } : {}),
    remote: () => origin,
    git: watched,
    now: () => 1_700_000_000_000,
  });

  const local = (script: string) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn("bash", ["-s"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      child.on("exit", (code) => resolve({ code: code ?? 1, output }));
      child.stdin.end(script);
    });

  /** The bundle the sandbox's script gives for `sha`, run in real bash. */
  async function bundle(sha: string, bases: string[] = ["refs/remotes/origin/main"]): Promise<Buffer> {
    const nonce = newNonce();
    const script = bundleScript({ worktree: "/home/employee/work/inc-1", sha, bases, nonce });
    const r = await local(script.replaceAll("/home/employee/work", work));
    return readBundle(r, nonce, sha);
  }

  function commit(file: string, text: string, message = `edit ${file}`): string {
    mkdirSync(dirname(join(wt, file)), { recursive: true });
    writeFileSync(join(wt, file), text);
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", message);
    return git(wt, "rev-parse", "HEAD");
  }

  return {
    root,
    work,
    wt,
    origin,
    mirrors,
    ledger,
    host,
    tokens,
    gitCalls,
    git,
    local,
    bundle,
    commit,
    originGit: (...args: string[]) =>
      execFileSync("git", ["--git-dir", origin, ...args], { env, encoding: "utf8" }).trim(),
    ledgerLines: () =>
      ledger && existsSync(ledger)
        ? readFileSync(ledger, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
  };
}

export type PushRig = ReturnType<typeof pushRig>;
