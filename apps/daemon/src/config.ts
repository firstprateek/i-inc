// Real mode's configuration on the host, in ~/.config/i-inc and never in the repo:
//   credentials.json  optional: the environment an account's sessions get, such as
//                     {"claude": {"CLAUDE_CODE_OAUTH_TOKEN": "…"}}, from `claude setup-token`
//   github-app.json   the GitHub App's ids, with its key in github-app.pem (docs/github-app.md)
// Both secret files must be readable only by their owner. By default each machine signs in to its
// harnesses itself, once at hiring (tools/host/sign-in-claude.sh), so accounts need no entry here.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Engine, Id } from "@i-inc/core";

export const configDir = () => join(homedir(), ".config", "i-inc");

/**
 * The web app's login token, in web-token next to the other config: made at random the first time,
 * readable only by the owner. Show it with: cat ~/.config/i-inc/web-token
 */
export function webToken(dir = configDir()): string {
  const path = join(dir, "web-token");
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
  }
  return readOwnerOnly(path).trim();
}

/** Reads a secret file, refusing one that anyone but its owner can read. */
export function readOwnerOnly(path: string): string {
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path} must be readable only by its owner: chmod 600 it`);
  }
  return readFileSync(path, "utf8");
}

export type Credentials = Record<Id, Record<string, string>>;

/** The environment per account. A missing file means no account has any. */
export function readCredentials(dir = configDir()): Credentials {
  const path = join(dir, "credentials.json");
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readOwnerOnly(path)) as Record<string, unknown>;
  const out: Credentials = {};
  for (const [account, env] of Object.entries(raw)) {
    if (typeof env !== "object" || env === null)
      throw new Error(`credentials.json: ${account} isn't an object`);
    out[account] = {};
    for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof value !== "string") {
        throw new Error(`credentials.json: ${account}.${name} isn't a variable with a string value`);
      }
      out[account][name] = value;
    }
  }
  return out;
}

/** What an engine's session gets: its account's environment, or nothing. */
export const credentialsFor =
  (all: Credentials) =>
  (engine: Engine): Record<string, string> =>
    all[engine.accountId] ?? {};
