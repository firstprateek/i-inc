// Fakes for every port, so the whole pipeline runs in tests without spending tokens.
import type { TicketEvent } from "../events.ts";
import type { Duty, Employee, Engine, Id, Ticket } from "../model.ts";
import type {
  Agent,
  ChecksResult,
  Clock,
  Company,
  EventStore,
  GatesResult,
  Harness,
  MachineProvider,
  Ports,
  SessionOutcome,
  SessionRequest,
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
  async ensureUp(employeeId: Id): Promise<void> {
    this.started.push(employeeId);
  }
}

/** Thrown by the fake agent to simulate the daemon dying mid-session. */
export class Crash extends Error {
  constructor() {
    super("simulated daemon crash");
  }
}

export type Scripted = SessionOutcome | { kind: "crash" };

export interface Match {
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
    return next;
  }

  /** Calls for one employee in one stage, in order. */
  callsFor(employee: Id, stage?: StageId): SessionRequest[] {
    return this.calls.filter((c) => c.employee.id === employee && (!stage || c.stage === stage));
  }
}

function matches(m: Match, r: SessionRequest): boolean {
  return (
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
  return done("done");
}

export const json = (value: unknown): string => JSON.stringify(value);

/** The project recipe and final gates, scripted: queued results first, then green. */
export class FakeHarness implements Harness {
  readonly checks: ChecksResult[] = [];
  readonly gates: GatesResult[] = [];
  checkRuns = 0;
  gateRuns = 0;
  async runChecks(_: Ticket): Promise<ChecksResult> {
    this.checkRuns++;
    return this.checks.shift() ?? { green: true, failures: [] };
  }
  async runGates(_: Ticket): Promise<GatesResult> {
    this.gateRuns++;
    return this.gates.shift() ?? { ok: true };
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
