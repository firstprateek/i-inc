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
  /**
   * "read" for a reviewer or verifier, who checks the branch out but never pushes. `repo` "*" asks
   * for every repo the App is installed on: a team sandbox's shared sign-in.
   */
  token(repo: string, access?: "write" | "read", f?: typeof fetch): Promise<string>;
  /**
   * The only token a sandbox ever gets (T68): read-only (`READ_PERMISSIONS`) and limited to the named repos.
   * `repos` is never empty and never "*". A source that can't limit a token this way (a stand-in) throws, so
   * a sandbox gets no GitHub access rather than a write token.
   */
  readToken(repos: string[], f?: typeof fetch): Promise<string>;
  /**
   * What the App's installation is: whose account it sits on, and what it may do there. Only the GitHub
   * App can say (it signs as itself); a stand-in token can't, and the projects flow then assumes the
   * least (no repo creation).
   */
  installation?(f?: typeof fetch): Promise<InstallationInfo>;
}

/** The installation of the GitHub App, as the projects flow needs it. No token is ever in here. */
export interface InstallationInfo {
  id: string;
  /** The account (user or organization) the App is installed on, if GitHub said. */
  account: string | null;
  accountType: "Organization" | "User" | "unknown";
  repositorySelection: "all" | "selected" | "unknown";
  /** The permissions the owner granted, such as `{ administration: "write", contents: "write" }`. */
  permissions: Record<string, string>;
  /** The App's public name in URLs. */
  slug: string;
}

/** What a sandbox's token may do: look, never change. `metadata` is what GitHub always adds. */
export const READ_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  metadata: "read",
  checks: "read",
} as const;

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

function sanitizedEndpoint(url: string): string {
  return (
    url
      .replace(/https:\/\/[^/]+/, "")
      .replace(/\/installations\/\d+/, "/installations/[id]")
      .split("?")[0] ?? "/"
  );
}

/** Structured error representing an upstream GitHub HTTP failure without leaking secrets or IDs. */
export class UpstreamGitHubError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly endpoint: string;
  public readonly detail: string;
  /** GitHub (or our own limiter) said "slow down": the primary limit, the secondary limit or a 429. */
  public rateLimited = false;
  /** How long to wait before trying again, when GitHub said. */
  public retryAfterSec?: number;
  /** For a bootstrap that failed part way: how many files it had written by then. */
  public written?: number;

  constructor(status: number, method: string, endpoint: string, detail = "") {
    super(`GitHub ${method} ${endpoint} failed with HTTP ${status}`);
    this.name = "UpstreamGitHubError";
    this.status = status;
    this.method = method;
    this.endpoint = endpoint;
    this.detail = detail;
    this.rateLimited = status === 429;
    Object.defineProperty(this, "detail", {
      value: detail,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

/** Notes on an error whether GitHub is rate limiting us, and for how long (headers only: no secrets). */
function readRateLimit(err: UpstreamGitHubError, headers: Headers | undefined) {
  const get = (name: string) => headers?.get?.(name) ?? null;
  const retryAfter = Number(get("retry-after"));
  const reset = Number(get("x-ratelimit-reset"));
  const exhausted = get("x-ratelimit-remaining") === "0";
  if (err.status === 429 || (err.status === 403 && (exhausted || /rate limit|abuse/i.test(err.detail)))) {
    err.rateLimited = true;
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSec = Math.ceil(retryAfter);
    else if (exhausted && Number.isFinite(reset) && reset > 0) {
      err.retryAfterSec = Math.max(1, Math.ceil(reset - Date.now() / 1000));
    }
  }
}

async function call(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = init.method ?? "GET";
  const sanitized = sanitizedEndpoint(url);

  try {
    const res = await f(url, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "i-inc",
        ...init.headers,
      },
    });

    let body: Record<string, unknown> = {};
    const text = await res.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          body = parsed as Record<string, unknown>;
        }
      } catch (_parseErr) {
        if (controller.signal.aborted || init.signal?.aborted) {
          throw new UpstreamGitHubError(504, method, sanitized, "timeout reading response body");
        }
        if (res.ok) {
          throw new UpstreamGitHubError(502, method, sanitized, "invalid json from GitHub API");
        }
      }
    }

    if (!res.ok) {
      const err = new UpstreamGitHubError(
        res.status,
        method,
        sanitized,
        typeof body.message === "string" ? body.message : "",
      );
      readRateLimit(err, res.headers);
      throw err;
    }
    return body;
  } catch (err) {
    if (err instanceof UpstreamGitHubError) throw err;
    if (
      controller.signal.aborted ||
      init.signal?.aborted ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      throw new UpstreamGitHubError(504, method, sanitized, "timeout");
    }
    throw new UpstreamGitHubError(502, method, sanitized, "network error");
  } finally {
    clearTimeout(timer);
  }
}

/** Strictly validates owner/name repository path, preventing dot segments, traversal, and invalid chars. */
export function isValidRepo(repo: string): boolean {
  if (typeof repo !== "string") return false;
  const parts = repo.split("/");
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  if (!owner || !name) return false;
  if (/^\.+$/.test(owner) || /^\.+$/.test(name)) return false;
  if (owner.startsWith(".") || owner.endsWith(".")) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.endsWith(".git")) return false;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return false;
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) return false;
  return true;
}

/**
 * Strictly validates a git branch / refname per git-check-ref-format rules.
 * Disallows leading/trailing dots/slashes/dashes, double dots/slashes, .lock, controls, and shell metacharacters.
 */
export function isValidBranch(branch: string): boolean {
  if (typeof branch !== "string") return false;
  const b = branch.trim();
  if (!b || b.length > 100) return false;
  if (b === "@") return false;
  if (b.startsWith("-") || b.startsWith(".") || b.startsWith("/")) return false;
  if (b.endsWith(".") || b.endsWith("/") || b.endsWith(".lock")) return false;
  if (b.includes("..") || b.includes("//") || b.includes("@{") || b.includes("\\")) return false;
  for (let i = 0; i < b.length; i++) {
    const code = b.charCodeAt(i);
    if (code <= 32 || code === 127) return false;
  }
  if (/[~^:?*[]/.test(b)) return false;
  // Plain characters only: the branch goes into scripts run in a sandbox (harness.ts, isSafeRefName).
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) return false;
  const parts = b.split("/");
  for (const part of parts) {
    if (!part) return false;
    if (part.startsWith(".") || part.endsWith(".lock") || part.startsWith("-")) return false;
  }
  return true;
}

/** Checks "owner/name" before it goes into a URL. */
export const checkRepo = (repo: string) => {
  if (!isValidRepo(repo)) throw new Error(`not a repo: ${repo}`);
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

  /** Tokens held; expired ones are dropped whenever a new one is minted. */
  footprint(): { tokens: number } {
    return { tokens: this.cache.size };
  }

  /**
   * Whose account the App is installed on and what it may do there. It signs as the App itself (the
   * JWT), because an installation token can't read its own account. Nothing secret comes back.
   */
  async installation(f?: typeof fetch): Promise<InstallationInfo> {
    const jwt = appJwt(this.config.appId, this.readKey(this.config.privateKeyPath), this.now());
    const body = await call(
      f ?? this.f,
      `${this.config.api ?? API}/app/installations/${this.config.installationId}`,
      { method: "GET", headers: { authorization: `Bearer ${jwt}` } },
    );
    const account = (body.account ?? {}) as Record<string, unknown>;
    const perms = (body.permissions ?? {}) as Record<string, unknown>;
    return {
      id: this.config.installationId,
      account: typeof account.login === "string" && account.login ? account.login : null,
      accountType:
        account.type === "Organization" ? "Organization" : account.type === "User" ? "User" : "unknown",
      repositorySelection:
        body.repository_selection === "all"
          ? "all"
          : body.repository_selection === "selected"
            ? "selected"
            : "unknown",
      permissions: Object.fromEntries(
        Object.entries(perms).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
      slug: this.config.slug ?? "i-inc-bot",
    };
  }

  async token(repo: string, access: "write" | "read" = "write", f?: typeof fetch): Promise<string> {
    if (repo === "*") return this.mint([], access === "read" ? READ_PERMISSIONS : undefined, f);
    return this.mint([repo], access === "read" ? READ_PERMISSIONS : undefined, f);
  }

  /**
   * A token limited to `repos` ("owner/name", at least one) and to `permissions`, using the `repositories` and
   * `permissions` fields of the access-token request. GitHub gives a token no more than the App has, so this
   * can only narrow it.
   */
  async scopedToken(repos: string[], permissions: Record<string, string>, f?: typeof fetch): Promise<string> {
    if (repos.length === 0) throw new Error("a scoped token needs at least one repo");
    return this.mint(repos, permissions, f);
  }

  /** The token a sandbox gets: read-only, and only for the repos it works on. */
  async readToken(repos: string[], f?: typeof fetch): Promise<string> {
    return this.scopedToken(repos, READ_PERMISSIONS, f);
  }

  /** `repos` empty: every repo of the installation (the host's own use only). */
  private async mint(
    repos: string[],
    permissions: Record<string, string> | undefined,
    f?: typeof fetch,
  ): Promise<string> {
    const names = [...new Set(repos.map((r) => checkRepo(r).split("/")[1] as string))].sort();
    const key = `${names.join(",") || "*"} ${permissions ? JSON.stringify(permissions) : "write"}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > minLeftMs) return cached.token;
    const jwt = appJwt(this.config.appId, this.readKey(this.config.privateKeyPath), this.now());
    const body = await call(
      f ?? this.f,
      `${this.config.api ?? API}/app/installations/${this.config.installationId}/access_tokens`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
        // Only the named repos: with whatever the App was granted there, or only what `permissions` names.
        body: JSON.stringify({
          ...(names.length ? { repositories: names } : {}),
          ...(permissions ? { permissions } : {}),
        }),
      },
    );
    if (typeof body.token !== "string") throw new Error("GitHub sent no installation token");
    const token = body.token;
    this.cache.set(key, { token, expiresAt: Date.parse(String(body.expires_at)) });
    // A token that has expired is never used again; drop it so a repo that's gone doesn't keep one.
    for (const [k, v] of this.cache) if (v.expiresAt <= this.now()) this.cache.delete(k);
    return token;
  }
}

/** A fine-grained token that can push and open PRs on the owner's repos, until the App exists. */
export class FineGrainedToken implements TokenSource {
  constructor(private readonly value: string) {}
  async token(): Promise<string> {
    return this.value;
  }
  /** A stand-in token can't be narrowed, so it never goes into a sandbox (T68). */
  async readToken(): Promise<string> {
    throw new Error(
      "a stand-in token can't be limited to read-only, so a sandbox gets no GitHub access: set up the GitHub App (docs/github-app.md)",
    );
  }
}

export interface DraftPr {
  number: number;
  url: string;
  nodeId: string;
}

export interface PrInfo extends DraftPr {
  state: "open" | "closed" | "merged";
  draft: boolean;
  /** The PR's latest commit. */
  headSha: string;
}

export interface PrChecks {
  state: "none" | "pending" | "success" | "failure";
  total: number;
  passed: number;
  failed: number;
  pending: number;
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

  /** One PR as the conversations panel shows it: whether it is open, merged or a draft, and its latest commit. */
  async get(repo: string, number: number): Promise<PrInfo> {
    const pr = await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls/${number}`, {
      method: "GET",
      headers: await this.auth(repo),
    });
    const head = (pr.head ?? {}) as Record<string, unknown>;
    return {
      number: Number(pr.number ?? number),
      url: String(pr.html_url ?? ""),
      nodeId: String(pr.node_id ?? ""),
      state: pr.merged === true || pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
      draft: pr.draft === true,
      headSha: typeof head.sha === "string" ? head.sha : "",
    };
  }

  /** The checks on a commit, as a count and one word: none, pending, success or failure. */
  async checks(repo: string, sha: string): Promise<PrChecks> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`not a commit: ${sha}`);
    const runs: Record<string, unknown>[] = [];
    for (let page = 1; page <= 5; page++) {
      const body = await call(
        this.f,
        `${this.api}/repos/${checkRepo(repo)}/commits/${sha}/check-runs?per_page=100&page=${page}`,
        { method: "GET", headers: await this.auth(repo) },
      );
      const batch = (Array.isArray(body.check_runs) ? body.check_runs : []) as Record<string, unknown>[];
      runs.push(...batch);
      if (batch.length < 100) break;
    }
    const finished = (r: Record<string, unknown>) =>
      r.status === "completed" || (typeof r.conclusion === "string" && r.conclusion.length > 0);
    const passed = (r: Record<string, unknown>) =>
      ["success", "neutral", "skipped"].includes(String(r.conclusion));
    const failed = runs.filter((r) => finished(r) && !passed(r)).length;
    const pending = runs.filter((r) => !finished(r)).length;
    return {
      state: !runs.length ? "none" : failed ? "failure" : pending ? "pending" : "success",
      total: runs.length,
      passed: runs.filter((r) => finished(r) && passed(r)).length,
      failed,
      pending,
    };
  }

  async isDraft(repo: string, number: number): Promise<boolean> {
    const pr = await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls/${number}`, {
      method: "GET",
      headers: await this.auth(repo),
    });
    return pr.draft === true;
  }

  /** The owner took the work back: the PR is closed (it can be reopened on GitHub). */
  async close(repo: string, number: number): Promise<void> {
    await call(this.f, `${this.api}/repos/${checkRepo(repo)}/pulls/${number}`, {
      method: "PATCH",
      headers: await this.auth(repo),
      body: JSON.stringify({ state: "closed" }),
    });
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
  /** Branch name for branch rules (default: main). */
  branch?: string;
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

  const targetBranch = encodeURIComponent(o.branch ?? "main");
  let rules: unknown = [];
  const rulesUrl = `${api}/repos/${checkRepo(repo)}/rules/branches/${targetBranch}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rules = await get(rulesUrl);
      break;
    } catch (err) {
      if (err instanceof UpstreamGitHubError && err.status === 404) {
        rules = [];
        break;
      }
      if (attempt === 2) throw err;
      await sleep(o.pollMs ? Math.min(o.pollMs, 1000 * 2 ** attempt) : 1000 * 2 ** attempt);
    }
  }
  const required = (Array.isArray(rules) ? (rules as Record<string, unknown>[]) : [])
    .filter((r) => r.type === "required_status_checks")
    .flatMap(
      (r) =>
        ((r.parameters as Record<string, unknown>)?.required_status_checks ?? []) as { context: string }[],
    )
    .map((c) => c.context);

  // GitHub sometimes leaves `status: "in_progress"` on a check run that already has `conclusion` and
  // `completed_at` set (seen on Duet's Sorting service job). A run with a conclusion is finished.
  const finished = (r: Record<string, unknown>) =>
    r.status === "completed" || (typeof r.conclusion === "string" && r.conclusion.length > 0);
  const passed = (r: Record<string, unknown>) =>
    ["success", "neutral", "skipped"].includes(String(r.conclusion));
  const start = now();
  for (;;) {
    const runs: Record<string, unknown>[] = [];
    let pollError: unknown = null;
    try {
      for (let page = 1; ; page++) {
        const body = await get(`${api}/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
        const batch = (Array.isArray(body.check_runs) ? body.check_runs : []) as Record<string, unknown>[];
        runs.push(...batch);
        if (batch.length < 100) break;
      }
    } catch (err) {
      pollError = err;
    }

    if (pollError) {
      const waited = now() - start;
      if (waited >= (o.timeoutMs ?? 45 * 60_000)) {
        throw pollError;
      }
      await sleep(o.pollMs ?? 20_000);
      continue;
    }
    const failed = runs.filter((r) => finished(r) && !passed(r));
    if (failed.length) {
      return {
        ok: false,
        reason: `CI failed: ${failed.map((r) => `${r.name} (${r.conclusion})`).join(", ")}`,
      };
    }
    const waited = now() - start;
    const allDone = runs.every(finished);
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

export interface GitHubRepoSummary {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  empty: boolean;
  pushedAt: string | null;
  alreadyRegistered: boolean;
  /** GitHub's numeric id: it survives a rename or a transfer, so "the same repo" is told by it when known. */
  id?: number;
}

export interface GitHubInspectResult {
  id: string;
  repo: string;
  defaultBranch: string;
  empty: boolean;
  checks: string[];
  protectedPaths: string[];
  detected: string;
}

/** The starter templates `bootstrapRepo` can write. */
export const TEMPLATES = ["ts-node", "web", "python", "minimal"] as const;
export type Template = (typeof TEMPLATES)[number];
export const isTemplate = (t: unknown): t is Template => TEMPLATES.some((x) => x === t);

export interface BootstrapOptions {
  repo: string;
  template?: Template;
  description?: string;
  defaultBranch?: string;
  /**
   * Carry on a bootstrap that stopped part way. Only allowed in a repo whose every commit is a scaffold
   * commit; it then adds the files that are missing and never changes one that is there.
   */
  force?: boolean;
  /** The bot's login (`<slug>[bot]`): the author a starter commit must have for `force` to carry on from it. */
  botLogin?: string;
}

export interface BootstrapResult {
  bootstrapped: boolean;
  commits: number;
}

/** One repo as GitHub lists it for the installation, before we mark which are projects. */
export type InstallationRepo = Omit<GitHubRepoSummary, "alreadyRegistered">;

/** Fetches every repository the installation can see (bounded paging), as GitHub lists them. */
export async function fetchInstallationRepos(
  tokens: TokenSource,
  deps: GitHubDeps & { api?: string } = {},
): Promise<InstallationRepo[]> {
  const f = deps.fetch ?? fetch;
  const api = deps.api ?? API;
  const token = await tokens.token("*", "read", deps.fetch);

  const rawRepos: Record<string, unknown>[] = [];
  let page = 1;
  const maxPages = 10;
  while (page <= maxPages) {
    const res = (await call(f, `${api}/installation/repositories?per_page=100&page=${page}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    })) as { repositories?: Record<string, unknown>[]; total_count?: number };
    const pageRepos = Array.isArray(res.repositories) ? res.repositories : [];
    rawRepos.push(...pageRepos);
    if (
      pageRepos.length < 100 ||
      (typeof res.total_count === "number" && rawRepos.length >= res.total_count)
    ) {
      break;
    }
    page++;
  }
  const out: InstallationRepo[] = rawRepos.map((r) => {
    const fullName = String(r.full_name ?? "");
    const size = typeof r.size === "number" ? r.size : 0;
    const pushedAt = typeof r.pushed_at === "string" ? r.pushed_at : null;
    return {
      ...(typeof r.id === "number" ? { id: r.id } : {}),
      fullName,
      name: String(r.name ?? ""),
      owner: String((r.owner as Record<string, unknown>)?.login ?? fullName.split("/")[0] ?? ""),
      private: Boolean(r.private),
      defaultBranch: String(r.default_branch ?? "main"),
      description: typeof r.description === "string" ? r.description : null,
      language: typeof r.language === "string" ? r.language : null,
      empty: size === 0 || !pushedAt,
      pushedAt,
    };
  });
  // The size and push time lag (a README-only repo can read 0), so a repo they call empty is asked of GitHub's
  // commit list. The answer is cached with the list. At most 20 are asked a time; the rest stay a hint.
  const hinted = out.filter((r) => r.empty && isValidRepo(r.fullName)).slice(0, EMPTY_CHECKS_PER_LIST);
  await Promise.all(
    hinted.map(async (r) => {
      try {
        if (await hasCommits(f, api, r.fullName, { authorization: `Bearer ${token}` })) r.empty = false;
      } catch {
        // Can't tell: it stays a hint, and the daemon checks again before anything is written.
      }
    }),
  );
  return out;
}

const EMPTY_CHECKS_PER_LIST = 20;

/** Marks which of the repos are projects already. */
export function markRegistered(
  repos: InstallationRepo[],
  registeredRepos: string[],
  registeredIds: Iterable<number> = [],
): GitHubRepoSummary[] {
  const registered = new Set(registeredRepos.map((r) => r.toLowerCase()));
  const ids = new Set(registeredIds);
  return repos.map((r) => ({
    ...r,
    alreadyRegistered: registered.has(r.fullName.toLowerCase()) || (r.id !== undefined && ids.has(r.id)),
  }));
}

/** Lists all repositories accessible to the GitHub App installation. */
export async function listInstallationRepos(
  tokens: TokenSource,
  registeredRepos: string[] = [],
  deps: GitHubDeps & { api?: string } = {},
): Promise<GitHubRepoSummary[]> {
  return markRegistered(await fetchInstallationRepos(tokens, deps), registeredRepos);
}

/**
 * Creates an empty repository in an organization the App is installed on. GitHub lets an App do this
 * only in an organization, and only with the Administration permission (write); never in a personal
 * account. The repo has no files, so `bootstrapRepo` can fill it.
 */
export async function createOrgRepo(
  tokens: TokenSource,
  o: { owner: string; name: string; private: boolean; description?: string },
  deps: GitHubDeps & { api?: string } = {},
): Promise<{ fullName: string; defaultBranch: string; private: boolean }> {
  const repo = checkRepo(`${o.owner}/${o.name}`);
  const token = await tokens.token("*", "write", deps.fetch);
  const body = await call(
    deps.fetch ?? fetch,
    `${deps.api ?? API}/orgs/${encodeURIComponent(o.owner)}/repos`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: o.name,
        private: o.private,
        ...(o.description ? { description: o.description.slice(0, 350) } : {}),
        auto_init: false,
      }),
    },
  );
  return {
    fullName: typeof body.full_name === "string" ? body.full_name : repo,
    defaultBranch: typeof body.default_branch === "string" ? body.default_branch : "main",
    private: body.private === true,
  };
}

/** A repo already has files that i.inc won't write over. */
export class NotEmptyError extends Error {
  /** How many files this run had written before it noticed. */
  written?: number;
  constructor(message: string) {
    super(message);
    this.name = "NotEmptyError";
  }
}

/**
 * Whether the repo has any commit, asked of GitHub's commit list (a repo with none answers 409). The
 * repo listing's `size` is in KB and lags, so it can say 0 for a repo that has a README.
 */
async function hasCommits(
  f: typeof fetch,
  api: string,
  repo: string,
  headers: HeadersInit,
): Promise<boolean> {
  try {
    const list = (await call(f, `${api}/repos/${repo}/commits?per_page=1`, {
      method: "GET",
      headers,
    })) as unknown;
    return Array.isArray(list) && list.length > 0;
  } catch (err) {
    if (err instanceof UpstreamGitHubError && err.status === 409) return false;
    throw err;
  }
}

const scaffoldMessage = /^Initialize (.+) \(i\.inc scaffold\)$/;

/**
 * Whether every commit in the repo is one this bootstrap made: written by the bot (its login), with the starter's
 * own message, and touching exactly one file, which is one of the starter's paths. A message alone proves nothing,
 * since anyone can write it.
 */
async function onlyScaffoldCommits(
  f: typeof fetch,
  api: string,
  repo: string,
  headers: HeadersInit,
  starterPaths: Set<string>,
  botLogin: string | undefined,
): Promise<boolean> {
  if (!botLogin) return false;
  const list = (await call(f, `${api}/repos/${repo}/commits?per_page=100`, {
    method: "GET",
    headers,
  })) as unknown;
  // A starter is a handful of files: more commits than paths means something else is in there.
  if (!Array.isArray(list) || list.length === 0 || list.length > starterPaths.size) return false;
  for (const c of list as { sha?: unknown; author?: { login?: unknown }; commit?: { message?: unknown } }[]) {
    const message = typeof c?.commit?.message === "string" ? c.commit.message : "";
    const path = scaffoldMessage.exec(message)?.[1];
    const login = typeof c?.author?.login === "string" ? c.author.login : "";
    if (!path || !starterPaths.has(path) || login.toLowerCase() !== botLogin.toLowerCase()) return false;
    if (typeof c.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(c.sha)) return false;
    const detail = (await call(f, `${api}/repos/${repo}/commits/${c.sha}`, { method: "GET", headers })) as {
      files?: { filename?: unknown }[];
    };
    const touched = Array.isArray(detail.files) ? detail.files.map((x) => x.filename) : [];
    if (touched.length !== 1 || touched[0] !== path) return false;
  }
  return true;
}

/** Inspects a repository to detect language, build tools, check recipes, and default branch. */
export async function inspectRepo(
  tokens: TokenSource,
  owner: string,
  name: string,
  deps: GitHubDeps & { api?: string } = {},
): Promise<GitHubInspectResult> {
  const f = deps.fetch ?? fetch;
  const api = deps.api ?? API;
  const repo = `${owner}/${name}`;
  checkRepo(repo);
  const token = await tokens.token(repo, "read", deps.fetch);
  const authHeader = { authorization: `Bearer ${token}` };

  const repoMeta = await call(f, `${api}/repos/${repo}`, {
    method: "GET",
    headers: authHeader,
  });
  const defaultBranch = String(repoMeta.default_branch ?? "main");
  const size = typeof repoMeta.size === "number" ? repoMeta.size : 0;
  const pushedAt = typeof repoMeta.pushed_at === "string" ? repoMeta.pushed_at : null;
  // The size and push time are hints (GitHub's lag): only a repo with no commit is empty.
  const empty = size > 0 && pushedAt ? false : !(await hasCommits(f, api, repo, authHeader));

  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  if (empty) {
    return {
      id,
      repo,
      defaultBranch,
      empty: true,
      checks: ["pnpm install", "pnpm test"],
      protectedPaths: [],
      detected: "empty",
    };
  }

  let contents: Record<string, unknown>[] = [];
  try {
    const list = await call(f, `${api}/repos/${repo}/contents`, {
      method: "GET",
      headers: authHeader,
    });
    contents = Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
  } catch (err) {
    if (err instanceof UpstreamGitHubError && err.status === 404) {
      return {
        id,
        repo,
        defaultBranch,
        empty: true,
        checks: ["pnpm install", "pnpm test"],
        protectedPaths: [],
        detected: "empty",
      };
    }
    throw err;
  }

  const fileNames = new Set(contents.map((c) => String(c.name ?? "")));

  if (fileNames.has("package.json")) {
    const checks: string[] = [];
    const hasPnpmLock = fileNames.has("pnpm-lock.yaml");
    const hasYarnLock = fileNames.has("yarn.lock");
    const hasPackageLock = fileNames.has("package-lock.json");
    const hasBunLock = fileNames.has("bun.lock") || fileNames.has("bun.lockb");

    const installCmd = hasBunLock
      ? "bun install --frozen-lockfile"
      : hasPnpmLock
        ? "pnpm install --frozen-lockfile"
        : hasYarnLock
          ? "yarn install --frozen-lockfile"
          : hasPackageLock
            ? "npm ci"
            : "pnpm install";

    checks.push(installCmd);

    const runner = hasBunLock ? "bun run" : hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn run" : "npm run";

    try {
      const pkgFile = await call(f, `${api}/repos/${repo}/contents/package.json`, {
        method: "GET",
        headers: authHeader,
      });
      const content =
        typeof pkgFile.content === "string" ? Buffer.from(pkgFile.content, "base64").toString("utf8") : "";
      const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};

      if (scripts.check) checks.push(`${runner} check`);
      if (scripts.typecheck) checks.push(`${runner} typecheck`);
      if (scripts.test) checks.push(hasBunLock ? "bun test" : `${runner} test`);
      if (!scripts.check && !scripts.typecheck && !scripts.test && scripts.build) {
        checks.push(`${runner} build`);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        checks.push(hasBunLock ? "bun test" : "pnpm test");
      } else {
        throw err;
      }
    }

    if (checks.length === 1) {
      checks.push(hasBunLock ? "bun test" : "pnpm test");
    }

    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks,
      protectedPaths: [
        "package.json",
        ...(hasBunLock
          ? fileNames.has("bun.lock")
            ? ["bun.lock"]
            : ["bun.lockb"]
          : hasPnpmLock
            ? ["pnpm-lock.yaml"]
            : hasYarnLock
              ? ["yarn.lock"]
              : hasPackageLock
                ? ["package-lock.json"]
                : []),
      ],
      detected: hasBunLock ? "bun" : "node",
    };
  }

  if (fileNames.has("pyproject.toml") || fileNames.has("requirements.txt")) {
    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks: ["pytest"],
      protectedPaths: fileNames.has("pyproject.toml") ? ["pyproject.toml"] : ["requirements.txt"],
      detected: "python",
    };
  }

  if (fileNames.has("Cargo.toml")) {
    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks: ["cargo test"],
      protectedPaths: ["Cargo.toml", ...(fileNames.has("Cargo.lock") ? ["Cargo.lock"] : [])],
      detected: "rust",
    };
  }

  if (fileNames.has("go.mod")) {
    return {
      id,
      repo,
      defaultBranch,
      empty: false,
      checks: ["go test ./..."],
      protectedPaths: ["go.mod", ...(fileNames.has("go.sum") ? ["go.sum"] : [])],
      detected: "go",
    };
  }

  return {
    id,
    repo,
    defaultBranch,
    empty: false,
    checks: ["echo ok"],
    protectedPaths: [],
    detected: typeof repoMeta.language === "string" ? repoMeta.language.toLowerCase() : "unknown",
  };
}

/** Scaffolds starter template files into a repository via the GitHub Contents API. */
export async function bootstrapRepo(
  tokens: TokenSource,
  opts: BootstrapOptions,
  deps: GitHubDeps & { api?: string } = {},
): Promise<BootstrapResult> {
  const f = deps.fetch ?? fetch;
  const api = deps.api ?? API;
  const repo = checkRepo(opts.repo);
  const token = await tokens.token(repo, "write", deps.fetch);
  const authHeader = { authorization: `Bearer ${token}` };

  const template = opts.template ?? "ts-node";
  const rawName = repo.split("/")[1] ?? "project";
  const name = rawName.slice(0, 100);
  const rawDesc =
    typeof opts.description === "string" && opts.description.trim()
      ? opts.description.trim()
      : "Project managed by i.inc";
  const description = rawDesc.slice(0, 500);
  const sanitizeToml = (s: string) => {
    let clean = "";
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      clean += code < 32 || code === 127 ? " " : s[i];
    }
    return clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"').trim().slice(0, 500);
  };

  const tomlDesc = sanitizeToml(description);
  const tomlName = sanitizeToml(name).slice(0, 100);

  const rawBranch = typeof opts.defaultBranch === "string" ? opts.defaultBranch.trim() : "";
  const defaultBranch = rawBranch && isValidBranch(rawBranch) ? rawBranch : undefined;

  const files: Record<string, string> = {};

  if (template === "ts-node") {
    files["package.json"] = `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        scripts: {
          check: "tsc --noEmit",
          test: "vitest run",
        },
        devDependencies: {
          typescript: "^5.7.0",
          vitest: "^3.0.0",
        },
      },
      null,
      2,
    )}\n`;
    files["tsconfig.json"] = `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
        },
        include: ["src", "test"],
      },
      null,
      2,
    )}\n`;
    files["src/index.ts"] =
      `export function greet(name = "World"): string {\n  return \`Hello, \${name}!\`;\n}\n`;
    files["test/index.test.ts"] =
      `import { describe, expect, it } from "vitest";\nimport { greet } from "../src/index.js";\n\ndescribe("greet", () => {\n  it("greets by name", () => {\n    expect(greet(${JSON.stringify(name)})).toBe(${JSON.stringify(`Hello, ${name}!`)});\n  });\n});\n`;
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = "node_modules/\ndist/\n";
  } else if (template === "web") {
    files["package.json"] = `${JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        scripts: {
          check: "tsc --noEmit",
          build: "vite build",
          test: "vitest run",
        },
        devDependencies: {
          typescript: "^5.7.0",
          vite: "^6.0.0",
          vitest: "^3.0.0",
        },
      },
      null,
      2,
    )}\n`;
    files["tsconfig.json"] = `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          jsx: "preserve",
        },
        include: ["src", "test"],
      },
      null,
      2,
    )}\n`;
    files["index.html"] =
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/main.ts"></script>\n</body>\n</html>\n`;
    files["src/main.ts"] =
      `document.querySelector("#app")!.innerHTML = "<h1>" + ${JSON.stringify(name)} + "</h1>";\n`;
    files["test/main.test.ts"] =
      `import { describe, expect, it } from "vitest";\n\ndescribe("app", () => {\n  it("initializes", () => {\n    expect(true).toBe(true);\n  });\n});\n`;
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = "node_modules/\ndist/\n";
  } else if (template === "python") {
    files["pyproject.toml"] =
      `[project]\nname = "${tomlName}"\nversion = "0.1.0"\ndescription = "${tomlDesc}"\nreadme = "README.md"\nrequires-python = ">=3.11"\n\n[build-system]\nrequires = ["setuptools>=61.0"]\nbuild-backend = "setuptools.build_meta"\n`;
    files["src/__init__.py"] = '__version__ = "0.1.0"\n';
    files["tests/test_basic.py"] = "def test_basic():\n    assert True\n";
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = "__pycache__/\n*.py[cod]\n.venv/\n";
  } else {
    files["README.md"] = `# ${name}\n\n${description}\n`;
    files[".gitignore"] = ".DS_Store\n";
  }

  // Right before the first write: a repo with a commit is never written over. A bootstrap that stopped part
  // way can be carried on, but only when every commit in the repo is its own.
  const resuming = await hasCommits(f, api, repo, authHeader);
  if (resuming) {
    if (!opts.force) {
      throw new NotEmptyError("This repository already has files, so i.inc won't write a starter into it.");
    }
    if (!(await onlyScaffoldCommits(f, api, repo, authHeader, new Set(Object.keys(files)), opts.botLogin))) {
      throw new NotEmptyError(
        "This repository has files that i.inc didn't write, so i.inc won't write a starter into it.",
      );
    }
  }

  const ref = defaultBranch ? `?ref=${encodeURIComponent(defaultBranch)}` : "";
  let commits = 0;
  try {
    for (const [path, content] of Object.entries(files)) {
      if (resuming) {
        // Carrying on: a file that is there is left as it is.
        const there = await call(f, `${api}/repos/${repo}/contents/${path}${ref}`, {
          method: "GET",
          headers: authHeader,
        }).then(
          () => true,
          (err: unknown) => {
            if (err instanceof UpstreamGitHubError && err.status === 404) return false;
            throw err;
          },
        );
        if (there) continue;
      }
      let putRes: Record<string, unknown>;
      try {
        putRes = await call(f, `${api}/repos/${repo}/contents/${path}`, {
          method: "PUT",
          headers: authHeader,
          body: JSON.stringify({
            message: `Initialize ${path} (i.inc scaffold)`,
            content: Buffer.from(content, "utf8").toString("base64"),
            ...(defaultBranch ? { branch: defaultBranch } : {}),
          }),
        });
      } catch (err) {
        // The file appeared since the check, so someone else is writing here: stop, never overwrite.
        if (err instanceof UpstreamGitHubError && (err.status === 422 || err.status === 409)) {
          throw new NotEmptyError(`${path} already exists in this repository, so i.inc stopped.`);
        }
        throw err;
      }
      if (!putRes || typeof putRes !== "object" || (!putRes.commit && !putRes.content)) {
        throw new UpstreamGitHubError(
          502,
          "PUT",
          `/repos/[owner]/[repo]/contents/${path}`,
          "empty or invalid commit response",
        );
      }
      commits++;
    }
  } catch (err) {
    if (err instanceof UpstreamGitHubError || err instanceof NotEmptyError) err.written = commits;
    throw err;
  }

  return { bootstrapped: true, commits };
}
