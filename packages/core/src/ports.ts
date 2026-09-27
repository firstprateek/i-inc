// The core has no I/O. Everything outside it comes through these ports: the daemon plugs in ACP
// sessions, Apple container machines and SQLite; tests plug in the fakes in ./testing.
import type { TicketEvent } from "./events.ts";
import type { Duty, Employee, Engine, Id, Ticket } from "./model.ts";
import type { StageId } from "./stages.ts";

export interface Clock {
  now(): number;
}

export interface EventStore {
  read(ticketId: Id): Promise<TicketEvent[]>;
  append(ticketId: Id, events: TicketEvent[]): Promise<void>;
}

/** Makes sure an employee's machine is up before a session runs on it. */
export interface MachineProvider {
  ensureUp(employeeId: Id): Promise<void>;
}

export interface SessionRequest {
  ticket: Ticket;
  stage: StageId;
  duty: Duty;
  employee: Employee;
  engine: Engine;
  /** Everything a fresh session needs: ticket, plan, progress, last error. See brief.ts. */
  brief: string;
}

export type SessionOutcome =
  | { kind: "done"; output: string }
  | { kind: "out-of-tokens"; resetsAt: number }
  | { kind: "stuck"; reason: string };

/** Runs one ACP session to the end of its step. */
export interface Agent {
  run(request: SessionRequest): Promise<SessionOutcome>;
}

export interface ChecksResult {
  green: boolean;
  failures: string[];
}

export type GatesResult = { ok: true } | { ok: false; conflict: boolean; reason: string };

/** Deterministic work the harness does itself: the project recipe and the final gates. */
export interface Harness {
  runChecks(ticket: Ticket): Promise<ChecksResult>;
  runGates(ticket: Ticket): Promise<GatesResult>;
}

export interface Company {
  employee(id: Id): Employee;
  engine(id: Id): Engine;
  /** Picks the reviewer (or verifier) for a ticket. Never the builder. */
  pickEmployee(duty: Duty, ticket: Ticket, exclude: Id[]): Employee | undefined;
  /** Whether an address is in the owner's contacts, for outbound rules. Unknown means no. */
  isContact?(address: string): boolean;
}

/**
 * A helper model (spec §5): a small, fast local model the daemon's code asks yes/no questions. It
 * is never an employee's engine and never works a ticket.
 */
export interface HelperModel {
  yesNo(question: string, text: string): Promise<boolean>;
}

/** A short session outside any ticket, to answer the owner's question in chat. */
export interface ChatSession {
  answer(request: { employee: Employee; engine: Engine; brief: string }): Promise<SessionOutcome>;
}

export interface Ports {
  clock: Clock;
  store: EventStore;
  machines: MachineProvider;
  agent: Agent;
  harness: Harness;
  company: Company;
}
