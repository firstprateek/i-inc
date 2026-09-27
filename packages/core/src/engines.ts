// Which engine runs a session: engine per duty, switch-rule overrides, and the home-data wall.

import type { Duty, Employee, Engine, Id, Ticket } from "./model.ts";
import type { Company } from "./ports.ts";
import type { TicketState } from "./state.ts";

/** Home data goes only to local engines (spec §7). Errands are the tickets that carry it. */
export function engineAllowed(ticket: Ticket, engine: Engine): boolean {
  return ticket.type !== "errand" || engine.local;
}

/** The engine for this duty right now: a switch rule's override wins, then the duty's engine, then the default. */
export function engineFor(employee: Employee, duty: Duty, state: TicketState, isAssignee: boolean): Id {
  if (isAssignee && state.engineOverride) return state.engineOverride;
  return employee.engines.perDuty?.[duty] ?? employee.engines.default;
}

/** The next fallback engine not yet used in the active stage, or undefined when none is left. */
export function nextFallback(
  employee: Employee,
  current: Id,
  state: TicketState,
  ticket: Ticket,
  company: Company,
): Id | undefined {
  const used = new Set([
    current,
    ...state.switches.filter((s) => s.stage === state.active).map((s) => s.from),
  ]);
  return employee.engines.fallbacks.find((id) => !used.has(id) && engineAllowed(ticket, company.engine(id)));
}
