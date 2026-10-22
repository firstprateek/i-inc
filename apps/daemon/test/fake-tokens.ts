// A token source that tells a write token from a read-only one by its value, so a test can look through
// everything that went into a sandbox (an environment, a script, stdin, an argument) for the write token.
import type { TokenSource } from "../src/github.ts";

/** The write token the host holds. It must never appear in anything that goes into a sandbox. */
export const WRITE_TOKEN = "ghs_WRITETOKEN0123456789abcdefghijklmnopqr";
/** The read-only token sandboxes get. */
export const READ_TOKEN = "ghs_READTOKEN0123456789abcdefghijklmnopqrs";

export interface MintLog {
  kind: "write" | "read";
  repos: string[];
}

/** `minted` says what was asked for, in order. */
export function fakeTokens(): TokenSource & { minted: MintLog[] } {
  const minted: MintLog[] = [];
  return {
    minted,
    async token(repo, access = "write") {
      minted.push({ kind: access === "read" ? "read" : "write", repos: [repo] });
      return access === "read" ? READ_TOKEN : WRITE_TOKEN;
    },
    async readToken(repos) {
      if (repos.length === 0 || repos.includes("*")) throw new Error("a read token needs named repos");
      minted.push({ kind: "read", repos: [...repos] });
      return READ_TOKEN;
    },
  };
}

/** Everything one call put into a sandbox: its script, its stdin, its arguments and its environment. */
export interface SandboxCall {
  via: string;
  employeeId?: string;
  script?: string;
  env?: Record<string, string> | undefined;
  args?: string[];
}

/** The calls that carry the write token anywhere. Empty is the point. */
export function leaksOf(calls: SandboxCall[], secret = WRITE_TOKEN): string[] {
  return calls
    .filter((c) =>
      JSON.stringify({ script: c.script ?? "", env: c.env ?? {}, args: c.args ?? [] }).includes(secret),
    )
    .map((c) => c.via);
}
