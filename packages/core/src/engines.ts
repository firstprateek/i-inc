// Which engine runs a session: engine per duty, switch-rule overrides, and the home-data wall.

import type { Duty, Employee, Engine, Id, Ticket } from "./model.ts";
import type { Company } from "./ports.ts";
import type { TicketState } from "./state.ts";

/**
 * Whether an engine can work on home data: a local one (spec §7). Codex is always a cloud service,
 * whatever its `local` flag says. A PA's sandbox has no internet, so a local engine is also the only
 * kind it can run: its model is reached on the host through the Ollama relay.
 */
export function isLocalEngine(engine: Pick<Engine, "local" | "harness">): boolean {
  return engine.local === true && engine.harness !== "codex";
}

/** Home data goes only to local engines (spec §7). Errands are the tickets that carry it. */
export function engineAllowed(ticket: Ticket, engine: Engine): boolean {
  return ticket.type !== "errand" || isLocalEngine(engine);
}

/** The engine for this duty right now: a switch rule's override wins, then the duty's engine, then the default. */
export function engineFor(employee: Employee, duty: Duty, state: TicketState, isAssignee: boolean): Id {
  if (isAssignee && state.engineOverride) return state.engineOverride;
  return employee.engines.perDuty?.[duty] ?? employee.engines.default;
}

/** The engine with this id, or undefined when it was removed from Setup while something still names it. */
export function findEngine(company: Pick<Company, "engine">, id: Id): Engine | undefined {
  try {
    return company.engine(id);
  } catch {
    return undefined;
  }
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
  return employee.engines.fallbacks.find((id) => {
    const engine = findEngine(company, id);
    return !used.has(id) && engine !== undefined && engineAllowed(ticket, engine);
  });
}
