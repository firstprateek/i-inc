// The core has no I/O. Everything outside it comes through these ports: the daemon plugs in ACP
// sessions, Apple container machines and SQLite; tests plug in the fakes in ./testing.
import type { TicketEvent } from "./events.ts";
import type {
  AgentHarness,
  Duty,
  Effort,
  Employee,
  Engine,
  Id,
  ProjectPolicy,
  PullRequestRef,
  Ticket,
} from "./model.ts";
import type { StageId } from "./stages.ts";

export interface Clock {
  /** Wall time, epoch ms. It can step either way (NTP, a sleeping laptop, a manual change). */
  now(): number;
  /**
   * Milliseconds on a clock that never steps back and does not follow wall time changes. Only
   * differences between two readings mean anything, and only within one process. Absent: wall time.
   */
  monotonic?(): number;
}

/** The clock's monotonic reading, or its wall time where it has no monotonic one. For waits that live in memory. */
export function monotonicNow(clock: Clock): number {
  return clock.monotonic ? clock.monotonic() : clock.now();
}

export interface EventStore {
  read(ticketId: Id): Promise<TicketEvent[]>;
  append(ticketId: Id, events: TicketEvent[]): Promise<void>;
}

/** Why a sandbox's machine won't boot (see classifyBootFailure in the daemon's machines.ts). */
export type SandboxFaultKind = "stale-hostname" | "container-service-down" | "unknown";

export interface SandboxStatus {
  team: Id;
  machine: string;
  state: "running" | "stopped" | "missing" | "error";
  cpus: number;
  memory: string;
  signedIn: { claude: boolean; antigravity: boolean; codex: boolean; github: boolean };
  /**
   * The launcher in this machine writes no agent notes (it was made before they existed), so an agent
   * left running by a crashed daemon can't be found there. Fixed by `tools/host/update-machine.sh <team>`.
   * Absent when it is current or not yet known.
   */
  launcher?: "needs-update";
  /** With `state: "error"` (contract C18): why it can't start, in plain words, and what fixes it. */
  reason?: string;
  kind?: SandboxFaultKind;
  /** When the daemon next tries to boot it (epoch ms). */
  retryAt?: number;
}

/** What the daemon did about the container service, for Setup > Sandboxes (T73). */
export type ServiceEventKind =
  | "restarted"
  | "resumed"
  | "not-fixed"
  | "restart-failed"
  | "gave-up-busy"
  | "walls-late";

export interface ServiceEvent {
  /** Epoch ms. */
  at: number;
  kind: ServiceEventKind;
  /** One plain sentence: "restarted the container service at 14:02 to clear a stuck machine name (inc-engineering)". */
  text: string;
  machine?: string;
}

/** A sandbox that failed to boot and is waiting out its backoff. */
export interface SandboxFault {
  machine: string;
  kind: SandboxFaultKind;
  /** The full sentence for Setup > Sandboxes. */
  reason: string;
  /** The short form tickets show: "the engineering sandbox can't start (restart the container service on the Mac mini)". */
  waiting: string;
  since: number;
  retryAt: number;
  attempts: number;
}

/**
 * Something that couldn't start (a sandbox that won't boot, an engine that won't launch). It is not
 * the ticket's fault: a builder's ticket waits, and a helper is skipped (T50).
 */
export class StartupError extends Error {
  constructor(
    message: string,
    /** Epoch ms when trying again is worthwhile, when known. */
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "StartupError";
  }
}

/**
 * The daemon is stopping (SIGTERM, a deploy, a kickstart). A session that ends because of it says
 * nothing about the ticket, so the runner lets it through without an event and the ticket carries
 * on from its log when the daemon is back.
 */
export class ShuttingDown extends Error {
  constructor() {
    super("the daemon is stopping");
    this.name = "ShuttingDown";
  }
}

/** Makes sure an employee's machine is up before a session runs on it. */
export interface MachineProvider {
  ensureUp(employeeId: Id): Promise<void>;
  /** Stops a machine whose employee has nothing running (spec §12: memory returns only on restart). */
  stop?(employeeId: Id): Promise<void>;
  /**
   * Whether a script or session is running in the employee's machine right now (a lease on it). The idle pass
   * leaves such a machine for the next pass instead of waiting on it: a stop waits for leases.
   */
  leased?(employeeId: Id): boolean;
  /**
   * At startup: of these employees, those whose machine an earlier daemon left running. They are
   * recorded as up, so `stop` can stop them once nothing uses them (a restart forgets what it started).
   */
  adopt?(employeeIds: Id[]): Promise<Id[]>;
  /** Delivers an OAuth callback URL into a team's sandbox (e.g. Antigravity sign-in). */
  deliverCallback?(teamId: Id, url: string): Promise<void>;
  /** Checks sandbox VM state and sign-ins for a team. */
  inspectSandbox?(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus>;
  /** The boot failure holding an employee's sandbox in backoff, only while it is still backing off. Reads memory only. */
  sandboxFault?(employeeId: Id): SandboxFault | undefined;
  /**
   * Whether an employee's sandbox is signed in to a harness, from the last probe: undefined when it
   * hasn't been probed yet.
   */
  signedIn?(employeeId: Id, harness: AgentHarness): boolean | undefined;
  /** What the daemon did about the container service lately (T73), newest first. */
  serviceEvents?(): ServiceEvent[];
  /** Clears a sandbox's backoff and tries to boot it now (contract C18). Returns its new state. */
  retrySandbox?(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus>;
}

export interface SessionRequest {
  ticket: Ticket;
  stage: StageId;
  duty: Duty;
  employee: Employee;
  engine: Engine;
  /** Everything a fresh session needs: ticket, plan, progress, last error. See brief.ts. */
  brief: string;
  /** Reasoning effort for this session when it differs from the ticket's (the done-when check runs at "low"). */
  effort?: Effort;
  /** Aborted when the owner sends an urgent message: stop at once and return "interrupted". */
  signal?: AbortSignal;
  /**
   * For an agent with `reportsLaunch`: called once the agent process is running. The runner records the
   * session as started then, so a launch that fails again and again adds nothing to the ticket's log.
   */
  onLaunched?: () => Promise<void>;
  /** Emits transcript items (streamed from ACP notifications) for recording. */
  onTranscriptItem?: (item: SessionTranscriptItem) => void;
  /**
   * For an agent that speaks ACP: every `session/update` it sends, as it arrives, for the read-only live view of
   * the session (T69). Raw and unredacted: the receiver redacts and caps. It never throws into the session.
   */
  onAgentUpdate?: (update: Record<string, unknown>) => void;
  /** For an agent that speaks ACP: the token counts of the finished prompt (`_meta.usage`), if it gave any. */
  onAgentUsage?: (usage: Record<string, unknown>) => void;
}

export interface SessionTranscriptItem {
  kind: "text" | "tool";
  text?: string;
  title?: string;
  status?: string;
  at: number;
  /** Files a tool call names (ACP `locations`), as the agent saw them. Not stored with the transcript. */
  locations?: string[];
  /** Internal ID for matching tool call updates or streaming chunks */
  id?: string;
}

export interface TicketSessionTranscript {
  /** The session's id (the daemon's `ticket_sessions` row): it names the session in `#/ticket/<id>/session/<id>`. */
  id?: number;
  stage: string;
  employeeId: string;
  engineId: string;
  startedAt: number;
  endedAt: number | null;
  items: SessionTranscriptItem[];
  /** The brain pages this session was given or read (contract C19). Absent when there were none. */
  brain?: BrainUse[];
}

/** A brain page that went into a session or turn, or that the agent opened. */
export interface BrainUse {
  scope: string;
  slug: string;
  title: string;
  updated: string | null;
  /** `search` and `link`: put in the prompt by retrieval. `read`: the agent opened it itself. */
  via: "search" | "link" | "read";
  /** The page was built from untrusted content. */
  untrusted?: true;
}

export type SessionOutcome =
  | { kind: "done"; output: string }
  | { kind: "out-of-tokens"; resetsAt: number }
  /** `startup`: the engine never got going (it wouldn't launch, or needs a sign-in), as opposed to failing mid-work. */
  | { kind: "stuck"; reason: string; startup?: true }
  | { kind: "interrupted"; reason: string };

/** Runs one ACP session to the end of its step. */
export interface Agent {
  /** The agent calls `onLaunched` once its process is up; the runner then waits for that to record the session. */
  readonly reportsLaunch?: boolean;
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
  | {
      ok: false;
      conflict: boolean;
      reason: string;
      protectedPaths?: string[];
      /** With `protectedPaths`: the change the card is about (see the protected-paths ask in events.ts). */
      approval?: { sha: string; patchId: string; diff?: string; diffTruncated?: boolean };
    };

export type CiResult = { ok: true } | { ok: false; reason: string };

export interface GatesOptions {
  /**
   * The owner has just answered a protected-paths card with OK. With no `approvedPaths`, that covers
   * everything (also what an owner's own push left behind: the branch is empty then).
   */
  ownerApproved?: boolean;
  /** The protected paths the owner has OKed, from the last card they answered. When given, only these are let through. */
  approvedPaths?: string[];
  /**
   * What the owner's last OK was for: the commit, a hash of the diff of the protected paths, and the paths. The
   * host lets a protected change through only if it is exactly this (T68); anything else asks again.
   */
  approval?: { sha: string; patchId: string; paths: string[] };
  /** Direct mode: the commit a run before this one was about to push; if it is on main already, it was pushed. */
  pushIntended?: string;
  /**
   * Direct mode: called with the commit about to be pushed to main, and awaited before the push. The
   * runner writes it to the log, so a stop between the push and its `pushed` event can be told from no push.
   */
  onPushIntended?: (headSha: string) => Promise<void>;
}

/** Deterministic work the harness does itself: the project recipe and the final gates. */
export interface Harness {
  runChecks(ticket: Ticket): Promise<ChecksResult>;
  /**
   * The final gates. In direct mode: rebase on main, checks, then push to main, unless the change
   * touches protected paths and the owner hasn't approved it.
   */
  runGates(ticket: Ticket, opts?: GatesOptions): Promise<GatesResult>;
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
/**
 * A worktree at a moment (T72): its HEAD commit, and `state`, a fingerprint of everything else (the branch, the
 * content of every tracked and untracked file, and the index). Two snapshots are the same worktree only when both
 * are equal; the content, not the names `git status` prints, is what is compared.
 */
export interface WorktreeSnapshot {
  head: string;
  state: string;
}

/** What `restore` did: whether the worktree verifiably matches the snapshot again, and which paths had changed. */
export interface RestoreResult {
  restored: boolean;
  changed: string[];
}

export interface Workspace {
  open(ticket: Ticket, builder: Employee): Promise<PullRequestRef>;
  /**
   * Whether the ticket's worktree is still in `employee`'s machine, by a cheap look (`git rev-parse`).
   * Cleanup removes the worktrees of old tickets, and a ticket retried after that must not build in a
   * bare folder: the runner calls `open` again when this says no.
   */
  present?(ticket: Ticket, employee: Employee): Promise<boolean>;
  /** Copies the ticket's images numbered `ns` into the worktree in `employee`'s machine. */
  attach?(ticket: Ticket, employee: Employee, ns: number[]): Promise<void>;
  /**
   * Makes the ticket's branch readable in a reviewer's or verifier's machine, at its latest pushed
   * commit. Never pushes, and never touches a builder's worktree that is already there.
   */
  checkout?(ticket: Ticket, employee: Employee): Promise<void>;
  /**
   * The ticket's worktree in `employee`'s machine as it is now. The done-when check (T72) is read-only, but a
   * session runs with full access, so the runner takes one before and one after, and any difference counts as the
   * checker having changed files.
   */
  snapshot?(ticket: Ticket, employee: Employee): Promise<WorktreeSnapshot>;
  /**
   * Puts the worktree back exactly as `before` had it: HEAD, every file's content (edited, staged, created or
   * deleted, whatever its name), and the index, so the builder's own uncommitted work from before comes back too.
   * It then looks again, and says `restored` only when the worktree really matches `before`.
   */
  restore?(
    ticket: Ticket,
    employee: Employee,
    before: WorktreeSnapshot,
    after: WorktreeSnapshot,
  ): Promise<RestoreResult>;
  /**
   * Owner-merges: pushes the builder's committed work to the ticket's branch (through the host, since a sandbox
   * holds no write credentials), so a checker in another machine reads the code as it is now. Safe to repeat.
   */
  push?(ticket: Ticket, builder: Employee): Promise<void>;
  ready(ticket: Ticket, pr: PullRequestRef, report: string): Promise<void>;
  /**
   * Where the ticket's PR stands on GitHub. The owner merges it there, then clicks Approve: i.inc
   * records "merged" only when GitHub says so. Absent: the owner's word is taken (no PR to ask).
   */
  prState?(ticket: Ticket, pr: PullRequestRef): Promise<"open" | "closed" | "merged">;
  /** Closes the ticket's PR on GitHub (the owner rejected the work). A merged or closed PR is left alone. */
  closePr?(ticket: Ticket, pr: PullRequestRef): Promise<void>;
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
  /** The company's projects, by id: what an engineer with no project named in its hiring writes pages for. */
  projectIds?(): string[];
  /** Every engine, so a reviewer can run on a different one from the builder's. */
  engines?(): Engine[];
  /**
   * Why an employee can't run this engine for this duty right now, or null: their team's sandbox is
   * in backoff, or (for a reviewer or verifier) its harness isn't known to be signed in there.
   */
  engineBlock?(employeeId: Id, engineId: Id, duty: Duty): EngineBlock | null;
}

export interface EngineBlock {
  reason: string;
  /** When it is worth trying again (epoch ms), if known. */
  until?: number;
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
  /**
   * Whether this employee has a copy of the brain in their machine whose edits the daemon collects after the
   * session (docs/design/brain.md, "Writing"). Then the retro asks for lessons as edits to the copy instead of
   * as JSON. Absent in demo mode and in tests; false when the copy is unavailable for this employee.
   */
  brainWrites?: (employeeId: Id) => boolean;
  /**
   * What the brain holds, for checking an orientation or a tidy-up against its done-when when its session ends.
   * Absent in tests that don't need it: the ticket then closes as before.
   */
  brainState?: BrainState;
}

/** The brain as the runner checks it. Each method may return null: it can't tell now, and the check is skipped. */
export interface BrainState {
  /**
   * The pages of this employee's own brain that THIS ticket's sessions wrote or changed, by page (`projects/duet`)
   * with their text, after what the session wrote in its copy has been collected into the brain. A page left by
   * an earlier run is not in it. Null: the brain can't be read, and the ticket waits for the owner.
   */
  pages(employeeId: Id, ticketId: Id): Promise<Map<string, string> | null>;
  /** After collecting: what the tidy-up still has to do, as plain lines. Empty: nothing is left. */
  tidyLeft(employeeId: Id, ticketId: Id): Promise<string[] | null>;
}
