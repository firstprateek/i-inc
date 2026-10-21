// The GitHub side of the projects flow (T62, contract C14): what the bot can see, whether it may create
// repos, and creating one. It sits between the API routes and github.ts and owns three things:
//   - a short cache of the repo list and of the installation, so a screen refresh costs no GitHub call;
//   - a limit on how many calls the owner's clicks can make in a minute (GitHub rate-limits an App);
//   - one place that turns any GitHub failure into a sentence for the owner, never a raw error.
// The installation token is minted in github.ts and used only inside the calls made there. It never
// comes back from this file, so it can't reach the browser or a log line.
import {
  createOrgRepo,
  fetchInstallationRepos,
  type GitHubDeps,
  type InstallationInfo,
  type InstallationRepo,
  isValidRepo,
  type TokenSource,
  UpstreamGitHubError,
} from "./github.ts";

/** The bot's public name until the App says otherwise (GitHub App `i-inc-bot`, docs/github-app.md). */
const DEFAULT_SLUG = "i-inc-bot";
const enc = encodeURIComponent;

/** How long the repo list is reused. */
export const REPO_CACHE_MS = 30_000;
/** "Refresh" asks GitHub again, but not more often than this. */
export const REFRESH_FLOOR_MS = 3_000;
/** How long the installation (account type, permissions) is reused. */
const INSTALLATION_CACHE_MS = 60_000;
/** The most GitHub calls the projects flow makes in a minute. The App's own limit is far higher. */
export const CALLS_PER_MINUTE = 60;

export type ProblemCode =
  | "rate-limited"
  | "timeout"
  | "unreachable"
  | "auth"
  | "forbidden"
  | "not-found"
  | "refused"
  | "unavailable"
  | "unknown";

/** A GitHub failure in the owner's words, with the HTTP status the daemon answers with. */
export interface GitHubProblem {
  status: number;
  code: ProblemCode;
  error: string;
  /** Seconds to wait, when GitHub (or our own limit) said. */
  retryAfter?: number;
}

const wait = (s?: number) =>
  s === undefined
    ? "in a minute"
    : s < 90
      ? `in about ${Math.max(5, s)} seconds`
      : `in about ${Math.ceil(s / 60)} minutes`;

/**
 * What to tell the owner when a GitHub call failed, and what to do about it. Upstream failures answer
 * 424 (a dependency failed) and a rate limit 429: never 401, which would sign the owner out, and never
 * 502/503/504, which the web app reads as "the daemon is down". Nothing from GitHub's body is echoed.
 */
export function describeGitHubError(e: unknown): GitHubProblem {
  if (!(e instanceof UpstreamGitHubError)) {
    return {
      status: 424,
      code: "unknown",
      error: "Something went wrong talking to GitHub. Try again in a minute.",
    };
  }
  if (e.rateLimited) {
    const retryAfter = e.retryAfterSec;
    return {
      status: 429,
      code: "rate-limited",
      error:
        e.detail === LOCAL_LIMIT
          ? `That was a lot of GitHub requests in a short time, so i.inc is pausing. Try again ${wait(retryAfter)}.`
          : `GitHub is asking i.inc to slow down. Try again ${wait(retryAfter)}.`,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
  if (e.status === 504) {
    return {
      status: 424,
      code: "timeout",
      error: "GitHub didn't answer in time. Wait a minute and try again.",
    };
  }
  if (e.status === 502 && e.detail === "network error") {
    return {
      status: 424,
      code: "unreachable",
      error: "i.inc couldn't reach GitHub from the Mac mini. Check its internet connection, then try again.",
    };
  }
  if (e.status === 401) {
    return {
      status: 424,
      code: "auth",
      error:
        "GitHub didn't accept i.inc's sign-in as the bot. The GitHub App's key or ids may be wrong or expired: see docs/github-app.md.",
    };
  }
  if (e.status === 403) {
    return {
      status: 424,
      code: "forbidden",
      error:
        "GitHub says the i.inc bot isn't allowed to do that. Check what the bot was granted on its GitHub settings page.",
    };
  }
  if (e.status === 404) {
    return {
      status: 424,
      code: "not-found",
      error:
        "GitHub can't find that, or the i.inc bot can't see it. Give i.inc access to the repository, then refresh.",
    };
  }
  if (e.status === 409 || e.status === 422) {
    return {
      status: 424,
      code: "refused",
      error:
        "GitHub refused it. A repository with that name may already exist: pick another name, or refresh to see it.",
    };
  }
  if (e.status >= 500) {
    return {
      status: 424,
      code: "unavailable",
      error: "GitHub is having trouble right now. Try again in a few minutes.",
    };
  }
  return { status: 424, code: "unknown", error: "GitHub didn't accept that request. Try again in a minute." };
}

/** What the owner's own limit trips with. */
const LOCAL_LIMIT = "i.inc limit";

export type CreateBlock = "not-configured" | "personal-account" | "missing-permission" | "unknown";

export interface GitHubStatus {
  configured: boolean;
  installation: null | {
    account: string | null;
    accountType: InstallationInfo["accountType"];
    repositorySelection: InstallationInfo["repositorySelection"];
  };
  /** Whether the bot can create a repo itself. GitHub allows it in an organization, with Administration: write. */
  create: { possible: boolean; reason: CreateBlock | null; detail: string };
  links: {
    /** Install the bot (or add it to another account). */
    install: string;
    /** This installation's settings: which repos the bot can see. */
    manage: string;
    /** The App's permissions, where its owner can add Administration. Null when not known. */
    appPermissions: string | null;
  };
  /** Set when the installation couldn't be read just now. */
  problem?: { code: ProblemCode; error: string };
}

export interface RepoList {
  repos: InstallationRepo[];
  /** Epoch ms of the GitHub call this list comes from. */
  fetchedAt: number;
  /** Set when GitHub failed and this is the last good list. */
  warning?: { code: ProblemCode; error: string };
}

export interface ServiceOptions extends GitHubDeps {
  now: () => number;
  api?: string;
  /** Called with the failed call's route and status only; never a token or a body. */
  log?: (msg: string) => void;
}

/** A repo name GitHub accepts, before an owner is attached. */
export const isValidRepoName = (name: unknown): name is string =>
  typeof name === "string" && isValidRepo(`owner/${name}`);

/** The link that opens GitHub's own "create a repository" page, filled in. Both parts are encoded. */
export function newRepoUrl(name: string, visibility: "private" | "public"): string {
  return `https://github.com/new?name=${enc(name)}&visibility=${enc(visibility)}`;
}

export class GitHubProjects {
  private list: RepoList | null = null;
  private listing: Promise<RepoList> | null = null;
  private lastAsk = 0;
  private info: { at: number; value: InstallationInfo } | null = null;
  private readonly calls: number[] = [];
  private readonly creating = new Set<string>();

  constructor(
    private readonly tokens: TokenSource | undefined,
    private readonly o: ServiceOptions,
  ) {}

  get configured(): boolean {
    return this.tokens !== undefined;
  }

  /** The deps github.ts takes: the limited fetch, and the API base a test or e2e stub points at. */
  private deps(): GitHubDeps & { api?: string } {
    return { fetch: this.limited, ...(this.o.api ? { api: this.o.api } : {}) };
  }

  private readonly limited = ((input: RequestInfo | URL, init?: RequestInit) => {
    const now = this.o.now();
    while (this.calls.length && now - (this.calls[0] ?? 0) >= 60_000) this.calls.shift();
    if (this.calls.length >= CALLS_PER_MINUTE) {
      const err = new UpstreamGitHubError(429, "GET", "/", LOCAL_LIMIT);
      err.rateLimited = true;
      err.retryAfterSec = Math.max(1, Math.ceil((60_000 - (now - (this.calls[0] ?? now))) / 1000));
      return Promise.reject(err);
    }
    this.calls.push(now);
    return (this.o.fetch ?? globalThis.fetch)(input, init);
  }) as typeof fetch;

  /** What the owner's clicks may spend of the minute's calls: other code (inspect, bootstrap) goes through this too. */
  get fetchDeps(): GitHubDeps & { api?: string } {
    return this.deps();
  }

  /** The tokens, for the github.ts calls that take them. Only code in the daemon calls this. */
  get source(): TokenSource {
    if (!this.tokens) throw new Error("GitHub is not configured");
    return this.tokens;
  }

  /** Forget the cached list: a repo was just created or filled. */
  invalidate(): void {
    this.list = null;
    this.lastAsk = 0;
  }

  /**
   * The repos the bot can see. Reused for 30 seconds; `refresh` asks GitHub again (at most every few
   * seconds). When GitHub fails and an older list exists, that list comes back with a warning.
   */
  async repos(refresh = false): Promise<RepoList> {
    const now = this.o.now();
    const fresh = this.list && now - this.list.fetchedAt < REPO_CACHE_MS;
    if (this.list && fresh && (!refresh || now - this.lastAsk < REFRESH_FLOOR_MS)) return this.list;
    if (this.listing) return this.listing;
    this.lastAsk = now;
    this.listing = fetchInstallationRepos(this.source, this.deps())
      .then((repos) => {
        this.list = { repos, fetchedAt: this.o.now() };
        return this.list;
      })
      .catch((e: unknown) => {
        this.o.log?.(`[github] listing repos failed: ${logLine(e)}`);
        if (!this.list) throw e;
        const p = describeGitHubError(e);
        return { ...this.list, warning: { code: p.code, error: p.error } };
      })
      .finally(() => {
        this.listing = null;
      });
    return this.listing;
  }

  /** Whether the bot can see `repo` ("owner/name"); asks GitHub again once if the cached list is a few seconds old. */
  async canSee(repo: string): Promise<boolean> {
    const lower = repo.toLowerCase();
    const has = (l: RepoList) => l.repos.some((r) => r.fullName.toLowerCase() === lower);
    const first = await this.repos();
    if (has(first)) return true;
    return has(await this.repos(true));
  }

  /** The installation, from the App, reused for a minute. Null when only a stand-in token is configured. */
  async installation(): Promise<InstallationInfo | null> {
    if (!this.tokens?.installation) return null;
    const now = this.o.now();
    if (this.info && now - this.info.at < INSTALLATION_CACHE_MS) return this.info.value;
    const value = await this.tokens.installation();
    this.info = { at: now, value };
    return value;
  }

  async status(): Promise<GitHubStatus> {
    const install = `https://github.com/apps/${DEFAULT_SLUG}/installations/new`;
    if (!this.tokens) {
      return {
        configured: false,
        installation: null,
        create: {
          possible: false,
          reason: "not-configured",
          detail: "The GitHub App isn't set up yet, so i.inc can't see any repos. See docs/github-app.md.",
        },
        links: { install, manage: "https://github.com/settings/installations", appPermissions: null },
      };
    }
    let info: InstallationInfo | null = null;
    let problem: GitHubStatus["problem"];
    try {
      info = await this.installation();
    } catch (e) {
      this.o.log?.(`[github] reading the installation failed: ${logLine(e)}`);
      const p = describeGitHubError(e);
      problem = { code: p.code, error: p.error };
    }
    const slug = info?.slug ?? DEFAULT_SLUG;
    const manage = info
      ? info.accountType === "Organization" && info.account
        ? `https://github.com/organizations/${enc(info.account)}/settings/installations/${enc(info.id)}`
        : `https://github.com/settings/installations/${enc(info.id)}`
      : "https://github.com/settings/installations";
    const create = this.createAbility(info, !!problem);
    return {
      configured: true,
      installation: info
        ? {
            account: info.account,
            accountType: info.accountType,
            repositorySelection: info.repositorySelection,
          }
        : null,
      create,
      links: {
        install: `https://github.com/apps/${enc(slug)}/installations/new`,
        manage,
        appPermissions: info ? `https://github.com/settings/apps/${enc(slug)}/permissions` : null,
      },
      ...(problem ? { problem } : {}),
    };
  }

  private createAbility(info: InstallationInfo | null, failed: boolean): GitHubStatus["create"] {
    if (!info) {
      return {
        possible: false,
        reason: "unknown",
        detail: failed
          ? "i.inc couldn't check what the bot may do on GitHub just now, so create the empty repo yourself."
          : "i.inc can't tell whether the bot may create repos, so create the empty repo yourself.",
      };
    }
    if (info.accountType !== "Organization") {
      return {
        possible: false,
        reason: "personal-account",
        detail:
          "GitHub doesn't let a bot create repos in a personal account, only in an organization. Create the empty repo yourself and give the bot access; i.inc fills it.",
      };
    }
    if (info.permissions.administration !== "write") {
      return {
        possible: false,
        reason: "missing-permission",
        detail:
          "The bot isn't allowed to create repos in this organization (it lacks the Administration permission). Create the empty repo yourself and give the bot access, or let the bot create repos by granting that permission.",
      };
    }
    return {
      possible: true,
      reason: null,
      detail: `The bot can create the repo in ${info.account ?? "your organization"} for you.`,
    };
  }

  /**
   * Creates an empty repo in the organization the App is installed on. Refuses (reason in the error)
   * when GitHub wouldn't allow it, so the flow falls back to the manual steps.
   */
  async create(o: {
    name: string;
    visibility: "private" | "public";
    description?: string;
  }): Promise<{ fullName: string; defaultBranch: string; private: boolean }> {
    const status = await this.status();
    const info = await this.installation().catch(() => null);
    if (!status.create.possible || !info?.account) throw new CannotCreate(status.create);
    const key = `${info.account}/${o.name}`.toLowerCase();
    if (this.creating.has(key)) throw new CreateInProgress();
    this.creating.add(key);
    try {
      const made = await createOrgRepo(
        this.source,
        {
          owner: info.account,
          name: o.name,
          private: o.visibility === "private",
          ...(o.description ? { description: o.description } : {}),
        },
        this.deps(),
      );
      return made;
    } finally {
      this.creating.delete(key);
      this.invalidate();
    }
  }
}

export class CannotCreate extends Error {
  constructor(readonly create: GitHubStatus["create"]) {
    super("the bot can't create a repo here");
  }
}

export class CreateInProgress extends Error {
  constructor() {
    super("that repo is already being created");
  }
}

/** A log line about a failed call: method, route and status, never a body, a header or a token. */
export function logLine(e: unknown): string {
  if (e instanceof UpstreamGitHubError) return `${e.method} ${e.endpoint} -> HTTP ${e.status}`;
  return e instanceof Error ? e.name : "error";
}
