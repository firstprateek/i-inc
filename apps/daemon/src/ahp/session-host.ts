// The session host: the AgentBackend that runs conversations on real agents (docs/design/conversations.md).
//
// One ACP connection per ACTIVE conversation, launched with `machineLaunch` into the employee's team
// sandbox and working in the conversation's own working copy. Idle conversations are suspended (the
// process stopped, everything kept) and wake with `session/load` where the adapter has it, otherwise
// with a continuation brief. At most three conversations per team are live at once; a fourth waits,
// and says why. Permission requests are never answered by the host: they become pending confirmations
// in the chat and wait for the owner (the agent's default mode is its bypass mode, so there are few).
//
// Everything the sandbox walls decide stays where it was: the launch is `machineLaunch`, which checks
// the walls and passes credentials by environment only.

import { type BrainUse, brainBudgetFor, type Engine, type Id } from "@i-inc/core";
import type { AgentInfo, Message } from "@microsoft/agent-host-protocol";
import {
  bypassMode,
  configChoices,
  extractRateLimit,
  type Launch,
  limitError,
  locationPaths,
  resetFromText,
  type UsageReport,
  upstreamReason,
  usageReport,
} from "../acp.ts";
import type { BrainFeed } from "../brain-feed.ts";
import type { Reap } from "../reaper.ts";
import type { AccountRateLimit } from "../registry.ts";
import { type CopyState, isSafeRefName, isSafeWorkDir } from "../workspace.ts";
import { AcpConnection, EXITED, type RpcReply, TIMED_OUT } from "./acp-connection.ts";
import { configFromAcp, promptBlocks, TurnMapper } from "./acp-mapper.ts";
import type {
  AgentBackend,
  AppGate,
  OpenedSession,
  OpenSessionRequest,
  ToolAnswer,
  TurnOutcome,
  TurnRun,
} from "./backend.ts";
import { type AhpHost, DEFAULT_TITLE } from "./host.ts";
import { redactText, redactTokens } from "./sanitize.ts";
import { ActionType, type ChatState, type Json, ResponsePartKind, SessionStatus } from "./wire.ts";

/** A conversation, as the session host needs to know it. */
export interface ConversationInfo {
  id: string;
  employeeId: Id;
  project: string | null;
  branch: string | null;
  /** The working copy in the sandbox: a branch worktree, or an empty scratch folder with no project. */
  cwd: string;
  engine: Engine;
  /** The team whose sandbox it runs in (and whose cap it counts against). */
  team: string;
}

export interface SessionHostOptions {
  /** Starts an agent's ACP server in a sandbox: `machineLaunch`. */
  launch: Launch;
  /** One provider per engine, for the root channel. */
  agents: () => AgentInfo[];
  engine: (id: Id) => Engine | undefined;
  teamOf: (employeeId: Id) => string;
  /** Makes (or finds) the conversation's working copy in the sandbox. Throwing fails the session. */
  workingCopy: (c: ConversationInfo) => Promise<CopyState | undefined>;
  /**
   * Takes away a working copy that was just made for a session that then failed to open, if nothing
   * of the owner's is in it. Failing to is fine: the storage cleanup finds what is left.
   */
  removeCopy?: (c: ConversationInfo) => Promise<void>;
  /** The environment an agent starts with: its account's credential, ports, the GitHub sign-in. */
  credentials: (
    engine: Engine,
    c: ConversationInfo,
  ) => Record<string, string> | Promise<Record<string, string>>;
  /** Is this employee still here? A conversation of one who left is suspended at the next sweep. */
  employeeKnown?: (employeeId: Id) => boolean;
  /**
   * For a personal assistant, a short note on what its machine has and hasn't (no internet, no sudo, no installs),
   * added to every turn: a small local model that isn't told tries `sudo apt install`. Absent or "" for anyone else.
   */
  homeNotes?: (employeeId: Id) => string;
  /** What the employee's sandbox is called in the chat while it boots ("Pip's sandbox", "the engineering sandbox"). */
  sandboxLabel?: (employeeId: Id) => string;
  /** The reasoning effort Codex is asked for. */
  effort?: (employeeId: Id) => string;
  /**
   * Stops an agent an earlier daemon left running in the sandbox (reaper.ts). Called before every
   * launch, with the folder, so a restart never ends up with two agents for one conversation.
   */
  reap?: Reap;
  /**
   * The brain (T57): before each turn the employee's copy in the sandbox is refreshed and the pages
   * that match the message go in as extra prompt content; reads the agent makes feed the page counters.
   */
  brain?: Pick<BrainFeed, "enabled" | "forTurn" | "noteRead" | "conversationPages">;
  /**
   * The employee's brain copy is collected (brain-harvest.ts) when a conversation goes idle or ends, and
   * after a turn where the owner said `/remember` (T58). Never awaited by a turn; a failure is only logged.
   */
  harvest?: (c: ConversationInfo, why: "idle" | "end" | "remember") => Promise<unknown> | undefined;
  /**
   * A turn of this employee's is running: a team shares one machine and one Unix user, so the brain harvest
   * needs to know who may have been working there. Returns what to call when the turn ends.
   */
  activity?: (employeeId: Id) => () => void;
  /** The agent fetched something from outside (a web page): what it writes into its brain is marked untrusted. */
  external?: (c: ConversationInfo, why: string) => void;
  /** Live conversations per team. Default 3. */
  perTeamCap?: number;
  /** A conversation with nothing happening for this long is suspended. Default 15 minutes. */
  idleMs?: number;
  /** How long a cancelled agent gets before it is killed. Default 10 s. */
  cancelGraceMs?: number;
  /** How long an agent gets to start and open its session. Default 120 s (a stopped sandbox boots first). */
  startTimeoutMs?: number;
  onUsage?: (u: UsageReport) => void;
  onRateLimit?: (accountId: Id, limit: AccountRateLimit) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Thrown when a conversation can't get a slot right now and should not wait (creating one). */
export class NoSlotError extends Error {
  override readonly name = "NoSlotError";
}

interface ActiveRun {
  turn: TurnRun;
  mapper: TurnMapper;
  permissions: Map<string, (outcome: Json) => void>;
  cancelled: boolean;
  usage: Json | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Live {
  session: string;
  chat: string;
  info: ConversationInfo;
  conn: AcpConnection | undefined;
  acpSessionId: string | undefined;
  caps: Json;
  /** The mode is the ACP session mode (set_mode), not a config option. */
  modeViaModes: boolean;
  /** The agent's own values for config keys, as last reported. */
  agentValues: Json;
  holdsSlot: boolean;
  lastActive: number;
  run: ActiveRun | undefined;
  /** The agent has no memory of this conversation: the next prompt carries a continuation brief. */
  needsBrief: boolean;
  /** During session/load the agent replays old messages: they are dropped. */
  replaying: boolean;
  /** The chat exists (afterCreate has run): side updates may touch the session. */
  created: boolean;
  starting: Promise<void> | undefined;
  /** The session is being created: its agent is still initialising and must not be evicted. */
  opening: boolean;
  /** Created while the sandbox was being cleaned: no copy and no agent yet; the first message makes them. */
  deferred: boolean;
  /** Brain pages put in the prompt of the turn in flight: shown now, recorded once the agent has accepted it. */
  brainPending: BrainUse[];
}

interface Waiter {
  team: string;
  wake: () => void;
}

/** What the owner is told when a conversation's working copy had been cleaned up and is made again. */
function copyNote(info: ConversationInfo, copy: CopyState): string {
  const gone = "The earlier working copy of this conversation was cleaned up while it was archived.";
  if (info.project === null) return `${gone} The folder starts empty again.`;
  if (copy === "restored")
    return `${gone} Its branch ${info.branch} was checked out again with the commits it had; changes that were not committed were not kept.`;
  if (copy === "remote")
    return `${gone} It was rebuilt from ${info.branch} on GitHub; changes that were not committed were not kept.`;
  return `${gone} Its branch is gone too, so this is a new copy from the project's main branch.`;
}

/** A tool call that fetches from outside: ACP's `fetch` kind, a web fetch or search tool, `curl` or `wget` of a URL. */
export function fetchesFromOutside(u: Json): boolean {
  const title = String(u.title ?? "");
  return u.kind === "fetch" || externalTool.test(title);
}
export const externalTool =
  /^\s*(?:web[ _-]?fetch|web[ _-]?search|fetch|search the web)\b|\b(?:curl|wget)\b[^\n]*https?:\/\//i;

/** What the agent is asked when the owner types `/remember`. */
function rememberPrompt(note: string): string {
  const extra = note.trim() ? ` The owner adds: ${note.trim()}` : "";
  return `The owner asked you to remember this conversation. In your brain copy, write down what is worth keeping from it: update the page that already covers a topic (rewrite it, don't append) or create one if none does, and search first so you never make a near-duplicate. Only what clears the bar: durable, non-obvious and reusable.${extra} Then reply with one line saying what you wrote, or that nothing here clears the bar.`;
}

const fileUriPath = (uri: string): string | undefined =>
  uri.startsWith("file://") ? uri.slice(7) : undefined;

export class SessionHost implements AgentBackend {
  private host: AhpHost | undefined;
  private readonly lives = new Map<string, Live>();
  private readonly waiters: Waiter[] = [];
  private readonly warned = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly cap: number;
  private readonly idleMs: number;

  constructor(private readonly o: SessionHostOptions) {
    this.cap = o.perTeamCap ?? 3;
    this.idleMs = o.idleMs ?? 15 * 60_000;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private log(m: string): void {
    this.o.log?.(`conversations: ${m}`);
  }
  private get h(): AhpHost {
    if (!this.host) throw new Error("the session host is not attached to an AHP host");
    return this.host;
  }

  // ───────────────────────────── AgentBackend ─────────────────────────────

  attach(host: AhpHost): void {
    this.host = host;
  }

  private app: AppGate | undefined;
  attachApp(app: AppGate): void {
    this.app = app;
  }

  /** Employees with an agent running or starting: their machines are in use. */
  liveEmployees(): string[] {
    return [...this.lives.values()]
      .filter((l) => (l.conn && !l.conn.exited) || l.starting || l.opening || l.run)
      .map((l) => l.info.employeeId);
  }

  /**
   * Work in a team machine waits while a storage cleanup holds it (a few minutes at most), and says
   * why in the chat when there is one to say it in.
   */
  private async untilCleanupDone(live: Live, say?: (reason: string | undefined) => void): Promise<void> {
    const storage = this.app?.storage;
    const machine = storage?.machineOf(live.info.employeeId);
    if (!storage || !machine || !storage.holding(machine)) return;
    say?.(
      `Waiting for the sandbox cleanup to finish (the ${live.info.team} sandbox starts again in a moment).`,
    );
    const free = await storage.untilFree(machine, 5 * 60_000);
    say?.(undefined);
    if (!free) throw new Error(`the ${live.info.team} sandbox is still being cleaned up, try again shortly`);
  }

  agents(): AgentInfo[] {
    return this.o.agents();
  }

  async openSession(req: OpenSessionRequest): Promise<OpenedSession> {
    const info = this.infoFromMeta(req.meta, req.provider, req.workingDirectories[0]);
    const live = this.newLive(req.session, req.chat, info);
    live.needsBrief = false;
    live.opening = true;
    this.lives.set(req.session, live);
    let copy: CopyState | undefined;
    try {
      // A sandbox being cleaned must not hold the owner's request for minutes. If the agent's
      // settings are known from an earlier session the conversation is made now, without an agent,
      // and its first message waits for the cleanup and says so; if not, the owner is told at once.
      const storage = this.app?.storage;
      const machine = storage?.machineOf(info.employeeId);
      if (storage && machine && storage.holding(machine)) {
        const known = this.configCache.get(info.engine.id);
        if (!known) {
          throw new NoSlotError(
            `The ${info.team} sandbox is being cleaned up and starts again in a few minutes. Try again then.`,
          );
        }
        live.deferred = true;
        return { config: known, meta: { "iinc.cwd": info.cwd } };
      }
      // A stopped machine takes a minute to boot, and the guard refuses every script in it until it is up. With
      // the agent's settings known from an earlier session the conversation is made now and the first message
      // boots the machine (saying so in the chat); if not, it boots here, since the settings come from the agent.
      const gate = this.app;
      if (gate?.ensureUp && gate.sandboxUp && !gate.sandboxUp(info.employeeId)) {
        const known = this.configCache.get(info.engine.id);
        if (known) {
          live.deferred = true;
          return { config: known, meta: { "iinc.cwd": info.cwd } };
        }
      }
      await this.acquire(live, { wait: false });
      await gate?.ensureUp?.(info.employeeId);
      copy = await this.o.workingCopy(info);
      const first = await this.launchSession(live, { fresh: true, mode: req.config?.mode });
      const config = configFromAcp(
        first.modes as Json | undefined,
        first.configOptions as Json[] | undefined,
      );
      this.configCache.set(info.engine.id, config);
      return { config, meta: { "iinc.cwd": info.cwd } };
    } catch (e) {
      this.discard(live);
      // A copy made for a conversation that never came to be: don't leave it behind.
      if (copy === "fresh" || copy === "restored") {
        await this.o.removeCopy?.(info).catch((err) => this.log(`couldn't remove ${info.cwd}: ${err}`));
      }
      throw e;
    } finally {
      live.opening = false;
    }
  }
  private readonly configCache = new Map<string, OpenedSession["config"]>();

  /** The channels exist now: remember the agent's session id (it survives a restart) and let updates through. */
  afterCreate(session: string, chat: string): void {
    const live = this.lives.get(session);
    if (!live) return;
    live.created = true;
    live.chat = chat;
    if (live.acpSessionId) this.h.setChannelMeta(chat, { acpSessionId: live.acpSessionId });
  }

  async closeSession(session: string): Promise<void> {
    const live = this.lives.get(session);
    if (live) this.discard(live);
  }

  async setConfig(session: string, values: Json): Promise<void> {
    const live = this.lives.get(session) ?? this.adopt(session);
    if (!live?.conn || live.conn.exited || !live.acpSessionId) return; // applied when the agent next starts
    for (const [k, v] of Object.entries(values)) {
      const r = await this.pushConfig(live, live.conn, live.acpSessionId, k, v);
      if (r.error) throw new Error(upstreamReason(r.error));
      live.agentValues[k] = v;
    }
  }

  async runTurn(run: TurnRun): Promise<TurnOutcome> {
    const live = this.lives.get(run.session) ?? this.adopt(run.session);
    if (!live)
      return { kind: "error", errorType: "no_session", message: "This conversation's session is gone." };
    live.lastActive = this.now();
    // A full disk loses what the agent just did: a new turn waits for room (one already running goes on).
    const lowDisk = this.app?.storage.lowDisk?.();
    if (lowDisk) return { kind: "error", errorType: "disk_low", message: `Not started: ${lowDisk}.` };
    try {
      await this.ensureRunning(live, run);
    } catch (e) {
      if (run.signal.aborted) return { kind: "cancelled" };
      return this.startFailure(e);
    }
    if (run.signal.aborted) return { kind: "cancelled" };
    const conn = live.conn;
    const sessionId = live.acpSessionId;
    if (!conn || !sessionId)
      return { kind: "error", errorType: "agent_exited", message: "The agent is not running." };
    // A blank agent (its memory of the conversation is lost) gets the continuation brief below.
    const blank = live.needsBrief && (this.h.chatState(live.chat)?.turns.length ?? 0) > 0;
    const brain = await this.brainFor(live, run, blank);
    if (run.signal.aborted) return { kind: "cancelled" };

    const mapper = new TurnMapper({
      turnId: run.turnId,
      emit: (a) => run.emit(a),
      put: (data, mime) => this.h.putContent(typeof data === "string" ? redactTokens(data) : data, mime),
      side: (kind, u) => this.onSide(live, kind, u),
    });
    let endActivity: (() => void) | undefined;
    const active: ActiveRun = {
      turn: run,
      mapper,
      permissions: new Map(),
      cancelled: false,
      usage: undefined,
      killTimer: undefined,
    };
    live.run = active;
    try {
      endActivity = this.o.activity?.(live.info.employeeId);
    } catch (e) {
      this.log(`couldn't note the turn's activity: ${e instanceof Error ? e.message : e}`);
    }
    if (run.signal.aborted) {
      // Cancelled between the host recording the turn and the prompt going out.
      live.run = undefined;
      endActivity?.();
      return { kind: "cancelled" };
    }
    // `/remember [note]`: the owner asks the agent to write what is worth keeping into its brain copy, and
    // the copy is collected as soon as the turn is over.
    const remember = /^\s*\/remember\b[ \t]*([\s\S]*)$/i.exec(run.message.text);
    const message = remember ? { ...run.message, text: rememberPrompt(remember[1] ?? "") } : run.message;
    let blocks = promptBlocks(message, live.caps);
    if (blank) {
      blocks = [{ type: "text", text: this.continuationBrief(live, run.message) }, ...blocks.slice(1)];
    }
    // The brain goes in after the owner's message, as its own block.
    const home = this.o.homeNotes?.(live.info.employeeId) ?? "";
    const extra = [brain.text, home].filter(Boolean).join("\n\n");
    if (extra) blocks = [blocks[0] as Json, { type: "text", text: extra }, ...blocks.slice(1)];
    // What a ticket did to the branch while this conversation was away, said once, ahead of everything.
    const note = this.app?.takeNote?.(live.info.id);
    if (note) blocks = [{ type: "text", text: note }, ...blocks];
    try {
      const done = await conn.request("session/prompt", { sessionId, prompt: blocks });
      if (!done.error) {
        live.needsBrief = false;
        // The agent has the pages now: only then do they count as sent in this conversation.
        brain.commit();
        live.brainPending = [];
        this.publishBrain(live);
      }
      const outcome = this.outcome(live, active, done);
      if (remember && outcome.kind === "complete") this.collect(live.info, "remember");
      return outcome;
    } finally {
      endActivity?.();
      if (active.killTimer) clearTimeout(active.killTimer);
      if (live.run === active) live.run = undefined;
      live.lastActive = this.now();
      // A finished turn makes the conversation idle, and so a slot for one that is waiting. The host
      // only ends the turn once this returns, so look again on the next tick, not now.
      const team = live.info.team;
      setTimeout(() => this.wake(team), 0).unref?.();
    }
  }

  hold(session: string): boolean {
    const live = this.lives.get(session) ?? this.adopt(session);
    if (!live) return true; // nothing of this conversation is running
    if (live.run || live.starting || live.opening || this.h.hasActiveTurn(live.chat)) return false;
    this.suspend(live, "its work became a ticket");
    return true;
  }

  /**
   * The brain section for this turn, or "" (no brain, nothing new, or a failure: a turn never waits
   * on or fails for the brain). Also publishes what the conversation has used so far.
   */
  private async brainFor(
    live: Live,
    run: TurnRun,
    blank: boolean,
  ): Promise<{ text: string; commit: () => void }> {
    const brain = this.o.brain;
    if (!brain?.enabled) return { text: "", commit: () => {} };
    try {
      const title = this.h.sessionState(live.session)?.title;
      const ctx = await brain.forTurn({
        employeeId: live.info.employeeId,
        conversation: live.info.id,
        turn: run.turnId,
        message: run.message.text,
        title: title && title !== DEFAULT_TITLE ? title : undefined,
        project: live.info.project,
        fresh: blank,
        // A conversation on a project can push to a repository; a PA's home data stays out of it.
        allowHome: live.info.project === null,
        budget: brainBudgetFor(live.info.engine),
      });
      live.brainPending = ctx.pages;
      this.publishBrain(live);
      return { text: ctx.text, commit: ctx.commit };
    } catch (e) {
      this.log(`the brain was left out of a turn of ${live.session}: ${e instanceof Error ? e.message : e}`);
      return { text: "", commit: () => {} };
    }
  }

  /** The pages a conversation has used, in the session's `_meta["iinc.brain"]` (contract C19/C22). */
  private publishBrain(live: Live): void {
    const session = this.h.sessionState(live.session);
    if (!session || !live.created || !this.o.brain) return;
    const seen = new Map<string, BrainUse>();
    for (const p of [...this.o.brain.conversationPages(live.info.id), ...live.brainPending]) {
      if (!seen.has(`${p.scope}:${p.slug}`)) seen.set(`${p.scope}:${p.slug}`, p);
    }
    const pages = [...seen.values()].slice(-100);
    const entries = pages.map((p) => ({
      id: `${p.scope}:${p.slug}`,
      title: p.title,
      scope: p.scope,
      slug: p.slug,
      updated: p.updated,
      via: p.via,
      ...(p.untrusted ? { untrusted: true } : {}),
    }));
    if (JSON.stringify(session._meta?.["iinc.brain"] ?? []) === JSON.stringify(entries)) return;
    this.h.emit(live.session, {
      type: ActionType.SessionMetaChanged,
      _meta: { ...(session._meta ?? {}), "iinc.brain": entries },
    });
  }

  cancelTurn(run: TurnRun): void {
    const live = this.lives.get(run.session);
    const active = live?.run;
    if (!live || !active || active.turn !== run) return;
    active.cancelled = true;
    // ACP: answer outstanding permission requests `cancelled`, then notify session/cancel.
    for (const resolve of active.permissions.values()) resolve({ outcome: "cancelled" });
    active.permissions.clear();
    if (live.conn && live.acpSessionId) live.conn.notify("session/cancel", { sessionId: live.acpSessionId });
    // An agent that does not wind down is killed; the next message starts it again.
    active.killTimer = setTimeout(() => {
      this.log(`the agent of ${run.session} did not stop after cancel: killing it`);
      live.conn?.kill();
    }, this.o.cancelGraceMs ?? 10_000);
    active.killTimer.unref?.();
  }

  answerToolCall(run: TurnRun, toolCallId: string, answer: ToolAnswer): void {
    const active = this.lives.get(run.session)?.run;
    if (!active || active.turn !== run) return;
    const resolve = active.permissions.get(toolCallId);
    if (!resolve) return;
    active.permissions.delete(toolCallId);
    active.mapper.confirmed(toolCallId, answer.approved);
    resolve(active.mapper.permissionOutcome(toolCallId, answer.approved, answer.selectedOptionId));
  }

  // ───────────────────────────── lifecycle: slots, start, suspend ─────────────────────────────

  private newLive(session: string, chat: string, info: ConversationInfo): Live {
    return {
      session,
      chat,
      info,
      conn: undefined,
      acpSessionId: undefined,
      caps: {},
      modeViaModes: false,
      agentValues: {},
      holdsSlot: false,
      lastActive: this.now(),
      run: undefined,
      needsBrief: true,
      replaying: false,
      created: false,
      starting: undefined,
      opening: false,
      deferred: false,
      brainPending: [],
    };
  }

  private infoFromMeta(meta: Json, provider: string, workingDir: string | undefined): ConversationInfo {
    const id = String(meta["iinc.conversation"] ?? "");
    const employeeId = String(meta["iinc.employee"] ?? "");
    const engine = this.o.engine(provider);
    if (!id || !employeeId) throw new Error("this session is not a conversation");
    if (!engine) throw new Error(`no engine ${provider}`);
    const cwd = (workingDir && fileUriPath(workingDir)) || `/home/employee/work/conv-${id}`;
    if (!isSafeWorkDir(cwd)) throw new Error(`not a safe working directory: ${cwd}`);
    const branch = typeof meta["iinc.branch"] === "string" ? meta["iinc.branch"] : null;
    if (branch !== null && !isSafeRefName(branch)) throw new Error(`not a branch name: ${branch}`);
    return {
      id,
      employeeId,
      project: typeof meta["iinc.project"] === "string" ? meta["iinc.project"] : null,
      branch,
      cwd,
      engine,
      team: this.o.teamOf(employeeId),
    };
  }

  /** After a daemon restart nothing is live: rebuild what is needed from the session's state. */
  private adopt(session: string): Live | undefined {
    const s = this.h.sessionState(session);
    if (!s?.defaultChat) return undefined;
    try {
      const info = this.infoFromMeta((s._meta ?? {}) as Json, s.provider, s.workingDirectories?.[0]);
      const live = this.newLive(session, s.defaultChat, info);
      live.created = true;
      const known = this.h.channelMeta(s.defaultChat).acpSessionId;
      live.acpSessionId = typeof known === "string" ? known : undefined;
      this.lives.set(session, live);
      return live;
    } catch (e) {
      this.log(`can't adopt ${session}: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  private liveInTeam(team: string): Live[] {
    return [...this.lives.values()].filter((l) => l.holdsSlot && l.info.team === team);
  }

  /** The conversations nobody is waiting on: no turn running, no question open, not starting. */
  private idle(l: Live): boolean {
    // A turn the host has recorded counts even before the agent has been sent it.
    return !!l.conn && !l.run && !l.starting && !l.opening && !this.h.hasActiveTurn(l.chat);
  }

  /**
   * Takes one of the team's slots. A full team first gives up its least recently used idle
   * conversation (it wakes again when its owner writes); if all are busy the caller waits, or, for
   * `wait: false`, is told no.
   */
  private async acquire(
    live: Live,
    o: { wait: boolean; onWait?: (reason: string) => void; signal?: AbortSignal | undefined },
  ): Promise<void> {
    const team = live.info.team;
    let told = false;
    for (;;) {
      if (live.holdsSlot) return;
      const running = this.liveInTeam(team);
      if (running.length < this.cap) {
        live.holdsSlot = true;
        return;
      }
      const victim = running
        .filter((l) => l !== live && this.idle(l))
        .sort((a, b) => a.lastActive - b.lastActive)[0];
      if (victim) {
        this.suspend(victim, "making room for another conversation");
        continue;
      }
      const reason = `Waiting for a free slot: ${running.length} of ${this.cap} conversations are running in the ${team} sandbox.`;
      if (!o.wait) throw new NoSlotError(reason);
      if (!told) {
        told = true;
        o.onWait?.(reason);
      }
      await new Promise<void>((resolve) => {
        const w: Waiter = { team, wake: resolve };
        this.waiters.push(w);
        // A turn cancelled while it waits leaves the queue.
        o.signal?.addEventListener(
          "abort",
          () => {
            const i = this.waiters.indexOf(w);
            if (i >= 0) this.waiters.splice(i, 1);
            resolve();
          },
          { once: true },
        );
      });
      if (o.signal?.aborted) throw new Error("cancelled while waiting for a slot");
    }
  }

  /** Tells the team's waiters to look again (each takes a slot or goes back to waiting). */
  private wake(team?: string): void {
    if (this.dropWakeups) return;
    this.wakeNow(team);
  }
  private wakeNow(team?: string): void {
    for (const w of this.waiters.filter((x) => team === undefined || x.team === team)) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.wake();
    }
  }
  private dropWakeups = false;
  /** Test hook: lose every wake-up, so only the sweep's can be seen to work. */
  testDropWakeups(): void {
    this.dropWakeups = true;
  }

  private release(live: Live): void {
    if (!live.holdsSlot) return;
    live.holdsSlot = false;
    this.wake(live.info.team);
  }

  /** Stops the agent process but keeps the conversation: it starts again, with its memory, on the next message. */
  private suspend(live: Live, why: string): void {
    // The conversation is going quiet: what the agent wrote in its brain copy is collected now.
    if (why !== "its employee left") this.collect(live.info, "idle");
    const conn = live.conn;
    live.conn = undefined; // before the kill: its exit is expected, not a crash
    this.release(live);
    if (conn && !conn.exited) {
      this.log(`suspending ${live.session} (${why})`);
      conn.close(1000);
    }
  }

  /** Forgets a conversation's agent for good. */
  private discard(live: Live): void {
    this.collect(live.info, "end");
    const conn = live.conn;
    live.conn = undefined;
    if (live.run) {
      for (const resolve of live.run.permissions.values()) resolve({ outcome: "cancelled" });
    }
    this.release(live);
    this.lives.delete(live.session);
    conn?.kill();
  }

  /** Collects the conversation's brain copy in the background. */
  private collect(info: ConversationInfo, why: "idle" | "end" | "remember"): void {
    try {
      void this.o
        .harvest?.(info, why)
        ?.catch((e) => this.log(`couldn't collect the brain copy: ${String(e)}`));
    } catch (e) {
      this.log(`couldn't collect the brain copy: ${String(e)}`);
    }
  }

  /** Suspends the idle and archived conversations. Call it from a timer. */
  sweep(): void {
    const t = this.now();
    // Whatever happened since the last look, a waiter should see it.
    this.wakeNow();
    for (const live of [...this.lives.values()]) {
      if (!this.idle(live)) continue;
      const archived = ((this.h.sessionState(live.session)?.status ?? 0) & SessionStatus.IsArchived) !== 0;
      if (this.o.employeeKnown && !this.o.employeeKnown(live.info.employeeId))
        this.suspend(live, "its employee left");
      else if (archived) this.suspend(live, "archived");
      else if (t - live.lastActive >= this.idleMs) this.suspend(live, "idle");
    }
  }

  start(everyMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const live of [...this.lives.values()]) {
      live.conn?.kill();
      live.conn = undefined;
    }
  }

  /**
   * The daemon is going down (SIGTERM, a deploy): end every agent politely, then not. A running turn
   * gets `session/cancel`, then each agent's stdin is closed; whatever is still there after `graceMs`
   * is killed. The caller then sweeps the sandboxes for anything that ignored both (`reapMachines`: the
   * `container` client dying does not stop the process in the machine). Conversations are kept: they start
   * again on the next message.
   */
  async shutdown(graceMs = 2500): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.shuttingDown = true;
    const conns: AcpConnection[] = [];
    for (const live of this.lives.values()) {
      const conn = live.conn;
      live.conn = undefined;
      this.release(live);
      if (!conn || conn.exited) continue;
      if (live.run && live.acpSessionId) conn.notify("session/cancel", { sessionId: live.acpSessionId });
      conns.push(conn);
    }
    for (const c of conns) c.close(graceMs);
    await Promise.race([
      Promise.all(conns.map((c) => c.waitExit())),
      new Promise<void>((r) => setTimeout(r, graceMs + 200).unref?.()),
    ]);
    for (const c of conns) c.kill();
  }
  private shuttingDown = false;

  /** What the cap is doing, for a status view and the tests. */
  status(): { session: string; team: string; live: boolean; busy: boolean }[] {
    return [...this.lives.values()].map((l) => ({
      session: l.session,
      team: l.info.team,
      live: !!l.conn && !l.conn.exited,
      busy: !!l.run,
    }));
  }

  // ───────────────────────────── starting and resuming an agent ─────────────────────────────

  /** Makes sure the conversation has a running agent with its session open; waits for a slot if it must. */
  private async ensureRunning(live: Live, run: TurnRun): Promise<void> {
    if (live.conn && !live.conn.exited) return;
    if (live.starting) return live.starting;
    live.starting = (async () => {
      await this.untilCleanupDone(live, (reason) => this.announce(run, reason));
      if (run.signal.aborted) throw new Error("cancelled while the sandbox was cleaned");
      let waited = false;
      await this.acquire(live, {
        wait: true,
        signal: run.signal,
        onWait: (reason) => {
          waited = true;
          this.announce(run, reason);
        },
      });
      if (waited) this.announce(run, undefined);
      try {
        if (run.signal.aborted) throw new Error("cancelled before the agent started");
        await this.bootSandbox(live, run);
        if (run.signal.aborted) throw new Error("cancelled while the sandbox started");
        const copy = await this.o.workingCopy(live.info);
        // Cancelled while the working copy was made: no agent, no slot.
        if (run.signal.aborted) throw new Error("cancelled before the agent started");
        // A conversation that comes back after its copy was cleaned up says what became of the copy.
        const earlier = this.h.chatState(live.chat)?.turns.length ?? 0;
        if (copy && copy !== "existing" && earlier > 0) this.note(run, copyNote(live.info, copy));
        // No agent session yet and no history (made while the sandbox was cleaned): a first start,
        // with the mode the owner asked for.
        const first = !live.acpSessionId && earlier === 0;
        const mode = this.h.sessionState(live.session)?.config?.values.mode;
        await this.launchSession(live, first ? { fresh: true, mode } : { fresh: false });
        if (run.signal.aborted) throw new Error("cancelled while the agent started");
      } catch (e) {
        this.kill(live);
        throw e;
      }
    })().finally(() => {
      live.starting = undefined;
    });
    return live.starting;
  }

  /**
   * Boots the employee's machine before anything is run in it (the working copy, the agent): a stopped
   * machine is refused by the sandbox guard, and tickets boot theirs first too. Says so in the chat when it
   * has to start it.
   */
  private async bootSandbox(live: Live, run: TurnRun): Promise<void> {
    const gate = this.app;
    if (!gate?.ensureUp) return;
    const id = live.info.employeeId;
    const stopped = gate.sandboxUp ? !gate.sandboxUp(id) : false;
    if (stopped) {
      this.announce(run, `Starting ${this.o.sandboxLabel?.(id) ?? `the ${live.info.team} sandbox`}…`);
    }
    try {
      await gate.ensureUp(id);
    } finally {
      if (stopped) this.announce(run, undefined);
    }
  }

  private kill(live: Live): void {
    const conn = live.conn;
    live.conn = undefined;
    this.release(live);
    conn?.kill();
  }

  /** A line in the chat, from the host. */
  private note(run: TurnRun, text: string): void {
    run.emit({
      type: ActionType.ChatResponsePart,
      turnId: run.turnId,
      part: { kind: ResponsePartKind.SystemNotification, content: text },
    });
  }

  /** The reason a turn is waiting, in the chat where the owner is looking. */
  private announce(run: TurnRun, reason: string | undefined): void {
    run.emit({ type: ActionType.ChatActivityChanged, ...(reason ? { activity: reason } : {}) });
    if (reason) {
      run.emit({
        type: ActionType.ChatResponsePart,
        turnId: run.turnId,
        part: { kind: ResponsePartKind.SystemNotification, content: reason },
      });
    }
  }

  /**
   * Starts the agent process and opens its session: a new one, or, for a conversation that has one,
   * `session/load` where the adapter has it. Without it the agent starts blank and the next prompt
   * carries a brief of the conversation so far.
   */
  private async launchSession(live: Live, o: { fresh: boolean; mode?: unknown }): Promise<Json> {
    const { info } = live;
    if (this.shuttingDown) throw new Error("the daemon is stopping");
    const env = await this.o.credentials(info.engine, info);
    // An agent a dead daemon left for this conversation would work in the same folder as the new one.
    await this.o.reap?.(info.employeeId, { cwd: info.cwd });
    const proc = await this.o.launch({
      employeeId: info.employeeId,
      engine: info.engine,
      cwd: info.cwd,
      env,
    });
    this.app?.awake(info.employeeId);
    const conn = new AcpConnection(proc, this.o.log);
    live.conn = conn;
    conn.onNotification = (method, params) => this.onNotification(live, conn, method, params);
    conn.onRequest = (method, params) => this.onAgentRequest(live, conn, method, params);
    conn.onExit = (code) => this.onExit(live, conn, code);
    const timeout = this.o.startTimeoutMs ?? 120_000;

    const init = await conn.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "i.inc", version: "0.1.0" },
      },
      timeout,
    );
    if (init.error)
      throw new Error(`the ${info.engine.harness} ACP server didn't start: ${upstreamReason(init.error)}`);
    live.caps = (init.result?.agentCapabilities ?? {}) as Json;

    let opened: Json | undefined;
    if (!o.fresh && live.acpSessionId && live.caps.loadSession) {
      live.replaying = true;
      const loaded = await conn.request(
        "session/load",
        { sessionId: live.acpSessionId, cwd: info.cwd, mcpServers: [] },
        timeout,
      );
      live.replaying = false;
      if (loaded.error)
        this.log(`session/load failed for ${live.session}: ${upstreamReason(loaded.error)}; starting afresh`);
      else {
        opened = loaded.result ?? {};
        live.needsBrief = false;
      }
    }
    if (!opened) {
      const created = await conn.request("session/new", { cwd: info.cwd, mcpServers: [] }, timeout);
      if (created.error) {
        // "Authentication required": sign-ins need the owner (spec §5).
        if ((created.error as Json).code === -32000) {
          throw new Error(`${info.engine.harness} needs a sign-in in the ${info.team} sandbox`);
        }
        throw new Error(`${info.engine.harness} couldn't open a session: ${upstreamReason(created.error)}`);
      }
      opened = created.result ?? {};
      live.acpSessionId = String(opened.sessionId);
      live.needsBrief = !o.fresh; // a conversation with history but a blank agent
      if (live.created) this.h.setChannelMeta(live.chat, { acpSessionId: live.acpSessionId });
    }
    const settled = await this.settle(live, conn, opened, o.mode, o.fresh);
    // Resumed: put the owner's choices (mode, model) back on the agent.
    if (!o.fresh) await this.resync(live, conn, settled);
    return settled;
  }

  /** The defaults for a new session (the bypass mode, Codex's model and effort) and what the agent reports. */
  private async settle(
    live: Live,
    conn: AcpConnection,
    opened: Json,
    wantedMode: unknown,
    fresh: boolean,
  ): Promise<Json> {
    const { info } = live;
    const sessionId = String(live.acpSessionId);
    let modes = opened.modes as Json | undefined;
    let options = Array.isArray(opened.configOptions) ? (opened.configOptions as Json[]) : [];
    live.modeViaModes = !!(modes?.availableModes as unknown[] | undefined)?.length;
    if (info.engine.harness === "codex" && fresh) {
      const select = async (
        category: string,
        ids: string[],
        label: string,
        desired: (c: { value: string; name: string }[]) => string | undefined,
      ) => {
        const cfg = options.find(
          (x) => ids.includes(String(x.id ?? x.configId ?? "")) || x.category === category,
        );
        if (!cfg) throw new Error(`Codex ACP didn't offer a ${label} option`);
        const value = desired(configChoices(cfg));
        if (!value) throw new Error(`Codex ACP doesn't offer the configured ${label}`);
        if (cfg.currentValue === value) return;
        const r = await conn.request("session/set_config_option", {
          sessionId,
          configId: String(cfg.id ?? cfg.configId),
          value,
        });
        if (r.error) throw new Error(`Codex ACP couldn't select ${label}: ${upstreamReason(r.error)}`);
        if (Array.isArray(r.result?.configOptions)) options = r.result?.configOptions as Json[];
      };
      // The model first: it can change which reasoning levels are offered.
      await select(
        "model",
        ["model"],
        `model ${info.engine.model}`,
        (cs) =>
          cs.find(
            (c) => c.value === info.engine.model || c.name.toLowerCase() === info.engine.model.toLowerCase(),
          )?.value,
      );
      const effort = this.o.effort?.(info.employeeId) ?? "medium";
      await select(
        "thought_level",
        ["reasoning_effort"],
        `${effort} reasoning effort`,
        (cs) => cs.find((c) => c.value === effort)?.value,
      );
      await select("mode", ["mode"], "mode", (cs) =>
        typeof wantedMode === "string" && cs.some((c) => c.value === wantedMode)
          ? wantedMode
          : cs.find((c) => bypassMode.test(c.value))?.value,
      );
    } else if (modes && live.modeViaModes && fresh) {
      // The default is the agent's own bypass-permissions mode (the owner's decision), unless one was asked for.
      const ids = ((modes.availableModes as Json[]) ?? []).map((m) => String(m.id));
      const want =
        typeof wantedMode === "string" && ids.includes(wantedMode)
          ? wantedMode
          : ids.find((m) => bypassMode.test(m));
      if (want && want !== modes.currentModeId) {
        const r = await conn.request("session/set_mode", { sessionId, modeId: want });
        if (r.error) throw new Error(`couldn't switch to ${want}: ${upstreamReason(r.error)}`);
        modes = { ...modes, currentModeId: want };
      }
    }
    const result: Json = { ...opened, ...(modes ? { modes } : {}), configOptions: options };
    // Remember what the agent has now.
    const cfg = configFromAcp(modes, options);
    live.agentValues = { ...cfg.values };
    return result;
  }

  /** After a resume: the session's config values are what the owner chose; make the agent match. */
  private async resync(live: Live, conn: AcpConnection, opened: Json): Promise<void> {
    const want = this.h.sessionState(live.session)?.config?.values ?? {};
    const have = configFromAcp(
      opened.modes as Json | undefined,
      opened.configOptions as Json[] | undefined,
    ).values;
    for (const [k, v] of Object.entries(want)) {
      if (have[k] === v || !live.acpSessionId) continue;
      const r = await this.pushConfig(live, conn, live.acpSessionId, k, v);
      if (r.error)
        this.log(`couldn't restore ${k}=${String(v)} on ${live.session}: ${upstreamReason(r.error)}`);
      else live.agentValues[k] = v;
    }
  }

  private pushConfig(
    live: Live,
    conn: AcpConnection,
    sessionId: string,
    key: string,
    value: unknown,
  ): Promise<RpcReply> {
    return key === "mode" && live.modeViaModes
      ? conn.request("session/set_mode", { sessionId, modeId: value }, 30_000)
      : conn.request("session/set_config_option", { sessionId, configId: key, value }, 30_000);
  }

  /** A conversation resumed on a blank agent: what was said, short enough to put at the top of a prompt. */
  private continuationBrief(live: Live, next: Message): string {
    const chat = this.h.chatState(live.chat);
    const parts: string[] = [
      "You are resuming a conversation with the owner. Your memory of it was lost when your session ended; the files in your working copy are as you left them.",
      "Here is how it went so far, most recent last (long messages are cut):",
    ];
    const turns = (chat?.turns ?? []).slice(-6);
    const said = (t: ChatState["turns"][number]) => {
      const text = t.responseParts
        .map((p) =>
          p.kind === ResponsePartKind.Markdown
            ? p.content
            : p.kind === ResponsePartKind.ToolCall
              ? `[${p.toolCall.displayName}]`
              : "",
        )
        .filter(Boolean)
        .join(" ");
      const safe = redactText(text);
      return safe.length > 1200 ? `${safe.slice(0, 1200)}…` : safe;
    };
    for (const t of turns) {
      const text = redactText(t.message.text);
      const user = text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
      parts.push(`Owner: ${user}`, `You: ${said(t) || "(no reply)"}`);
    }
    parts.push("", "The owner's new message:", next.text);
    return parts.join("\n");
  }

  // ───────────────────────────── what the agent says ─────────────────────────────

  private onNotification(live: Live, conn: AcpConnection, method: string, params: Json): void {
    if (conn !== live.conn || method !== "session/update") return;
    if (params.sessionId !== undefined && params.sessionId !== live.acpSessionId && live.acpSessionId) return;
    const u = (params.update ?? {}) as Json;
    if (live.replaying) return; // session/load replays history, limits included: the host already has it
    // Claude's usage windows ride along on any update.
    const rl = ((u._meta ?? {}) as Json)["_claude/rateLimit"] as Json | undefined;
    if (rl) this.recordLimit(live, rl);
    // A tool call that names a file in this employee's brain copy is a read of that page.
    if (
      live.run &&
      this.o.brain?.enabled &&
      (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
    ) {
      const paths = locationPaths(u.locations);
      if (paths.length) {
        try {
          const added = this.o.brain.noteRead(live.info.employeeId, paths, {
            kind: "turn",
            conversation: live.info.id,
            turn: live.run.turn.turnId,
          });
          if (added.length) this.publishBrain(live);
        } catch (e) {
          this.log(`couldn't note a brain read: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    if (u.sessionUpdate === "tool_call" && fetchesFromOutside(u)) {
      try {
        this.o.external?.(live.info, "a web fetch");
      } catch (e) {
        this.log(`couldn't note an outside fetch: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (live.run) live.run.mapper.update(u);
    else if (
      [
        "current_mode_update",
        "config_option_update",
        "available_commands_update",
        "session_info_update",
      ].includes(String(u.sessionUpdate))
    ) {
      this.onSide(live, String(u.sessionUpdate), u);
    }
    // anything else outside a turn is a late update: dropped
  }

  private recordLimit(live: Live, rl: Json): void {
    const report = usageReport(live.info.engine.accountId, rl);
    this.o.onUsage?.(report);
    this.o.onRateLimit?.(live.info.engine.accountId, extractRateLimit(rl, this.now()));
  }

  /** Modes, config, commands, usage and what we don't know: the parts of an update that are not a chat action. */
  private onSide(live: Live, kind: string, u: Json): void {
    const session = this.h.sessionState(live.session);
    if (kind === "usage") {
      if (live.run) live.run.usage = { contextUsed: u.used, contextSize: u.size };
      return;
    }
    // While we start or resume the agent we are the ones changing its modes: its echoes are not news.
    if (!session || !live.created || live.starting) return;
    if (kind === "current_mode_update") {
      const id = String(u.currentModeId);
      live.agentValues.mode = id;
      if (session.config?.values.mode !== id && session.config?.schema.properties.mode) {
        this.h.emit(live.session, { type: ActionType.SessionConfigChanged, config: { mode: id } });
      }
    } else if (kind === "config_option_update") {
      const values: Json = {};
      for (const o of (u.configOptions ?? []) as Json[]) {
        if (o.type !== "select" || typeof o.id !== "string") continue;
        live.agentValues[o.id] = o.currentValue;
        if (session.config?.schema.properties[o.id] && session.config.values[o.id] !== o.currentValue)
          values[o.id] = o.currentValue;
      }
      if (Object.keys(values).length)
        this.h.emit(live.session, { type: ActionType.SessionConfigChanged, config: values });
    } else if (kind === "available_commands_update") {
      // AHP has no slash-command list: it lives in the session's _meta and is served by `completions`.
      const commands = (u.availableCommands ?? []) as Json[];
      const mine = commands.map((c) => ({ name: c.name, description: c.description, input: c.input }));
      if (JSON.stringify(session._meta?.["iinc.commands"]) !== JSON.stringify(mine)) {
        this.h.emit(live.session, {
          type: ActionType.SessionMetaChanged,
          _meta: { ...(session._meta ?? {}), "iinc.commands": mine },
        });
      }
    } else if (kind === "session_info_update") {
      // The agent's own title for the conversation, unless the owner (or the first message) named it.
      const title = typeof u.title === "string" ? u.title.trim().slice(0, 200) : "";
      const first = this.h.chatState(live.chat)?.turns[0]?.message.text.trim().split("\n")[0]?.slice(0, 60);
      const unnamed = session.title === DEFAULT_TITLE || (first !== undefined && session.title === first);
      if (title && unnamed && title !== session.title) {
        this.h.emit(live.session, { type: ActionType.SessionTitleChanged, title });
      }
    } else if (kind.startsWith("unknown:") || kind.startsWith("dropped:")) {
      if (!this.warned.has(kind)) {
        this.warned.add(kind);
        this.log(`ignoring ${kind} from ${live.info.engine.harness}`);
      }
    }
  }

  private onAgentRequest(live: Live, conn: AcpConnection, method: string, params: Json): Promise<unknown> {
    if (conn !== live.conn) return Promise.reject(new Error("stale connection"));
    if (method !== "session/request_permission") return Promise.reject(new Error(`not offered: ${method}`));
    const active = live.run;
    if (!active || active.cancelled) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const call = (params.toolCall ?? {}) as Json;
    const id = String(call.toolCallId);
    return new Promise((resolve) => {
      // The same id asked again replaces the first request, which is answered `cancelled`, not orphaned.
      active.permissions.get(id)?.({ outcome: "cancelled" });
      active.permissions.set(id, (outcome) => resolve({ outcome }));
      active.mapper.permission(params);
    });
  }

  /** The agent process ended. During a turn the pending prompt has already settled with an error. */
  private onExit(live: Live, conn: AcpConnection, code: number | null): void {
    if (live.conn !== conn) return; // suspended or replaced: expected
    this.log(`the agent of ${live.session} exited (${code ?? "killed"})`);
    live.conn = undefined;
    this.release(live);
    if (live.run) for (const resolve of live.run.permissions.values()) resolve({ outcome: "cancelled" });
  }

  // ───────────────────────────── how a turn ended ─────────────────────────────

  private outcome(live: Live, active: ActiveRun, done: RpcReply): TurnOutcome {
    const { turn } = active;
    const text = String(done.error?.message ?? "");
    if (active.cancelled || turn.signal.aborted) return { kind: "cancelled" };
    if (done.error) {
      if (done.error.code === EXITED && this.shuttingDown) {
        return {
          kind: "error",
          errorType: "host_restarted",
          message: "The daemon restarted while this turn was running. Send a message to carry on.",
        };
      }
      if (done.error.code === EXITED) {
        return {
          kind: "error",
          errorType: "agent_exited",
          message: `The agent stopped unexpectedly (${text}). Send a message to start it again.`,
        };
      }
      if (done.error.code === TIMED_OUT) return { kind: "error", errorType: "agent_timeout", message: text };
      if (limitError.test(text)) {
        const resetsAt = resetFromText(text, this.now());
        this.o.onRateLimit?.(live.info.engine.accountId, {
          status: "rejected",
          ...(resetsAt ? { resetsAt } : {}),
          updatedAt: this.now(),
        });
        return {
          kind: "error",
          errorType: "rate_limited",
          // The agent's own words name a time in UTC: when the reset is known it goes in `resetsAt`, and the app
          // words it in the owner's time zone.
          message: resetsAt
            ? upstreamReason(done.error)
                .replace(/\s*[·.,;-]?\s*resets\b.*$/i, "")
                .trim()
            : upstreamReason(done.error),
          ...(resetsAt ? { resetsAt } : {}),
        };
      }
      if (done.error.code === -32000 || /authentication required|sign.?in/i.test(text)) {
        return {
          kind: "error",
          errorType: "needs_sign_in",
          message: `${live.info.engine.harness} needs a sign-in in the ${live.info.team} sandbox.`,
        };
      }
      return { kind: "error", errorType: "agent_error", message: upstreamReason(done.error) };
    }
    const result = (done.result ?? {}) as Json;
    const usage = (result._meta as Json | undefined)?.usage as Json | undefined;
    if (usage || active.usage) {
      turn.emit({
        type: ActionType.ChatUsage,
        turnId: turn.turnId,
        usage: {
          ...(typeof usage?.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
          ...(typeof usage?.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
          ...(typeof usage?.cachedReadTokens === "number" ? { cacheReadTokens: usage.cachedReadTokens } : {}),
          model: live.info.engine.model,
          ...(active.usage ? { _meta: active.usage } : {}),
        },
      });
    }
    const stop = String(result.stopReason ?? "end_turn");
    if (stop === "cancelled") return { kind: "cancelled" };
    if (stop === "end_turn") {
      active.mapper.finish();
      return { kind: "complete" };
    }
    // max_tokens, max_turn_requests, refusal: the turn did not finish what it set out to do.
    return {
      kind: "error",
      errorType: stop,
      message: `The agent stopped early (${stop}). Send a message to carry on.`,
    };
  }

  private startFailure(e: unknown): TurnOutcome {
    const message = e instanceof Error ? e.message : String(e);
    const needsSignIn = /needs a sign-in|Authentication required/i.test(message);
    return {
      kind: "error",
      errorType: needsSignIn ? "needs_sign_in" : e instanceof NoSlotError ? "no_slot" : "agent_start_failed",
      message: `The agent could not start: ${message}`,
    };
  }
}
