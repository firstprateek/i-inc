// What the Setup screens read and write: teams, projects, engines, accounts and sandbox status.
// Kept apart from api.ts so the views that share that file don't collide with these.
import type { AccountCost, Engine } from "@i-inc/core";
import { call } from "./api.ts";

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
}

export interface ProjectBody {
  repo: string;
  checks: string[];
  mode: MergeMode;
  protectedPaths: string[];
  followUpsPerDay: number;
  autoRelease: boolean;
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
  signedIn: { claude: boolean; antigravity: boolean; github: boolean };
}

export type Harness = Engine["harness"];
export const harnesses: Harness[] = ["claude-code", "antigravity", "opencode"];

/** The daemon's defaults for a project with no policy of its own (defaultProjectPolicy in the core). */
export const policyDefaults = {
  mode: "direct" as MergeMode,
  protectedPaths: [".github/", "release-please-config.json", ".release-please-manifest.json"],
  followUpsPerDay: 3,
  autoRelease: false,
};

/** A sandbox with no size of its own is this big. */
export const defaultSandbox = { cpus: 6, memory: "12G" };

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
  githubRepos: () => call<{ repos: GitHubRepoSummary[] }>("GET", "/api/github/repos").then((r) => r.repos),
  inspectRepo: (owner: string, name: string) =>
    call<GitHubInspectResult>("GET", `/api/github/repos/${enc(owner)}/${enc(name)}/inspect`),
  bootstrapProject: (id: string, body: BootstrapProjectBody) =>
    call<{ project: Project; bootstrapped: boolean; commits: number }>(
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
      local: e.local,
    }),
  /** null when the daemon has no such endpoint yet (PR #36), or it fails. */
  sandboxes: (): Promise<Sandbox[] | null> =>
    call<{ sandboxes: Sandbox[] }>("GET", "/api/sandboxes").then(
      (r) => (Array.isArray(r.sandboxes) ? r.sandboxes : null),
      () => null,
    ),
};
