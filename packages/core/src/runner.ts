// The In progress loop (spec §6). Deterministic code runs the company; agents only do the work.
//
// runTicket takes one step at a time: fold the ticket's events, decide the next step, do it, append
// what happened, repeat. Nothing lives in memory between steps, so after a crash, a quota pause or
// an owner's answer, calling runTicket again carries on from the last event.
import { stuckAsk } from "./approvals.ts";
import { brief, freshBrief } from "./brief.ts";
import { engineAllowed, engineFor, findEngine, nextFallback } from "./engines.ts";
import type { Decision, HelperDuty, NeedsYou, TicketEvent } from "./events.ts";
import { isHomeEmployee } from "./hiring.ts";
import {
  engineerOrientationTask,
  homeOrientationTask,
  orientationExpectations,
  orientationFeedback,
  tidyFeedback,
} from "./home.ts";
import {
  type Duty,
  defaultProjectPolicy,
  type Effort,
  type Employee,
  type Id,
  type KnowledgeEdit,
  type ProjectPolicy,
  type Ticket,
} from "./model.ts";
import { decideOutbound } from "./outbound.ts";
import { type Ports, type SessionOutcome, StartupError, type WorktreeSnapshot } from "./ports.ts";
import { assembleReport, type Report, reportMarkdown } from "./report.ts";
import { planFor, type StageId, type StagePlan } from "./stages.ts";
import { fold, type TicketState } from "./state.ts";
import {
  type DoneWhenItem,
  isRecord,
  nothingMeansNoActionNeeded,
  readDisputed,
  readDoneWhenCheck,
  readEdits,
  readFollowUps,
  readProof,
  readProposals,
  readVerdict,
} from "./validate.ts";

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
/** Direct mode: how long main may stay red after this ticket's push before the push is reverted. */
const redMainLimitMs = 2 * 60 * 60_000;
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
  policy: ProjectPolicy;
  s: TicketState;
  builder: Employee;
  emit: (...events: TicketEvent[]) => Promise<void>;
}

export async function runTicket(p: Ports, original: Ticket, opts: RunOptions = {}): Promise<RunResult> {
  const policy = p.company.projectPolicy?.(original.project) ?? defaultProjectPolicy;
  const plan = planFor(original, policy);
  const emit = (...events: TicketEvent[]) => p.store.append(original.id, events);

  for (let i = 0; i < maxSteps; i++) {
    const s = fold(await p.store.read(original.id));
    const now = p.clock.now();
    // A handoff changes who builds; the ticket, branch, plan and notes stay. Images the owner added
    // since this run began come from the events.
    const ticket = withAttachments(s.assignee ? { ...original, assignee: s.assignee } : original, s);
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
      if (await fallBackFromEmptyAccount({ p, opts, ticket, plan, policy, s, builder, emit })) continue;
      return { status: "paused", until: s.paused.until };
    }

    // After the owner's decision on a code ticket, only the retro is left; errands have it in their plan.
    // The next stage is the plan's first one not yet finished, not the one at the count of finished stages: a
    // plan that changed under a running ticket (fast mode replacing plan, prove and done-when) would otherwise
    // skip the gates or run off the end.
    const stage =
      s.active ??
      (s.decision && !s.finished.includes("retro")
        ? "retro"
        : plan.stages.find((st) => !s.finished.includes(st)));
    if (!stage) throw new Error(`ticket ${ticket.id} ran out of stages without a report`);
    if (!s.active) {
      await emit({ type: "stage-started", at: now, stage });
      continue;
    }
    await stageSteps[stage]({ p, opts, ticket, plan, policy, s, builder, emit });
  }
  throw new Error(`ticket ${original.id} made no progress in ${maxSteps} steps`);
}

/**
 * Hands a ticket to another employee (spec §6): it carries on from the same branch, plan and
 * progress notes, with a resume brief. Used for a ticket paused on an empty account, or a stuck one.
 */
/** Tries a failed ticket again from the stage it failed in, with a resume brief (spec §6). */
export async function retry(p: Ports, ticketId: Id): Promise<void> {
  const s = fold(await p.store.read(ticketId));
  if (s.status !== "failed") throw new Error(`ticket ${ticketId} is ${s.status}, not failed`);
  await p.store.append(ticketId, [{ type: "retried", at: p.clock.now() }]);
}

export async function handOff(p: Ports, ticketId: Id, to: Id): Promise<void> {
  const s = fold(await p.store.read(ticketId));
  if (s.status === "done" || s.status === "ready")
    throw new Error(`ticket ${ticketId} is ${s.status}; nothing to hand off`);
  const from = s.assignee ?? s.sessions.find((x) => x.stage === "build")?.employeeId ?? "";
  await p.store.append(ticketId, [{ type: "reassigned", at: p.clock.now(), from, to }]);
}

/** Records the reviewer or verifier the scheduler picked for a waiting ticket. Run the ticket again afterwards. */
export async function assignHelper(
  p: Ports,
  ticketId: Id,
  duty: HelperDuty,
  employeeId: Id,
): Promise<boolean> {
  // The scheduler decided from a snapshot that may be seconds old (a machine stopping in between, an
  // owner's action): the ticket must still be waiting for this duty, or the assignment is dropped.
  const s = fold(await p.store.read(ticketId));
  if (s.waitingFor?.duty !== duty) return false;
  await p.store.append(ticketId, [{ type: "helper-assigned", at: p.clock.now(), duty, employeeId }]);
  return true;
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
  answer: "approve" | "reject" | "builder" | "reviewer" | "continue",
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
    if (c.s.lastAnswer?.answer === "reject") {
      await c.emit(failed(c, "work", "the owner declined to keep going"));
      return;
    }
    const last = c.s.doneWhen.last;
    const task =
      'Do the errand with the home tools. Send nothing yourself. Reply as JSON: {"proposals":[{"action","summary","to"?,"invitesOthers"?}]}. If the errand needs no outgoing action, say why: {"proposals":[],"nothing":"<the reason>"}.';
    const out = await session(
      c,
      "build",
      c.builder,
      last && !last.met
        ? `${task}\n\nYour last reply had no proposals and no reason. List the proposals, or give the reason nothing is needed in "nothing". An empty list alone is not an answer.`
        : task,
    );
    if (out === null) return;
    // An empty result alone is how a model that did nothing looks. The errand is done when it proposes something
    // or says why nothing is needed; a bare empty reply gets one more session, then goes to the owner.
    const reply = parseJson<unknown>(out);
    const proposals = readProposals(reply);
    const nothing = isRecord(reply) && typeof reply.nothing === "string" ? reply.nothing.trim() : "";
    if (proposals !== null && proposals.length === 0 && nothing && !nothingMeansNoActionNeeded(nothing)) {
      // A reason that is giving up ("sudo failed", "no internet", an error text) is not a finished errand.
      await c.emit(
        {
          type: "done-when-checked",
          at: c.p.clock.now(),
          stage: "work",
          met: false,
          missing: [`gave up: ${nothing}`],
        },
        needsYou(c, "work", {
          kind: "stuck",
          reason: `${c.builder.name} proposed nothing, and says: "${nothing.slice(0, 300)}". That reads as giving up, not as nothing to do`,
        }),
      );
      return;
    }
    if (proposals !== null && proposals.length === 0 && !nothing) {
      const misses = c.s.doneWhen.misses + 1;
      const at = c.p.clock.now();
      await c.emit(
        { type: "done-when-checked", at, stage: "work", met: false, missing: ["no proposals and no reason"] },
        ...(misses >= maxMisses
          ? [
              needsYou(c, "work", {
                kind: "stuck",
                reason: `${c.builder.name} finished the errand with no proposals and no reason, after ${misses} sessions`,
              }),
            ]
          : []),
      );
      return;
    }
    await c.emit(
      ...(proposals !== null && proposals.length === 0 && nothing
        ? [{ type: "errand-nothing", at: c.p.clock.now(), reason: nothing } as TicketEvent]
        : []),
      checkpoint(c, "work", out),
      finished(c, "work"),
    );
  },

  async proposals(c) {
    if (!c.s.proposals) {
      const items = readProposals(parseJson(c.s.outputs.work ?? ""));
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

  // Orientation (spec §5, "Hiring"): the new hire reads, then writes its brain's first pages. A PA has no code
  // projects, so its orientation is its own (home.ts). It closes only when the pages it was asked for are there.
  async orient(c) {
    if (c.s.lastAnswer?.answer === "reject") {
      await c.emit(failed(c, "orient", "the owner declined to keep going"));
      return;
    }
    const home = isHomeEmployee(c.builder);
    const expected = orientationExpectations(c.ticket, c.builder, home, c.p.company.projectIds?.() ?? []);
    const last = c.s.doneWhen.last;
    const redo =
      last && !last.met
        ? expected
            .map((e) => ({ e, problem: last.missing.find((m) => m.startsWith(`${e.page}:`)) }))
            .filter((x): x is { e: (typeof expected)[number]; problem: string } => x.problem !== undefined)
            .map((x) => ({ problem: x.problem, how: x.e.how }))
        : [];
    const task = [
      home ? homeOrientationTask(c.builder) : engineerOrientationTask(c.builder, expected, pageRules),
      ...(redo.length ? [orientationFeedback(redo)] : []),
    ].join("\n\n");
    const out = await session(c, "build", c.builder, task);
    if (out === null) return;
    const read = readEdits(replyField(out, "edits"), { layer: "brain" });
    const edits = read.kept;
    const at = c.p.clock.now();
    // What the agent wrote in its brain copy is collected now, so the check sees it (and the harvest at the end
    // of the ticket finds nothing more to do). Pages it sent back as JSON count as written too.
    let unmet: Unmet = "skip";
    if (c.p.brainState) {
      const have = await c.p.brainState.pages(c.builder.id, c.ticket.id);
      if (have === null) unmet = "unreadable";
      else {
        const pages = new Map([
          ...have,
          ...Object.entries(c.s.brainProposed),
          ...edits.map((e): [string, string] => [e.page, e.text]),
        ]);
        unmet = expected.map((e) => e.problem(pages)).filter((m): m is string => m !== null);
      }
    }
    await closeIfDone(
      c,
      "orient",
      unmet,
      [
        ...flagged(c, "orient", "edits", read.dropped),
        { type: "knowledge-proposed", at, employeeId: c.builder.id, apply: edits, awaitOwner: [] },
      ],
      home ? "its home pages" : "its project pages",
    );
  },

  async pickup(c) {
    await c.p.machines.ensureUp(c.ticket.assignee);
    // A code ticket gets its branch and draft PR now, so CI runs from the start (spec §6).
    const { workspace } = c.p;
    if (workspace && c.plan.stages.includes("build") && !c.s.pr) {
      const pr = await openWorkspace(c, c.builder, "pickup");
      if (pr) await c.emit(...pr, finished(c, "pickup"));
      return;
    }
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
    // Lenient approvals never hold a plan for the owner.
    const gated =
      !lenient(c) &&
      (c.plan.planGate === "always" || (c.plan.planGate === "risky" && riskyAreas.test(planText)));
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
    // Fast mode has no plan stage: the builder plans in the same session, and its closing summary is the report.
    const out = await session(
      c,
      "build",
      c.builder,
      c.plan.fast ? fastBuildTask : "Implement the plan in small commits, pushing WIP as checkpoints.",
    );
    if (out === null) return;
    // The output is capped at 16 KB, which could cut off a long reply's closing summary: keep the summary itself.
    const summary = c.plan.fast ? lastJson(out) : null;
    await c.emit(
      checkpoint(c, "build", out),
      c.plan.fast ? finished(c, "build", summary ? JSON.stringify(summary) : out) : finished(c, "build"),
    );
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
    // One append, so a stop between the result and the stage's end can't leave a green run unrecorded as done.
    await c.emit(
      { type: "checks-ran", at: c.p.clock.now(), green: result.green, failures: result.failures },
      ...(result.green ? [finished(c, "checks")] : []),
    );
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
    const seat = await verifySeat(c);
    if (seat === "none") {
      await c.emit(finished(c, "prove", "no one on the team has the verify duty"));
      return;
    }
    if (seat === "wait") return;
    const verifier = "employee" in seat ? seat.employee : seat;
    const out = await session(
      c,
      "verify",
      verifier,
      'Check each done-when item against the running app, as a black box. Reply as JSON: {"items":[{"doneWhen","pass","evidence"}]}.',
      "employee" in seat
        ? { fresh: true, helperFor: "verify", ...(seat.engineId ? { engineId: seat.engineId } : {}) }
        : { helperFor: "verify" },
    );
    if (out === null) return;
    const items = readProof(parseJson(out));
    if (!items) {
      await c.emit(failed(c, "prove", `the verifier's proof could not be read${quoteOf(out)}`));
      return;
    }
    await c.emit(
      { type: "proof", at: c.p.clock.now(), items },
      ...(items.every((i) => i.pass) ? [finished(c, "prove")] : []),
    );
  },

  // The done-when check (T72): every code ticket's done-when is checked before it closes. Where the prove stage
  // checked it, this only records that; otherwise a fresh, light, read-only session that is never the builder's
  // own checks each item. All met: on to the gates. Something not met: the builder fixes it once. Still not met,
  // or can't tell: the owner, with the result for each item. Nothing is ever marked done on a guess.
  async "done-when"(c) {
    if (c.s.lastAnswer?.answer === "reject") {
      await c.emit(failed(c, "done-when", "the owner declined to keep going"));
      return;
    }
    const items = c.ticket.doneWhen.map((d) => d.trim()).filter(Boolean);
    const at = c.p.clock.now();
    if (c.s.fixDue) {
      const unmet = (c.s.doneCheck?.items ?? []).filter((i) => i.verdict !== "met");
      const out = await session(
        c,
        "build",
        c.builder,
        `Your change was checked against the ticket's done-when, and these items are not met or could not be confirmed:\n${unmet
          .map(
            (i) =>
              `- ${i.doneWhen}: ${i.verdict === "not-met" ? "not met" : "can't tell"}${i.evidence ? `, ${i.evidence}` : ""}`,
          )
          .join(
            "\n",
          )}\nFix what is missing, or make it easy to confirm (a test, a clear change), and keep the checks green. ${
          c.policy.mode === "direct"
            ? "Commit your work to the local branch."
            : "Commit your work: i.inc pushes the branch for the recheck, and the checker reads what is committed."
        }`,
      );
      if (out !== null) await c.emit(checkpoint(c, "done-when", out));
      return;
    }
    if (!items.length) {
      await c.emit(
        { type: "done-when-verdict", at, by: null, items: [], retry: false, note: noDoneWhen },
        finished(c, "done-when", noDoneWhen),
      );
      return;
    }
    // A prove stage that ran and passed has checked these items already: no second check.
    const proof = c.s.lastProof;
    if (c.s.finished.includes("prove") && proof && proof.length > 0 && proof.every((i) => i.pass)) {
      await c.emit(
        {
          type: "done-when-verdict",
          at,
          by: null,
          items: proof.map((i) => ({ doneWhen: i.doneWhen, verdict: "met" as const, evidence: i.evidence })),
          retry: false,
          note: "Checked in the prove stage",
        },
        finished(c, "done-when", "checked in the prove stage"),
      );
      return;
    }
    const seat = await doneWhenSeat(c);
    if (seat === "wait") return;
    // Owner-merges: a checker in another machine reads the branch from GitHub, so what the builder committed
    // (the first time, or in the fix) goes there first, by the host (T68). Pushing again is harmless.
    const ws = c.p.workspace;
    if (ws?.push && c.policy.mode === "owner-merges" && c.s.pr?.number !== undefined) {
      try {
        await ws.push(c.ticket, c.builder);
      } catch (err) {
        if (isPassing(err)) throw err;
        await c.emit(failed(c, "done-when", `couldn't push the branch for the check: ${errorText(err)}`));
        return;
      }
    }
    const checks = c.s.lastChecks;
    const guard: Guard = { changed: [], restored: true };
    const out = await session(
      c,
      seat.duty,
      seat.employee,
      `Check whether this change meets each done-when item above. Read the diff of this folder against main (\`git diff origin/main\`, committed or not) and whatever else you need, but change no files. The checks ${
        !checks
          ? "were not run"
          : checks.green
            ? "passed on the builder's last run"
            : `failed on the builder's last run: ${checks.failures.join("; ")}`
      }. For each item answer met, not met, or can't tell, with evidence (a file and line, a test, a command's output); say can't tell rather than guess. Be brief. Reply as JSON: {"items":[{"doneWhen":"<the item, word for word>","verdict":"met"|"not met"|"can't tell","evidence":"..."}]}.`,
      {
        fresh: true,
        helperFor: seat.duty,
        effort: "low",
        guard,
        ...(seat.engineId ? { engineId: seat.engineId } : {}),
      },
    );
    if (out === null) return;
    // "Read-only" is only a request (sessions run with full access), so the worktree is compared before and after.
    // A checker that changed anything has its changes put back and its answer thrown away: the owner decides.
    if (guard.changed.length) {
      const what = `the checker changed files (${guard.changed.slice(0, 5).join(", ")}${guard.changed.length > 5 ? ", ..." : ""}), so its answer is not used${guard.restored ? "; they were put back" : "; they could not be put back, so look at the worktree"}`;
      const touched: DoneWhenItem[] = items.map((doneWhen) => ({
        doneWhen,
        verdict: "cant-tell",
        evidence: what,
      }));
      await c.emit(
        { type: "done-when-verdict", at, by: seat.employee.id, items: touched, retry: false },
        { type: "done-when-checked", at, stage: "done-when", met: false, missing: items },
        needsYou(c, "done-when", {
          kind: "stuck",
          reason: `The done-when is not confirmed: ${c.p.company.employee(seat.employee.id).name}, who was checking it, ${what.replace("the checker changed", "changed")}`,
        }),
      );
      return;
    }
    const read = parseJson<unknown>(out);
    const earlier = c.s.doneCheck?.items ?? [];
    const result: DoneWhenItem[] = readDoneWhenCheck(read, items).map((i) =>
      read === null
        ? {
            ...i,
            evidence: `the checker's reply could not be read${quoteOf(out)}`,
            unanswered: true as const,
          }
        : stillNotMet(c, i, earlier),
    );
    const unmet = result.filter((i) => blocks(c, i));
    const by = seat.employee.id;
    if (unmet.length === 0) {
      // Lenient: an item the checker can't confirm doesn't hold the work; the report shows it as not confirmed.
      const unsure = result.filter((i) => i.verdict !== "met").length;
      await c.emit(
        { type: "done-when-verdict", at, by, items: result, retry: false },
        { type: "done-when-checked", at, stage: "done-when", met: true, missing: [] },
        finished(c, "done-when", unsure ? `went ahead; ${unsure} not confirmed` : undefined),
      );
      return;
    }
    // One fix session for something that is not met; can't tell, or a second miss, is the owner's to look at.
    const retry = c.s.doneWhen.misses === 0 && unmet.some((i) => i.verdict === "not-met");
    await c.emit(
      { type: "done-when-verdict", at, by, items: result, retry },
      {
        type: "done-when-checked",
        at,
        stage: "done-when",
        met: false,
        missing: unmet.map((i) => i.doneWhen),
      },
      ...(retry
        ? []
        : [
            needsYou(c, "done-when", {
              kind: "stuck",
              reason: `${doneWhenLine(unmet, result.length)}${c.s.doneWhen.misses > 0 ? " after the fix" : ""}, says ${c.p.company.employee(by).name}`,
            }),
          ]),
    );
  },

  async review(c) {
    if (c.plan.fast && c.policy.mode === "direct") return fastCheck(c);
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
        await c.emit(
          { type: "addressed", at: c.p.clock.now(), round: r.round, disputed: null },
          finished(c, "review", `settled by the owner: ${c.s.lastAnswer.answer}`),
        );
        return;
      }
      await c.emit(finished(c, "review", `settled by the owner: ${c.s.lastAnswer.answer}`));
      return;
    }

    const direct = c.policy.mode === "direct";
    const needsVerdict = r.round === 0 || (r.addressed && r.round < c.plan.reviewRounds);
    if (needsVerdict) {
      const seat = direct ? await reviewSeat(c) : await helperOrWait(c, "review");
      if (seat === "none") {
        await c.emit(finished(c, "review", "no one on the team has the review duty"));
        return;
      }
      if (seat === "wait") return;
      const reviewer = "employee" in seat ? seat.employee : seat;
      if (!direct && reviewer.id === c.ticket.assignee)
        throw new Error("the reviewer must never be the builder");
      const shape =
        '{"approved": boolean, "findings":[{"severity":"blocking"|"should-fix"|"nit","where","text"}]}';
      const earlier = r.findings.map((f) => `- [${f.severity}] ${f.where}: ${f.text}`).join("\n");
      const task = direct
        ? r.round === 0
          ? `Review this change with fresh eyes. It's the diff of this folder against main: \`git diff origin/main\`, committed or not. Run what you need, but don't change any files. Reply as JSON: ${shape}.`
          : `Re-review this change: the builder addressed your earlier findings, below. Check the diff in this folder against main again; don't change any files. Reply as JSON: ${shape}.\nEarlier findings:\n${earlier}`
        : r.round === 0
          ? `Check out the branch in your machine and run it. Reply as JSON: ${shape}, checking the builder's claims against the diff.`
          : "Re-review only what changed since your last round, in the same JSON shape.";
      const out = await session(
        c,
        "review",
        reviewer,
        task,
        "employee" in seat
          ? { fresh: true, helperFor: "review", ...(seat.engineId ? { engineId: seat.engineId } : {}) }
          : { fresh: direct, helperFor: "review" },
      );
      if (out === null) return;
      const verdict = readVerdict(parseJson(out));
      if (!verdict) {
        await c.emit(failed(c, "review", `the review could not be read${quoteOf(out)}`));
        return;
      }
      await c.emit(
        {
          type: "review-verdict",
          at: c.p.clock.now(),
          reviewerId: reviewer.id,
          round: r.round + 1,
          approved: verdict.approved,
          findings: verdict.findings,
        },
        ...(verdict.approved ? [finished(c, "review")] : []),
      );
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
      await c.emit({
        type: "addressed",
        at: c.p.clock.now(),
        round: r.round,
        disputed: readDisputed(parseJson(out)),
      });
      return;
    }

    // Addressed and out of rounds. Direct mode goes on after 2 rounds, noting any open disagreement
    // for the report; otherwise it goes to the owner, summarized.
    if (r.disputed && (c.policy.mode === "direct" || lenient(c))) {
      await c.emit(
        finished(
          c,
          "review",
          `went ahead after ${r.round} review rounds; the builder disputed: ${r.disputed}`,
        ),
      );
      return;
    }
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
    if (c.policy.mode === "direct") return directGates(c);
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
    if (c.policy.mode === "direct") return directReport(c);
    const out = await session(
      c,
      "build",
      c.builder,
      "Draft the report's judgment: what changed, why this way, risk, and the calls the owner might overrule. Reply with the report itself: i.inc puts it into the PR, so don't edit the PR.",
    );
    if (out === null) return;
    const at = c.p.clock.now();
    // The report becomes the PR's body, and the PR comes out of draft for the owner.
    if (c.p.workspace && c.s.pr) {
      const worked = c.s.workedMs + (c.s.lastAt !== null ? at - c.s.lastAt : 0);
      const report = assembleReport(
        c.ticket,
        { ...c.s, readyAt: at, workedMs: worked, outputs: { ...c.s.outputs, report: out } },
        c.p.company,
      );
      try {
        await c.p.workspace.ready(c.ticket, c.s.pr, reportMarkdown(report));
      } catch (err) {
        if (isPassing(err)) throw err;
        await c.emit(failed(c, "report", `couldn't mark the PR ready: ${errorText(err)}`));
        return;
      }
    }
    await c.emit(finished(c, "report", out), { type: "report-ready", at, summary: capPayload(out) });
  },

  // The daily tidy-up (docs/design/brain.md, "Tending"): the librarian edits the brain copy. What it changes is
  // collected, checked and committed by the daemon after the ticket; nothing here proposes an edit.
  async tidy(c) {
    if (c.s.lastAnswer?.answer === "reject") {
      await c.emit(failed(c, "tidy", "the owner declined to keep going"));
      return;
    }
    const last = c.s.doneWhen.last;
    const out = await session(
      c,
      "librarian",
      c.builder,
      last && !last.met ? `${tidyTask}\n\n${tidyFeedback(last.missing)}` : tidyTask,
    );
    if (out === null) return;
    // What the librarian changed in its copy is collected now, then the report is made again: the ticket is
    // done when nothing it listed is left (the pages unused for 60 days may stay if they are worth keeping).
    const left = c.p.brainState ? await c.p.brainState.tidyLeft(c.builder.id, c.ticket.id) : "skip";
    await closeIfDone(c, "tidy", left ?? "unreadable", [checkpoint(c, "tidy", out)], "the tidy-up");
  },

  // The retro (spec §6, stage 11): builder and reviewer each propose 0-2 knowledge edits.
  async retro(c) {
    const reviewerId = c.s.sessions.find(
      (x) => x.stage === "review" && x.employeeId !== c.builder.id,
    )?.employeeId;
    // Fast mode: only the builder looks back, and only when the ticket had something worth learning from.
    const people = c.plan.fast
      ? notable(c)
        ? [c.builder]
        : []
      : [c.builder, ...(reviewerId ? [c.p.company.employee(reviewerId)] : [])];
    const next = people.find((e) => !c.s.retroBy.includes(e.id));
    if (next) {
      const out = await session(
        c,
        next.id === c.builder.id ? "build" : "review",
        next,
        c.p.brainWrites?.(next.id)
          ? retroInCopy
          : `Look back at this ticket. Propose at most 2 durable, non-obvious, reusable lessons. Reply as JSON: {"edits":[{"layer":"brain"|"fact"|"policy","page","text"}]}. "brain" is your own working style and duty lessons; "fact" is useful to every employee; "policy" changes how the company works. ${pageRules}`,
      );
      if (out === null) return;
      // With a brain copy the lessons are edits to its files, collected after the ticket. A reply that still
      // carries lessons as JSON (the copy wasn't available this time, and the brief said to) is taken as before.
      const read = readEdits(replyField(out, "edits"), { limit: 2 });
      const edits = read.kept.map((e) => routed(c.ticket, e));
      await c.emit(...flagged(c, "retro", "edits", read.dropped), {
        type: "knowledge-proposed",
        at: c.p.clock.now(),
        employeeId: next.id,
        apply: edits.filter((e) => e.layer !== "policy"),
        awaitOwner: edits.filter((e) => e.layer === "policy"),
      });
      return;
    }
    let outcome: "merged" | "rejected" | "done" =
      c.s.decision === "approve" ? "merged" : c.s.decision === "reject" ? "rejected" : "done";
    // In owner-merges, Approve means the owner merged the PR on GitHub; "merged" is recorded only when GitHub agrees (auto-release
    // and cleanup trust it). A failed look throws, and the run is tried again, so nothing is recorded unchecked.
    // Reject closes the PR, so it doesn't stay open on GitHub after the work was declined.
    const ws = c.p.workspace;
    const pr = c.s.pr;
    // In direct mode "merged" means the work is on main, which only the gates' push makes true: a ticket that
    // never pushed closes as done, so the board doesn't claim work landed that didn't.
    if (outcome === "merged" && c.policy.mode === "direct" && !c.s.pushed) outcome = "done";
    if (ws && pr && pr.number !== undefined && c.policy.mode === "owner-merges") {
      if (outcome === "merged" && ws.prState && (await ws.prState(c.ticket, pr)) !== "merged")
        outcome = "done";
      // "Close without merging" after the owner already merged the PR (within the daemon's watch window) is
      // still a merge: it is recorded as one, and nothing is closed.
      if (outcome === "rejected" && ws.prState && (await ws.prState(c.ticket, pr)) === "merged")
        outcome = "merged";
      if (outcome === "rejected" && ws.closePr) await ws.closePr(c.ticket, pr);
    }
    await c.emit(finished(c, "retro"), { type: "closed", at: c.p.clock.now(), outcome });
  },
};

/** Fast mode's build: plan in the same session, and close with the summary the report is made from. */
const fastBuildTask =
  'Start with a short plan in a few lines (the approach, the files, how you will test it), then implement it in small commits on the local branch, and run the project\'s checks yourself before you finish. For a fix, write a failing test that reproduces the bug first. End your reply with a JSON block: {"summary": "what changed, why this way, the risk, and any call the owner might overrule", "followUps":[{"title","doneWhen":["..."],"type":"fix"|"feat"|"chore","effort":"low"|"medium"|"high","reason"}]}, with at most 3 follow-ups you noticed but did not do, only ones worth doing.';

const normItem = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

/** The ticket's done-when items the last check left not met or not confirmed (all of them before any check). */
function openItems(c: Step, items: string[]): string[] {
  const checked = c.s.doneCheck?.items;
  if (!checked) return items;
  return items.filter((d) => checked.find((i) => normItem(i.doneWhen) === normItem(d))?.verdict !== "met");
}

/**
 * Fast mode's check session (decided 2026-11-14): one fresh session reviews the diff and checks each done-when
 * item together, in the builder's own seat and engine (another vendor's only when the project opts in), at low
 * effort and without the brain. Round 2 looks only at what changed since round 1, and at the items still open. It
 * may not change files: one that did has them put back, and its answer goes to the owner. A done-when item still
 * not met or not confirmed after the last round goes to the owner too, never to done (T72).
 */
async function fastCheck(c: Step): Promise<void> {
  const r = c.s.review;
  // Fast mode's cards are stuck cards: any answer but a decline starts the check again from a fresh first round.
  if (c.s.lastAnswer?.answer === "reject") {
    await c.emit(failed(c, "review", "the owner declined to keep going"));
    return;
  }

  const items = c.ticket.doneWhen.map((d) => d.trim()).filter(Boolean);
  const needsVerdict = r.round === 0 || (r.addressed && r.round < c.plan.reviewRounds);
  if (needsVerdict) {
    let reviewer = c.builder;
    let engineId: Id | undefined;
    if (c.policy.crossVendorReview === true) {
      const seat = await reviewSeat(c);
      if (seat === "wait") return;
      reviewer = "employee" in seat ? seat.employee : seat;
      engineId = "employee" in seat ? seat.engineId : undefined;
    }
    const open = r.round === 0 ? items : openItems(c, items);
    const head = r.round > 0 ? r.head : null;
    const checks = c.s.lastChecks;
    const checksLine = !checks
      ? "were not run"
      : checks.green
        ? "passed on the builder's last run"
        : `failed on the builder's last run: ${checks.failures.join("; ")}`;
    const findingsShape =
      '"approved": boolean, "findings":[{"severity":"blocking"|"should-fix"|"nit","where","text"}]';
    const doneShape =
      ', "doneWhen":[{"doneWhen":"<the item, word for word>","verdict":"met"|"not met"|"can\'t tell","evidence":"..."}]';
    const shape = `{${findingsShape}${open.length ? doneShape : ""}}`;
    const doneAsk = open.length
      ? ` Then, for each done-when item below, answer met, not met or can't tell, with evidence (a file and line, a test, a command's output); say can't tell rather than guess.\nDone-when:\n${open.map((d) => `- ${d}`).join("\n")}\n`
      : " ";
    const earlier = r.findings.map((f) => `- [${f.severity}] ${f.where}: ${f.text}`).join("\n");
    const task =
      r.round === 0
        ? `Check this change with fresh eyes, as its reviewer. It is the diff of this folder against main: \`git diff origin/main\`, committed or not. Run what you need, but change no files. The checks ${checksLine}. Look for bugs, missing tests and anything that misses the ticket's intent; keep nits few.${doneAsk}Be brief. Reply as JSON: ${shape}.`
        : `Re-check this change: the builder addressed the earlier findings below. ${
            head
              ? `Look only at what changed since the last check, \`git diff ${head}\` (committed or not), and at whether each earlier finding is resolved; don't review the rest again.`
              : "Check the diff of this folder against main again (`git diff origin/main`), and whether each earlier finding is resolved."
          } Change no files. The checks ${checksLine}.${doneAsk}Be brief. Reply as JSON: ${shape}.\nEarlier findings:\n${earlier}`;
    const guard: Guard = { changed: [], restored: true };
    const out = await session(c, "review", reviewer, task, {
      fresh: true,
      helperFor: "review",
      effort: "low",
      guard,
      brain: false,
      ...(engineId ? { engineId } : {}),
    });
    if (out === null) return;
    const at = c.p.clock.now();
    const by = reviewer.id;
    // "Change no files" is only a request (sessions run with full access), so the worktree was compared before and
    // after. A check that changed anything has its changes put back and its answer thrown away: the owner decides.
    if (guard.changed.length) {
      const what = `the check changed files (${guard.changed.slice(0, 5).join(", ")}${guard.changed.length > 5 ? ", ..." : ""}), so its answer is not used${guard.restored ? "; they were put back" : "; they could not be put back, so look at the worktree"}`;
      await c.emit(
        {
          type: "done-when-verdict",
          at,
          by,
          items: items.map((doneWhen) => ({ doneWhen, verdict: "cant-tell" as const, evidence: what })),
          retry: false,
        },
        needsYou(c, "review", { kind: "stuck", reason: `The change is not checked: ${what}` }),
      );
      return;
    }
    const reply = parseJson<unknown>(out);
    const verdict = readVerdict(reply);
    if (!verdict) {
      await c.emit(failed(c, "review", `the check could not be read${quoteOf(out)}`));
      return;
    }
    const fresh = open.length ? readDoneWhenCheck(isRecord(reply) ? reply.doneWhen : undefined, open) : [];
    const before = c.s.doneCheck?.items ?? [];
    const all: DoneWhenItem[] = items.map((d) => {
      const now = fresh.find((i) => normItem(i.doneWhen) === normItem(d));
      if (now) return stillNotMet(c, now, before);
      return (
        before.find((i) => normItem(i.doneWhen) === normItem(d) && i.verdict === "met") ?? {
          doneWhen: d,
          verdict: "cant-tell",
          evidence: "not checked",
          unanswered: true,
        }
      );
    });
    const unmet = all.filter((i) => i.verdict !== "met");
    const blocking = unmet.filter((i) => blocks(c, i));
    const findings = [
      ...verdict.findings,
      ...unmet.map((i) => ({
        severity: i.verdict === "not-met" ? ("blocking" as const) : ("should-fix" as const),
        where: "done-when",
        text: `${i.verdict === "not-met" ? "not met" : "can't confirm it from the change; make it easy to confirm (a test, a clear change)"}: ${i.doneWhen}${i.evidence ? ` (${i.evidence})` : ""}`,
      })),
    ];
    const approved = verdict.approved && blocking.length === 0;
    await c.emit(
      {
        type: "review-verdict",
        at,
        reviewerId: by,
        round: r.round + 1,
        approved,
        findings,
        ...(guard.head ? { head: guard.head } : {}),
      },
      items.length
        ? { type: "done-when-verdict", at, by, items: all, retry: false }
        : { type: "done-when-verdict", at, by: null, items: [], retry: false, note: noDoneWhen },
      ...(approved ? [finished(c, "review")] : []),
    );
    return;
  }

  if (!r.addressed) {
    const out = await session(
      c,
      "build",
      c.builder,
      'Address each finding of the check: fix it, or say why not, and commit your work to the local branch. Reply as JSON: {"disputed": null or "what you disagree with and why"}.',
    );
    if (out === null) return;
    await c.emit({
      type: "addressed",
      at: c.p.clock.now(),
      round: r.round,
      disputed: readDisputed(parseJson(out)),
    });
    return;
  }

  // Out of rounds. A done-when item that is still open goes to the owner (T72); anything else goes on, with an
  // open disagreement noted for the report.
  const checked = c.s.doneCheck?.items ?? [];
  const open: DoneWhenItem[] = openItems(c, items)
    .map(
      (d) =>
        checked.find((x) => normItem(x.doneWhen) === normItem(d)) ?? {
          doneWhen: d,
          verdict: "cant-tell" as const,
          evidence: "not checked",
          unanswered: true as const,
        },
    )
    .filter((i) => blocks(c, i));
  if (open.length) {
    await c.emit(
      needsYou(c, "review", {
        kind: "stuck",
        reason: `${doneWhenLine(open, items.length)} after ${r.round} check rounds`,
      }),
    );
    return;
  }
  await c.emit(
    finished(
      c,
      "review",
      r.disputed
        ? `went ahead after ${r.round} check rounds; the builder disputed: ${r.disputed}`
        : "findings addressed",
    ),
  );
}

/**
 * Fast mode's report: no session. The builder's closing summary from its build session is the judgment, the
 * daemon adds the facts (assembleReport), and the follow-ups it listed there are filed.
 */
async function fastReport(c: Step): Promise<void> {
  const reply = lastJson(c.s.outputs.build ?? "");
  const said = reply && typeof reply.summary === "string" ? reply.summary.trim() : "";
  const report = said || `${c.builder.name} didn't write a summary; the commits say what changed.`;
  const read = readFollowUps(reply ? reply.followUps : undefined);
  const at = c.p.clock.now();
  await c.emit(
    ...flagged(c, "report", "follow-ups", read.dropped),
    finished(c, "report", report),
    { type: "report-ready", at, summary: report },
    ...(read.kept.length
      ? [{ type: "follow-ups" as const, at, employeeId: c.builder.id, tickets: read.kept }]
      : []),
    { type: "owner-decided", at, decision: "approve" },
  );
}

/**
 * Whether a fast ticket had something worth a retro: a failed check run, an engine switch, a rebase conflict or a
 * red CI to fix, pushback from the check, or a handoff. Most tickets have none, and write nothing anyway.
 */
function notable(c: Step): boolean {
  const s = c.s;
  return (
    s.switches.length > 0 ||
    s.handedFrom !== null ||
    s.review.round > 1 ||
    s.review.findings.some((f) => f.severity === "blocking") ||
    s.sessions.some((x) => x.employeeId === c.builder.id && (x.stage === "checks" || x.stage === "gates"))
  );
}

/**
 * The last JSON object in an agent's reply: fenced blocks from the end, then the whole reply, then the outermost
 * braces. A build reply is prose and code first, with its summary block at the end.
 */
function lastJson(text: string): Record<string, unknown> | null {
  const tries = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)]
    .map((m) => (m[1] ?? "").trim())
    .reverse();
  tries.push(text.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
  for (const t of tries) {
    try {
      const v: unknown = JSON.parse(t);
      if (isRecord(v)) return v;
    } catch {}
  }
  return null;
}

type Seat = Employee | { employee: Employee; engineId?: Id };

/**
 * Direct mode's reviewer (decided 2026-10-17): another employee with the review duty if there is one
 * who can start; otherwise a fresh session in the builder's seat, on a different engine from the
 * builder's when the company has one. Either way the reviewer sees only the ticket and the diff.
 */
async function reviewSeat(c: Step): Promise<Seat | "wait"> {
  const other = await helper(c, "review");
  if (other === "none" || other === "exhausted") return ownSeat(c, "review");
  return other;
}

/**
 * The verifier: another employee who can start, else the builder's seat on a different engine (a
 * fresh session, so it still checks as a black box), else wait. "none": no one else has the duty.
 */
async function verifySeat(c: Step): Promise<Seat | "none" | "wait"> {
  const other = await helper(c, "verify");
  if (other !== "exhausted") return other;
  const own = await ownSeat(c, "verify", true);
  if (own) return own;
  await wantHelper(c, "verify");
  return "wait";
}

const noDoneWhen = "No done-when to check";

/**
 * Who checks the done-when (T72), never the builder's own session: another employee with the verify duty, else one
 * with the review duty (either may be waited for through the scheduler), else a fresh session in the builder's seat
 * on a different engine when there is one, else on the builder's own engine with a clean context.
 */
async function doneWhenSeat(
  c: Step,
): Promise<{ employee: Employee; duty: HelperDuty; engineId?: Id } | "wait"> {
  for (const duty of ["verify", "review"] as const) {
    const other = await helper(c, duty);
    if (other === "wait") return "wait";
    if (typeof other !== "string") return { employee: other, duty };
  }
  return { ...ownSeat(c, "verify"), duty: "verify" };
}

/** A reviewer or verifier outside direct mode: "exhausted" (no one left who can start) waits. */
async function helperOrWait(c: Step, duty: HelperDuty): Promise<Employee | "none" | "wait"> {
  const other = await helper(c, duty);
  if (other !== "exhausted") return other;
  await wantHelper(c, duty);
  return "wait";
}

/**
 * The builder's own seat as a fresh reviewer or verifier, on an engine different from the builder's
 * when there is one that is usable (not ruled out for this ticket, not blocked). `needDifferent`
 * returns null when there isn't.
 */
function ownSeat(c: Step, duty: HelperDuty, needDifferent: true): { employee: Employee; engineId: Id } | null;
function ownSeat(c: Step, duty: HelperDuty): { employee: Employee; engineId?: Id };
function ownSeat(
  c: Step,
  duty: HelperDuty,
  needDifferent = false,
): { employee: Employee; engineId?: Id } | null {
  const own = engineFor(c.builder, "build", c.s, true);
  const ownEngine = findEngine(c.p.company, own);
  const ruledOut = (c.s.unavailable[duty] ?? [])
    .filter((u) => u.employeeId === c.builder.id && u.engineId)
    .map((u) => u.engineId);
  const different = (c.p.company.engines?.() ?? []).find(
    (e) =>
      e.id !== own &&
      (!ownEngine || e.harness !== ownEngine.harness || e.accountId !== ownEngine.accountId) &&
      engineAllowed(c.ticket, e) &&
      !c.s.paused &&
      !ruledOut.includes(e.id) &&
      !c.p.company.engineBlock?.(c.builder.id, e.id, duty),
  );
  if (!different && needDifferent) return null;
  return { employee: c.builder, ...(different ? { engineId: different.id } : {}) };
}

/**
 * Direct mode's gates: protected paths wait for the owner's OK; then rebase on main, checks, and a
 * push to main; then CI on that commit. Red CI makes the builder fix it, and if main is still red 2
 * hours after the push, the push is reverted and the ticket fails honestly.
 */
async function directGates(c: Step): Promise<void> {
  const at = c.p.clock.now();
  const red = c.s.mainRed;
  // The limit is wall time since the red, so a stopped daemon or a long pause counts too: the revert waits
  // until a fix of the builder's has been pushed since the red, however long ago it was.
  if (red && red.fixes >= 1 && at - red.since > redMainLimitMs) {
    if (c.p.harness.revert) await c.p.harness.revert(c.ticket, red.sha);
    await c.emit(
      { type: "reverted", at, sha: red.sha },
      failed(
        c,
        "gates",
        `main stayed red for 2 hours after ${red.sha.slice(0, 7)}, so it was reverted: ${red.reason}`,
      ),
    );
    return;
  }
  if (c.s.fixDue) {
    if (!red && c.s.gateConflicts >= maxGateConflicts) {
      await c.emit(failed(c, "gates", "the rebase on main conflicted again after a fix"));
      return;
    }
    const out = await session(
      c,
      "build",
      c.builder,
      red
        ? `CI failed on main after your push (${red.sha.slice(0, 7)}): ${red.reason}. Fix it here; i.inc pushes the fix straight to main. Main is red until then.`
        : "The rebase on main conflicted. Resolve it and keep the checks green.",
    );
    if (out !== null) await c.emit(checkpoint(c, "gates", out));
    return;
  }
  const answer = c.s.lastAnswer?.answer;
  if (answer === "reject") {
    await c.emit(failed(c, "gates", "the owner declined the change to protected paths"));
    return;
  }
  let sha = c.s.pushed && !red ? c.s.pushed : undefined;
  if (!sha) {
    const g = await c.p.harness.runGates(c.ticket, {
      // The OK that just came covers the paths on the card it answered, and only those (gates-ran or a
      // new card clears it, so it never reaches a later run).
      ownerApproved: answer === "approve",
      approvedPaths: c.s.approvedPaths,
      ...(c.s.approval ? { approval: c.s.approval } : {}),
      ...(c.s.pushIntended ? { pushIntended: c.s.pushIntended } : {}),
      onPushIntended: (headSha) => c.emit({ type: "push-intended", at: c.p.clock.now(), headSha }),
    });
    if (!g.ok && g.protectedPaths?.length) {
      await c.emit(
        needsYou(c, "gates", {
          kind: "protected-paths",
          paths: g.protectedPaths,
          ...(g.approval
            ? {
                sha: g.approval.sha,
                patchId: g.approval.patchId,
                ...(g.approval.diff !== undefined ? { diff: g.approval.diff } : {}),
                ...(g.approval.diffTruncated ? { diffTruncated: true } : {}),
              }
            : {}),
        }),
      );
      return;
    }
    const now = c.p.clock.now();
    if (!g.ok) {
      await c.emit({ type: "gates-ran", at: now, ok: false, conflict: g.conflict, reason: g.reason });
      if (!g.conflict) await c.emit(failed(c, "gates", g.reason));
      return;
    }
    const events: TicketEvent[] = [{ type: "gates-ran", at: now, ok: true, conflict: false }];
    if (g.pushed) events.push({ type: "pushed", at: now, sha: g.pushed });
    await c.emit(...events);
    sha = g.pushed;
  }
  if (sha && c.p.harness.watchCi) {
    const ci = await c.p.harness.watchCi(c.ticket, sha);
    const now = c.p.clock.now();
    if (!ci.ok) {
      await c.emit({ type: "main-red", at: now, sha, reason: ci.reason });
      return;
    }
    await c.emit({ type: "ci-green", at: now, sha }, finished(c, "gates"));
    return;
  }
  await c.emit(finished(c, "gates"));
}

/**
 * Direct mode's report: it goes to the board (the work is on main already), with up to 3 follow-up
 * tickets the builder noticed, and the ticket closes without waiting for the owner.
 */
async function directReport(c: Step): Promise<void> {
  if (c.plan.fast) return fastReport(c);
  const out = await session(
    c,
    "build",
    c.builder,
    `i.inc pushed your work to main${c.s.pushed ? ` as ${c.s.pushed.slice(0, 7)}` : ""}, and CI passed there. Write the report: what changed, why this way, risk, and the calls the owner might overrule. Then list up to 3 follow-up tickets you noticed but didn't do, only ones worth doing. Reply as JSON: {"report": "...", "followUps":[{"title","doneWhen":["..."],"type":"fix"|"feat"|"chore","effort":"low"|"medium"|"high","reason"}]}.`,
  );
  if (out === null) return;
  const parsed = parseJson<unknown>(out);
  const said = isRecord(parsed) && typeof parsed.report === "string" ? parsed.report.trim() : "";
  const report = said || out;
  const read = readFollowUps(isRecord(parsed) ? parsed.followUps : undefined);
  const followUps = read.kept;
  const at = c.p.clock.now();
  await c.emit(
    ...flagged(c, "report", "follow-ups", read.dropped),
    finished(c, "report", report),
    { type: "report-ready", at, summary: report },
    ...(followUps.length
      ? [{ type: "follow-ups" as const, at, employeeId: c.builder.id, tickets: followUps }]
      : []),
    // Nothing waits for the owner: the work is on main, and the retro follows.
    { type: "owner-decided", at, decision: "approve" },
  );
}

/**
 * The reviewer or verifier for this ticket: the one already assigned, or "none" when no one else has
 * the duty. Otherwise "wait": the runner picked one itself, or asked the scheduler for one. People who
 * couldn't start for this ticket, or whose sandbox or sign-in isn't ready, are passed over; when that
 * leaves no one, "exhausted".
 */
async function helper(c: Step, duty: HelperDuty): Promise<Employee | "none" | "exhausted" | "wait"> {
  const assigned = c.s.helpers[duty];
  if (assigned && assigned !== c.ticket.assignee) return c.p.company.employee(assigned);
  if (!c.p.company.pickEmployee(duty, c.ticket, [c.ticket.assignee])) return "none";
  const skip = [
    c.ticket.assignee,
    ...(c.s.unavailable[duty] ?? []).filter((u) => !u.engineId).map((u) => u.employeeId),
  ];
  let pick: Employee | undefined;
  for (;;) {
    pick = c.p.company.pickEmployee(duty, c.ticket, skip);
    if (!pick) return "exhausted";
    const engineId = engineFor(pick, duty, c.s, false);
    if (!c.p.company.engineBlock?.(pick.id, engineId, duty)) break;
    skip.push(pick.id);
  }
  const at = c.p.clock.now();
  await c.emit(
    c.opts.helpers === "scheduler"
      ? { type: "helper-wanted", at, stage: c.s.active as StageId, duty }
      : { type: "helper-assigned", at, duty, employeeId: pick.id },
  );
  return "wait";
}

/** Asks the scheduler for a helper even though everyone with the duty is out: it says why it waits. */
async function wantHelper(c: Step, duty: HelperDuty): Promise<void> {
  if (c.opts.helpers !== "scheduler" || c.s.waitingFor) return;
  await c.emit({ type: "helper-wanted", at: c.p.clock.now(), stage: c.s.active as StageId, duty });
}

/** How many sessions an orientation or tidy-up gets to meet its done-when before it goes to the owner. */
const maxMisses = 2;

/** What a done-when check found: what is missing, nothing to check against ("skip"), or a brain it could not read. */
type Unmet = string[] | "skip" | "unreadable";

/**
 * Closes an orientation or tidy-up only when its done-when is met. "skip" means there is no brain to look at (a
 * demo, a test): the ticket closes as it always did. A brain that can't be read goes straight to the owner, since
 * another session would not help. A miss runs the stage once more, with what is wrong in its brief; the second
 * goes to the owner as a Needs you card with the reason, never to done (spec §6).
 */
async function closeIfDone(
  c: Step,
  stage: "orient" | "tidy",
  unmet: Unmet,
  before: TicketEvent[],
  what: string,
): Promise<void> {
  const at = c.p.clock.now();
  if (unmet === "unreadable") {
    const reason = `${c.builder.name}'s brain could not be read to check ${what}, so it is not marked done`;
    await c.emit(
      ...before,
      { type: "done-when-checked", at, stage, met: false, missing: ["the brain could not be read"] },
      needsYou(c, stage, { kind: "stuck", reason }),
    );
    return;
  }
  if (unmet !== "skip" && unmet.length > 0) {
    const misses = c.s.doneWhen.misses + 1;
    // The count first: the card is one short line, and the list is what gets cut.
    const reason = `${c.builder.name} says ${what} is done, but${misses >= maxMisses ? ` after ${misses} sessions` : ""} ${unmet.join("; ")}`;
    await c.emit(
      ...before,
      { type: "done-when-checked", at, stage, met: false, missing: unmet },
      ...(misses >= maxMisses ? [needsYou(c, stage, { kind: "stuck", reason })] : []),
    );
    return;
  }
  await c.emit(
    ...before,
    ...(unmet === "skip"
      ? []
      : [{ type: "done-when-checked", at, stage, met: true, missing: [] } as TicketEvent]),
    finished(c, stage),
    { type: "closed", at, outcome: "done" },
  );
}

/** What a read-only session changed in the worktree, if anything (see `guardWorktree`). */
interface Guard {
  changed: string[];
  /** Whether those changes were put back. */
  restored: boolean;
  /** The commit the worktree was at when the session began, when it could be looked at. */
  head?: string;
}

/**
 * Looks at the worktree again after a read-only session. Anything that differs from before (a file edited, staged,
 * created or deleted, a commit) is put back exactly, and listed in `guard`; `restored` is true only when the restore
 * verified. A hiccup worth another tick is thrown, so the check runs again.
 */
async function guardWorktree(
  c: Step,
  employee: Employee,
  before: WorktreeSnapshot,
  guard: Guard,
): Promise<void> {
  const ws = c.p.workspace;
  if (!ws?.snapshot) return;
  let after: WorktreeSnapshot;
  try {
    after = await ws.snapshot(c.ticket, employee);
  } catch (err) {
    if (isPassing(err)) throw err;
    return;
  }
  const moved = before.head !== after.head;
  if (!moved && before.state === after.state) return;
  let names: string[] = [];
  try {
    if (!ws.restore) throw new Error("no way to restore");
    const r = await ws.restore(c.ticket, employee, before, after);
    names = r.changed;
    guard.restored = r.restored;
  } catch (err) {
    if (isPassing(err)) throw err;
    guard.restored = false;
  }
  guard.changed = [...(moved ? ["a new commit"] : []), ...names];
  if (guard.changed.length === 0) guard.changed = ["the worktree"];
}

/** Runs one session. Returns its output, or null when it paused, switched engine, escalated or failed. */
async function session(
  c: Step,
  duty: Duty,
  employee: Employee,
  task: string,
  o: {
    engineId?: Id;
    fresh?: boolean;
    helperFor?: HelperDuty;
    effort?: Effort;
    guard?: Guard;
    brain?: false;
  } = {},
): Promise<string | null> {
  const stage = c.s.active as StageId;
  const isAssignee = employee.id === c.ticket.assignee;
  const engineId = o.engineId ?? engineFor(employee, duty, c.s, isAssignee);
  // A reviewer or verifier that can't start never fails the builder's ticket: it is skipped, and
  // another seat is picked. The builder's own default engine is the exception (switch rules apply).
  const helperDuty =
    o.helperFor !== undefined && (!isAssignee || o.engineId !== undefined) ? o.helperFor : null;
  const unavailable = async (reason: string): Promise<null> => {
    await c.emit({
      type: "helper-unavailable",
      at: c.p.clock.now(),
      stage,
      duty: helperDuty as HelperDuty,
      employeeId: employee.id,
      ...(isAssignee ? { engineId } : {}),
      reason,
    });
    return null;
  };
  // An engine taken out of Setup while an employee or a ticket still names it never stops the loop.
  const engine = findEngine(c.p.company, engineId);
  if (!engine) {
    const gone = `${employee.name}'s engine "${engineId}" was removed in Setup; choose another and retry`;
    if (helperDuty) return unavailable(gone);
    await c.emit(failed(c, stage, gone));
    return null;
  }
  if (!engineAllowed(c.ticket, engine)) {
    await c.emit(failed(c, stage, `${engine.model} is not a local engine, and errands carry home data`));
    return null;
  }
  try {
    await c.p.machines.ensureUp(employee.id);
  } catch (err) {
    if (helperDuty && err instanceof StartupError) return unavailable(err.message);
    throw err;
  }
  // After a handoff the new builder's machine has no worktree yet: make it before its first session.
  if (isAssignee && c.p.workspace && c.s.pr && c.s.prFor !== employee.id) {
    const pr = await openWorkspace(c, employee, stage);
    if (!pr) return null;
    await c.emit(...pr);
  } else if (isAssignee && c.s.pr && c.s.prFor === employee.id) {
    const worktree = await reopenIfGone(c, employee, stage);
    if (worktree === "failed") return null;
    // (A reopened worktree has every image already.)
    if (worktree === "there" && !(await copyAttachments(c, employee))) return null;
  } else if (helperDuty && !isAssignee && c.p.workspace && c.s.pr) {
    // A reviewer or verifier may be on another team's machine: it gets the branch and the images too.
    const why = await readyHelper(c, employee);
    if (why !== null) return unavailable(why);
  }
  // A session that must not change the worktree (the done-when check) is measured before it runs.
  let before: WorktreeSnapshot | undefined;
  if (o.guard && c.p.workspace?.snapshot && c.s.pr) {
    try {
      before = await c.p.workspace.snapshot(c.ticket, employee);
    } catch (err) {
      if (isPassing(err)) throw err; // anything else: the look is advisory, the session still runs
    }
    if (before) o.guard.head = before.head;
  }
  const text = o.fresh
    ? freshBrief(c.ticket, stage, task, c.p.harness.describe?.(c.ticket))
    : brief(
        c.ticket,
        stage,
        c.s,
        task,
        c.p.harness.describe?.(c.ticket),
        isAssignee && duty !== "review",
        employee,
      );
  // The session is recorded as started when it is. An agent that says when its process is up
  // (`reportsLaunch`) is waited for, so a launch that fails again and again (the walls are down, GitHub
  // gives no token) leaves nothing in the ticket's log; any other agent is recorded up front.
  const resume = c.s.interrupted || c.s.paused !== null;
  let recorded: Promise<void> | undefined;
  const recordStart = (): Promise<void> => {
    recorded ??= c.emit({
      type: "session-started",
      at: c.p.clock.now(),
      stage,
      employeeId: employee.id,
      engineId,
      resume,
    });
    return recorded;
  };
  if (!c.p.agent.reportsLaunch) await recordStart();
  const signal = c.opts.signal?.(employee.id);
  let out: SessionOutcome;
  try {
    out = await c.p.agent.run({
      ticket: c.ticket,
      stage,
      duty,
      employee,
      engine,
      brief: text,
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.brain === false ? { brain: false as const } : {}),
      ...(signal ? { signal } : {}),
      ...(c.p.agent.reportsLaunch ? { onLaunched: recordStart } : {}),
    });
    // An agent that never said it had launched still ran: the session is recorded before its outcome.
    await recordStart();
  } catch (err) {
    // A helper whose session couldn't even launch is skipped, like one whose sandbox won't boot.
    if (helperDuty && err instanceof StartupError) return unavailable(err.message);
    throw err;
  }

  if (out.kind === "done") {
    if (o.guard && before) await guardWorktree(c, employee, before, o.guard);
    return out.output;
  }
  if (out.kind === "interrupted") {
    await c.emit({ type: "session-interrupted", at: c.p.clock.now(), stage, reason: out.reason });
    return null;
  }
  if (out.kind === "out-of-tokens") {
    await c.emit({ type: "out-of-tokens", at: c.p.clock.now(), stage, engineId, resetsAt: out.resetsAt });
    return null;
  }
  if (helperDuty && out.startup) return unavailable(out.reason);
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
  const model = findEngine(c.p.company, paused.engineId)?.model ?? paused.engineId;
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

const MAX_PAYLOAD_CHARS = 16 * 1024;
export const capPayload = (text: string, max = MAX_PAYLOAD_CHARS): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;

/** One field of an agent's JSON reply, or undefined when the reply isn't a JSON object. */
function replyField(out: string, name: string): unknown {
  const v = parseJson<unknown>(out);
  return isRecord(v) ? v[name] : undefined;
}

/** A note on the ticket that part of an agent's reply was left out because it wasn't usable. */
function flagged(c: Step, stage: StageId, what: string, dropped: number): TicketEvent[] {
  return dropped > 0
    ? [
        {
          type: "reply-flagged",
          at: c.p.clock.now(),
          stage,
          what,
          detail: `${dropped} of the ${what} in the reply could not be used and were left out`,
        },
      ]
    : [];
}

function finished(c: Step, stage: StageId, output?: string): TicketEvent {
  return output === undefined
    ? { type: "stage-finished", at: c.p.clock.now(), stage }
    : { type: "stage-finished", at: c.p.clock.now(), stage, output: capPayload(output) };
}

function checkpoint(c: Step, stage: StageId, note: string): TicketEvent {
  return { type: "checkpoint", at: c.p.clock.now(), stage, note: capPayload(note) };
}

/** A Needs you card. A stuck card's reason is one short line (`stuckAsk`): the whole of it stays on the ticket. */
function needsYou(c: Step, stage: StageId, ask: NeedsYou): TicketEvent {
  return {
    type: "needs-you",
    at: c.p.clock.now(),
    stage,
    ask: ask.kind === "stuck" ? stuckAsk(ask.reason) : ask,
  };
}

/** Lenient approvals (approvals.ts): the builder's level, or the company's. Careful where the port is absent. */
function lenient(c: Step): boolean {
  return c.p.company.approvals?.(c.builder.id) === "lenient";
}

/**
 * A done-when check's result that should stop the work: not met; and can't tell, unless approvals are lenient and
 * it is the checker's own judgment, with evidence (an unanswered item or an unreadable reply always stops it).
 */
function blocks(c: Step, item: DoneWhenItem): boolean {
  if (item.verdict === "met") return false;
  if (item.verdict === "not-met") return true;
  return !lenient(c) || item.unanswered === true || !item.evidence.trim();
}

/**
 * Lenient: once an item was not met on this ticket, only "met" clears it, so a recheck that can't tell keeps it not
 * met (careful asks on both anyway, so it records the checker's answer as it was).
 */
function stillNotMet(c: Step, item: DoneWhenItem, earlier: DoneWhenItem[]): DoneWhenItem {
  if (item.verdict !== "cant-tell" || !lenient(c)) return item;
  const was = earlier.find((i) => normItem(i.doneWhen) === normItem(item.doneWhen));
  return was?.verdict === "not-met"
    ? {
        ...item,
        verdict: "not-met",
        evidence: `not met before, and can't be confirmed now: ${item.evidence}`,
      }
    : item;
}

/** "2 of 5 done-when items are not met" (or "can't be confirmed"), for a one-line card. */
function doneWhenLine(open: DoneWhenItem[], total: number): string {
  const n = open.length;
  const notMet = open.filter((i) => i.verdict === "not-met").length;
  const items = total === 1 ? "item" : "items";
  if (notMet === 0) return `${n} of ${total} done-when ${items} can't be confirmed`;
  const line = `${notMet} of ${total} done-when ${items} ${notMet === 1 ? "is" : "are"} not met`;
  return notMet === n ? line : `${line}, ${n - notMet} can't be confirmed`;
}

/** An honest failure: what went wrong and which engines were tried. */
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** GitHub or the network hiccuped: worth another try at the next tick, not a failed ticket. */
export const passingRegex =
  /failed(?::| with HTTP)\s*5\d\d|failed(?::| with HTTP)\s*429|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed out|Could not resolve host|unable to access|the remote end hung up unexpectedly|Connection reset by peer|early EOF|RPC failed|OpenSSL SSL_read|Connection refused/i;

export function isPassing(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object") {
    const e = err as {
      status?: unknown;
      rateLimited?: unknown;
      network?: unknown;
    };
    if (typeof e.status === "number" && (e.status >= 500 || e.status === 429)) {
      return true;
    }
    if (e.rateLimited || e.network) {
      return true;
    }
  }
  return passingRegex.test(errorText(err));
}

/**
 * Makes the ticket's worktree and branch in `employee`'s machine, with its draft PR. A passing
 * hiccup is thrown, so the daemon tries again at its next tick; anything else fails the ticket.
 */
async function openWorkspace(c: Step, employee: Employee, stage: StageId): Promise<TicketEvent[] | null> {
  const workspace = c.p.workspace;
  if (!workspace) return null;
  try {
    const pr = await workspace.open(c.ticket, employee);
    const at = c.p.clock.now();
    // Opening copies every image the ticket has so far.
    const upTo = Math.max(0, ...(c.ticket.attachments ?? []).map((a) => a.n));
    return [
      { type: "pr-opened", at, pr, employeeId: employee.id },
      ...(upTo ? [{ type: "attachments-copied", at, employeeId: employee.id, upTo } as const] : []),
    ];
  } catch (err) {
    if (isPassing(err)) throw err;
    await c.emit(failed(c, stage, `couldn't open the branch and draft PR: ${errorText(err)}`));
    return null;
  }
}

/** A builder who has been away this long may have lost their worktree to cleanup. */
const awayMs = 60 * 60_000;

/**
 * Before a builder's session after a gap, looks for the ticket's worktree and makes it again if it is
 * gone (storage cleanup removes the worktrees of old tickets, and a retried ticket would otherwise
 * build in an empty folder that is not a git repo). `open` is safe to repeat. "failed": it couldn't,
 * and the ticket with it; a passing hiccup is thrown.
 */
async function reopenIfGone(
  c: Step,
  employee: Employee,
  stage: StageId,
): Promise<"there" | "reopened" | "failed"> {
  const workspace = c.p.workspace;
  const last = c.s.lastSessionAt[employee.id];
  if (!workspace?.present || last === undefined || c.p.clock.now() - last < awayMs) return "there";
  let there = true;
  try {
    there = await workspace.present(c.ticket, employee);
  } catch (err) {
    // The look is advisory: only a hiccup worth another tick stops the session.
    if (isPassing(err)) throw err;
  }
  if (there) return "there";
  const pr = await openWorkspace(c, employee, stage);
  if (!pr) return "failed";
  await c.emit(...pr);
  return "reopened";
}

/**
 * Copies images the owner added since the worktree was made into it, before the builder's next
 * session. Returns false when the copy failed and the ticket with it; a passing hiccup is thrown.
 */
async function copyAttachments(c: Step, employee: Employee): Promise<boolean> {
  const workspace = c.p.workspace;
  const upTo = c.s.copiedUpTo[employee.id] ?? 0;
  const ns = (c.ticket.attachments ?? []).map((a) => a.n).filter((n) => n > upTo);
  if (!workspace?.attach || !ns.length) return true;
  try {
    await workspace.attach(c.ticket, employee, ns);
  } catch (err) {
    if (isPassing(err)) throw err;
    await c.emit(failed(c, c.s.active as StageId, `couldn't copy the owner's images: ${errorText(err)}`));
    return false;
  }
  await c.emit({
    type: "attachments-copied",
    at: c.p.clock.now(),
    employeeId: employee.id,
    upTo: Math.max(...ns),
  });
  return true;
}

/**
 * Checks the branch out in a reviewer's or verifier's machine and copies in the images it doesn't
 * have yet. Returns why it couldn't, or null; a passing hiccup is thrown.
 */
async function readyHelper(c: Step, employee: Employee): Promise<string | null> {
  const workspace = c.p.workspace;
  const upTo = c.s.copiedUpTo[employee.id] ?? 0;
  const ns = (c.ticket.attachments ?? []).map((a) => a.n).filter((n) => n > upTo);
  try {
    await workspace?.checkout?.(c.ticket, employee);
    if (workspace?.attach && ns.length) await workspace.attach(c.ticket, employee, ns);
  } catch (err) {
    if (isPassing(err)) throw err;
    return `couldn't ready ${employee.name}'s machine: ${errorText(err)}`;
  }
  if (workspace?.attach && ns.length) {
    await c.emit({
      type: "attachments-copied",
      at: c.p.clock.now(),
      employeeId: employee.id,
      upTo: Math.max(...ns),
    });
  }
  return null;
}

/** The ticket with the images the owner added after filing it, in order. */
function withAttachments(ticket: Ticket, s: TicketState): Ticket {
  const known = ticket.attachments ?? [];
  const added = s.attachments.filter((a) => !known.some((k) => k.n === a.n)).map(({ at: _, ...a }) => a);
  if (!added.length) return ticket;
  return { ...ticket, attachments: [...known, ...added].sort((a, b) => a.n - b.n) };
}

function failed(c: Step, stage: StageId, reason: string): TicketEvent {
  const tried = [
    ...new Set(
      c.s.sessions
        .filter((x) => x.stage === stage)
        .map((x) => findEngine(c.p.company, x.engineId)?.model ?? x.engineId),
    ),
  ];
  return { type: "failed", at: c.p.clock.now(), stage, reason, tried };
}

/**
 * The retro when the agent has a brain copy: the lessons are edits to its files (docs/design/brain.md,
 * "Writing"), not a reply. Most tickets write nothing.
 */
const retroInCopy =
  "Look back at this ticket. If you learned something durable (still true in a month), non-obvious (not in the code, --help or a README) and reusable (it will change a future task), write it in your brain copy: update the one page for that topic, rewriting it rather than appending, or create the page if there is none (search first). Company facts and policies go in the company/ folder, your own working style and duty lessons in personal/. Most tickets write nothing; if so, change nothing. Reply with one line saying what you changed, or `nothing`.";

/** The tidy-up's task: the report of what to look at comes with the brain section of the brief. */
const tidyTask =
  "Tend the brain. Work through the tidy-up report at the end of this brief, in your brain copy: merge duplicate pages into one (the better-named page keeps its name, the other is deleted), resolve contradictions and every `## Conflict` section by keeping what is true, fix broken [[links]], delete the pages the report lists as unused for 60 days and linked from nowhere (unless they are still true and worth keeping), and keep each scope's map short by merging or pruning. Rewrite pages, do not append. Never touch another person's brain. Reply with a short summary of what you changed.";

/** How pages are named, so the daemon can file an edit (see pagePath in knowledge.ts). */
const pageRules =
  'Name brain pages "<folder>/<name>" with folder tools, patterns, projects, reference or duties (or "personality"), and handbook pages by a plain name; names are lowercase words joined by dashes.';

/** Home data never reaches the shared handbook: an errand's lessons stay in the PA's own brain (spec §5). */
function routed(ticket: Ticket, edit: KnowledgeEdit): KnowledgeEdit {
  return ticket.type === "errand" ? { ...edit, layer: "brain" } : edit;
}

/**
 * An agent's JSON reply. Real agents (first seen on Duet, 2026-10-17) wrap it in a code fence or a
 * sentence, so this tries the whole reply, then each fenced block, then the outermost braces.
 */
export function parseJson<T>(text: string): T | null {
  const tries = [text.trim()];
  for (const m of text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)) tries.push((m[1] ?? "").trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
  for (const t of tries) {
    try {
      return JSON.parse(t) as T;
    } catch {}
  }
  return null;
}

/** The start of an unreadable reply, for the failure's reason. */
const quoteOf = (text: string) => ` (it began: "${text.trim().slice(0, 160).replace(/\s+/g, " ")}")`;
