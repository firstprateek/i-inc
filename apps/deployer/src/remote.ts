// The tip of origin's main, read with `git ls-remote` from the owner's checkout (which is only read).
import { type FullShell, runFull, type Shell } from "./shell.ts";
import type { Remote } from "./types.ts";

export class GitRemote implements Remote {
  constructor(
    private readonly checkout: string,
    private readonly shell: Shell,
    private readonly branch = "main",
    /** Where the running release lives: its own clone is where history is compared. */
    private readonly releaseDir: (sha: string) => string = () => checkout,
    /** Reads a command's stdout whole (a list of commits or files), apart from its stderr. */
    private readonly full: FullShell = runFull,
  ) {}

  async head(): Promise<string> {
    const r = await this.shell("git", ["ls-remote", "origin", `refs/heads/${this.branch}`], {
      cwd: this.checkout,
      timeoutMs: 60_000,
    });
    if (r.code !== 0) throw new Error(`git ls-remote failed (exit ${r.code}): ${r.output.trim()}`);
    const sha = r.output.trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new Error(`git ls-remote gave no sha for ${this.branch}: ${r.output.trim()}`);
    return sha;
  }

  /** The URL of `origin`, which releases are cloned from. */
  async originUrl(): Promise<string> {
    const r = await this.shell("git", ["remote", "get-url", "origin"], {
      cwd: this.checkout,
      timeoutMs: 15_000,
    });
    if (r.code !== 0) throw new Error(`git remote get-url origin failed: ${r.output.trim()}`);
    return r.output.trim();
  }

  /**
   * Whether `descendant` includes `ancestor`, asked in the ancestor's own release folder (the owner's
   * checkout is never fetched into). Null if the history could not be fetched or compared.
   */
  async descends(ancestor: string, descendant: string): Promise<boolean | null> {
    const cwd = this.releaseDir(ancestor);
    const has = async () =>
      (await this.shell("git", ["cat-file", "-e", `${descendant}^{commit}`], { cwd, timeoutMs: 15_000 }))
        .code === 0;
    if (!(await has())) {
      await this.shell("git", ["fetch", "--quiet", "origin", `refs/heads/${this.branch}`], {
        cwd,
        timeoutMs: 120_000,
      });
      if (!(await has())) {
        await this.shell("git", ["fetch", "--quiet", "origin", descendant], { cwd, timeoutMs: 120_000 });
        if (!(await has())) return null;
      }
    }
    const r = await this.shell("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      timeoutMs: 30_000,
    });
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    return null;
  }

  async range(
    ancestor: string,
    descendant: string,
    max: number,
  ): Promise<{ shas: string[]; truncated: boolean } | null> {
    if (!/^[0-9a-f]{40}$/.test(ancestor) || !/^[0-9a-f]{40}$/.test(descendant)) return null;
    const r = await this.full("git", ["rev-list", `--max-count=${max + 1}`, `${ancestor}..${descendant}`], {
      cwd: this.releaseDir(ancestor),
      timeoutMs: 30_000,
    });
    if (r.code !== 0 || r.truncated) return null;
    const shas = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f]{40}$/.test(l));
    return { shas: shas.slice(0, max), truncated: shas.length > max };
  }

  /**
   * Every path the commit changes (against each parent, for a merge; renames count as both paths), or null when it
   * cannot be told. Read in the running release's clone, which has fetched the candidate and its history.
   */
  async changedFiles(sha: string, current: string): Promise<string[] | null> {
    if (!/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{40}$/.test(current)) return null;
    const r = await this.full(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", "--no-renames", "-z", sha],
      { cwd: this.releaseDir(current), timeoutMs: 30_000 },
    );
    if (r.code !== 0 || r.truncated) return null;
    return [...new Set(r.stdout.split("\0").filter((f) => f !== ""))];
  }
}
