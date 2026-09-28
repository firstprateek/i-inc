// The core has no I/O. Everything outside it comes through these ports: the daemon plugs in ACP
// sessions, Apple container machines and SQLite; tests plug in the fakes in ./testing.
import type { TicketEvent } from "./events.ts";
import type { Duty, Employee, Engine, Id, PullRequestRef, Ticket } from "./model.ts";
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
  /** Stops a machine whose employee has nothing running (spec §12: memory returns only on restart). */
  stop?(employeeId: Id): Promise<void>;
}

export interface SessionRequest {
  ticket: Ticket;
  stage: StageId;
  duty: Duty;
  employee: Employee;
  engine: Engine;
  /** Everything a fresh session needs: ticket, plan, progress, last error. See brief.ts. */
  brief: string;
  /** Aborted when the owner sends an urgent message: stop at once and return "interrupted". */
  signal?: AbortSignal;
}

export type SessionOutcome =
  | { kind: "done"; output: string }
  | { kind: "out-of-tokens"; resetsAt: number }
  | { kind: "stuck"; reason: string }
  | { kind: "interrupted"; reason: string };

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

/**
 * A code ticket's branch and pull request (spec §6). Pick-up makes the worktree and branch in the
 * builder's machine and opens a draft PR, so CI runs from the start. The report then goes into the
 * PR, which is marked ready for the owner. Both are safe to repeat after a crash.
 */
export interface Workspace {
  open(ticket: Ticket, builder: Employee): Promise<PullRequestRef>;
  ready(ticket: Ticket, pr: PullRequestRef, report: string): Promise<void>;
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
  /** Absent in demo mode and in tests: tickets then run without a branch or PR. */
  workspace?: Workspace;
}
