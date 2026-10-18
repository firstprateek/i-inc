import type { AccountCost, Employee, Engine, ProjectRelease, TicketEvent } from "@i-inc/core";
import type {
  AccountRateLimit,
  DeskEntry,
  DeskView,
  KnowledgeView,
  NamedChange,
  Page,
  PendingRelease,
  PendingTicket,
  PolicyProposal,
  TicketView,
} from "@i-inc/daemon/views";

export type {
  AccountCost,
  AccountRateLimit,
  DeskEntry,
  DeskView,
  KnowledgeView,
  NamedChange,
  Page,
  PendingRelease,
  PendingTicket,
  PolicyProposal,
  ProjectRelease,
  TicketEvent,
  TicketView,
};

/** One entry of a session transcript (contract C4). */
export interface TranscriptItem {
  kind: "text" | "tool";
  text?: string;
  title?: string;
  status?: string;
  at: number;
}

/** One agent session on a ticket (contract C4, GET /api/tickets/:id/sessions). */
export interface TicketSession {
  stage: string;
  employeeId: string;
  engineId: string;
  startedAt: number;
  endedAt: number | null;
  items: TranscriptItem[];
}

/** What POST /api/tickets takes from the owner (daemon NewTicket). */
export interface NewTicketBody {
  title: string;
  project: string;
  type: "fix" | "feat" | "chore" | "errand";
  effort: "low" | "medium" | "high";
  doneWhen: string[];
}

export interface OfficeResponse {
  employees: DeskEntry[];
  accounts?: AccountCost[];
  rateLimits?: Record<string, AccountRateLimit>;
}

import { isGatewayDown, report } from "./connection.ts";
import { showLogin } from "./login.ts";

/** fetch, plus telling the app whether the daemon answered (see connection.ts). */
export async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    report(false);
    throw new Error("Can't reach i.inc");
  }
  report(!isGatewayDown(res.status));
  return res;
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Every write is JSON, even an empty one: the daemon refuses anything else (api.ts).
  const write = method !== "GET";
  const res = await send(path, {
    method,
    headers: write ? { "content-type": "application/json" } : {},
    ...(write ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  if (res.status === 401) showLogin();
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${method} ${path}: ${res.status}`);
  return data;
}

export async function authStatus(): Promise<{ initialized: boolean }> {
  const res = await send("/api/auth");
  return (await res.json()) as { initialized: boolean };
}

export async function signup(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await send("/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return res.ok ? { ok: true } : { ok: false, ...(data.error ? { error: data.error } : {}) };
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await send("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return res.ok ? { ok: true } : { ok: false, ...(data.error ? { error: data.error } : {}) };
}

export async function logout(): Promise<void> {
  await send("/api/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  showLogin();
}

/** The ticket's session transcripts, or null when the daemon has no such endpoint or ticket (404). */
async function sessions(id: string): Promise<TicketSession[] | null> {
  const res = await send(`/api/tickets/${encodeURIComponent(id)}/sessions`);
  if (res.status === 404) return null;
  if (res.status === 401) showLogin();
  if (!res.ok) throw new Error(`GET sessions: ${res.status}`);
  return ((await res.json()) as { sessions: TicketSession[] }).sessions;
}

export const api = {
  sessions,
  authStatus,
  signup,
  login,
  logout,
  board: () => call<{ tickets: TicketView[] }>("GET", "/api/board").then((r) => r.tickets),
  projects: () => call<{ projects: { id: string }[] }>("GET", "/api/projects").then((r) => r.projects),
  createTicket: (t: NewTicketBody) => call<{ ticket: { id: string } }>("POST", "/api/tickets", t),
  office: () => call<OfficeResponse>("GET", "/api/office"),
  desk: () => call<DeskView>("GET", "/api/desk"),
  releases: () => call<{ releases: ProjectRelease[]; pending: PendingRelease[] }>("GET", "/api/releases"),
  cutRelease: (id: string, tag?: string) =>
    call<{ release: ProjectRelease }>(
      "POST",
      `/api/projects/${encodeURIComponent(id)}/release`,
      tag ? { tag } : {},
    ),
  ticket: (id: string) => call<{ ticket: TicketView; events: TicketEvent[] }>("GET", `/api/tickets/${id}`),
  answer: (id: string, answer: "approve" | "reject" | "builder" | "reviewer", note?: string) =>
    call("POST", `/api/tickets/${id}/answer`, note ? { answer, note } : { answer }),
  engines: () => call<{ engines: Engine[] }>("GET", "/api/engines").then((r) => r.engines),
  hire: (e: Partial<Employee>) => call<{ employee: Employee }>("POST", "/api/employees", e),
  employees: () => call<{ employees: Employee[] }>("GET", "/api/employees").then((r) => r.employees),
  updateEmployee: (id: string, e: Partial<Employee>) =>
    call<{ employee: Employee }>("PUT", `/api/employees/${encodeURIComponent(id)}`, e),
  teams: () =>
    call<{ teams: { id: string; name: string; members: (string | { id: string; name?: string })[] }[] }>(
      "GET",
      "/api/teams",
    ).then((r) => r.teams),
  handbook: () => call<KnowledgeView>("GET", "/api/knowledge/handbook"),
  brain: (id: string) => call<KnowledgeView>("GET", `/api/knowledge/brains/${id}`),
  learned: () => call<{ changes: NamedChange[] }>("GET", "/api/knowledge/recent").then((r) => r.changes),
  revert: (repo: string, commit: string) => call("POST", `/api/knowledge/${repo}/revert`, { commit }),
  decidePolicy: (id: string, approved: boolean) =>
    call("POST", `/api/knowledge/policies/${encodeURIComponent(id)}`, { approved }),
  decide: (id: string, decision: "approve" | "changes" | "reject", note?: string) =>
    call("POST", `/api/tickets/${id}/decide`, note ? { decision, note } : { decision }),
  retry: (id: string): Promise<void> => call("POST", `/api/tickets/${id}/retry`, {}),
  retryTicket: (id: string): Promise<void> => call("POST", `/api/tickets/${id}/retry`, {}),
};

/** What changed, when a refresh comes from the live event stream. A refresh without one is for everything. */
export interface RefreshScope {
  tickets: Set<string>;
  office: boolean;
}

/** Tells every view to refetch: after an action, on a live event, and on a timer. */
export const refresh = new EventTarget();
export const refreshNow = (scope?: RefreshScope) =>
  refresh.dispatchEvent(new CustomEvent<RefreshScope | undefined>("refresh", { detail: scope }));
