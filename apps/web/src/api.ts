// A small typed client for the daemon's API. The view types come straight from the daemon.
import type { Employee, Engine, TicketEvent } from "@i-inc/core";
import type { DeskEntry, DeskView, TicketView } from "@i-inc/daemon/views";

export type { DeskEntry, DeskView, TicketEvent, TicketView };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${method} ${path}: ${res.status}`);
  return data;
}

export const api = {
  board: () => call<{ tickets: TicketView[] }>("GET", "/api/board").then((r) => r.tickets),
  office: () => call<{ employees: DeskEntry[] }>("GET", "/api/office").then((r) => r.employees),
  desk: () => call<DeskView>("GET", "/api/desk"),
  ticket: (id: string) => call<{ ticket: TicketView; events: TicketEvent[] }>("GET", `/api/tickets/${id}`),
  answer: (id: string, answer: "approve" | "reject" | "builder" | "reviewer", note?: string) =>
    call("POST", `/api/tickets/${id}/answer`, note ? { answer, note } : { answer }),
  engines: () => call<{ engines: Engine[] }>("GET", "/api/engines").then((r) => r.engines),
  hire: (e: Partial<Employee>) => call<{ employee: Employee }>("POST", "/api/employees", e),
  decide: (id: string, decision: "approve" | "changes" | "reject", note?: string) =>
    call("POST", `/api/tickets/${id}/decide`, note ? { decision, note } : { decision }),
};

/** Tells every view to refetch: after an action, and on a timer. */
export const refresh = new EventTarget();
export const refreshNow = () => refresh.dispatchEvent(new Event("refresh"));
