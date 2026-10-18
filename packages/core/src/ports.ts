// The core has no I/O. Everything outside it comes through these ports: the daemon plugs in ACP
// sessions, Apple container machines and SQLite; tests plug in the fakes in ./testing.
import type { TicketEvent } from "./events.ts";
import type { Duty, Employee, Engine, Id, ProjectPolicy, PullRequestRef, Ticket } from "./model.ts";
import type { StageId } from "./stages.ts";

export interface Clock {
  now(): number;
}

export interface EventStore {
  read(ticketId: Id): Promise<TicketEvent[]>;
  append(ticketId: Id, events: TicketEvent[]): Promise<void>;
}

export interface SandboxStatus {
  team: Id;
  machine: string;
  state: "running" | "stopped" | "missing" | "error";
  cpus: number;
  memory: string;
  signedIn: { claude: boolean; antigravity: boolean; codex: boolean; github: boolean };
}

/** Makes sure an employee's machine is up before a session runs on it. */
export interface MachineProvider {
  ensureUp(employeeId: Id): Promise<void>;
  /** Stops a machine whose employee has nothing running (spec §12: memory returns only on restart). */
  stop?(employeeId: Id): Promise<void>;
  /** Delivers an OAuth callback URL into a team's sandbox (e.g. Antigravity sign-in). */
  deliverCallback?(teamId: Id, url: string): Promise<void>;
  /** Checks sandbox VM state and sign-ins for a team. */
  inspectSandbox?(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus>;
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
  /** Emits transcript items (streamed from ACP notifications) for recording. */
  onTranscriptItem?: (item: SessionTranscriptItem) => void;
}

export interface SessionTranscriptItem {
  kind: "text" | "tool";
  text?: string;
  title?: string;
  status?: string;
  at: number;
  /** Internal ID for matching tool call updates or streaming chunks */
  id?: string;
}

export interface TicketSessionTranscript {
  stage: string;
  employeeId: string;
  engineId: string;
  startedAt: number;
  endedAt: number | null;
  items: SessionTranscriptItem[];
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

export type GatesResult =
  /** `pushed`: in direct mode, the commit that reached main. */
  | { ok: true; pushed?: string }
  /** `protectedPaths`: the change touches paths that need the owner's OK first. */
  | { ok: false; conflict: boolean; reason: string; protectedPaths?: string[] };

export type CiResult = { ok: true } | { ok: false; reason: string };

/** Deterministic work the harness does itself: the project recipe and the final gates. */
export interface Harness {
  runChecks(ticket: Ticket): Promise<ChecksResult>;
  /**
   * The final gates. In direct mode: rebase on main, checks, then push to main, unless the change
   * touches protected paths and the owner hasn't approved it.
   */
  runGates(ticket: Ticket, opts?: { ownerApproved?: boolean }): Promise<GatesResult>;
  /** Direct mode: CI on the commit pushed to main. */
  watchCi?(ticket: Ticket, sha: string): Promise<CiResult>;
  /** Direct mode: takes a commit back out of main, when its CI stayed red too long. */
  revert?(ticket: Ticket, sha: string): Promise<void>;
  /**
   * What a brief should say about the machine and the project's checks. In M1 neither engine knew
   * the machine had no pnpm, because the brief said nothing about it.
   */
  describe?(ticket: Ticket): string[];
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
  /** How a project's work reaches main. Absent: the default (direct). */
  projectPolicy?(project: string): ProjectPolicy;
  /** Every engine, so a reviewer can run on a different one from the builder's. */
  engines?(): Engine[];
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
