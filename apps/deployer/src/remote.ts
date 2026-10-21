// The tip of origin's main, read with `git ls-remote` from the owner's checkout (which is only read).
import type { Shell } from "./shell.ts";
import type { Remote } from "./types.ts";

export class GitRemote implements Remote {
  constructor(
    private readonly checkout: string,
    private readonly shell: Shell,
    private readonly branch = "main",
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
}
