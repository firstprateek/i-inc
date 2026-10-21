// What the Setup screens read and write: teams, projects, engines, accounts and sandbox status.
// Kept apart from api.ts so the views that share that file don't collide with these.
import type { AccountCost } from "@i-inc/core";
import { call } from "./api.ts";
import { ghCall } from "./github-projects.ts";
import type { Engine } from "./providers.ts";

export type { Harness } from "./providers.ts";
export { engineIsLocal, engineLabel, harnesses, harnessOptions } from "./providers.ts";
export type { AccountCost, Engine };

export interface Team {
  id: string;
  name: string;
  members: string[];
  /** The sandbox's size. Absent means the default (6 CPUs, 12G). */
  sandbox?: { cpus: number; memory: string };
}

export type MergeMode = "direct" | "owner-merges";

export interface Project {
  id: string;
  repo: string;
  checks: string[];
  mode?: MergeMode;
  protectedPaths?: string[];
  followUpsPerDay?: number;
  autoRelease?: boolean;
  defaultBranch?: string;
}

export interface ProjectBody {
  repo: string;
  checks: string[];
  mode: MergeMode;
  protectedPaths: string[];
  followUpsPerDay: number;
  autoRelease: boolean;
  defaultBranch?: string;
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

export interface BootstrapProjectBody {
  repo: string;
  mode?: MergeMode;
  template?: "ts-node" | "web" | "python" | "minimal";
  description?: string;
  employees?: string[];
  checks?: string[];
  protectedPaths?: string[];
  autoRelease?: boolean;
  force?: boolean;
  defaultBranch?: string;
}

/** One sandbox in `GET /api/sandboxes` (contract C1 in docs/coord.md). */
export interface Sandbox {
  team: string;
  machine: string;
  state: "running" | "stopped" | "missing" | "error";
  cpus: number;
  memory: string;
  signedIn: { claude: boolean; antigravity: boolean; github: boolean; codex?: boolean };
  /** The machine's launcher writes no agent notes (made before they existed): run update-machine.sh for the team. */
  launcher?: "needs-update";
  reason?: string;
  kind?: string;
  retryAt?: number;
}

/** The daemon's defaults for a project with no policy of its own (defaultProjectPolicy in the core). */
export const policyDefaults = {
  mode: "direct" as MergeMode,
  protectedPaths: [".github/", "release-please-config.json", ".release-please-manifest.json"],
  followUpsPerDay: 3,
  autoRelease: false,
};

/** A sandbox with no size of its own is this big. */
export const defaultSandbox = { cpus: 6, memory: "12G" };

/** Where the owner first installs the i.inc bot on GitHub. */
export const GITHUB_INSTALL_URL = "https://github.com/apps/i-inc-bot/installations/new";
/** Where the repositories an installed bot can see are managed (any installed GitHub App). */
export const GITHUB_MANAGE_URL = "https://github.com/settings/installations";

const enc = encodeURIComponent;

export const setupApi = {
  teams: () => call<{ teams: Team[] }>("GET", "/api/teams").then((r) => r.teams),
  saveTeam: (t: Team) =>
    call<{ team: Team }>("PUT", `/api/teams/${enc(t.id)}`, {
      name: t.name,
      members: t.members,
      ...(t.sandbox ? { sandbox: t.sandbox } : {}),
    }),
  projects: () => call<{ projects: Project[] }>("GET", "/api/projects").then((r) => r.projects),
  saveProject: (id: string, body: ProjectBody) => call("PUT", `/api/projects/${enc(id)}`, body),
  deleteProject: (id: string) => call<{ ok: boolean }>("DELETE", `/api/projects/${enc(id)}`),
  githubRepos: () => ghCall<{ repos: GitHubRepoSummary[] }>("GET", "/api/github/repos").then((r) => r.repos),
  inspectRepo: (owner: string, name: string) =>
    ghCall<GitHubInspectResult>("GET", `/api/github/repos/${enc(owner)}/${enc(name)}/inspect`),
  bootstrapProject: (id: string, body: BootstrapProjectBody) =>
    ghCall<{ project: Project; bootstrapped: boolean; commits: number }>(
      "POST",
      `/api/projects/${enc(id)}/bootstrap`,
      body,
    ),
  engines: () => call<{ engines: Engine[] }>("GET", "/api/engines").then((r) => r.engines),
  accounts: () => call<{ accounts: AccountCost[] }>("GET", "/api/accounts").then((r) => r.accounts),
  saveAccount: (a: AccountCost) =>
    call<{ account: AccountCost }>("PUT", `/api/accounts/${enc(a.id)}`, {
      name: a.name,
      ...(a.monthlyFee !== undefined ? { monthlyFee: a.monthlyFee } : {}),
      ...(a.pricePerMillionTokens !== undefined ? { pricePerMillionTokens: a.pricePerMillionTokens } : {}),
      ...(a.monthlyCap !== undefined ? { monthlyCap: a.monthlyCap } : {}),
    }),
  saveEngine: (e: Engine) =>
    call<{ engine: Engine }>("PUT", `/api/engines/${enc(e.id)}`, {
      harness: e.harness,
      model: e.model,
      accountId: e.accountId,
      local: e.harness === "codex" ? false : e.local,
    }),
  /** null when the daemon has no such endpoint yet (PR #36), or it fails. */
  sandboxes: (): Promise<Sandbox[] | null> =>
    call<{ sandboxes: Sandbox[] }>("GET", "/api/sandboxes").then(
      (r) => (Array.isArray(r.sandboxes) ? r.sandboxes : null),
      () => null,
    ),
  retrySandbox: (team: string): Promise<Sandbox> =>
    call<{ ok: boolean; sandbox: Sandbox }>("POST", `/api/sandboxes/${enc(team)}/retry`, {}).then(
      (r) => r.sandbox,
    ),
};
