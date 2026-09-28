// Fakes for every port, so the whole pipeline runs in tests without spending tokens.
import type { TicketEvent } from "../events.ts";
import type { Duty, Employee, Engine, Id, PullRequestRef, Ticket } from "../model.ts";
import type {
  Agent,
  ChatSession,
  ChecksResult,
  Clock,
  Company,
  EventStore,
  GatesResult,
  Harness,
  HelperModel,
  MachineProvider,
  Ports,
  SessionOutcome,
  SessionRequest,
  Workspace,
} from "../ports.ts";
import type { StageId } from "../stages.ts";

export class FakeClock implements Clock {
  constructor(private t = Date.UTC(2026, 8, 27, 21, 40)) {}
  now(): number {
    return this.t;
  }
  advance(minutes: number): void {
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
  async ensureUp(employeeId: Id): Promise<void> {
    this.started.push(employeeId);
  }
  async stop(employeeId: Id): Promise<void> {
    this.stopped.push(employeeId);
  }
}

/** Records the branches it opens and the PRs it marks ready. Set `failOpen` to make pick-up fail. */
export class FakeWorkspace implements Workspace {
  readonly opened: Id[] = [];
  readonly readied: { ticketId: Id; pr: PullRequestRef; report: string }[] = [];
  failOpen: string | null = null;
  async open(ticket: Ticket, builder: Employee): Promise<PullRequestRef> {
    if (this.failOpen) throw new Error(this.failOpen);
    this.opened.push(ticket.id);
    return {
      number: Number(ticket.id),
      url: `https://github.com/owner/repo/pull/${ticket.id}`,
      nodeId: `PR_${ticket.id}`,
      branch: `inc/${ticket.id}-${builder.id}`,
    };
  }
  async ready(ticket: Ticket, pr: PullRequestRef, report: string): Promise<void> {
    this.readied.push({ ticketId: ticket.id, pr, report });
  }
}

/** Thrown by the fake agent to simulate the daemon dying mid-session. */
export class Crash extends Error {
  constructor() {
    super("simulated daemon crash");
  }
}

/** "hang" keeps the session going until its signal aborts, like a long build the owner interrupts. */
export type Scripted = SessionOutcome | { kind: "crash" } | { kind: "hang" };

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
  if (r.duty === "verify") {
    return done(
      json({ items: r.ticket.doneWhen.map((d) => ({ doneWhen: d, pass: true, evidence: "screenshot" })) }),
    );
  }
  if (r.duty === "review") return done(json({ approved: true, findings: [] }));
  if (r.stage === "review") return done(json({ disputed: null }));
  if (r.stage === "report") return done("What changed: refunds are subtracted from spending.");
  if (r.stage === "work") return done(json({ proposals: [] }));
  if (r.stage === "retro") return done(json({ edits: [] }));
  if (r.stage === "orient") {
    return done(
      json({
        edits: [{ page: `projects/${r.ticket.project.toLowerCase()}`, text: "Read the CLAUDE.md first." }],
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
  async runGates(_: Ticket): Promise<GatesResult> {
    this.gateRuns++;
    return this.gates.shift() ?? { ok: true };
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
  private readonly engines = new Map<Id, Engine>();
  /** The owner's contacts, for outbound rules. */
  readonly contacts: string[] = [];

  constructor(employees: Employee[], engines: Engine[]) {
    for (const e of employees) this.employees.set(e.id, e);
    for (const e of engines) this.engines.set(e.id, e);
  }
  employee(id: Id): Employee {
    const e = this.employees.get(id);
    if (!e) throw new Error(`no employee ${id}`);
    return e;
  }
  engine(id: Id): Engine {
    const e = this.engines.get(id);
    if (!e) throw new Error(`no engine ${id}`);
    return e;
  }
  isContact(address: string): boolean {
    return this.contacts.includes(address);
  }
  pickEmployee(duty: Duty, _ticket: Ticket, exclude: Id[]): Employee | undefined {
    return [...this.employees.values()].find((e) => e.duties.includes(duty) && !exclude.includes(e.id));
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
