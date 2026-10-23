// The daemon's heartbeat-free loop (spec §4, principle 4): code schedules, agents work. Each tick
// asks the scheduler what to start, runs those tickets, and re-runs paused ones whose wait may be
// over. Tickets run concurrently; each is resumable from its event log, so a restart loses nothing.

import {
  type Agent,
  assignHelper,
  type BacklogItem,
  type BrainState,
  brainBudgetFor,
  type ChatSession,
  type Clock,
  type Company,
  type Duty,
  decide,
  type Employee,
  findEngine,
  fold,
  type Harness,
  type HelperModel,
  type Id,
  isHomeEmployee,
  knowledgeLog,
  type MachineProvider,
  monotonicNow,
  occupancy,
  type PendingDuty,
  type Ports,
  type ProjectRelease,
  type RunResult,
  readFollowUps,
  runTicket,
  type SessionOutcome,
  type SessionRequest,
  ShuttingDown,
  type Snapshot,
  type StageId,
  StartupError,
  schedule,
  type Ticket,
  type TicketEvent,
  type TicketState,
  type Waiting,
  type Workspace,
} from "@i-inc/core";
import type { ConversationService } from "./ahp/conversations.ts";
import { externalTool } from "./ahp/session-host.ts";
import type { StageFeed, TicketChannels } from "./ahp/ticket-channels.ts";
import type { BrainFeed } from "./brain-feed.ts";
import type { BrainHarvest } from "./brain-harvest.ts";
import type { BrainIndex } from "./brain-index.ts";
import type { ChatLog } from "./chat.ts";
import type { Db } from "./db.ts";
import type { TokenSource } from "./github.ts";
import type { KnowledgeStore } from "./knowledge.ts";
import type { LiveEvents } from "./live.ts";
import type { Proposals } from "./proposals.ts";
import type { NotificationPayload, PushService } from "./push.ts";
import type { Registry } from "./registry.ts";
import { capText, type SessionStore, safeReason } from "./sessions.ts";
import type { Shipping } from "./ship.ts";
import type { Storage } from "./storage.ts";
import type { SqliteEventStore } from "./store.ts";
import type { TicketRecord, Tickets } from "./tickets.ts";

export interface DaemonDeps {
  clock: Clock;
  store: SqliteEventStore;
  sessions: SessionStore;
  registry: Registry;
  tickets: Tickets;
  proposals: Proposals;
  machines: MachineProvider;
  agent: Agent;
  harness: Harness;
  workspace?: Workspace;
  tokens?: TokenSource;
  /** How often one open PR waiting to be merged is looked at (ms); default `Daemon.prCheckMs`. For tests and the end-to-end run. */
  prCheckMs?: number;
  /** Where GitHub's API is, when it isn't api.github.com: a test's or the end-to-end run's stand-in. */
  githubApi?: string;
  /** The fetch the projects flow uses for GitHub, when it isn't the global one (tests). */
  githubFetch?: typeof fetch;
  helper: HelperModel;
  chat: ChatSession;
  chatLog: ChatLog;
  knowledge: KnowledgeStore;
  /** The disposable search index over the brains and the handbook. */
  brain: BrainIndex;
  /** The brain's copy in sandboxes and its retrieval into briefs and turns (T57). */
  brainFeed: BrainFeed;
  /** Collects what agents wrote in their brain copies, checks it and commits it (T58). */
  brainHarvest: BrainHarvest;
  db: Db;
  push?: PushService;
  live?: LiveEvents;
  /** Retention and cleanup (T52). Set by createApp. */
  storage?: Storage;
  log?: (msg: string) => void;
  /** Conversations over AHP (src/ahp); absent in the few places that build deps by hand. */
  conversations?: ConversationService;
  /** Shipping a conversation's work as a ticket or a PR (T62b); absent without GitHub. */
  shipping?: Shipping;
  /** Every stage session as a read-only AHP chat, for "Open the session" (T69); absent in the few places that build deps by hand. */
  ticketChannels?: TicketChannels;
}

/** What the daemon asks of storage when it decides to stop a machine (storage.ts, T52). */
export interface StorageHooks {
  machineOf(employeeId: Id): string | undefined;
  /** A cleanup is running in this machine, so it stays up until that ends. */
  holding(machine: string): boolean;
  due(machine: string): boolean;
  /** Resolves true when no cleanup holds the machine, false after `maxMs`. */
  untilFree(machine: string, maxMs: number): Promise<boolean>;
  startClean(machine: string, done: () => void): void;
  /** Why new work shouldn't start (the host's disk is nearly full), or null. */
  lowDisk(): string | null;
}

/** On a ticket the owner accepted from a proposal, so the daily follow-up budget doesn't count it. */
export const ACCEPTED_LABEL = "accepted-proposal";

/** A ticket that carries someone else's words: it names a GitHub issue or pull request, or is labelled as one. */
export function ticketFromOutside(t: Ticket): boolean {
  const text = [t.title, t.reason ?? "", ...t.doneWhen].join("\n");
  return (
    (t.labels ?? []).some((l) => /^(?:github-)?issue$|^from-issue$|^external$/i.test(l)) ||
    /github\.com\/[^\s/]+\/[^\s/]+\/(?:issues|pull)\/\d+/i.test(text)
  );
}

/** On the daily "Tend the brain" tickets (docs/design/brain.md, "Tending"). */
export const TIDY_LABEL = "brain-tidy";

/** The project the tidy-up ticket is filed under, like a new hire's orientation. */
const TIDY_PROJECT = "General";

export class Daemon {
  private readonly running = new Map<Id, Promise<void>>();
  /** Turns in flight that are not tickets (an owner chat turn today, conversations later). */
  private turns = 0;
  private readonly busyHooks: Array<() => boolean> = [];
  /** The session each ticket is in now, so an urgent message can stop it. */
  private readonly sessions = new Map<Id, { employeeId: Id; controller: AbortController }>();
  /** Why each ticket that didn't start is waiting, from the last tick. */
  waiting: Waiting[] = [];
  /** For a waiting ticket blocked by an account or usage cap: when it resets (epoch ms). */
  waitingUntil: Record<Id, number> = {};
  /**
   * Tickets whose run threw, with how many times in a row and when they may run again. A ticket that
   * keeps failing backs off (30 s, doubling, up to 10 min) and is failed with the reason after
   * `maxErrors` in a row; a `StartupError` only waits, as its `retryAt` says. `retryAt` (wall time) is
   * what the board shows; whether the wait is over is read on the monotonic clock (`retryMono`, `sinceMono`),
   * so a clock stepped back or forward neither stretches nor skips it.
   */
  private readonly failures = new Map<
    Id,
    { count: number; since: number; sinceMono: number; retryAt: number; retryMono: number; reason: string }
  >();
  /** Tickets whose owner acted while a run was still finishing: they run again as soon as it ends. */
  private readonly rerun = new Set<Id>();
  /** Tickets whose events or fold broke in a pass, with why: skipped, logged once, shown on the board. */
  private readonly broken = new Map<Id, string>();
  /** Things already logged, so a standing problem is logged once and not at every tick. */
  private readonly logged = new Set<string>();

  private readonly stateCache = new Map<Id, TicketState>();
  private readonly dirtyTickets = new Set<Id>();

  constructor(private readonly d: DaemonDeps) {
    this.d.store.subscribe?.((ticketId) => {
      this.dirtyTickets.add(ticketId);
      this.stateCache.delete(ticketId);
    });
    this.d.tickets.subscribe?.((ticketId) => {
      this.dirtyTickets.add(ticketId);
      this.stateCache.delete(ticketId);
    });
  }

  invalidate(ticketId: Id): void {
    this.dirtyTickets.add(ticketId);
    this.stateCache.delete(ticketId);
  }

  /** Logs a message once per key (a standing problem would otherwise fill the log every 30 seconds). */
  private logOnce(key: string, msg: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.d.log?.(msg);
  }

  /** Folds a ticket's events; an event that can't be applied is skipped and logged once. */
  private foldTicket(id: Id, events: TicketEvent[]): TicketState {
    return fold(events, (_event, why) =>
      this.logOnce(`fold:${id}:${why}`, `ticket ${id}: skipped an event: ${why}`),
    );
  }

  /** Tickets the daemon can't read or fold at the moment, with why. The board lists them. */
  unreadable(): { id: Id; reason: string }[] {
    return [...this.d.tickets.unreadable(), ...[...this.broken].map(([id, reason]) => ({ id, reason }))];
  }

  /** Employees waiting for their sandbox's cleanup to finish, with why: shown on their tickets. */
  private readonly holds = new Map<Id, string>();

  /** Employees whose machines are up, as far as this daemon knows. */
  private readonly awake = new Set<Id>();

  /** `ensureUp` calls in flight, by employee: their machine must not be stopped under them. */
  private readonly starting = new Map<Id, number>();

  /**
   * At startup: employees whose machines an earlier daemon left running are recorded as awake (and in
   * the machine provider), so the idle sweep stops them once nothing uses them. Without this a machine
   * stays up until work happens to use it, because a new daemon knows nothing about what it didn't start.
   */
  async adoptRunning(): Promise<Id[]> {
    const adopt = this.d.machines.adopt;
    if (!adopt) return [];
    const ids = this.d.registry.employees().map((e) => e.id);
    const adopted = await adopt.call(this.d.machines, ids);
    for (const id of adopted) this.awake.add(id);
    return adopted;
  }

  /** Set by createApp once storage exists: cleaning runs while a machine is up and idle. */
  storage?: StorageHooks;

  /** How many entries each long-lived structure holds, to show growth (GET /api/storage) and test it. */
  footprint() {
    return {
      daemonRunning: this.running.size,
      daemonSessions: this.sessions.size,
      daemonAwake: this.awake.size,
      daemonHolds: this.holds.size,
      daemonTurns: this.turns,
      daemonWaiting: this.waiting.length,
      daemonWaitingUntil: Object.keys(this.waitingUntil).length,
      sessionsActive: this.d.sessions.footprint().active,
      liveListeners:
        (this.d.live?.listenerCount("ticket") ?? 0) + (this.d.live?.listenerCount("office") ?? 0),
    };
  }

  /** Whether this ticket is being driven now. */
  isRunning(id: Id): boolean {
    return this.running.has(id);
  }

  /**
   * Whether the daemon is doing work that a restart or a VACUUM would cut short: a ticket stage or
   * session, a chat turn, a long write tracked in api.ts (a project bootstrap), or anything a registered
   * hook says (conversations will register theirs). The deployer waits for false before it switches
   * releases (GET /api/health, contract C21).
   */
  busy(): boolean {
    return this.running.size > 0 || this.turns > 0 || this.busyHooks.some((h) => h());
  }

  /** Registers a source of busyness, such as "a conversation turn is running". */
  onBusy(hook: () => boolean): void {
    this.busyHooks.push(hook);
  }

  /** Machines that something other than a ticket is using (live conversation agents), by name. */
  private readonly machineHooks: Array<(machine: string) => boolean> = [];
  onMachineBusy(hook: (machine: string) => boolean): void {
    this.machineHooks.push(hook);
  }
  /** An employee's machine was started by something else (a conversation): it is stopped and cleaned like the rest. */
  noteAwake(id: Id): void {
    this.awake.add(id);
    this.d.brainFeed?.noteMachineUp(id);
  }

  /** Counts a turn as running until it settles. */
  async track<T>(turn: Promise<T>): Promise<T> {
    this.turns++;
    try {
      return await turn;
    } finally {
      this.turns--;
    }
  }

  /**
   * Whether something is using a machine now: a session in it, or a running ticket whose builder
   * works there. Cleanup never runs in such a machine.
   */
  async machineBusy(machine: string): Promise<boolean> {
    const at = (id: Id) => this.storage?.machineOf(id) === machine;
    if (this.machineHooks.some((h) => h(machine))) return true;
    if ([...this.sessions.values()].some((s) => at(s.employeeId))) return true;
    for (const id of this.running.keys()) {
      const record = this.d.tickets.get(id);
      const state = await this.state(id);
      if (record && at(state.assignee ?? record.ticket.assignee)) return true;
      if (Object.values(state.helpers).some((h) => h && at(h))) return true;
    }
    return false;
  }

  get company(): Company {
    const reg = this.d.registry;
    const isContact = reg.isContact;
    const projectPolicy = reg.projectPolicy;
    return {
      employee: (id) => reg.employee(id),
      engine: (id) => reg.engine(id),
      pickEmployee: (duty, ticket, exclude) => reg.pickEmployee(duty, ticket, exclude),
      ...(isContact ? { isContact: (address) => isContact.call(reg, address) } : {}),
      ...(projectPolicy ? { projectPolicy: (project) => projectPolicy.call(reg, project) } : {}),
      engines: () => reg.engines(),
      engineBlock: (employeeId: Id, engineId: Id, duty: Duty) => {
        // `sandboxFault` is the fault only while its backoff runs (measured on the machines' monotonic clock).
        const fault = this.d.machines.sandboxFault?.(employeeId);
        if (fault) {
          return { reason: fault.waiting, until: fault.retryAt };
        }
        const eng = findEngine(reg, engineId);
        if (!eng) return { reason: `the engine "${engineId}" was removed in Setup` };
        if (duty === "review" || duty === "verify") {
          const signedIn = this.d.machines.signedIn?.(employeeId, eng.harness);
          if (signedIn === false) {
            return { reason: `${eng.harness} is not signed in for this team` };
          }
        }
        return null;
      },
    };
  }

  private get ports(): Ports {
    const { clock, store, harness, sessions } = this.d;
    const m = this.d.machines;
    const stop = m.stop;
    const deliverCallback = m.deliverCallback;
    const inspectSandbox = m.inspectSandbox;
    const sandboxFault = m.sandboxFault;
    const signedIn = m.signedIn;
    const retrySandbox = m.retrySandbox;
    const startMachine = async (id: Id) => {
      // A sandbox being cleaned takes no new work until it is done (storage.ts); this waits a few
      // minutes, shows why on the employee's tickets, and only then gives up with a reason.
      const storage = this.storage;
      const machine = storage?.machineOf(id);
      if (storage && machine && storage.holding(machine)) {
        this.holds.set(id, "its sandbox is being cleaned up and starts again in a moment");
        try {
          if (!(await storage.untilFree(machine, 5 * 60_000))) {
            throw new StartupError(
              "its sandbox is still being cleaned up, trying again shortly",
              clock.now() + 60_000,
            );
          }
        } finally {
          this.holds.delete(id);
        }
      }
      await m.ensureUp(id);
      this.awake.add(id);
      // A stage that starts right now must not find a stale "the machine is down" in the brain feed.
      this.d.brainFeed?.noteMachineUp(id);
    };
    const machines: MachineProvider = {
      ensureUp: async (id: Id) => {
        // Counted from the first moment, so the idle sweep never stops the machine under a start.
        this.starting.set(id, (this.starting.get(id) ?? 0) + 1);
        try {
          await startMachine(id);
        } finally {
          const left = (this.starting.get(id) ?? 1) - 1;
          if (left > 0) this.starting.set(id, left);
          else this.starting.delete(id);
        }
      },
      ...(stop ? { stop: (id) => stop.call(m, id) } : {}),
      ...(deliverCallback ? { deliverCallback: (team, url) => deliverCallback.call(m, team, url) } : {}),
      ...(inspectSandbox ? { inspectSandbox: (team, size) => inspectSandbox.call(m, team, size) } : {}),
      ...(sandboxFault ? { sandboxFault: (id) => sandboxFault.call(m, id) } : {}),
      ...(signedIn ? { signedIn: (id, harness) => signedIn.call(m, id, harness) } : {}),
      ...(retrySandbox ? { retrySandbox: (team, size) => retrySandbox.call(m, team, size) } : {}),
    };
    const agent: Agent = {
      reportsLaunch: this.d.agent.reportsLaunch === true,
      run: async (req: SessionRequest): Promise<SessionOutcome> => {
        let sessionId: number | null = null;
        try {
          sessionId = sessions.start(req.ticket.id, req.stage, req.employee.id, req.engine.id);
        } catch (err) {
          console.error("[sessions] start failed:", err);
        }
        // The brain (T57): the maps and the pages that match this ticket go at the end of the brief,
        // after the employee's copy in the sandbox is brought up to date. A failure here never stops
        // the session: it just goes without.
        const feed = this.d.brainFeed;
        if (feed?.enabled) {
          try {
            const st = await this.state(req.ticket.id);
            const blind = req.stage === "review" || req.stage === "prove";
            const ctx = await feed.forTicket({
              employeeId: req.employee.id,
              sessionId,
              // A PA's own brain is home data: it goes into errands and orientation, never into code work.
              allowHome: req.ticket.type === "errand" || req.ticket.type === "orientation",
              // A local engine's window is small: it gets a smaller brain section.
              budget: brainBudgetFor(req.engine),
              query: {
                title: req.ticket.title,
                project: req.ticket.project,
                reason: req.ticket.reason,
                doneWhen: req.ticket.doneWhen,
                failures: st.lastChecks && !st.lastChecks.green ? st.lastChecks.failures : [],
                findings: blind ? [] : st.review.findings.map((f) => `${f.where}: ${f.text}`),
                plan: blind ? undefined : st.outputs.plan,
              },
            });
            if (ctx.text) req.brief = `${req.brief}\n\n${ctx.text}`;
            // The retro asked for edits in the copy, and the copy isn't there this time: lessons go as JSON.
            if (req.stage === "retro" && !ctx.copy) {
              req.brief = `${req.brief}\n\nYour brain copy is not available this time, so reply with your lessons as JSON instead: {"edits":[{"layer":"brain"|"fact"|"policy","page","text"}]}, at most 2.`;
            }
            // The tidy-up is told where to look: duplicates, conflicts, broken links, unused pages, map sizes.
            if (req.stage === "tidy") req.brief = `${req.brief}\n\n${feed.tidyText(req.employee.id)}`;
          } catch (err) {
            this.d.log?.(`brain: no pages for ${req.ticket.id}/${req.stage}: ${err}`);
          }
        }
        // What the session handles from outside (a GitHub issue as the ticket, a web fetch) makes what it writes
        // into the brain untrusted.
        const harvest = this.d.brainHarvest;
        const ticketSource = { kind: "ticket" as const, id: req.ticket.id };
        if (harvest && ticketFromOutside(req.ticket))
          harvest.noteExternal(ticketSource, "the ticket comes from a GitHub issue");
        let textCount = 0;
        // The stage as a read-only AHP chat (T69), watchable live. It never fails a stage: whatever it hits, it stops.
        let view: StageFeed | undefined;
        if (sessionId !== null) {
          try {
            view = this.d.ticketChannels?.begin({
              ticketId: req.ticket.id,
              ticketTitle: req.ticket.title,
              stage: req.stage,
              sessionId,
              employeeId: req.employee.id,
              engineId: req.engine.id,
              model: req.engine.model,
              brief: req.brief,
              startedAt: clock.now(),
            });
          } catch (err) {
            this.d.log?.(`ticket session ${sessionId}: no live view: ${err}`);
          }
        }
        const origOnAgentUpdate = req.onAgentUpdate;
        const origOnAgentUsage = req.onAgentUsage;
        if (view) {
          req.onAgentUpdate = (u) => {
            view.update(u);
            origOnAgentUpdate?.(u);
          };
          req.onAgentUsage = (u) => {
            view.usage(u);
            origOnAgentUsage?.(u);
          };
        }
        const origOnTranscriptItem = req.onTranscriptItem;
        req.onTranscriptItem = (item) => {
          view?.item(item);
          if (item.kind === "text") textCount++;
          if (harvest && item.kind === "tool" && item.title && externalTool.test(item.title)) {
            harvest.noteExternal(ticketSource, "a web fetch");
          }
          // Reads of brain pages in the employee's copy (the agent's own tool calls) feed the page counters.
          if (item.locations?.length && sessionId !== null && feed) {
            try {
              feed.noteRead(req.employee.id, item.locations, { kind: "session", id: sessionId });
            } catch (err) {
              this.d.log?.(`brain: couldn't note a read: ${err}`);
            }
          }
          if (sessionId !== null) {
            try {
              sessions.recordItem(sessionId, item);
            } catch (err) {
              console.error("[sessions] recordItem failed:", err);
            }
          }
          origOnTranscriptItem?.(item);
        };
        try {
          let outcome = await this.d.agent.run(req);
          // Whatever agent it was, its words reach the log and the API only redacted and cut.
          if (outcome.kind === "stuck" || outcome.kind === "interrupted") {
            outcome = { ...outcome, reason: safeReason(outcome.reason) };
          }
          if (textCount === 0 && sessionId !== null) {
            try {
              if (outcome.kind === "done" && outcome.output) {
                sessions.recordItem(sessionId, {
                  kind: "text",
                  text: capText(outcome.output, 4096),
                  at: clock.now(),
                });
              } else if ((outcome.kind === "stuck" || outcome.kind === "interrupted") && outcome.reason) {
                sessions.recordItem(sessionId, {
                  kind: "text",
                  text: capText(outcome.reason, 4096),
                  at: clock.now(),
                });
              }
            } catch (err) {
              console.error("[sessions] recordItem failed:", err);
            }
          }
          view?.end(outcome);
          return outcome;
        } catch (err) {
          view?.end(
            err instanceof ShuttingDown ? { kind: "stopping" } : { kind: "crashed", reason: String(err) },
          );
          throw err;
        } finally {
          if (sessionId !== null) {
            try {
              sessions.finish(sessionId);
            } catch (err) {
              console.error("[sessions] finish failed:", err);
            }
          }
        }
      },
    };
    const { workspace } = this.d;
    return {
      clock,
      store,
      machines,
      agent,
      harness,
      company: this.company,
      ...(workspace ? { workspace } : {}),
      // Agents with a copy of the brain edit it; the retro asks for lessons there (T58).
      ...(this.d.brainFeed?.enabled ? { brainWrites: (id: Id) => this.d.brainFeed.copyUsable(id) } : {}),
      brainState: this.brainState,
    };
  }

  /**
   * What an orientation or tidy-up is checked against when its session ends. With sandboxes the employee's
   * copy is collected first (the same harvest that runs at the end of the ticket, which then finds nothing
   * more), so the pages the agent wrote are in the brain when they are looked at.
   */
  private readonly brainState: BrainState = {
    pages: async (employeeId, ticketId) => {
      await this.collectCopy(employeeId, ticketId, false);
      const repo = { kind: "brain", id: employeeId } as const;
      if (!this.d.knowledge.exists(repo)) return null;
      return new Map(this.d.knowledge.pages(repo).map((p) => [p.path.replace(/\.md$/, ""), p.text]));
    },
    tidyLeft: async (employeeId, ticketId) => {
      await this.collectCopy(employeeId, ticketId, true);
      const feed = this.d.brainFeed;
      if (!feed) return null;
      const r = feed.tidyData(employeeId);
      const at = (p: { scope: string; slug: string }) => `${p.scope}/${p.slug}`;
      return [
        ...r.duplicates.map((x) => `duplicate pages not merged: ${at(x.a)} and ${at(x.b)} (${x.why})`),
        ...r.conflicts.map((x) => `a \`## Conflict\` section is still in ${at(x)}`),
        ...r.broken.map((x) => `broken link [[${x.link}]] in ${at(x.from)}`),
        ...r.maps
          .filter((m) => m.lines > m.limit)
          .map((m) => `the map of ${m.scope} is ${m.lines} lines, over its limit of ${m.limit}`),
      ];
    },
  };

  /** Collects an employee's brain copy into the shared brain, now. A copy that can't be collected fails the run, which backs off and tries again. */
  private async collectCopy(employeeId: Id, ticketId: Id, tidy: boolean): Promise<void> {
    const harvest = this.d.brainHarvest;
    if (!harvest || !this.d.brainFeed?.enabled) return;
    const r = await harvest.run({
      employeeId,
      allowHome: !tidy,
      source: { kind: "ticket", id: ticketId },
      trigger: "ticket-end",
      tidy,
    });
    if (r.status === "failed") {
      throw new Error(
        `couldn't collect ${employeeId}'s brain copy to check the work${r.detail ? `: ${r.detail}` : ""}`,
      );
    }
  }

  async state(id: Id): Promise<TicketState> {
    const cached = this.stateCache.get(id);
    if (cached && !this.dirtyTickets.has(id)) return cached;
    const events = await this.d.store.read(id);
    const s = this.foldTicket(id, events);
    this.stateCache.set(id, s);
    this.dirtyTickets.delete(id);
    return s;
  }

  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;

  /**
   * One scheduling pass. Returns once everything it started is under way. Passes never overlap, so
   * a reviewer is never picked twice; a tick asked for while one is waiting to run joins it. A pass
   * that fails is logged and the next tick tries again: it never rejects, so no caller (startup
   * included) can be taken down by what one pass found.
   */
  tick(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.chain
      .then(() => {
        this.queued = null;
        return this.pass();
      })
      .catch((e: unknown) => {
        const msg = `tick failed: ${errorLine(e)}`;
        if (this.d.log) this.d.log(msg);
        else console.error(msg);
      });
    this.queued = next;
    this.chain = next;
    return next;
  }

  /** Runs one piece of a ticket's housekeeping; a failure is logged and stops nothing else. */
  private async guarded(id: Id, what: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logOnce(`${what}:${id}:${errorLine(err)}`, `ticket ${id}: ${what} failed: ${errorLine(err)}`);
    }
  }

  private async pass(): Promise<void> {
    const now = this.d.clock.now();
    const states = new Map<Id, TicketState>();
    // One ticket's bad data (an event that won't fold, a step that throws) costs only that ticket:
    // it is left out of this pass, logged once, and listed on the board; the others carry on.
    const records: TicketRecord[] = [];
    for (const r of this.d.tickets.all()) {
      const id = r.ticket.id;
      let fresh: TicketEvent[] | null = null;
      try {
        let s = this.stateCache.get(id);
        if (!s || this.dirtyTickets.has(id)) {
          fresh = await this.d.store.read(id);
          s = this.foldTicket(id, fresh);
          this.stateCache.set(id, s);
        }
        states.set(id, s);
      } catch (err) {
        this.broken.set(id, errorLine(err));
        this.logOnce(
          `broken:${id}:${errorLine(err)}`,
          `ticket ${id} can't be read and is skipped: ${errorLine(err)}`,
        );
        continue;
      }
      this.broken.delete(id);
      records.push(r);
      if (fresh) {
        const events = fresh;
        await this.guarded(id, "applying its knowledge edits", () => this.applyKnowledge(id, events));
        await this.guarded(id, "filing its follow-ups", () => this.fileFollowUps(id, events));
        await this.guarded(id, "sending its notifications", () =>
          this.sendPushNotifications(r.ticket, events),
        );
      }
    }
    this.dirtyTickets.clear();

    // Owner-merges tickets that wait for the owner: has the PR been merged (or closed) on GitHub? Not awaited,
    // so a slow GitHub never holds the tick; one look at a time.
    if (!this.prWatch) {
      this.prWatch = this.watchPrs(records, states)
        .catch((err) =>
          this.logOnce(`prs:${errorLine(err)}`, `watching pull requests failed: ${errorLine(err)}`),
        )
        .finally(() => {
          this.prWatch = null;
        });
    }
    try {
      this.checkAutoReleases(records, states, now);
    } catch (err) {
      this.logOnce(`releases:${errorLine(err)}`, `auto-release check failed: ${errorLine(err)}`);
    }
    try {
      this.fileTidy(records, states, now);
    } catch (err) {
      this.d.log?.(`brain: couldn't file the tidy-up: ${String(err)}`);
    }
    // Brain copies whose machine was stopped when their work ended are collected once it is up.
    void this.d.brainHarvest?.catchUp().catch((e) => this.d.log?.(`brain: catch-up failed: ${String(e)}`));

    const sandboxWaiting: Waiting[] = [];
    const sandboxWaitingUntil: Record<Id, number> = {};

    // Paused tickets run again (the runner returns at once if the wait isn't over), and so do running
    // ones that nothing is driving, e.g. after a restart.
    for (const r of records) {
      const s = states.get(r.ticket.id);
      if (s?.created && (s.status === "paused" || (s.status === "running" && !s.waitingFor))) {
        const builder = s.assignee ?? r.ticket.assignee;
        const fault = this.d.machines.sandboxFault?.(builder);
        if (fault) {
          sandboxWaiting.push({ ticketId: r.ticket.id, reason: fault.waiting });
          sandboxWaitingUntil[r.ticket.id] = fault.retryAt;
          continue;
        }
        this.runQuietly(r.ticket.id);
      }
    }

    const builderOf = (id: Id, fallback: Id) => states.get(id)?.assignee ?? fallback;
    const { busy, holding } = occupancy(
      records.flatMap((r) => {
        const state = states.get(r.ticket.id);
        return state ? [{ builder: builderOf(r.ticket.id, r.ticket.assignee), state }] : [];
      }),
      now,
    );
    // A builder waiting for a reviewer resumes within minutes, so their machine stays up; one waiting
    // for the owner or an account may wait hours, so it sleeps.
    const soon = records
      .filter((r) => states.get(r.ticket.id)?.waitingFor)
      .map((r) => builderOf(r.ticket.id, r.ticket.assignee));
    try {
      await this.sleepIdle(new Set([...busy, ...soon]));
    } catch (err) {
      this.logOnce(`sleep:${errorLine(err)}`, `stopping idle machines failed: ${errorLine(err)}`);
    }
    const pending: PendingDuty[] = records.flatMap((r) => {
      const w = states.get(r.ticket.id)?.waitingFor;
      return w
        ? [
            {
              ticketId: r.ticket.id,
              duty: w.duty,
              builder: builderOf(r.ticket.id, r.ticket.assignee),
              exclude: [builderOf(r.ticket.id, r.ticket.assignee)],
              since: w.since,
            },
          ]
        : [];
    });

    const accountsBlockedUntil: Record<Id, number> = {};
    for (const s of states.values()) {
      if (s.paused) {
        // An engine removed while a ticket waits on it blocks no account.
        const account = findEngine(this.d.registry, s.paused.engineId)?.accountId;
        if (account)
          accountsBlockedUntil[account] = Math.max(accountsBlockedUntil[account] ?? 0, s.paused.until);
      }
    }

    const backlog: BacklogItem[] = records
      .filter((r) => !states.get(r.ticket.id)?.created)
      .map((r) => ({
        id: r.ticket.id,
        project: r.ticket.project,
        type: r.ticket.type,
        ...(r.ticket.labels ? { labels: r.ticket.labels } : {}),
        priority: r.priority,
        createdAt: r.createdAt,
        assignee: r.ticket.assignee || null,
        hold: r.hold,
      }));

    const capReachedUntil: Record<Id, number> = {};
    for (const [accountId, limit] of Object.entries(this.d.registry.accountRateLimits())) {
      const rejected = limit.status === "rejected";
      const saturated = (limit.fiveHourUtilization ?? 0) >= 1 || (limit.sevenDayUtilization ?? 0) >= 1;
      if ((rejected || saturated) && limit.resetsAt && limit.resetsAt > now) {
        capReachedUntil[accountId] = Math.max(capReachedUntil[accountId] ?? 0, limit.resetsAt);
      }
    }
    const d = new Date(now);
    const nextMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
    for (const account of this.d.registry.accounts()) {
      if (
        account.monthlyCap !== undefined &&
        account.monthlyFee !== undefined &&
        account.monthlyFee > account.monthlyCap
      ) {
        capReachedUntil[account.id] = Math.max(capReachedUntil[account.id] ?? 0, nextMonthStart);
      }
    }

    const offset = this.d.registry.settings().utcOffsetMinutes;
    const snap: Snapshot = {
      now,
      localHour: new Date(now + offset * 60_000).getUTCHours(),
      employees: this.d.registry.employees(),
      busy,
      holding,
      accountsBlockedUntil,
      capReachedUntil,
      pickedUpToday: this.pickedUpToday(now),
      pending,
      backlog,
    };
    const plan = schedule(snap, this.company);
    this.waiting = [...plan.waiting, ...sandboxWaiting];
    // A ticket that is backing off after an error says so, until it runs again.
    for (const [id, f] of this.failures) {
      if (f.retryMono > monotonicNow(this.d.clock) && !this.waiting.some((w) => w.ticketId === id)) {
        this.waiting.push({ ticketId: id, reason: f.reason });
        sandboxWaitingUntil[id] ??= f.retryAt;
      }
    }
    // A ticket whose builder waits for its sandbox's cleanup says so.
    for (const r of records) {
      const reason = this.holds.get(states.get(r.ticket.id)?.assignee ?? r.ticket.assignee);
      if (reason && this.running.has(r.ticket.id) && !this.waiting.some((w) => w.ticketId === r.ticket.id)) {
        this.waiting.push({ ticketId: r.ticket.id, reason });
      }
    }
    this.waitingUntil = { ...(plan.resets ?? {}), ...sandboxWaitingUntil };

    // A nearly full disk loses the event log's writes: new tickets wait, with the reason on them. Work
    // already under way, and the reviews and proofs it needs, carry on.
    const lowDisk = this.storage?.lowDisk();
    for (const start of plan.starts) {
      if (lowDisk && start.as === "build") {
        this.waiting.push({ ticketId: start.ticketId, reason: lowDisk });
        continue;
      }
      try {
        // The plan was made from a snapshot taken before the machines were put to sleep: an assignment is
        // dropped when the ticket no longer waits for that duty.
        if (start.as !== "build") {
          if (!(await assignHelper(this.ports, start.ticketId, start.as, start.employeeId))) continue;
        } else if (start.by === "standing-order")
          this.d.tickets.assign(start.ticketId, start.employeeId, now);
      } catch (err) {
        this.logOnce(
          `start:${start.ticketId}:${errorLine(err)}`,
          `ticket ${start.ticketId} didn't start: ${errorLine(err)}`,
        );
        continue;
      }
      this.runQuietly(start.ticketId);
    }
  }

  /** `run`, for the tick: a ticket that can't be run costs only itself. */
  private runQuietly(id: Id): void {
    try {
      this.run(id);
    } catch (err) {
      this.logOnce(`run:${id}:${errorLine(err)}`, `ticket ${id} didn't run: ${errorLine(err)}`);
    }
  }

  /** How many errors in a row stop a ticket for good. */
  static readonly maxErrors = 5;

  /**
   * Runs (or resumes) one ticket in the background, unless it's already running. A ticket that threw
   * lately waits out its back-off first, unless the owner has just acted on it (`force`).
   */
  run(id: Id, opts: { force?: boolean } = {}): void {
    if (this.running.has(id)) {
      // The owner acted on a ticket whose last run is still finishing its after-run steps: it must not wait
      // for the next tick, so it runs again the moment that run is over.
      if (opts.force) this.rerun.add(id);
      return;
    }
    const held = this.failures.get(id);
    if (opts.force) this.failures.delete(id);
    else if (held && monotonicNow(this.d.clock) < held.retryMono) return;
    const record = this.d.tickets.get(id);
    if (!record) throw new Error(`no ticket ${id}`);
    const signal = (employeeId: Id) => {
      const controller = new AbortController();
      this.sessions.set(id, { employeeId, controller });
      return controller.signal;
    };
    const done = runTicket(this.ports, record.ticket, { helpers: "scheduler", signal })
      .then(async (r: RunResult) => {
        this.failures.delete(id);
        this.d.log?.(`ticket ${id}: ${r.status}`);
        // What follows is housekeeping: its failure is logged and is not the ticket's error.
        await this.guarded(id, "its after-run steps", async () => {
          const events = await this.d.store.read(id);
          const s = this.foldTicket(id, events);
          this.stateCache.set(id, s);
          this.dirtyTickets.delete(id);
          this.applyKnowledge(id, events);
          this.fileFollowUps(id, events);
          await this.sendPushNotifications(record.ticket, events);
          // The ticket is over (after its retro, or it failed): what the agents wrote in their brain
          // copies is collected, checked and committed. Never a reason for the ticket to fail.
          if (r.status === "done" || r.status === "failed") await this.harvestTicket(record.ticket, events);
        });
        // A stage finished or wants a helper: someone may be free now, or a reviewer is needed.
        if (r.status !== "paused") void this.tick().catch(() => {});
      })
      .catch((e: unknown) => {
        if (e instanceof ShuttingDown) {
          // The daemon is stopping, not the ticket: no events, no back-off, so it stays running and resumes.
          this.d.log?.(`ticket ${id}: paused for the daemon's stop, resumes when it is back`);
          this.rerun.delete(id);
          return;
        }
        return this.runFailed(id, e);
      })
      .finally(() => {
        this.running.delete(id);
        this.sessions.delete(id);
        if (this.rerun.delete(id)) {
          try {
            this.run(id, { force: true });
          } catch (err) {
            this.logOnce(`run:${id}:${errorLine(err)}`, `ticket ${id} didn't run: ${errorLine(err)}`);
          }
        }
      });
    this.running.set(id, done);
  }

  /** A ticket's run threw: wait (a startup problem), back off (anything else), or give up after a few in a row. */
  private async runFailed(id: Id, e: unknown): Promise<void> {
    const now = this.d.clock.now();
    const mono = monotonicNow(this.d.clock);
    const prev = this.failures.get(id);
    const count = (prev?.count ?? 0) + 1;
    const since = prev?.since ?? now;
    const sinceMono = prev?.sinceMono ?? mono;
    const startup = e instanceof StartupError;
    const reason = errorLine(e);
    let backoff = Math.min(30_000 * 2 ** (count - 1), 10 * 60_000);
    // An upstream that says when to come back (GitHub's rate limit, a sandbox's own retry time) is believed.
    const retryAfterSec = (e as { retryAfterSec?: unknown })?.retryAfterSec;
    if (typeof retryAfterSec === "number" && retryAfterSec > 0)
      backoff = Math.max(backoff, retryAfterSec * 1000);
    if (startup && e.retryAt) backoff = Math.max(backoff, e.retryAt - now);
    const retryAt = now + backoff;
    const retryMono = mono + backoff;
    this.waitingUntil[id] = retryAt;
    if (startup) {
      // Not the ticket's fault, so it waits and shows why, but not for ever: after a long stretch it
      // is the owner's to look at.
      const existing = this.waiting.find((w) => w.ticketId === id);
      if (existing) existing.reason = reason;
      else this.waiting.push({ ticketId: id, reason });
      this.d.log?.(`ticket ${id} waiting (${count} in a row): ${reason}`);
      if (count >= Daemon.maxStartAttempts || mono - sinceMono >= Daemon.maxStartWindowMs) {
        this.failures.delete(id);
        await this.escalate(id, `can't start: ${reason}`);
        return;
      }
      this.failures.set(id, { count, since, sinceMono, retryAt, retryMono, reason });
      return;
    }
    this.d.log?.(`ticket ${id} stopped (${count} in a row): ${reason}`);
    if (count >= Daemon.maxErrors) {
      this.failures.delete(id);
      await this.giveUp(id, count, reason);
      return;
    }
    this.failures.set(id, {
      count,
      since,
      sinceMono,
      retryAt,
      retryMono,
      reason: `hit an error and tries again shortly: ${reason}`,
    });
  }

  /** How many launches that can't start in a row, or how long of them, before the owner is asked. */
  static readonly maxStartAttempts = 60;
  static readonly maxStartWindowMs = 2 * 60 * 60_000;

  /** A ticket that can't start for hours is put in front of the owner, as a Needs you card with why. */
  private async escalate(id: Id, reason: string): Promise<void> {
    try {
      const s = await this.state(id);
      if (s.status !== "running" && s.status !== "paused") return;
      await this.d.store.append(id, [
        {
          type: "needs-you",
          at: this.d.clock.now(),
          stage: s.active ?? "pickup",
          ask: { kind: "stuck", reason },
        },
      ]);
    } catch (err) {
      this.d.log?.(`ticket ${id}: couldn't ask the owner: ${errorLine(err)}`);
    }
  }

  /** Fails a ticket that keeps throwing, so it reaches the owner instead of looping for ever. */
  private async giveUp(id: Id, count: number, reason: string): Promise<void> {
    try {
      const s = await this.state(id);
      if (s.status === "failed" || s.status === "done" || s.status === "ready") return;
      const stage: StageId = s.active ?? "pickup";
      await this.d.store.append(id, [
        {
          type: "failed",
          at: this.d.clock.now(),
          stage,
          reason: `stopped after ${count} errors in a row: ${reason}`,
          tried: [],
        },
      ]);
    } catch (err) {
      this.d.log?.(`ticket ${id}: couldn't record that it gave up: ${errorLine(err)}`);
    }
  }

  /**
   * The employee who tends the brain today: those with the librarian duty take turns by the day. With
   * none, a fallback: the first person (never a personal assistant, whose brain is home data) with the
   * plan duty, else review, else any. Returns what to say about it when it is a fallback.
   */
  pickLibrarian(now: number): { employee: Employee; fallback: Duty | null } | null {
    const people = this.d.registry.employees().filter((e) => !isHomeEmployee(e));
    const librarians = people.filter((e) => e.duties.includes("librarian"));
    if (librarians.length) {
      return {
        employee: librarians[Math.floor(now / 86_400_000) % librarians.length] as Employee,
        fallback: null,
      };
    }
    for (const duty of ["plan", "review", "build"] as Duty[]) {
      const e = people.find((x) => x.duties.includes(duty));
      if (e) return { employee: e, fallback: duty };
    }
    const any = people[0];
    return any ? { employee: any, fallback: any.duties[0] ?? null } : null;
  }

  private tidyNoted = "";

  /**
   * The daily "Tend the brain" ticket: at most one a day, none while the previous one is still open, none
   * when there is nothing to tend, and it counts against the project's daily budget for tickets agents
   * file themselves (like a follow-up, but it is skipped rather than turned into a proposal).
   */
  private fileTidy(records: TicketRecord[], states: Map<Id, TicketState>, now: number): void {
    const feed = this.d.brainFeed;
    if (!feed?.enabled) return;
    const note = (why: string) => {
      if (this.tidyNoted !== why) this.d.log?.(`brain: no tidy-up ticket: ${why}`);
      this.tidyNoted = why;
    };
    const tidy = records.filter((r) => r.ticket.labels?.includes(TIDY_LABEL));
    const open = tidy.find((r) => {
      const s = states.get(r.ticket.id);
      return !s?.created || (s.status !== "done" && s.status !== "failed");
    });
    if (open) {
      note(`ticket ${open.ticket.id} is still open`);
      return;
    }
    const dayStart = localDayStart(now);
    if (tidy.some((r) => r.createdAt >= dayStart)) return;
    const pick = this.pickLibrarian(now);
    if (!pick) {
      note("nobody to ask");
      return;
    }
    const filedToday = records.filter(
      (r) =>
        r.ticket.project === TIDY_PROJECT &&
        r.ticket.createdBy &&
        !r.ticket.labels?.includes(ACCEPTED_LABEL) &&
        r.createdAt >= dayStart,
    ).length;
    if (filedToday >= this.d.registry.projectPolicy(TIDY_PROJECT).followUpsPerDay) {
      note(`today's budget for tickets agents file in ${TIDY_PROJECT} is used`);
      return;
    }
    const r = feed.tidyData(pick.employee.id);
    const work =
      r.duplicates.length +
      r.conflicts.length +
      r.broken.length +
      r.unused.length +
      r.maps.filter((m) => m.lines > m.limit).length;
    if (!work) {
      note("the brain has nothing to tend");
      return;
    }
    this.tidyNoted = "";
    const reason = pick.fallback
      ? `Nobody has the librarian duty, so ${pick.employee.name} (${pick.fallback}) was asked. Give someone the Librarian duty in Company → Team to choose who tends the brain.`
      : "The brain is tended once a day.";
    const t = this.d.tickets.create(
      {
        title: "Tend the brain",
        project: TIDY_PROJECT,
        type: "tidy",
        effort: "low",
        doneWhen: [
          "duplicate pages are merged into one",
          "conflicts and contradictions are resolved",
          "broken [[links]] are fixed",
          "pages unused for 60 days and linked from nowhere are pruned",
          "each scope's map is under its limit",
        ],
        assignee: pick.employee.id,
        createdBy: pick.employee.id,
        labels: [TIDY_LABEL],
        reason,
      },
      now,
    );
    this.d.log?.(
      `brain: ticket ${t.id} "Tend the brain" filed for ${pick.employee.name}${pick.fallback ? ` (no librarian; fell back to the ${pick.fallback} duty)` : ""}`,
    );
  }

  /** Collects the brain copy of everyone who worked on a ticket that has ended (brain-harvest.ts). */
  private async harvestTicket(ticket: Ticket, events: TicketEvent[]): Promise<void> {
    const harvest = this.d.brainHarvest;
    if (!harvest || !this.d.brainFeed?.enabled) return;
    try {
      const s = fold(events);
      const people = [
        ...(s.assignee ? [s.assignee] : [ticket.assignee]),
        ...s.sessions.map((x) => x.employeeId),
      ].filter(Boolean);
      await harvest.ticketEnded(ticket, people);
    } catch (e) {
      this.d.log?.(`brain: couldn't collect the brain copies of ticket ${ticket.id}: ${String(e)}`);
    }
  }

  /**
   * Stops the machines of employees with nothing running (spec §12). A machine keeps what it has
   * touched in memory until it restarts, and wakes in under a second, so idle ones are stopped.
   */
  private async sleepIdle(busy: Set<Id>): Promise<void> {
    if (!this.d.machines.stop) return;
    // A brain copy is being collected: its machine stays up until the next pass.
    if (this.d.brainHarvest?.busy) return;
    const inSession = new Set([...this.sessions.values()].map((s) => s.employeeId));
    // A machine is in use while any employee awake in it is, and is cleaned (when it is due) once
    // none is: it is up, and about to stop, so cleaning never has to wake it.
    const storage = this.storage;
    const inUse = new Set<string>();
    if (storage) {
      for (const id of this.awake) {
        const m = storage.machineOf(id);
        if (m && (busy.has(id) || inSession.has(id) || this.machineHooks.some((h) => h(m)))) inUse.add(m);
      }
    }
    for (const id of [...this.awake]) {
      if (busy.has(id) || inSession.has(id)) continue;
      const machine = storage?.machineOf(id);
      if (machine && this.machineHooks.some((h) => h(machine))) continue;
      // `busy` is from the start of the pass, and earlier iterations awaited stops: look again.
      if (await this.inUseNow(id)) continue;
      if (storage && machine && !inUse.has(machine)) {
        if (storage.holding(machine)) continue;
        if (storage.due(machine)) {
          storage.startClean(machine, () => void this.tick().catch(() => {}));
          continue;
        }
      }
      // Nothing between this look and the stop call waits (the machine provider queues the stop behind
      // any boot already under way, and a start that comes later queues behind the stop).
      if (await this.inUseNow(id)) continue;
      this.awake.delete(id);
      try {
        await this.d.machines.stop(id);
      } catch (e) {
        this.d.log?.(`machine for ${id} didn't stop: ${String(e)}`);
      }
    }
  }

  /**
   * Whether an employee is using their machine right now, from live state rather than the pass's
   * snapshot: a machine start in flight, a session, or a running ticket they build or help with.
   */
  private async inUseNow(id: Id): Promise<boolean> {
    for (const ticketId of this.running.keys()) {
      const record = this.d.tickets.get(ticketId);
      const state = await this.state(ticketId);
      if (record && (state.assignee ?? record.ticket.assignee) === id) return true;
      if (Object.values(state.helpers).some((h) => h === id)) return true;
    }
    // Last, and with nothing awaited after it: the caller stops the machine straight away.
    return this.starting.has(id) || [...this.sessions.values()].some((x) => x.employeeId === id);
  }

  /** The handbook, and a brain for everyone who works here (hiring makes one; this covers the rest). */
  ensureKnowledge(): void {
    // Startup: a handbook or a brain that can't be made is logged, and the daemon still comes up.
    const attempt = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        this.d.log?.(`${what} failed: ${errorLine(err)}`);
      }
    };
    attempt("making the handbook", () => this.d.knowledge.ensureHandbook());
    for (const e of this.d.registry.employees()) {
      attempt(`making ${e.id}'s brain`, () => this.d.knowledge.ensureBrain(e));
    }
    attempt("seeding the notification baseline", () => this.ensurePushBaseline());
  }

  /** Seeds push_sent with a baseline on initial startup so historical events aren't notified. */
  ensurePushBaseline(): void {
    const [row] = this.d.db.all<{ key: string }>(
      "SELECT key FROM push_sent WHERE key = 'baseline:init' LIMIT 1",
    );
    if (row) return;

    this.d.db.transaction(() => {
      this.d.db.run(
        "INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)",
        "baseline:init",
        this.d.clock.now(),
      );
      const rows = this.d.db.all<{ ticket_id: string; body: string }>(
        "SELECT ticket_id, body FROM events ORDER BY ticket_id, seq",
      );
      const byTicket = new Map<string, number>();
      for (const r of rows) {
        const idx = byTicket.get(r.ticket_id) ?? 0;
        byTicket.set(r.ticket_id, idx + 1);
        // A row that can't be read is an `unreadable` placeholder in the store, at the same index.
        let e: { type?: unknown } | null = null;
        try {
          e = JSON.parse(r.body) as { type?: unknown };
        } catch {}
        if (e?.type === "needs-you" || e?.type === "report-ready" || e?.type === "main-red") {
          this.d.db.run(
            "INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)",
            `push:${r.ticket_id}:${idx}`,
            this.d.clock.now(),
          );
        }
      }
    });
  }

  /**
   * Files the tickets agents proposed for themselves (decided 2026-10-17), each once, while the
   * project's daily budget allows. They go to the agent that proposed them, marked as its own.
   */
  fileFollowUps(ticketId: Id, events: TicketEvent[]): void {
    const from = this.d.tickets.get(ticketId)?.ticket;
    if (!from) return;
    const now = this.d.clock.now();
    const dayStart = localDayStart(now);
    events.forEach((e, i) => {
      if (e.type !== "follow-ups" || !Array.isArray(e.tickets)) return;
      e.tickets.forEach((raw, j) => {
        const key = `followup:${ticketId}:${i}:${j}`;
        const [done] = this.d.db.all<{ n: number }>(
          "SELECT COUNT(*) AS n FROM knowledge_applied WHERE edit_id = ?",
          key,
        );
        if (done?.n) return;
        // Events stored before replies were checked may hold anything: it is read again here, and what
        // can't be a ticket is marked done and left alone, never filed and never tried again.
        const [f] = readFollowUps([raw], 1).kept;
        if (!f || typeof e.employeeId !== "string") {
          this.d.db.run("INSERT OR IGNORE INTO knowledge_applied (edit_id, at) VALUES (?, ?)", key, now);
          this.d.log?.(`follow-up ${j + 1} of ticket ${ticketId} isn't a ticket and was left out`);
          return;
        }
        // The budget counts what agents filed on their own today; a ticket the owner accepted from
        // a proposal was their call, so it doesn't use any of it.
        const filedToday = this.d.tickets
          .all()
          .filter(
            (r) =>
              r.ticket.project === from.project &&
              r.ticket.createdBy &&
              !r.ticket.labels?.includes(ACCEPTED_LABEL) &&
              r.createdAt >= dayStart,
          ).length;
        // Filing and marking it filed go together, so a crash between them can't file it twice.
        this.d.db.transaction(() => {
          if (filedToday >= this.d.registry.projectPolicy(from.project).followUpsPerDay) {
            // Over budget: the owner decides, so it waits as a proposal instead of being dropped.
            const made = this.d.proposals.add(
              {
                project: from.project,
                title: f.title,
                body: f.reason ?? "",
                proposedBy: e.employeeId,
                sourceTicket: ticketId,
                type: f.type,
                effort: f.effort,
                doneWhen: f.doneWhen,
              },
              now,
            );
            if (made) {
              this.d.log?.(
                `follow-up "${f.title}" from ${e.employeeId} kept as proposal ${made.id}: ${from.project}'s budget for today is used`,
              );
            }
          } else {
            const t = this.d.tickets.create(
              {
                title: f.title,
                project: from.project,
                type: f.type,
                effort: f.effort,
                doneWhen: f.doneWhen,
                assignee: e.employeeId,
                createdBy: e.employeeId,
                ...(f.reason ? { reason: f.reason } : {}),
                labels: ["follow-up"],
              },
              now,
            );
            this.d.log?.(`ticket ${t.id} filed by ${e.employeeId} as a follow-up of ${ticketId}: ${f.title}`);
          }
          this.d.db.run("INSERT OR IGNORE INTO knowledge_applied (edit_id, at) VALUES (?, ?)", key, now);
        });
      });
    });
  }

  /** Sends push notifications for needs-you, report-ready, and main-red events (Contract C2). */
  async sendPushNotifications(ticket: Ticket, events: TicketEvent[]): Promise<void> {
    if (!this.d.push) return;
    for (const [i, e] of events.entries()) {
      let payload: NotificationPayload | undefined;
      if (e.type === "needs-you") {
        payload = {
          title: `Needs you · #${ticket.id}`,
          body: ticket.title,
          url: `#/ticket/${ticket.id}`,
        };
      } else if (e.type === "report-ready") {
        payload = {
          title: `Report ready · #${ticket.id}`,
          body: ticket.title,
          url: `#/ticket/${ticket.id}`,
        };
      } else if (e.type === "main-red") {
        payload = {
          title: `Main is red · #${ticket.id}`,
          body: e.reason,
          url: `#/ticket/${ticket.id}`,
        };
      }
      if (!payload) continue;

      const key = `push:${ticket.id}:${i}`;
      const res = this.d.db.run(
        "INSERT INTO push_sent (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
        key,
        this.d.clock.now(),
      );
      if ((res?.changes ?? 0) === 0) continue;

      try {
        await this.d.push.send(payload);
      } catch (err) {
        this.d.log?.(`failed to send push notification for ${key}: ${String(err)}`);
      }
    }
  }

  /** Applies a ticket's proposed edits that are due and not yet applied (spec §5, "The brain"). */
  applyKnowledge(ticketId: Id, events: TicketEvent[]): void {
    const due = knowledgeLog(ticketId, events).due;
    if (!due.length) return;
    const placeholders = due.map(() => "?").join(", ");
    const applied = new Set(
      this.d.db
        .all<{ edit_id: string }>(
          `SELECT edit_id FROM knowledge_applied WHERE edit_id IN (${placeholders})`,
          ...due.map((p) => p.id),
        )
        .map((r) => r.edit_id),
    );
    for (const p of due) {
      if (applied.has(p.id)) continue;
      try {
        this.d.knowledge.apply(p, (id) => this.d.registry.employee(id));
        this.d.db.run(
          "INSERT OR IGNORE INTO knowledge_applied (edit_id, at) VALUES (?, ?)",
          p.id,
          this.d.clock.now(),
        );
      } catch (e) {
        this.d.log?.(`knowledge edit ${p.id} not applied: ${String(e)}`);
      }
    }
  }

  /**
   * Stops the employee's session on a ticket, if they're in one, so it starts again with the urgent
   * message first. Returns whether a session was stopped.
   */
  interrupt(ticketId: Id, employeeId: Id): boolean {
    const s = this.sessions.get(ticketId);
    if (!s || s.employeeId !== employeeId || s.controller.signal.aborted) return false;
    s.controller.abort("the owner sent an urgent message");
    return true;
  }

  /** How often one open PR is looked at while its ticket waits for the owner to merge it. */
  static readonly prCheckMs = 5 * 60_000;
  /** The most a rate-limited or failing PR check waits before it tries again. */
  static readonly prCheckMaxMs = 30 * 60_000;
  /** The look at the open PRs that is going on now, if any. */
  private prWatch: Promise<void> | null = null;
  /** When each ready ticket's PR is next looked at (monotonic ms), and how many looks failed in a row. */
  private readonly prChecks = new Map<Id, { next: number; failed: number }>();

  /**
   * An owner-merges ticket that is ready waits for the owner to merge the PR on GitHub (there is no Approve
   * button for it). Each such PR is looked at every few minutes: merged records `merged` (auto-release and
   * cleanup follow from that), closed without merging records a rejection. GitHub's rate limit and failures
   * only make the next look later. The ticket's own run is untouched: this is only the owner's decision, made
   * for them by what they did on GitHub.
   */
  private async watchPrs(records: TicketRecord[], states: Map<Id, TicketState>): Promise<void> {
    const ws = this.d.workspace;
    for (const id of [...this.prChecks.keys()])
      if (states.get(id)?.status !== "ready") this.prChecks.delete(id);
    if (!ws?.prState) return;
    for (const r of records) {
      const id = r.ticket.id;
      const s = states.get(id);
      if (s?.status !== "ready" || !s.pr || s.pr.number === undefined) continue;
      if (this.d.registry.projectPolicy(r.ticket.project).mode !== "owner-merges") continue;
      const mono = monotonicNow(this.d.clock);
      const prev = this.prChecks.get(id);
      if (prev && mono < prev.next) continue;
      let seen: "open" | "closed" | "merged";
      try {
        seen = await ws.prState(r.ticket, s.pr);
      } catch (err) {
        const failed = (prev?.failed ?? 0) + 1;
        const asked = (err as { retryAfterSec?: unknown })?.retryAfterSec;
        const wait = Math.min(
          Math.max(
            (this.d.prCheckMs ?? Daemon.prCheckMs) * 2 ** (failed - 1),
            typeof asked === "number" ? asked * 1000 : 0,
          ),
          Daemon.prCheckMaxMs,
        );
        this.prChecks.set(id, { next: mono + wait, failed });
        this.logOnce(
          `pr:${id}:${errorLine(err)}`,
          `ticket ${id}: couldn't look at its PR: ${errorLine(err)}`,
        );
        continue;
      }
      this.prChecks.set(id, { next: mono + (this.d.prCheckMs ?? Daemon.prCheckMs), failed: 0 });
      if (seen === "open") continue;
      // Decide from the log, not the snapshot: the owner may have acted meanwhile.
      if ((await this.state(id)).status !== "ready") continue;
      this.prChecks.delete(id);
      this.d.log?.(
        `ticket ${id}: its PR was ${seen === "merged" ? "merged" : "closed without merging"} on GitHub`,
      );
      await decide(this.ports, id, seen === "merged" ? "approve" : "reject");
      try {
        this.run(id, { force: true });
      } catch (err) {
        this.logOnce(`run:${id}:${errorLine(err)}`, `ticket ${id} didn't run: ${errorLine(err)}`);
      }
    }
  }

  /** Resolves when nothing is running. For tests and a clean shutdown. */
  async idle(): Promise<void> {
    // A ticket that finishes asks for a tick before it leaves `running`, so the chain covers it.
    for (;;) {
      await this.chain;
      if (this.prWatch) {
        await this.prWatch;
        continue;
      }
      if (!this.running.size) return;
      await Promise.all(this.running.values());
    }
  }

  private pickedUpToday(now: number): Record<Id, number> {
    const dayStart = localDayStart(now);
    const out: Record<Id, number> = {};
    for (const r of this.d.tickets.all()) {
      if (r.pickedAt !== null && r.pickedAt >= dayStart)
        out[r.ticket.assignee] = (out[r.ticket.assignee] ?? 0) + 1;
    }
    return out;
  }

  private checkAutoReleases(records: TicketRecord[], states: Map<Id, TicketState>, now: number): void {
    const allReleases = this.d.registry.releases();
    for (const project of this.d.registry.projects()) {
      const policy = this.d.registry.projectPolicy(project.id);
      if (!policy.autoRelease) continue;

      const projectReleases = allReleases.filter((r) => r.project === project.id);
      const releasedTicketIds = new Set(projectReleases.flatMap((r) => r.ticketIds));
      const latestReleaseAt = projectReleases.length ? Math.max(...projectReleases.map((r) => r.at)) : null;

      const projectTickets = records.filter((r) => r.ticket.project === project.id);
      const pendingTickets = projectTickets.filter((r) => {
        if (releasedTicketIds.has(r.ticket.id)) return false;
        const state = states.get(r.ticket.id);
        if (state?.outcome !== "merged") return false;
        if (latestReleaseAt !== null && latestReleaseAt <= now && (state.closedAt ?? 0) <= latestReleaseAt)
          return false;
        return true;
      });

      if (!pendingTickets.length) continue;

      const count = projectReleases.length + 1;
      const tag = `v${new Date(now).toISOString().slice(0, 10)}.${count}`;
      const ticketIds = pendingTickets.map((r) => r.ticket.id);
      const commits = pendingTickets
        .map((r) => states.get(r.ticket.id)?.pushed)
        .filter((c): c is string => typeof c === "string" && Boolean(c));

      const release: ProjectRelease = {
        project: project.id,
        tag,
        at: now,
        ticketIds,
        commits,
      };

      this.d.registry.recordRelease(release);
      allReleases.push(release);
      this.d.log?.(`auto-release ${tag} recorded for project ${project.id} (${ticketIds.length} tickets)`);
    }
  }
}

/**
 * When the owner's day began at `now` (epoch ms): midnight in the daemon host's time zone, where the owner is,
 * so "today's" budgets reset at the owner's midnight and not at UTC's. A day with a clock change is 23 or 25 hours.
 */
export function localDayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** An error as one short line for the log and for a ticket's reason: no control characters, cut at 300. */
function errorLine(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).replace(/\p{Cc}+/gu, " ").trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
