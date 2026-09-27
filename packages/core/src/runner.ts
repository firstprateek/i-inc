// The In progress loop (spec §6). Deterministic code runs the company; agents only do the work.
//
// runTicket takes one step at a time: fold the ticket's events, decide the next step, do it, append
// what happened, repeat. Nothing lives in memory between steps, so after a crash, a quota pause or
// an owner's answer, calling runTicket again carries on from the last event.
import { brief } from "./brief.ts";
import { engineAllowed, engineFor, nextFallback } from "./engines.ts";
import type { Decision, Finding, HelperDuty, NeedsYou, TicketEvent } from "./events.ts";
import type { Duty, Employee, Id, KnowledgeEdit, Proposal, Ticket } from "./model.ts";
import { decideOutbound } from "./outbound.ts";
import type { Ports } from "./ports.ts";
import { assembleReport, type Report } from "./report.ts";
import { planFor, type StageId, type StagePlan } from "./stages.ts";
import { fold, type TicketState } from "./state.ts";

export type RunResult =
  | { status: "ready"; report: Report }
  | { status: "paused"; until: number }
  | { status: "needs-you"; ask: NeedsYou }
  | { status: "waiting"; duty: HelperDuty }
  | { status: "failed"; reason: string; tried: string[] }
  | { status: "done"; outcome: "merged" | "rejected" | "done" };

/** A plan that touches these waits at the gate on Medium effort (spec §6, stage 2). */
const riskyAreas = /\b(schema|migration|auth|public api|dependenc|ci\b|workflow)/i;

/** Proof may fail once and be fixed; a second failure is an honest failure. */
const maxProofFailures = 2;
/** A rebase conflict may be resolved once; if it comes back, the ticket fails honestly. */
const maxGateConflicts = 2;
/** Guards against a bug that makes no progress. A healthy ticket takes a few dozen steps. */
const maxSteps = 500;

export interface RunOptions {
  /**
   * Who picks the reviewer and the verifier. "runner" picks the first employee with the duty, at once.
   * "scheduler" records that the stage wants one and returns "waiting": the daemon's scheduler picks a
   * free employee, records it with `assignHelper`, and runs the ticket again (spec §6).
   */
  helpers?: "runner" | "scheduler";
  /**
   * A fresh signal for each session, so an urgent message can stop it (spec §10, "Chat"). Called with
   * the employee who runs the session: only the builder's own sessions are interrupted.
   */
  signal?: (employeeId: Id) => AbortSignal | undefined;
}

interface Step {
  p: Ports;
  opts: RunOptions;
  ticket: Ticket;
  plan: StagePlan;
  s: TicketState;
  builder: Employee;
  emit: (...events: TicketEvent[]) => Promise<void>;
}

export async function runTicket(p: Ports, original: Ticket, opts: RunOptions = {}): Promise<RunResult> {
  const plan = planFor(original);
  const emit = (...events: TicketEvent[]) => p.store.append(original.id, events);

  for (let i = 0; i < maxSteps; i++) {
    const s = fold(await p.store.read(original.id));
    const now = p.clock.now();
    // A handoff changes who builds; the ticket, branch, plan and notes stay.
    const ticket = s.assignee ? { ...original, assignee: s.assignee } : original;
    const builder = p.company.employee(ticket.assignee);

    if (!s.created) {
      await emit({ type: "ticket-created", at: now, ticketId: ticket.id });
      continue;
    }
    if (s.status === "ready") return { status: "ready", report: assembleReport(ticket, s, p.company) };
    if (s.status === "done" && s.outcome) return { status: "done", outcome: s.outcome };
    if (s.status === "failed" && s.failure) {
      return { status: "failed", reason: s.failure.reason, tried: s.failure.tried };
    }
    if (s.status === "needs-you" && s.needsYou) return { status: "needs-you", ask: s.needsYou };
    if (s.waitingFor) return { status: "waiting", duty: s.waitingFor.duty };
    if (s.paused && now < s.paused.until) {
      if (await fallBackFromEmptyAccount({ p, opts, ticket, plan, s, builder, emit })) continue;
      return { status: "paused", until: s.paused.until };
    }

    // After the owner's decision on a code ticket, only the retro is left; errands have it in their plan.
    const stage =
      s.active ?? (s.decision && !s.finished.includes("retro") ? "retro" : plan.stages[s.finished.length]);
    if (!stage) throw new Error(`ticket ${ticket.id} ran out of stages without a report`);
    if (!s.active) {
      await emit({ type: "stage-started", at: now, stage });
      continue;
    }
    await stageSteps[stage]({ p, opts, ticket, plan, s, builder, emit });
  }
  throw new Error(`ticket ${original.id} made no progress in ${maxSteps} steps`);
}

/**
 * Hands a ticket to another employee (spec §6): it carries on from the same branch, plan and
 * progress notes, with a resume brief. Used for a ticket paused on an empty account, or a stuck one.
 */
export async function handOff(p: Ports, ticketId: Id, to: Id): Promise<void> {
  const s = fold(await p.store.read(ticketId));
  if (s.status === "done" || s.status === "ready")
    throw new Error(`ticket ${ticketId} is ${s.status}; nothing to hand off`);
  const from = s.assignee ?? s.sessions.find((x) => x.stage === "build")?.employeeId ?? "";
  await p.store.append(ticketId, [{ type: "reassigned", at: p.clock.now(), from, to }]);
}

/** Records the reviewer or verifier the scheduler picked for a waiting ticket. Run the ticket again afterwards. */
export async function assignHelper(p: Ports, ticketId: Id, duty: HelperDuty, employeeId: Id): Promise<void> {
  await p.store.append(ticketId, [{ type: "helper-assigned", at: p.clock.now(), duty, employeeId }]);
}

/** The owner's decision on a ready ticket: approve (merge), request changes, or reject. */
export async function decide(p: Ports, ticketId: Id, decision: Decision, note?: string): Promise<void> {
  const event: TicketEvent =
    note === undefined
      ? { type: "owner-decided", at: p.clock.now(), decision }
      : { type: "owner-decided", at: p.clock.now(), decision, note };
  await p.store.append(ticketId, [event]);
}

/** The owner's answer to a Needs you card. Run the ticket again afterwards. */
export async function answer(
  p: Ports,
  ticketId: Id,
  answer: "approve" | "reject" | "builder" | "reviewer",
  note?: string,
): Promise<void> {
  const event: TicketEvent =
    note === undefined
      ? { type: "owner-answered", at: p.clock.now(), answer }
      : { type: "owner-answered", at: p.clock.now(), answer, note };
  await p.store.append(ticketId, [event]);
}

const stageSteps: Record<StageId, (c: Step) => Promise<void>> = {
  // An errand (spec §7): the PA works through the home tools and hands back proposals.
  async work(c) {
    const out = await session(
      c,
      "build",
      c.builder,
      'Do the errand with the home tools. Send nothing yourself. Reply as JSON: {"proposals":[{"action","summary","to"?,"invitesOthers"?}]}.',
    );
    if (out !== null) await c.emit(checkpoint(c, "work", out), finished(c, "work"));
  },

  async proposals(c) {
    if (!c.s.proposals) {
      const items = parseJson<{ proposals: Proposal[] }>(c.s.outputs.work ?? "")?.proposals;
      if (!items) {
        await c.emit(failed(c, "proposals", "the errand's proposals could not be read"));
        return;
      }
      const isContact = (a: string) => c.p.company.isContact?.(a) ?? false;
      const by = (d: string) =>
        items.filter((p) => decideOutbound(p, c.builder.outbound ?? {}, isContact) === d);
      await c.emit({
        type: "proposals-sorted",
        at: c.p.clock.now(),
        auto: by("auto"),
        ask: by("ask"),
        off: by("off"),
      });
      return;
    }
    const { auto, ask, off } = c.s.proposals;
    if (ask.length && !c.s.lastAnswer) {
      await c.emit(needsYou(c, "proposals", { kind: "proposals", items: ask }));
      return;
    }
    const approved = c.s.lastAnswer?.answer === "approve" ? ask : [];
    const carryOut = [...auto, ...approved];
    const declined = [...off, ...ask.filter((p) => !approved.includes(p))];
    await c.emit(
      { type: "proposals-decided", at: c.p.clock.now(), carryOut, declined },
      finished(c, "proposals"),
    );
  },

  async pickup(c) {
    await c.p.machines.ensureUp(c.ticket.assignee);
    await c.emit(finished(c, "pickup"));
  },

  async plan(c) {
    const planText = c.s.outputs.plan;
    if (planText === undefined) {
      const out = await session(
        c,
        "plan",
        c.builder,
        "Explore, then write the approach, the files, the test strategy, the risks and all your questions at once. For a fix, write a failing test that reproduces the bug first.",
      );
      if (out !== null) await c.emit(checkpoint(c, "plan", out));
      return;
    }
    const gated = c.plan.planGate === "always" || (c.plan.planGate === "risky" && riskyAreas.test(planText));
    if (gated && !c.s.lastAnswer) {
      await c.emit(needsYou(c, "plan", { kind: "plan-gate", plan: planText }));
      return;
    }
    if (c.s.lastAnswer?.answer === "reject") {
      await c.emit(failed(c, "plan", "the owner rejected the plan"));
      return;
    }
    await c.emit(finished(c, "plan", planText));
  },

  async build(c) {
    const out = await session(
      c,
      "build",
      c.builder,
      "Implement the plan in small commits, pushing WIP as checkpoints.",
    );
    if (out !== null) await c.emit(checkpoint(c, "build", out), finished(c, "build"));
  },

  async checks(c) {
    if (c.s.fixDue) {
      if (c.s.checkFailures >= c.builder.switchRules.checksFailedBeforeSwitch) {
        await stuck(c, c.builder, "build", `${c.s.checkFailures} failed check runs`);
        return;
      }
      const out = await session(
        c,
        "build",
        c.builder,
        "The checks failed. Fix the failures; never skip or weaken a test.",
      );
      if (out !== null) await c.emit(checkpoint(c, "checks", out));
      return;
    }
    const result = await c.p.harness.runChecks(c.ticket);
    await c.emit({ type: "checks-ran", at: c.p.clock.now(), green: result.green, failures: result.failures });
    if (result.green) await c.emit(finished(c, "checks"));
  },

  async prove(c) {
    if (c.s.fixDue) {
      if (c.s.proofFailures >= maxProofFailures) {
        await c.emit(failed(c, "prove", "done-when items still fail after a fix"));
        return;
      }
      const out = await session(c, "build", c.builder, "Proof failed for some done-when items. Fix them.");
      if (out !== null) await c.emit(checkpoint(c, "prove", out));
      return;
    }
    const verifier = await helper(c, "verify");
    if (verifier === "none") {
      await c.emit(finished(c, "prove", "no one on the team has the verify duty"));
      return;
    }
    if (verifier === "wait") return;
    const out = await session(
      c,
      "verify",
      verifier,
      'Check each done-when item against the running app, as a black box. Reply as JSON: {"items":[{"doneWhen","pass","evidence"}]}.',
    );
    if (out === null) return;
    const items = parseJson<{ items: { doneWhen: string; pass: boolean; evidence: string }[] }>(out)?.items;
    if (!items) {
      await c.emit(failed(c, "prove", "the verifier's proof could not be read"));
      return;
    }
    await c.emit({ type: "proof", at: c.p.clock.now(), items });
    if (items.every((i) => i.pass)) await c.emit(finished(c, "prove"));
  },

  async review(c) {
    const r = c.s.review;

    // The owner settled an open disagreement.
    if (c.s.lastAnswer) {
      if (c.s.lastAnswer.answer === "reviewer") {
        const out = await session(
          c,
          "build",
          c.builder,
          "The owner sided with the reviewer. Fix the findings.",
        );
        if (out === null) return;
        await c.emit({ type: "addressed", at: c.p.clock.now(), round: r.round, disputed: null });
      }
      await c.emit(finished(c, "review", `settled by the owner: ${c.s.lastAnswer.answer}`));
      return;
    }

    const needsVerdict = r.round === 0 || (r.addressed && r.round < c.plan.reviewRounds);
    if (needsVerdict) {
      const reviewer = await helper(c, "review");
      if (reviewer === "none") {
        await c.emit(finished(c, "review", "no one on the team has the review duty"));
        return;
      }
      if (reviewer === "wait") return;
      if (reviewer.id === c.ticket.assignee) throw new Error("the reviewer must never be the builder");
      const out = await session(
        c,
        "review",
        reviewer,
        r.round === 0
          ? 'Check out the branch in your machine and run it. Reply as JSON: {"approved": boolean, "findings":[{"severity","where","text"}]}, checking the builder\'s claims against the diff.'
          : "Re-review only what changed since your last round, in the same JSON shape.",
      );
      if (out === null) return;
      const verdict = parseJson<{ approved: boolean; findings: Finding[] }>(out);
      if (!verdict) {
        await c.emit(failed(c, "review", "the review could not be read"));
        return;
      }
      await c.emit({
        type: "review-verdict",
        at: c.p.clock.now(),
        reviewerId: reviewer.id,
        round: r.round + 1,
        approved: verdict.approved,
        findings: verdict.findings,
      });
      if (verdict.approved) await c.emit(finished(c, "review"));
      return;
    }

    if (!r.addressed) {
      const out = await session(
        c,
        "build",
        c.builder,
        'Address each review finding: fix it, or say why not. Reply as JSON: {"disputed": null or "what you disagree with and why"}.',
      );
      if (out === null) return;
      const reply = parseJson<{ disputed: string | null }>(out);
      await c.emit({
        type: "addressed",
        at: c.p.clock.now(),
        round: r.round,
        disputed: reply?.disputed ?? null,
      });
      return;
    }

    // Addressed and out of rounds: an open disagreement goes to the owner, summarized; otherwise go on.
    if (r.disputed) {
      await c.emit(
        needsYou(c, "review", {
          kind: "disagreement",
          builder: r.disputed,
          reviewer: r.findings.map((f) => `${f.where}: ${f.text}`).join("; "),
        }),
      );
      return;
    }
    await c.emit(finished(c, "review", "findings addressed"));
  },

  async gates(c) {
    if (c.s.fixDue) {
      if (c.s.gateConflicts >= maxGateConflicts) {
        await c.emit(failed(c, "gates", "the rebase on main conflicted again after a fix"));
        return;
      }
      const out = await session(
        c,
        "build",
        c.builder,
        "The rebase on main conflicted. Resolve it and keep the checks green.",
      );
      if (out !== null) await c.emit(checkpoint(c, "gates", out));
      return;
    }
    const g = await c.p.harness.runGates(c.ticket);
    const at = c.p.clock.now();
    if (g.ok) {
      await c.emit({ type: "gates-ran", at, ok: true, conflict: false }, finished(c, "gates"));
      return;
    }
    await c.emit({ type: "gates-ran", at, ok: false, conflict: g.conflict, reason: g.reason });
    if (!g.conflict) await c.emit(failed(c, "gates", g.reason));
  },

  async report(c) {
    const out = await session(
      c,
      "build",
      c.builder,
      "Draft the report's judgment: what changed, why this way, risk, and the calls the owner might overrule.",
    );
    if (out === null) return;
    await c.emit(finished(c, "report", out), { type: "report-ready", at: c.p.clock.now(), summary: out });
  },

  // The retro (spec §6, stage 11): builder and reviewer each propose 0-2 knowledge edits.
  async retro(c) {
    const reviewerId = c.s.sessions.find(
      (x) => x.stage === "review" && x.employeeId !== c.builder.id,
    )?.employeeId;
    const people = [c.builder, ...(reviewerId ? [c.p.company.employee(reviewerId)] : [])];
    const next = people.find((e) => !c.s.retroBy.includes(e.id));
    if (next) {
      const out = await session(
        c,
        next.id === c.builder.id ? "build" : "review",
        next,
        'Look back at this ticket. Propose at most 2 durable, non-obvious, reusable lessons. Reply as JSON: {"edits":[{"layer":"brain"|"fact"|"policy","page","text"}]}. "brain" is your own working style and duty lessons; "fact" is useful to every employee; "policy" changes how the company works.',
      );
      if (out === null) return;
      const edits = (parseJson<{ edits: KnowledgeEdit[] }>(out)?.edits ?? [])
        .slice(0, 2)
        .map((e) => routed(c.ticket, e));
      await c.emit({
        type: "knowledge-proposed",
        at: c.p.clock.now(),
        employeeId: next.id,
        apply: edits.filter((e) => e.layer !== "policy"),
        awaitOwner: edits.filter((e) => e.layer === "policy"),
      });
      return;
    }
    const outcome = c.s.decision === "approve" ? "merged" : c.s.decision === "reject" ? "rejected" : "done";
    await c.emit(finished(c, "retro"), { type: "closed", at: c.p.clock.now(), outcome });
  },
};

/**
 * The reviewer or verifier for this ticket: the one already assigned, or "none" when no one else has
 * the duty. Otherwise "wait": the runner picked one itself, or asked the scheduler for one.
 */
async function helper(c: Step, duty: HelperDuty): Promise<Employee | "none" | "wait"> {
  const assigned = c.s.helpers[duty];
  if (assigned && assigned !== c.ticket.assignee) return c.p.company.employee(assigned);
  const pick = c.p.company.pickEmployee(duty, c.ticket, [c.ticket.assignee]);
  if (!pick) return "none";
  const at = c.p.clock.now();
  await c.emit(
    c.opts.helpers === "scheduler"
      ? { type: "helper-wanted", at, stage: c.s.active as StageId, duty }
      : { type: "helper-assigned", at, duty, employeeId: pick.id },
  );
  return "wait";
}

/** Runs one session. Returns its output, or null when it paused, switched engine, escalated or failed. */
async function session(c: Step, duty: Duty, employee: Employee, task: string): Promise<string | null> {
  const stage = c.s.active as StageId;
  const isAssignee = employee.id === c.ticket.assignee;
  const engineId = engineFor(employee, duty, c.s, isAssignee);
  const engine = c.p.company.engine(engineId);
  if (!engineAllowed(c.ticket, engine)) {
    await c.emit(failed(c, stage, `${engine.model} is not a local engine, and errands carry home data`));
    return null;
  }

  await c.p.machines.ensureUp(employee.id);
  const text = brief(c.ticket, stage, c.s, task);
  await c.emit({
    type: "session-started",
    at: c.p.clock.now(),
    stage,
    employeeId: employee.id,
    engineId,
    resume: c.s.interrupted || c.s.paused !== null,
  });
  const signal = c.opts.signal?.(employee.id);
  const out = await c.p.agent.run({
    ticket: c.ticket,
    stage,
    duty,
    employee,
    engine,
    brief: text,
    ...(signal ? { signal } : {}),
  });

  if (out.kind === "done") return out.output;
  if (out.kind === "interrupted") {
    await c.emit({ type: "session-interrupted", at: c.p.clock.now(), stage, reason: out.reason });
    return null;
  }
  if (out.kind === "out-of-tokens") {
    await c.emit({ type: "out-of-tokens", at: c.p.clock.now(), stage, engineId, resetsAt: out.resetsAt });
    return null;
  }
  await stuck(c, employee, duty, `the agent is stuck: ${out.reason}`);
  return null;
}

/** The stuck switch rule: move to the next fallback engine for the rest of the stage, or escalate, or fail. */
async function stuck(c: Step, employee: Employee, duty: Duty, reason: string): Promise<void> {
  const stage = c.s.active as StageId;
  const current = engineFor(employee, duty, c.s, employee.id === c.ticket.assignee);
  if (employee.switchRules.onStuck === "switch" && employee.id === c.ticket.assignee) {
    const next = nextFallback(employee, current, c.s, c.ticket, c.p.company);
    if (next) {
      await c.emit({ type: "engine-switched", at: c.p.clock.now(), stage, from: current, to: next, reason });
      return;
    }
  }
  if (employee.switchRules.onStuck === "escalate") {
    await c.emit(needsYou(c, stage, { kind: "stuck", reason }));
    return;
  }
  await c.emit(failed(c, stage, reason));
}

/** The out-of-tokens switch rule: after waiting long enough, move the builder to a fallback engine. */
async function fallBackFromEmptyAccount(c: Step): Promise<boolean> {
  const paused = c.s.paused;
  const rule = c.builder.switchRules.outOfTokens;
  const last = c.s.sessions.at(-1);
  if (!paused || rule.action !== "fallback" || last?.employeeId !== c.builder.id) return false;
  if (c.p.clock.now() - paused.since < rule.afterMinutes * 60_000) return false;
  const next = nextFallback(c.builder, paused.engineId, c.s, c.ticket, c.p.company);
  if (!next) return false;
  const model = c.p.company.engine(paused.engineId).model;
  await c.emit({
    type: "engine-switched",
    at: c.p.clock.now(),
    stage: c.s.active as StageId,
    from: paused.engineId,
    to: next,
    reason: `${model} ran out of tokens`,
  });
  return true;
}

function finished(c: Step, stage: StageId, output?: string): TicketEvent {
  return output === undefined
    ? { type: "stage-finished", at: c.p.clock.now(), stage }
    : { type: "stage-finished", at: c.p.clock.now(), stage, output };
}

function checkpoint(c: Step, stage: StageId, note: string): TicketEvent {
  return { type: "checkpoint", at: c.p.clock.now(), stage, note };
}

function needsYou(c: Step, stage: StageId, ask: NeedsYou): TicketEvent {
  return { type: "needs-you", at: c.p.clock.now(), stage, ask };
}

/** An honest failure: what went wrong and which engines were tried. */
function failed(c: Step, stage: StageId, reason: string): TicketEvent {
  const tried = [
    ...new Set(
      c.s.sessions.filter((x) => x.stage === stage).map((x) => c.p.company.engine(x.engineId).model),
    ),
  ];
  return { type: "failed", at: c.p.clock.now(), stage, reason, tried };
}

/** Home data never reaches the shared handbook: an errand's lessons stay in the PA's own brain (spec §5). */
function routed(ticket: Ticket, edit: KnowledgeEdit): KnowledgeEdit {
  return ticket.type === "errand" ? { ...edit, layer: "brain" } : edit;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
