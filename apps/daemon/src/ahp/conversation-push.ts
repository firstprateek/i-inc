// Push notifications for conversations (T65, docs/design/conversations.md "Permission modes"): when an
// agent in a conversation needs the owner and nobody is looking, the owner's phone gets a push that opens
// the card.
//
// It listens to the host (AhpHost.observe) for the session's "Needs you" list (`session/inputNeededSet` and
// `Removed`: a tool waiting for a yes or no, or a question) and for the ends of turns. Then:
//   - a request that appears waits a grace period (about 20 s). Answered within it, nothing is sent, so
//     answering at the laptop never buzzes the phone;
//   - at the end of the grace, if a client that reported itself looking (page visible and focused, with a
//     heartbeat) is on that conversation, it looks again every few seconds instead, until the request is
//     answered or somebody leaves it;
//   - one push per request, ever (the key is kept in `push_sent`, like the ticket pushes);
//   - the push says "<Employee> needs you", a short redacted label of what it wants to do, and a link that
//     carries only ids. One tag per conversation, so a newer request replaces the older notification;
//   - when the request is answered (on any device), or the turn ends, a "resolve" push with the same tag
//     tells the service worker to close the notification.
// Optional and off by default: a turn the owner started that ran a minute or more and finished while nobody
// was looking.
// The owner's choices are the `notify` settings (`GET/PUT /api/push/settings`), read when it matters.
import type { Id } from "@i-inc/core";
import type { Db } from "../db.ts";
import { type NotificationPayload, notifySettings, type PushService } from "../push.ts";
import type { Registry } from "../registry.ts";
import type { Conversation, ConversationService } from "./conversations.ts";
import type { AhpHost } from "./host.ts";
import { redactText } from "./sanitize.ts";
import {
  ActionType,
  type Json,
  SessionInputRequestKind,
  type SessionState,
  type StateAction,
} from "./wire.ts";

export interface ConversationPushOptions {
  host: AhpHost;
  conversations: ConversationService;
  registry: Registry;
  db: Db;
  push: PushService | undefined;
  now: () => number;
  log?: (message: string) => void;
  /** How long a new request waits before it may be pushed (ms). Default 20 s. */
  graceMs?: number;
  /** While a client is looking at the conversation, how often to look again (ms). Default 10 s. */
  recheckMs?: number;
  /** A turn must run this long to count as a long reply (ms). Default 60 s. */
  longTurnMs?: number;
  /** A request still unanswered after this long is not pushed any more (ms). Default 24 h. */
  maxWaitMs?: number;
  /** Runs `fn` after `ms`; returns the way to cancel. Replaceable, so tests run on their own clock. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/** The longest a notification body is. */
export const BODY_MAX = 120;

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

interface Pending {
  /** The session's `inputNeeded` id. */
  key: string;
  session: string;
  conversation: Conversation;
  /** The id the link carries: a tool call's id or a question request's id. */
  card: string;
  turnId: string | undefined;
  label: string;
  since: number;
  cancel: (() => void) | undefined;
  /** Whether the push for it went out (so that answering it closes the notification). */
  sent: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Text of a string-or-markdown field (`{ markdown }`). */
const text = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" ? str((v as Json).markdown) : "";

/** One short line, no markup, no secrets, and no working-copy path. */
export function oneLine(raw: string, max = BODY_MAX): string {
  let t = raw
    // a working copy's path is noise on a phone: show the path inside the project
    .replace(/\/home\/employee\/work\/conv-[0-9a-f]{8}\/?/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  t = redactText(t).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * What a request wants, for the notification body: "Run: pnpm test", "Edit src/app.ts", or the question
 * asked. It uses only the call's own short title; never its input, its diff or any file contents.
 */
export function describeRequest(request: Json): string {
  if (request.kind === SessionInputRequestKind.ToolConfirmation) {
    const call = (request.toolCall ?? {}) as Json;
    const title = oneLine(
      text(call.confirmationTitle) || text(call.invocationMessage) || str(call.displayName),
      400,
    );
    if (!title) return "Wants to use a tool";
    // the agent's kind of tool: a command is shown as "Run: <command>"
    const run = /^(?:run|bash|execute)\b\s*:?\s*(.*)$/i.exec(title);
    if (run) return oneLine(`Run: ${run[1] ?? ""}`);
    return oneLine(call.toolName === "execute" ? `Run: ${title}` : title);
  }
  const req = (request.request ?? {}) as Json;
  const first = Array.isArray(req.questions) ? ((req.questions[0] ?? {}) as Json) : {};
  const ask = oneLine(str(req.message) || str(first.message) || str(first.title), 400);
  return ask ? oneLine(`Asks: ${ask}`) : "Has a question for you";
}

export class ConversationPush {
  private readonly pending = new Map<string, Pending>();
  /** When each chat's running turn began (ms). */
  private readonly turnStart = new Map<string, number>();
  /** Per conversation, the sends so far: a resolve never overtakes the push it closes. */
  private readonly chain = new Map<string, Promise<void>>();
  private readonly stop: () => void;
  private readonly graceMs: number;
  private readonly recheckMs: number;
  private readonly longTurnMs: number;
  private readonly maxWaitMs: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly o: ConversationPushOptions) {
    this.graceMs = o.graceMs ?? 20_000;
    this.recheckMs = o.recheckMs ?? 10_000;
    this.longTurnMs = o.longTurnMs ?? 60_000;
    this.maxWaitMs = o.maxWaitMs ?? 86_400_000;
    this.schedule = o.schedule ?? defaultSchedule;
    this.stop = o.host.observe((channel, action) => this.onAction(channel, action));
    this.prune();
  }

  /** Stops listening and drops every wait. */
  close(): void {
    this.stop();
    for (const p of this.pending.values()) p.cancel?.();
    this.pending.clear();
    this.turnStart.clear();
  }

  /** Requests waiting for their grace to pass (tests, and the storage report). */
  get waiting(): number {
    return this.pending.size;
  }

  /** The dedupe keys of old pushes are not needed for long. */
  private prune(): void {
    try {
      this.o.db.run(
        "DELETE FROM push_sent WHERE key LIKE 'convpush:%' AND at < ?",
        this.o.now() - 7 * 86_400_000,
      );
    } catch {
      // the table is the ticket pushes'; if it isn't there yet there is nothing to prune
    }
  }

  private onAction(channel: string, action: StateAction): void {
    switch (action.type) {
      case ActionType.SessionInputNeededSet:
        this.track(channel, action.request as unknown as Json);
        return;
      case ActionType.SessionInputNeededRemoved:
        this.untrack(channel, action.id);
        return;
      case ActionType.SessionIsArchivedChanged:
        if (action.isArchived) this.endAll(channel);
        return;
      case ActionType.ChatTurnStarted:
        this.turnStart.set(channel, this.o.now());
        return;
      case ActionType.ChatTurnComplete:
        this.turnEnded(channel, "complete");
        return;
      case ActionType.ChatTurnCancelled:
      case ActionType.ChatError:
        this.turnEnded(channel, "other");
        return;
    }
  }

  // ───────────────────────────── a request appears ─────────────────────────────

  private track(session: string, request: Json): void {
    const key = str(request.id);
    if (!key || this.pending.has(key)) return;
    const tool = request.kind === SessionInputRequestKind.ToolConfirmation;
    const q = (request.request ?? {}) as Json;
    const call = (request.toolCall ?? {}) as Json;
    if (!tool && request.kind !== SessionInputRequestKind.ChatInput) return;
    const card = tool ? str(call.toolCallId) : str(q.id);
    const conversation = this.o.conversations.bySession(session);
    if (!card || !conversation || conversation.archivedAt !== null) return;
    const p: Pending = {
      key,
      session,
      conversation,
      card,
      turnId: tool ? str(request.turnId) || undefined : undefined,
      label: describeRequest(request),
      since: this.o.now(),
      cancel: undefined,
      sent: false,
    };
    this.pending.set(key, p);
    p.cancel = this.schedule(() => this.fire(p), this.graceMs);
  }

  /** The grace is over (or a look at the conversation is). Push, wait some more, or let it go. */
  private fire(p: Pending): void {
    p.cancel = undefined;
    if (this.pending.get(p.key) !== p) return;
    const settings = notifySettings(this.o.registry.settings().notify);
    // Turned off, or too old to matter: this request gets no push.
    if (!settings.conversationsNeedMe || this.o.now() - p.since > this.maxWaitMs) return;
    // Gone while it waited (archived, session disposed): nothing to open.
    const now = this.o.conversations.bySession(p.session);
    if (!this.o.host.sessionState(p.session) || !now || now.archivedAt !== null) {
      this.pending.delete(p.key);
      return;
    }
    if (this.o.host.isWatched(p.session)) {
      p.cancel = this.schedule(() => this.fire(p), this.recheckMs);
      return;
    }
    const key = `convpush:${p.key}:${p.turnId ?? ""}`;
    const res = this.o.db.run(
      "INSERT INTO push_sent (key, at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
      key,
      this.o.now(),
    );
    if ((res?.changes ?? 0) === 0) return; // pushed before (the daemon restarted with it still waiting)
    p.sent = true;
    this.send(p.conversation, {
      title: `${this.who(p.conversation)} needs you`,
      body: p.label,
      url: `#/conversations/${p.conversation.id}?card=${encodeURIComponent(p.card)}`,
      tag: tagOf(p.conversation),
    });
  }

  // ───────────────────────────── it is answered, or the turn ends ─────────────────────────────

  private untrack(session: string, key: string): void {
    const p = this.pending.get(key);
    if (!p || p.session !== session) return;
    this.pending.delete(key);
    p.cancel?.();
    p.cancel = undefined;
    if (!p.sent) return;
    // Another request of the same conversation is still showing: its notification stays.
    for (const other of this.pending.values()) {
      if (other.sent && other.conversation.id === p.conversation.id) return;
    }
    this.resolve(p.conversation);
  }

  private endAll(session: string): void {
    for (const [key, p] of [...this.pending]) if (p.session === session) this.untrack(session, key);
  }

  private turnEnded(chat: string, how: "complete" | "other"): void {
    const startedAt = this.turnStart.get(chat);
    this.turnStart.delete(chat);
    const session = this.o.host.sessionOfChat(chat);
    if (!session) return;
    this.endAll(session);
    if (how !== "complete" || startedAt === undefined) return;
    if (this.o.now() - startedAt < this.longTurnMs) return;
    if (!notifySettings(this.o.registry.settings().notify).longReplyFinished) return;
    if (this.o.host.isWatched(session)) return;
    const conversation = this.o.conversations.bySession(session);
    if (!conversation || conversation.archivedAt !== null) return;
    const title =
      (this.o.host.sessionState(session) as SessionState | undefined)?.title ?? conversation.title;
    this.send(conversation, {
      title: `${this.who(conversation)} finished`,
      body: oneLine(title) || "A long reply is ready",
      url: `#/conversations/${conversation.id}`,
      tag: tagOf(conversation),
    });
  }

  // ───────────────────────────── sending ─────────────────────────────

  private who(c: Conversation): string {
    try {
      return this.o.registry.employee(c.employeeId as Id).name;
    } catch {
      return c.employeeId;
    }
  }

  private resolve(c: Conversation): void {
    this.send(c, {
      title: `${this.who(c)} needs you`,
      body: "Answered",
      url: `#/conversations/${c.id}`,
      tag: tagOf(c),
      resolve: true,
    });
  }

  private send(c: Conversation, payload: NotificationPayload): void {
    const push = this.o.push;
    if (!push) return;
    const before = this.chain.get(c.id) ?? Promise.resolve();
    const next = before
      .then(() => push.send(payload))
      .catch((e) => this.o.log?.(`conversation push failed: ${String(e)}`));
    this.chain.set(c.id, next);
    void next.then(() => {
      if (this.chain.get(c.id) === next) this.chain.delete(c.id);
    });
  }

  /** Waits for the sends so far (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.chain.values()]);
  }
}

/** One notification per conversation. */
export const tagOf = (c: Pick<Conversation, "id">): string => `conv-${c.id}`;
