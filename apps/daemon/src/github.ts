// GitHub for i.inc (spec §5 and §6): the bot identity. The GitHub App "i.inc" mints a 1-hour
// installation token per session, limited to the ticket's repo, so pushes and draft PRs come from the
// bot and never from the owner. A ruleset on main means only the owner merges. Setting it up:
// docs/github-app.md. Until the App exists, a fine-grained token (M1 step 6) can stand in.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, readOwnerOnly } from "./config.ts";

/** Where a session's GitHub token comes from. `repo` is "owner/name". */
export interface TokenSource {
  /** "read" for a reviewer or verifier, who checks the branch out but never pushes. */
  token(repo: string, access?: "write" | "read"): Promise<string>;
}

/** A session can run for most of an hour, so it gets a token with at least this long left. */
const minLeftMs = 50 * 60_000;

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  /** Its public name in URLs, `i-inc-bot`, which the bot's commit address needs. */
  slug?: string;
  /** On the mini: ~/.config/i-inc/github-app.pem, readable only by the owner. Never in the repo. */
  privateKeyPath: string;
  api?: string;
}

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
export const readPrivateKey = readOwnerOnly;

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

  async token(repo: string, access: "write" | "read" = "write"): Promise<string> {
    const key = `${repo} ${access}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > minLeftMs) return cached.token;
    const jwt = appJwt(this.config.appId, this.readKey(this.config.privateKeyPath), this.now());
    const body = await call(
      this.f,
      `${this.config.api ?? API}/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
        // Only the ticket's repo: with whatever the App was granted there, or read-only.
        body: JSON.stringify({
          repositories: [checkRepo(repo).split("/")[1]],
          ...(access === "read"
            ? { permissions: { contents: "read", pull_requests: "read", metadata: "read", checks: "read" } }
            : {}),
        }),
      },
    );
    if (typeof body.token !== "string") throw new Error("GitHub sent no installation token");
    const token = body.token;
    this.cache.set(key, { token, expiresAt: Date.parse(String(body.expires_at)) });
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

  /** The open PR for a branch, if there is one: pick-up after a crash finds the PR it opened. */
  async find(repo: string, branch: string): Promise<DraftPr | null> {
    const owner = checkRepo(repo).split("/")[0] ?? "";
    const head = encodeURIComponent(`${owner}:${branch}`);
    const list = (await call(this.f, `${this.api}/repos/${repo}/pulls?head=${head}&state=open`, {
      method: "GET",
      headers: await this.auth(repo),
    })) as unknown as Record<string, unknown>[];
    const [pr] = Array.isArray(list) ? list : [];
    return pr ? { number: Number(pr.number), url: String(pr.html_url), nodeId: String(pr.node_id) } : null;
  }

  async isDraft(repo: string, number: number): Promise<boolean> {
    const pr = await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls/${number}`, {
      method: "GET",
      headers: await this.auth(repo),
    });
    return pr.draft === true;
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

export interface CiOptions {
  fetch?: typeof fetch;
  api?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long CI may take in all. */
  timeoutMs?: number;
  /** How long to wait for the first check to show up before deciding the repo has no CI. */
  graceMs?: number;
  pollMs?: number;
}

/**
 * Stage 8's "GitHub CI green" (spec §6). The checks `main`'s rules require must each have run on the
 * commit and passed; every other check run that showed up must have finished without failing. A
 * check that hasn't started yet has no run, so the required ones are what keep this from passing
 * early. A repo whose `main` requires no checks and whose commit gets no runs in the grace period
 * has no CI.
 */
export async function waitForCi(
  tokens: TokenSource,
  repo: string,
  sha: string,
  o: CiOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const f = o.fetch ?? fetch;
  const api = o.api ?? API;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
  const get = async (url: string) =>
    call(f, url, { method: "GET", headers: { authorization: `Bearer ${await tokens.token(repo)}` } });

  const rules = (await get(`${api}/repos/${checkRepo(repo)}/rules/branches/main`)) as unknown;
  const required = (Array.isArray(rules) ? (rules as Record<string, unknown>[]) : [])
    .filter((r) => r.type === "required_status_checks")
    .flatMap(
      (r) =>
        ((r.parameters as Record<string, unknown>)?.required_status_checks ?? []) as { context: string }[],
    )
    .map((c) => c.context);

  const passed = (r: Record<string, unknown>) =>
    ["success", "neutral", "skipped"].includes(String(r.conclusion));
  const start = now();
  for (;;) {
    const runs: Record<string, unknown>[] = [];
    for (let page = 1; ; page++) {
      const body = await get(`${api}/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
      const batch = (Array.isArray(body.check_runs) ? body.check_runs : []) as Record<string, unknown>[];
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    const failed = runs.filter((r) => r.status === "completed" && !passed(r));
    if (failed.length) {
      return {
        ok: false,
        reason: `CI failed: ${failed.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`,
      };
    }
    const waited = now() - start;
    const allDone = runs.every((r) => r.status === "completed");
    const requiredPassed = required.every((name) => runs.some((r) => r.name === name && passed(r)));
    if (required.length ? requiredPassed && allDone : runs.length > 0 && allDone) return { ok: true };
    if (!required.length && runs.length === 0 && waited >= (o.graceMs ?? 120_000)) return { ok: true };
    if (waited >= (o.timeoutMs ?? 45 * 60_000)) {
      const missing = required.filter((name) => !runs.some((r) => r.name === name && passed(r)));
      return {
        ok: false,
        reason: `CI didn't finish in time${missing.length ? `: waiting on ${missing.join(", ")}` : ""}`,
      };
    }
    await sleep(o.pollMs ?? 20_000);
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
