import type { AccountCost, Employee, ProjectRelease, TicketEvent } from "@i-inc/core";
import type {
  AccountRateLimit,
  BrainChangesView,
  BrainChangeView,
  DeskEntry,
  DeskView,
  KnowledgeView,
  NamedChange,
  Page,
  PendingRelease,
  PendingTicket,
  PolicyProposal,
  ProposalView,
  ShipBrief,
  ShipView,
  TicketView,
} from "@i-inc/daemon/views";
import type { Engine } from "./providers.ts";

export type {
  AccountCost,
  AccountRateLimit,
  BrainChangesView,
  BrainChangeView,
  DeskEntry,
  DeskView,
  KnowledgeView,
  NamedChange,
  Page,
  PendingRelease,
  PendingTicket,
  PolicyProposal,
  ProjectRelease,
  ProposalView,
  ShipBrief,
  ShipView,
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
  /** The brain pages this session was given or opened (contract C19); absent when there were none. */
  brain?: BrainUse[];
}

/** A brain page that went into a session, or that the agent opened (contract C19). */
export interface BrainUse {
  scope: string;
  slug: string;
  title: string;
  updated: string | null;
  via: "search" | "link" | "read";
  untrusted?: boolean;
}

/** What POST /api/tickets takes from the owner (daemon NewTicket). */
export interface NewTicketBody {
  title: string;
  project: string;
  type: "fix" | "feat" | "chore" | "errand";
  effort: "low" | "medium" | "high";
  doneWhen: string[];
  /** Who does it. Left out, nobody is assigned and only a standing order can pick it up. */
  assignee?: string;
}

/** The images a ticket takes; the daemon checks them again, by their bytes (#12, #15). */
export const imageRules = {
  types: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  /** At a time. */
  count: 6,
  bytes: 10 * 1024 * 1024,
  /** On one ticket, in all. */
  perTicket: 24,
};

/**
 * Sends images, with any JSON `fields`, as one multipart request. The `x-i-inc-upload` header is
 * what lets the daemon take a write that isn't JSON.
 */
async function upload<T>(path: string, images: File[], fields: Record<string, unknown> = {}): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, JSON.stringify(v));
  for (const f of images) form.append("image", f, f.name);
  const res = await send(path, { method: "POST", headers: { "x-i-inc-upload": "1" }, body: form });
  if (res.status === 401) showLogin();
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `POST ${path}: ${res.status}`);
  return data;
}

/** Files a ticket. With images it's one request, so the ticket is never picked up before they arrive. */
async function createTicket(t: NewTicketBody, images: File[] = []): Promise<{ ticket: { id: string } }> {
  if (!images.length) return call("POST", "/api/tickets", t);
  return upload("/api/tickets", images, { ticket: t });
}

/** The owner's decision on a ready ticket; a request for changes may bring images. */
async function decide(
  id: string,
  decision: "approve" | "changes" | "reject",
  note?: string,
  images: File[] = [],
): Promise<unknown> {
  const body = note ? { decision, note } : { decision };
  const path = `/api/tickets/${id}/decide`;
  return images.length ? upload(path, images, { decision: body }) : call("POST", path, body);
}

/** One conversation, as `/api/conversations` lists it (contract C22). */
export interface Conversation {
  id: string;
  employeeId: string;
  project: string | null;
  branch: string | null;
  title: string;
  mode: string | null;
  engineId: string;
  createdAt: number;
  archivedAt: number | null;
  ahpSession: string;
  ahpChat: string;
  /** AHP `SessionStatus` bits: 1 idle, 2 error, 8 in progress, 24 input needed, 32 read, 64 archived. */
  status: number;
  needsYou: boolean;
  running: boolean;
  modifiedAt: number;
  /** Once the work was handed to a ticket or opened as a PR (C22b). */
  ship?: ShipBrief;
}

/** What the owner is notified about beyond tickets (C2, T65). One setting for every device. */
export interface NotifySettings {
  conversationsNeedMe: boolean;
  longReplyFinished: boolean;
}

export interface OfficeResponse {
  employees: DeskEntry[];
  accounts?: AccountCost[];
  rateLimits?: Record<string, AccountRateLimit>;
}

import { isGatewayDown, report } from "./connection.ts";
import { draftMemo } from "./drafts.ts";
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
  // The daemon never answers 502-504 for a GitHub problem (it sends 424 or 429), so one of those is a proxy
  // with nothing behind it, on any route.
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
  draftMemo.clearAll();
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
  createTicket,
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
  hire: (e: Partial<Employee> & { teamId?: string }) =>
    call<{ employee: Employee }>("POST", "/api/employees", e),
  employees: () => call<{ employees: Employee[] }>("GET", "/api/employees").then((r) => r.employees),
  updateEmployee: (id: string, e: Partial<Employee> & { teamId?: string }) =>
    call<{ employee: Employee }>("PUT", `/api/employees/${encodeURIComponent(id)}`, e),
  teams: () =>
    call<{ teams: { id: string; name: string; members: (string | { id: string; name?: string })[] }[] }>(
      "GET",
      "/api/teams",
    ).then((r) => r.teams),
  handbook: () => call<KnowledgeView>("GET", "/api/knowledge/handbook"),
  brain: (id: string) => call<KnowledgeView>("GET", `/api/knowledge/brains/${id}`),
  /** The Brain changes feed (C19, T58): newest first, filtered by scope, employee or status. */
  brainChanges: (q: { scope?: string; employee?: string; status?: string; before?: number } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
    return call<BrainChangesView>("GET", `/api/brain/changes${p.size ? `?${p}` : ""}`);
  },
  /** Undoes one committed change with a new commit, "reverted by owner". */
  revertBrainChange: (id: number) =>
    call<{ change: BrainChangeView }>("POST", `/api/brain/changes/${id}/revert`, {}),
  learned: () => call<{ changes: NamedChange[] }>("GET", "/api/knowledge/recent").then((r) => r.changes),
  revert: (repo: string, commit: string) => call("POST", `/api/knowledge/${repo}/revert`, { commit }),
  decidePolicy: (id: string, approved: boolean) =>
    call("POST", `/api/knowledge/policies/${encodeURIComponent(id)}`, { approved }),
  decide,
  /** Adds images to a ticket that isn't done; its builder gets them at their next session. */
  attach: (id: string, images: File[]) => upload(`/api/tickets/${id}/attachments`, images),
  /**
   * Follow-ups waiting for the owner (C20). A daemon without them, or a failed call, shows none:
   * the board and inbox work the same without this list.
   */
  proposals: (): Promise<ProposalView[]> =>
    call<{ proposals?: ProposalView[] }>("GET", "/api/proposals?status=open")
      .then((r) => (Array.isArray(r.proposals) ? r.proposals : []))
      .catch(() => []),
  acceptProposal: (id: number) =>
    call<{ proposal: ProposalView; ticket: { id: string } }>("POST", `/api/proposals/${id}/accept`, {}),
  declineProposal: (id: number) =>
    call<{ proposal: ProposalView }>("POST", `/api/proposals/${id}/decline`, {}),
  /** Assigns a ticket that has not started (C17). */
  assign: (id: string, to: string) =>
    call<{ ok: true; ticket: TicketView }>("POST", `/api/tickets/${encodeURIComponent(id)}/assign`, { to }),
  retry: (id: string): Promise<void> => call("POST", `/api/tickets/${id}/retry`, {}),
  retryTicket: (id: string): Promise<void> => call("POST", `/api/tickets/${id}/retry`, {}),
  /** Conversations (C22): live ones by default, newest activity first; `archived` asks for the archived or all. */
  conversations: (archived?: "true" | "all"): Promise<Conversation[]> =>
    call<{ conversations: Conversation[] }>(
      "GET",
      `/api/conversations${archived ? `?archived=${archived}` : ""}`,
    ).then((r) => r.conversations),
  conversation: (id: string) =>
    call<{ conversation: Conversation }>("GET", `/api/conversations/${encodeURIComponent(id)}`).then(
      (r) => r.conversation,
    ),
  createConversation: (c: { employeeId: string; project?: string | null; title?: string; mode?: string }) =>
    call<{ conversation: Conversation }>("POST", "/api/conversations", c).then((r) => r.conversation),
  /** What to be notified about (C2): a conversation that needs the owner, a long reply that finished. */
  notifySettings: () =>
    call<{ settings: NotifySettings }>("GET", "/api/push/settings").then((r) => r.settings),
  setNotifySettings: (patch: Partial<NotifySettings>) =>
    call<{ settings: NotifySettings }>("PUT", "/api/push/settings", patch).then((r) => r.settings),
  /** Shipping a conversation's work (C22b): the ticket and PR it has, and with `preview` what would be committed. */
  ship: (id: string, preview = false) =>
    call<{ ship: ShipView }>(
      "GET",
      `/api/conversations/${encodeURIComponent(id)}/ship${preview ? "?preview=1" : ""}`,
    ).then((r) => r.ship),
  /** Ends a ticket that waits for the owner as rejected, and gives the conversation its working copy back. */
  takeBack: (id: string) =>
    call<{ ok: true; released: boolean; pr: "closed" | "open" | "merged" | "none"; prProblem?: string }>(
      "POST",
      `/api/conversations/${encodeURIComponent(id)}/take-back`,
      {},
    ),
  makeTicket: (
    id: string,
    body: { title?: string; description?: string; doneWhen?: string[]; confirmBinary?: boolean },
  ) =>
    call<{ ticket: { id: string; title: string }; created: boolean }>(
      "POST",
      `/api/conversations/${encodeURIComponent(id)}/ticket`,
      body,
    ),
  openPr: (id: string, body: { title?: string; confirmBinary?: boolean } = {}) =>
    call<{ pr: { number: number; url: string; draft: boolean }; created: boolean }>(
      "POST",
      `/api/conversations/${encodeURIComponent(id)}/pr`,
      body,
    ),
  patchConversation: (id: string, c: { title?: string; archived?: boolean }) =>
    call<{ conversation: Conversation }>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, c).then(
      (r) => r.conversation,
    ),
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
