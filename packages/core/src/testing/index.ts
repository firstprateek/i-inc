// Fakes for every port, so the whole pipeline runs in tests without spending tokens.
import type { TicketEvent } from "../events.ts";
import {
  type Duty,
  defaultProjectPolicy,
  type Employee,
  type Engine,
  type Id,
  type ProjectPolicy,
  type PullRequestRef,
  type Ticket,
} from "../model.ts";
import type {
  Agent,
  ChatSession,
  ChecksResult,
  CiResult,
  Clock,
  Company,
  EngineBlock,
  EventStore,
  GatesOptions,
  GatesResult,
  Harness,
  HelperModel,
  MachineProvider,
  Ports,
  SandboxStatus,
  SessionOutcome,
  SessionRequest,
  SessionTranscriptItem,
  Workspace,
} from "../ports.ts";
import type { StageId } from "../stages.ts";

export class FakeClock implements Clock {
  private mono = 0;
  constructor(private t = Date.UTC(2026, 8, 27, 21, 40)) {}
  now(): number {
    return this.t;
  }
  monotonic(): number {
    return this.mono;
  }
  /** Time passes: both clocks move. */
  advance(minutes: number): void {
    this.t += minutes * 60_000;
    this.mono += minutes * 60_000;
  }
  /** Wall time is set forward or back (a negative `minutes`) while no time passes: the monotonic clock stays. */
  step(minutes: number): void {
    this.t += minutes * 60_000;
  }
}

export class MemoryEventStore implements EventStore {
  readonly log = new Map<Id, TicketEvent[]>();
  async read(ticketId: Id): Promise<TicketEvent[]> {
    return [...(this.log.get(ticketId) ?? [])];
  }
  async append(ticketId: Id, events: TicketEvent[]): Promise<void> {
    this.log.set(ticketId, [...(this.log.get(ticketId) ?? []), ...events]);
  }
}

export class FakeMachines implements MachineProvider {
  readonly started: Id[] = [];
  readonly stopped: Id[] = [];
  readonly callbacks: { teamId: Id; url: string }[] = [];
  sandboxSignIns?: Record<Id, { claude: boolean; antigravity: boolean; codex: boolean; github: boolean }>;
  teamMembers?: Record<Id, Id[]> | ((team: Id) => Id[]);
  sandboxStates?: Record<Id, "running" | "stopped" | "missing">;

  /** Employees whose machine won't start, with the error `ensureUp` throws (T50). */
  readonly bootFailures = new Map<Id, Error>();

  async ensureUp(employeeId: Id): Promise<void> {
    const failure = this.bootFailures.get(employeeId);
    if (failure) throw failure;
    this.started.push(employeeId);
  }
  async stop(employeeId: Id): Promise<void> {
    this.stopped.push(employeeId);
  }
  /** Employees whose machine an earlier daemon left running: what `adopt` reports at startup. */
  readonly leftRunning: Id[] = [];
  async adopt(employeeIds: Id[]): Promise<Id[]> {
    return employeeIds.filter((id) => this.leftRunning.includes(id));
  }
  async deliverCallback(teamId: Id, url: string): Promise<void> {
    this.callbacks.push({ teamId, url });
  }

  isUp(id: Id): boolean {
    const starts = this.started.filter((x) => x === id).length;
    const stops = this.stopped.filter((x) => x === id).length;
    return starts > stops;
  }

  async inspectSandbox(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus> {
    const signedIn = this.sandboxSignIns?.[team] ?? {
      claude: true,
      antigravity: false,
      codex: false,
      github: true,
    };
    if (this.sandboxStates?.[team]) {
      return {
        team,
        machine: `inc-${team}`,
        state: this.sandboxStates[team],
        cpus: size.cpus,
        memory: size.memory,
        signedIn,
      };
    }
    const members =
      typeof this.teamMembers === "function" ? this.teamMembers(team) : (this.teamMembers?.[team] ?? []);
    const running = this.isUp(`inc-${team}`) || this.isUp(team) || members.some((m) => this.isUp(m));
    return {
      team,
      machine: `inc-${team}`,
      state: running ? "running" : "stopped",
      cpus: size.cpus,
      memory: size.memory,
      signedIn,
    };
  }

  async retrySandbox(team: Id, size: { cpus: number; memory: string }): Promise<SandboxStatus> {
    return this.inspectSandbox(team, size);
  }
}

/** Records the branches it opens and the PRs it marks ready. Set `failOpen` to make pick-up fail. */
export class FakeWorkspace implements Workspace {
  readonly opened: Id[] = [];
  /** Whose machine each open was for. */
  readonly openedFor: Id[] = [];
  readonly readied: { ticketId: Id; pr: PullRequestRef; report: string }[] = [];
  /** What GitHub says about each ticket's PR; a ticket not listed has an open one. */
  readonly prStates = new Map<Id, "open" | "closed" | "merged">();
  /** The tickets whose PR was closed, in order. */
  readonly closedPrs: Id[] = [];
  /** The images copied in after pick-up, by whose machine. */
  readonly attached: { ticketId: Id; employeeId: Id; ns: number[] }[] = [];
  /** The branch checked out in a reviewer's or verifier's machine, by whose machine, in order. */
  readonly checkedOut: { ticketId: Id; employeeId: Id }[] = [];
  /** Every open, checkout and attach, in order. */
  readonly calls: string[] = [];
  /** Whose worktrees are gone (cleanup removed them); `open` brings them back. */
  readonly gone = new Set<Id>();
  /** Every look for a worktree, by whose machine. */
  readonly looked: Id[] = [];
  async present(_ticket: Ticket, employee: Employee): Promise<boolean> {
    this.looked.push(employee.id);
    return !this.gone.has(employee.id);
  }
  failOpen: string | null = null;
  failAttach: string | null = null;
  failCheckout: string | null = null;
  async open(ticket: Ticket, builder: Employee): Promise<PullRequestRef> {
    if (this.failOpen) throw new Error(this.failOpen);
    this.opened.push(ticket.id);
    this.openedFor.push(builder.id);
    this.gone.delete(builder.id);
    this.calls.push(`open ${builder.id}`);
    return {
      number: Number(ticket.id),
      url: `https://github.com/owner/repo/pull/${ticket.id}`,
      nodeId: `PR_${ticket.id}`,
      branch: `inc/${ticket.id}-${builder.id}`,
    };
  }
  async attach(ticket: Ticket, employee: Employee, ns: number[]): Promise<void> {
    if (this.failAttach) throw new Error(this.failAttach);
    this.attached.push({ ticketId: ticket.id, employeeId: employee.id, ns });
    this.calls.push(`attach ${employee.id} ${ns.join(",")}`);
  }
  async checkout(ticket: Ticket, employee: Employee): Promise<void> {
    if (this.failCheckout) throw new Error(this.failCheckout);
    this.checkedOut.push({ ticketId: ticket.id, employeeId: employee.id });
    this.calls.push(`checkout ${employee.id}`);
  }
  async ready(ticket: Ticket, pr: PullRequestRef, report: string): Promise<void> {
    this.readied.push({ ticketId: ticket.id, pr, report });
  }
  async prState(ticket: Ticket): Promise<"open" | "closed" | "merged"> {
    return this.prStates.get(ticket.id) ?? "open";
  }
  async closePr(ticket: Ticket): Promise<void> {
    // Like the real one: only an open PR is closed.
    if ((this.prStates.get(ticket.id) ?? "open") !== "open") return;
    this.prStates.set(ticket.id, "closed");
    this.closedPrs.push(ticket.id);
  }
}

/** Thrown by the fake agent to simulate the daemon dying mid-session. */
export class Crash extends Error {
  constructor() {
    super("simulated daemon crash");
  }
}

/** "hang" keeps the session going until its signal aborts, like a long build the owner interrupts. */
export type Scripted =
  | (SessionOutcome & { items?: SessionTranscriptItem[] })
  | { kind: "crash" }
  | { kind: "hang" };

export interface Match {
  ticket?: Id;
  employee?: Id;
  stage?: StageId;
  duty?: Duty;
  engine?: Id;
}

/**
 * A scripted ACP agent. `on(match, ...outcomes)` queues outcomes for matching sessions; each session
 * takes the first queued outcome that matches, else a sensible default for its duty and stage.
 */
export class FakeAgent implements Agent {
  readonly calls: SessionRequest[] = [];
  private readonly scripts: { match: Match; queue: Scripted[] }[] = [];

  on(match: Match, ...outcomes: Scripted[]): this {
    this.scripts.push({ match, queue: outcomes });
    return this;
  }

  async run(request: SessionRequest): Promise<SessionOutcome> {
    this.calls.push(request);
    const script = this.scripts.find((s) => s.queue.length > 0 && matches(s.match, request));
    const next = script?.queue.shift() ?? defaultOutcome(request);
    if (next.kind === "crash") throw new Crash();
    if (next.kind === "hang") return hang(request.signal);
    if ("items" in next && Array.isArray((next as { items?: SessionTranscriptItem[] }).items)) {
      for (const item of (next as { items?: SessionTranscriptItem[] }).items ?? []) {
        request.onTranscriptItem?.(item);
      }
    }
    return next;
  }

  /** Calls for one employee in one stage, in order. */
  callsFor(employee: Id, stage?: StageId): SessionRequest[] {
    return this.calls.filter((c) => c.employee.id === employee && (!stage || c.stage === stage));
  }
}

function hang(signal: AbortSignal | undefined): Promise<SessionOutcome> {
  if (!signal) throw new Error("a hanging session needs a signal, or it never ends");
  return new Promise((resolve) => {
    const stop = () => resolve({ kind: "interrupted", reason: String(signal.reason ?? "interrupted") });
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}

function matches(m: Match, r: SessionRequest): boolean {
  return (
    (!m.ticket || m.ticket === r.ticket.id) &&
    (!m.employee || m.employee === r.employee.id) &&
    (!m.stage || m.stage === r.stage) &&
    (!m.duty || m.duty === r.duty) &&
    (!m.engine || m.engine === r.engine.id)
  );
}

function defaultOutcome(r: SessionRequest): SessionOutcome {
  const done = (output: string): SessionOutcome => ({ kind: "done", output });
  if (r.duty === "plan") return done("Approach: change the sorter and add a test that reproduces the bug.");
  // The done-when check (T72): every item met, with evidence, unless a test scripts otherwise.
  if (r.stage === "done-when") {
    return done(
      json({
        items: r.ticket.doneWhen.map((d) => ({
          doneWhen: d,
          verdict: "met",
          evidence: "the diff and a test",
        })),
      }),
    );
  }
  if (r.duty === "verify") {
    return done(
      json({ items: r.ticket.doneWhen.map((d) => ({ doneWhen: d, pass: true, evidence: "screenshot" })) }),
    );
  }
  if (r.duty === "review") return done(json({ approved: true, findings: [] }));
  if (r.stage === "review") return done(json({ disputed: null }));
  if (r.stage === "report") return done("What changed: refunds are subtracted from spending.");
  if (r.stage === "work") return done(json({ proposals: [], nothing: "nothing to prepare" }));
  if (r.stage === "retro") return done(json({ edits: [] }));
  if (r.stage === "orient") {
    return done(
      json({
        edits: [
          {
            page: `projects/${r.ticket.project.toLowerCase()}`,
            text: `---\ntitle: ${r.ticket.project}\ndescription: What to know before working on ${r.ticket.project}\n---\n# ${r.ticket.project}\nRead the CLAUDE.md first. It says how the project is built and tested, which checks must pass before a review, where the specification lives, and which paths only the owner may change. Run the checks locally, keep commits small, and never push to main yourself: the daemon does that after the review.\n`,
          },
        ],
      }),
    );
  }
  return done("done");
}

export const json = (value: unknown): string => JSON.stringify(value);

/** The project recipe and final gates, scripted: queued results first, then green. */
export class FakeHarness implements Harness {
  readonly checks: ChecksResult[] = [];
  readonly gates: GatesResult[] = [];
  checkRuns = 0;
  gateRuns = 0;
  /** Results for one ticket only, used before the shared queue. */
  readonly checksFor = new Map<Id, ChecksResult[]>();
  async runChecks(ticket: Ticket): Promise<ChecksResult> {
    this.checkRuns++;
    return this.checksFor.get(ticket.id)?.shift() ?? this.checks.shift() ?? { green: true, failures: [] };
  }
  /** What each gates run was told: whether the owner approved protected paths. */
  readonly gateOpts: GatesOptions[] = [];
  /** Set to a commit: the next gates run reports it as about to be pushed, then throws `Crash` after the push. */
  crashAfterPushOf: string | null = null;
  async runGates(_: Ticket, opts: GatesOptions = {}): Promise<GatesResult> {
    this.gateRuns++;
    this.gateOpts.push(opts);
    const crash = this.crashAfterPushOf;
    if (crash) {
      this.crashAfterPushOf = null;
      await opts.onPushIntended?.(crash);
      throw new Crash();
    }
    return this.gates.shift() ?? { ok: true };
  }
  /** CI results on commits pushed to main, in order; green when the queue is empty. */
  readonly ci: CiResult[] = [];
  async watchCi(_: Ticket, _sha: string): Promise<CiResult> {
    return this.ci.shift() ?? { ok: true };
  }
  readonly reverted: string[] = [];
  async revert(_: Ticket, sha: string): Promise<void> {
    this.reverted.push(sha);
  }
  /** What briefs say about the machine and the checks. */
  description: string[] = [];
  describe(_: Ticket): string[] {
    return this.description;
  }
}

/**
 * A scripted helper model. Queued answers first; otherwise a simple heuristic: an ask for work
 * starts with an imperative ("add", "also", "fix", "find", ...), and a note mentions "this" or "it".
 */
export class FakeHelper implements HelperModel {
  readonly asked: { question: string; text: string }[] = [];
  readonly answers: boolean[] = [];
  async yesNo(question: string, text: string): Promise<boolean> {
    this.asked.push({ question, text });
    const queued = this.answers.shift();
    if (queued !== undefined) return queued;
    const t = text.trim().toLowerCase();
    if (question.includes("new work")) {
      return /^(please )?(add|also|fix|make|build|find|book|draft|write|create|update)\b/.test(t);
    }
    return /\b(this|it|that)\b/.test(t) && !t.endsWith("?");
  }
}

/** A scripted chat session: queued outcomes first, else a short answer. */
export class FakeChat implements ChatSession {
  readonly briefs: string[] = [];
  readonly outcomes: SessionOutcome[] = [];
  async answer(request: { employee: Employee; engine: Engine; brief: string }): Promise<SessionOutcome> {
    this.briefs.push(request.brief);
    return this.outcomes.shift() ?? { kind: "done", output: `${request.employee.name}: here's what I know.` };
  }
}

export class FakeCompany implements Company {
  private readonly employees = new Map<Id, Employee>();
  private readonly engineMap = new Map<Id, Engine>();
  /** The owner's contacts, for outbound rules. */
  readonly contacts: string[] = [];
  /** The company's project ids (what an engineer with no project named writes pages for). */
  readonly projects: string[] = [];
  projectIds(): string[] {
    return this.projects;
  }
  /**
   * Every project's policy. The fakes default to the owner-merges flow most tests were written for;
   * direct-mode tests set `mode: "direct"`.
   */
  policy: ProjectPolicy = { ...defaultProjectPolicy, mode: "owner-merges" };

  constructor(employees: Employee[], engines: Engine[]) {
    for (const e of employees) this.employees.set(e.id, e);
    for (const e of engines) this.engineMap.set(e.id, e);
  }
  projectPolicy(_project: string): ProjectPolicy {
    return this.policy;
  }
  engines(): Engine[] {
    return [...this.engineMap.values()];
  }
  employee(id: Id): Employee {
    const e = this.employees.get(id);
    if (!e) throw new Error(`no employee ${id}`);
    return e;
  }
  engine(id: Id): Engine {
    const e = this.engineMap.get(id);
    if (!e) throw new Error(`no engine ${id}`);
    return e;
  }
  isContact(address: string): boolean {
    return this.contacts.includes(address);
  }
  pickEmployee(duty: Duty, _ticket: Ticket, exclude: Id[]): Employee | undefined {
    return [...this.employees.values()].find((e) => e.duties.includes(duty) && !exclude.includes(e.id));
  }
  /** Employees (or engines) that can't run right now, as the daemon reports them (T50). */
  readonly blocks: { employee?: Id; engine?: Id; duty?: Duty; block: EngineBlock }[] = [];
  engineBlock(employeeId: Id, engineId: Id, duty: Duty): EngineBlock | null {
    const hit = this.blocks.find(
      (b) =>
        (!b.employee || b.employee === employeeId) &&
        (!b.engine || b.engine === engineId) &&
        (!b.duty || b.duty === duty),
    );
    return hit?.block ?? null;
  }
}

export interface FakePorts extends Ports {
  clock: FakeClock;
  store: MemoryEventStore;
  machines: FakeMachines;
  agent: FakeAgent;
  harness: FakeHarness;
  company: FakeCompany;
}

export function fakePorts(employees: Employee[], engines: Engine[]): FakePorts {
  return {
    clock: new FakeClock(),
    store: new MemoryEventStore(),
    machines: new FakeMachines(),
    agent: new FakeAgent(),
    harness: new FakeHarness(),
    company: new FakeCompany(employees, engines),
  };
}
