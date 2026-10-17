// A small typed client for the daemon's API. The view types come straight from the daemon.
import type { Employee, Engine, TicketEvent } from "@i-inc/core";
import type {
  DeskEntry,
  DeskView,
  KnowledgeView,
  NamedChange,
  Page,
  PolicyProposal,
  TicketView,
} from "@i-inc/daemon/views";

export type {
  DeskEntry,
  DeskView,
  KnowledgeView,
  NamedChange,
  Page,
  PolicyProposal,
  TicketEvent,
  TicketView,
};

import { showLogin } from "./login.ts";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Every write is JSON, even an empty one: the daemon refuses anything else (api.ts).
  const write = method !== "GET";
  const res = await fetch(path, {
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
  const res = await fetch("/api/auth");
  return (await res.json()) as { initialized: boolean };
}

export async function signup(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return res.ok ? { ok: true } : { ok: false, ...(data.error ? { error: data.error } : {}) };
}

export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  return res.ok ? { ok: true } : { ok: false, ...(data.error ? { error: data.error } : {}) };
}

export const api = {
  authStatus,
  signup,
  login,
  board: () => call<{ tickets: TicketView[] }>("GET", "/api/board").then((r) => r.tickets),
  office: () => call<{ employees: DeskEntry[] }>("GET", "/api/office").then((r) => r.employees),
  desk: () => call<DeskView>("GET", "/api/desk"),
  ticket: (id: string) => call<{ ticket: TicketView; events: TicketEvent[] }>("GET", `/api/tickets/${id}`),
  answer: (id: string, answer: "approve" | "reject" | "builder" | "reviewer", note?: string) =>
    call("POST", `/api/tickets/${id}/answer`, note ? { answer, note } : { answer }),
  engines: () => call<{ engines: Engine[] }>("GET", "/api/engines").then((r) => r.engines),
  hire: (e: Partial<Employee>) => call<{ employee: Employee }>("POST", "/api/employees", e),
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

/** Tells every view to refetch: after an action, and on a timer. */
export const refresh = new EventTarget();
export const refreshNow = () => refresh.dispatchEvent(new Event("refresh"));
