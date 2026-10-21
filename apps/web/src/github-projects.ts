// The GitHub projects flow's non-visual parts (T62, contract C14): the shapes the daemon answers with, a
// request helper that keeps GitHub's problems readable, the links to GitHub, names, and the new-project
// draft that survives a reload. The components are setup-projects.ts, project-flow.ts and project-page.ts.
import { send } from "./api.ts";
import { showLogin } from "./login.ts";
import type { GitHubInspectResult, GitHubRepoSummary, MergeMode, Project } from "./setup-api.ts";

export type { GitHubInspectResult, GitHubRepoSummary };

export type ProblemCode =
  | "rate-limited"
  | "timeout"
  | "unreachable"
  | "auth"
  | "forbidden"
  | "not-found"
  | "refused"
  | "unavailable"
  | "unknown"
  | "not-accessible"
  | "not-empty"
  | "cannot-create"
  | "in-progress";

/** What the daemon said went wrong, in words for the owner (it never carries GitHub's own text). */
export class ApiProblem extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly extra: {
      code?: ProblemCode;
      retryAfter?: number;
      resumable?: boolean;
      reason?: string;
      manualUrl?: string;
    } = {},
  ) {
    super(message);
    this.name = "ApiProblem";
  }
  get code(): ProblemCode | undefined {
    return this.extra.code;
  }
}

/**
 * A daemon call that keeps the answer's `code`, `retryAfter`, `resumable` and `manualUrl`. A 401 from the
 * daemon signs the owner out (it's the login); a GitHub problem never does, because the daemon never
 * passes GitHub's 401 on. A network failure is "Can't reach i.inc", and nothing else is.
 */
export async function ghCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  const res = await send(path, {
    method,
    headers: write ? { "content-type": "application/json" } : {},
    ...(write ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  if (res.status === 401) showLogin();
  const data = (await res.json().catch(() => ({}))) as T & Record<string, unknown>;
  if (!res.ok) {
    const extra: ApiProblem["extra"] = {};
    if (typeof data.code === "string") extra.code = data.code as ProblemCode;
    if (typeof data.retryAfter === "number") extra.retryAfter = data.retryAfter;
    if (data.resumable === true) extra.resumable = true;
    if (typeof data.reason === "string") extra.reason = data.reason;
    if (typeof data.manualUrl === "string") extra.manualUrl = data.manualUrl;
    const text =
      typeof data.error === "string" && data.error
        ? data.error
        : "i.inc ran into a problem it didn't explain. Try again in a minute.";
    throw new ApiProblem(text, res.status, extra);
  }
  return data;
}

/** A problem as one line for the owner, with how long to wait when GitHub asked for that. */
export function problemText(e: unknown): string {
  if (e instanceof ApiProblem) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// ---- the daemon's answers ----

export interface GitHubStatus {
  configured: boolean;
  installation: null | {
    account: string | null;
    accountType: "Organization" | "User" | "unknown";
    repositorySelection: "all" | "selected" | "unknown";
  };
  create: {
    possible: boolean;
    reason: "not-configured" | "personal-account" | "missing-permission" | "unknown" | null;
    detail: string;
  };
  links: { install: string; manage: string; appPermissions: string | null };
  problem?: { code: ProblemCode; error: string };
}

export interface RepoList {
  configured: boolean;
  repos: GitHubRepoSummary[];
  fetchedAt?: number;
  warning?: { code: ProblemCode; error: string };
}

export interface ProjectStatus {
  id: string;
  repo: string;
  repoUrl: string | null;
  mode: MergeMode;
  checks: string[];
  defaultBranch?: string;
  lastTicket: { id: string; title: string; at: number; status: string } | null;
  openTickets: number;
  openPrs: { ticketId: string; number?: number; url: string }[];
}

export interface ProjectDetail extends ProjectStatus {
  project: Project;
  policy: { mode: MergeMode; protectedPaths: string[]; followUpsPerDay: number; autoRelease: boolean };
  tickets: { id: string; title: string; type: string; at: number; status: string }[];
  releases: { project: string; tag: string; at: number; ticketIds: string[]; commits: string[] }[];
}

export const projectsApi = {
  status: () => ghCall<GitHubStatus>("GET", "/api/github/status"),
  repos: (refresh = false) => ghCall<RepoList>("GET", `/api/github/repos${refresh ? "?refresh=1" : ""}`),
  createRepo: (body: { name: string; visibility: "private" | "public"; description?: string }) =>
    ghCall<{ repo: { fullName: string; defaultBranch: string; private: boolean } }>(
      "POST",
      "/api/github/repos",
      body,
    ),
  overview: () =>
    ghCall<{ projects: ProjectStatus[] }>("GET", "/api/project-overview").then((r) => r.projects),
  detail: (id: string) => ghCall<ProjectDetail>("GET", `/api/projects/${encodeURIComponent(id)}`),
};

// ---- links and names ----

/** Where the owner starts a conversation on a project: the Conversations screen reads `new` and `project`. */
export const conversationHref = (project: string) =>
  `#/conversations?new=1&project=${encodeURIComponent(project)}`;

export const projectHref = (id: string) => `#/company/projects/${encodeURIComponent(id)}`;
export const addRepoHref = (repo: string) => `#/company/projects/add?repo=${encodeURIComponent(repo)}`;
export const NEW_PROJECT_HREF = "#/company/projects/new";
export const ADD_PROJECT_HREF = "#/company/projects/add";

/** GitHub's own "create a repository" page, filled in. The same link the daemon builds on a refusal. */
export function newRepoLink(name: string, visibility: "private" | "public"): string {
  return `https://github.com/new?name=${encodeURIComponent(name)}&visibility=${encodeURIComponent(visibility)}`;
}

/** A repo name GitHub accepts (letters, digits, dots, dashes, underscores; not just dots; not ending .git). */
export function repoNameProblem(name: string): string | null {
  if (!name) return "Give the project a name.";
  if (name.length > 100) return "A repository name is at most 100 characters.";
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return "Use letters, digits, dots, dashes and underscores only (no spaces).";
  }
  if (/^\.+$/.test(name) || name.endsWith(".git") || name.startsWith(".") || name.endsWith(".")) {
    return "A repository name can't start or end with a dot, or end in .git.";
  }
  return null;
}

/** A project's id from its repo's name: lowercase, with dashes. */
export function projectIdFromRepo(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return id;
}

/** Why a project name can't be used, or null. Matches the daemon (api.ts projectIdProblem). */
export function projectIdProblem(id: string, existing: string[] = []): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(id)) {
    return "A project name is up to 40 letters, digits, spaces, dots and dashes.";
  }
  if (["add", "new"].includes(id.trim().toLowerCase()))
    return `"${id}" is kept for the app's own pages: pick another name.`;
  if (existing.some((e) => e.toLowerCase() === id.toLowerCase()))
    return `There is already a project called ${id}.`;
  return null;
}

export const MODE_WORDS: Record<MergeMode, { label: string; sentence: string }> = {
  direct: {
    label: "Direct",
    sentence: "After i.inc's own review, finished work is pushed straight to the main branch.",
  },
  "owner-merges": {
    label: "Owner merges",
    sentence: "Finished work waits as a pull request, and only you merge it.",
  },
};

export const TEMPLATES = [
  {
    id: "ts-node",
    title: "TypeScript + Node",
    blurb: "A TypeScript package with a Vitest test.",
    checks: ["pnpm install", "pnpm test"],
  },
  {
    id: "web",
    title: "Web app",
    blurb: "A Vite + TypeScript page with a test.",
    checks: ["pnpm install", "pnpm check", "pnpm test", "pnpm build"],
  },
  { id: "python", title: "Python", blurb: "A pyproject with a pytest test.", checks: ["pytest"] },
  { id: "minimal", title: "Minimal", blurb: "A README and a .gitignore.", checks: ["echo ok"] },
] as const;
export type TemplateId = (typeof TEMPLATES)[number]["id"];

/** "3 minutes ago", "2 days ago": short, for a status line. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ---- the new-project draft ----

/** A new project in progress. It lives in this browser so a reload picks up where the steps stood. */
export interface NewProjectDraft {
  name: string;
  visibility: "private" | "public";
  template: TemplateId;
  mode: MergeMode;
  description: string;
  /** Who creates the repo: the bot, or the owner on GitHub. */
  via: "bot" | "manual";
  /** The bot was asked to create it (so a reload doesn't ask twice). */
  createAsked?: boolean;
  /** Starter files were started (so a repo with files is ours to finish, not someone else's). */
  fillStarted?: boolean;
}

const DRAFT_KEY = "inc.new-project";

export const draftStore = {
  read(): NewProjectDraft | null {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw) as Partial<NewProjectDraft>;
      if (typeof d.name !== "string" || repoNameProblem(d.name)) return null;
      return {
        name: d.name,
        visibility: d.visibility === "public" ? "public" : "private",
        template: TEMPLATES.some((t) => t.id === d.template) ? (d.template as TemplateId) : "ts-node",
        mode: d.mode === "owner-merges" ? "owner-merges" : "direct",
        description: typeof d.description === "string" ? d.description.slice(0, 350) : "",
        via: d.via === "bot" ? "bot" : "manual",
        ...(d.createAsked ? { createAsked: true } : {}),
        ...(d.fillStarted ? { fillStarted: true } : {}),
      };
    } catch {
      return null;
    }
  },
  write(d: NewProjectDraft): void {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch {
      // Private mode: the steps still run, they just won't survive a reload.
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Nothing was stored.
    }
  },
};
