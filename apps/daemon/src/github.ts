// GitHub for i.inc (spec §5 and §6): the bot identity. The GitHub App "i.inc" mints a 1-hour
// installation token per session, limited to the ticket's repo, so pushes and draft PRs come from the
// bot and never from the owner. A ruleset on main means only the owner merges. Setting it up:
// docs/github-app.md. Until the App exists, a fine-grained token (M1 step 6) can stand in.
import { createSign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where a session's GitHub token comes from. `repo` is "owner/name". */
export interface TokenSource {
  token(repo: string): Promise<string>;
}

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  /** Its public name in URLs, `i-inc-bot`, which the bot's commit address needs. */
  slug?: string;
  /** On the mini: ~/.config/i-inc/github-app.pem, readable only by the owner. Never in the repo. */
  privateKeyPath: string;
  api?: string;
}

/** Where the App's ids and key live on the host (docs/github-app.md). */
export const configDir = () => join(homedir(), ".config", "i-inc");

/** Reads `github-app.json` ({appId, installationId, slug}); the key sits next to it. */
export function readGitHubAppConfig(dir = configDir()): GitHubAppConfig {
  const raw = JSON.parse(readFileSync(join(dir, "github-app.json"), "utf8")) as Record<string, unknown>;
  const id = (key: string) => {
    const value = String(raw[key] ?? "");
    if (!/^\d+$/.test(value)) throw new Error(`github-app.json needs ${key}, a number`);
    return value;
  };
  return {
    appId: id("appId"),
    installationId: id("installationId"),
    slug: typeof raw.slug === "string" ? raw.slug : "i-inc-bot",
    privateKeyPath: join(dir, "github-app.pem"),
  };
}

export interface GitHubDeps {
  fetch?: typeof fetch;
  now?: () => number;
  readKey?: (path: string) => string;
}

const API = "https://api.github.com";
const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** A JWT for the App itself, signed with its private key (RS256), good for 9 minutes. */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  // Backdated a minute, as GitHub suggests, in case the clocks disagree.
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Reads the App's key, refusing one that anyone but its owner can read. */
export function readPrivateKey(path: string): string {
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path} must be readable only by its owner: chmod 600 it`);
  }
  return readFileSync(path, "utf8");
}

async function call(f: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await f(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "i-inc",
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(
      `GitHub ${init.method ?? "GET"} ${url} failed: ${res.status} ${body.message ?? ""}`.trim(),
    );
  return body;
}

/** Checks "owner/name" before it goes into a URL. */
const checkRepo = (repo: string) => {
  if (!/^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`not a repo: ${repo}`);
  return repo;
};

/** Installation tokens from the App: one per repo, reused until five minutes before it expires. */
export class GitHubApp implements TokenSource {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly readKey: (path: string) => string;

  constructor(
    private readonly config: GitHubAppConfig,
    deps: GitHubDeps = {},
  ) {
    this.f = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.readKey = deps.readKey ?? readPrivateKey;
  }

  async token(repo: string): Promise<string> {
    const cached = this.cache.get(repo);
    if (cached && cached.expiresAt - this.now() > 5 * 60_000) return cached.token;
    const jwt = appJwt(this.config.appId, this.readKey(this.config.privateKeyPath), this.now());
    const body = await call(
      this.f,
      `${this.config.api ?? API}/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
        // Only the ticket's repo, with whatever the App was granted there.
        body: JSON.stringify({ repositories: [checkRepo(repo).split("/")[1]] }),
      },
    );
    if (typeof body.token !== "string") throw new Error("GitHub sent no installation token");
    const token = body.token;
    this.cache.set(repo, { token, expiresAt: Date.parse(String(body.expires_at)) });
    return token;
  }
}

/** A fine-grained token that can push and open PRs on the owner's repos, until the App exists. */
export class FineGrainedToken implements TokenSource {
  constructor(private readonly value: string) {}
  async token(): Promise<string> {
    return this.value;
  }
}

export interface DraftPr {
  number: number;
  url: string;
  nodeId: string;
}

/** The pull requests an employee's work goes through, opened and updated as the bot. */
export class PullRequests {
  private readonly f: typeof fetch;
  private readonly api: string;

  constructor(
    private readonly tokens: TokenSource,
    deps: GitHubDeps & { api?: string } = {},
  ) {
    this.f = deps.fetch ?? fetch;
    this.api = deps.api ?? API;
  }

  private async auth(repo: string) {
    return { authorization: `Bearer ${await this.tokens.token(repo)}` };
  }

  /** Stage 1 opens the PR as a draft, so CI runs from the start (spec §6). */
  async openDraft(
    repo: string,
    pr: { head: string; base: string; title: string; body: string },
  ): Promise<DraftPr> {
    const body = await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls`, {
      method: "POST",
      headers: await this.auth(repo),
      body: JSON.stringify({ ...pr, draft: true }),
    });
    return { number: Number(body.number), url: String(body.html_url), nodeId: String(body.node_id) };
  }

  /** Stage 9: the report becomes the PR body. */
  async setBody(repo: string, number: number, body: string): Promise<void> {
    await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls/${number}`, {
      method: "PATCH",
      headers: await this.auth(repo),
      body: JSON.stringify({ body }),
    });
  }

  /** Stage 9: out of draft, ready for the owner. REST can't do this; GraphQL can. */
  async markReady(repo: string, nodeId: string): Promise<void> {
    const body = await call(this.f, `${this.api}/graphql`, {
      method: "POST",
      headers: await this.auth(repo),
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
        variables: { id: nodeId },
      }),
    });
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new Error(`GitHub couldn't mark the PR ready: ${JSON.stringify(body.errors)}`);
    }
  }
}

/**
 * The git identity for an employee's commits: its own name, with the bot's noreply address, so GitHub
 * shows them as the App's ("Ada (i.inc)"). The address needs the bot account's id.
 */
export async function commitIdentity(
  employeeName: string,
  appSlug: string,
  deps: GitHubDeps & { api?: string } = {},
): Promise<{ name: string; email: string }> {
  const url = `${deps.api ?? API}/users/${encodeURIComponent(`${appSlug}[bot]`)}`;
  const bot = await call(deps.fetch ?? fetch, url, { method: "GET" });
  return { name: `${employeeName} (i.inc)`, email: `${bot.id}+${appSlug}[bot]@users.noreply.github.com` };
}
