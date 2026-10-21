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
  /** The chat it lives in (a turn ending in another chat does not end it). */
  chat: string;
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

/**
 * One short line of text a model wrote (a question, a conversation's title): no markup, no secrets, no
 * working-copy path. Only for prose: never for a command or a path, whose characters mean something.
 */
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

/** Subcommand words that are never a secret: what a command does, not what it is given. */
const SAFE_WORDS = new Set(
  (
    "add audit build bundle cat check checkout ci clean commit compile config create deploy dev diff dlx doctor " +
    "exec fetch fix format generate get help info init install lint list log ls merge migrate outdated pack " +
    "pull push rebase release remove reset restart run serve show start status stop switch tag test " +
    "typecheck uninstall update upgrade version view watch"
  ).split(" "),
);
/** An executable's name: letters, digits and a few joiners. */
const EXECUTABLE = /^[A-Za-z][A-Za-z0-9._+-]{0,30}$/;

/**
 * What a command is, for a lock screen: the program and at most two well-known subcommand words, and an
 * ellipsis when there was more. `pnpm test` is "Run: pnpm test"; `mysql -pSecret` is "Run: mysql …". Its
 * arguments are never shown, because a password or a token may be one; when unsure, "Run a command".
 */
export function commandLabel(command: string): string {
  const tokens = command
    .replace(/^[\s`'"]+|[\s`'"]+$/g, "")
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) i++; // VAR=value prefixes
  const program = (tokens[i] ?? "").replace(/^.*\//, "");
  if (!EXECUTABLE.test(program)) return "Run a command";
  const words: string[] = [];
  let j = i + 1;
  while (j < tokens.length && words.length < 2 && SAFE_WORDS.has(tokens[j] ?? ""))
    words.push(tokens[j++] as string);
  return `Run: ${[program, ...words].join(" ")}${j < tokens.length ? " …" : ""}`;
}

const VERBS: Record<string, string> = {
  edit: "Edit",
  write: "Write",
  read: "Read",
  delete: "Delete",
  create: "Create",
  move: "Move",
  rename: "Rename",
  fetch: "Fetch",
  search: "Search",
};

/** A file path the way a phone should show it: inside the project, plain characters only, short. */
function pathLabel(raw: string): string | undefined {
  const token = (raw.trim().split(/\s+/)[0] ?? "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^[`'"]+|[`'",.:;]+$/g, "")
    .replace(/^\/home\/employee\/work\/conv-[0-9a-f]{8}\//, "");
  if (!/^[\w@.+/~-]{1,200}$/.test(token)) return undefined;
  const t = redactText(token);
  return t.length > 80 ? `…${t.slice(-79)}` : t;
}

/**
 * What a request wants, for the notification body, and nothing more: "Run: pnpm test", "Edit: src/app.ts",
 * "Fetch: github.com", "Run a command". It is built from the tool's kind and the first word, path or host
 * of its own title; a command's arguments, a tool's input, a diff and file contents are never in it. A
 * question the agent asks is model text: markup out, redacted, and cut short.
 */
export function describeRequest(request: Json): string {
  if (request.kind === SessionInputRequestKind.ToolConfirmation) {
    const call = (request.toolCall ?? {}) as Json;
    const title = (
      text(call.confirmationTitle) ||
      text(call.invocationMessage) ||
      str(call.displayName)
    ).trim();
    const kind = str(call.toolName).toLowerCase();
    const lead = /^(\w+)\b\s*:?\s*([\s\S]*)$/.exec(title.replace(/^[`*_\s]+/, ""));
    const word = (lead?.[1] ?? "").toLowerCase();
    if (kind === "execute" || word === "run" || word === "bash" || word === "execute") {
      const isVerb = word === "run" || word === "bash" || word === "execute";
      return commandLabel(isVerb ? (lead?.[2] ?? "") : title);
    }
    const verb = VERBS[word] ?? VERBS[kind];
    if (!verb) return "Wants to use a tool";
    const rest = VERBS[word] ? (lead?.[2] ?? "") : title;
    if (verb === "Search") return "Search the project";
    if (verb === "Fetch") {
      try {
        const host = new URL(
          rest
            .trim()
            .split(/\s+/)[0]
            ?.replace(/^[`'"<]+|[`'">]+$/g, "") ?? "",
        ).hostname;
        return /^[\w.-]{1,100}$/.test(host) ? `Fetch: ${host}` : "Fetch a page";
      } catch {
        return "Fetch a page";
      }
    }
    const target = pathLabel(rest);
    return target ? `${verb}: ${target}` : `${verb} a file`;
  }
  const req = (request.request ?? {}) as Json;
  const first = Array.isArray(req.questions) ? ((req.questions[0] ?? {}) as Json) : {};
  const ask = oneLine(str(req.message) || str(first.message) || str(first.title), 80);
  return ask ? `Asks: ${ask}` : "Has a question for you";
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
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS conv_push_open (
        key TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
    this.prune();
    this.adopt();
    this.stop = o.host.observe((channel, action) => this.onAction(channel, action));
    this.pruneTimer = setInterval(() => this.prune(), 3_600_000);
    this.pruneTimer.unref?.();
  }
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * After a restart, what the last run left: requests still waiting are looked at again (one that was pushed
   * stays pushed and will be closed when answered; one still in its grace is pushed once, now), and a
   * notification still on the phone for a request that is gone (answered or ended while the daemon was down)
   * is closed.
   */
  private adopt(): void {
    for (const session of this.o.host.sessions()) {
      const needed = (this.o.host.sessionState(session) as SessionState | undefined)?.inputNeeded ?? [];
      for (const request of needed) this.track(session, request as unknown as Json);
    }
    const rows = this.o.db.all<{ key: string; conversation: string }>(
      "SELECT key, conversation FROM conv_push_open",
    );
    const orphaned = new Set<string>();
    for (const r of rows) {
      if (this.pending.has(r.key)) continue;
      this.o.db.run("DELETE FROM conv_push_open WHERE key = ?", r.key);
      orphaned.add(r.conversation);
    }
    for (const id of orphaned) {
      const c = this.o.conversations.get(id);
      if (c && !this.stillShowing(id)) this.resolve(c);
    }
  }

  /** Whether a request of this conversation has a notification up. */
  private stillShowing(conversation: string): boolean {
    for (const p of this.pending.values()) if (p.sent && p.conversation.id === conversation) return true;
    return false;
  }

  /** The owner turned "Conversations need me" off: requests still in their grace are dropped. */
  settingsChanged(): void {
    if (notifySettings(this.o.registry.settings().notify).conversationsNeedMe) return;
    for (const [key, p] of [...this.pending]) {
      if (p.sent) continue;
      p.cancel?.();
      this.pending.delete(key);
    }
  }

  /** Stops listening and drops every wait (the daemon is stopping: nothing it does now should reach a phone). */
  close(): void {
    this.stop();
    clearInterval(this.pruneTimer);
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
    const cutoff = this.o.now() - 7 * 86_400_000;
    try {
      this.o.db.run("DELETE FROM push_sent WHERE key LIKE 'convpush:%' AND at < ?", cutoff);
      this.o.db.run("DELETE FROM conv_push_open WHERE at < ?", cutoff);
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
        if (action.isArchived) this.endAll((p) => p.session === channel);
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
    const pushed =
      this.o.db.all<{ key: string }>("SELECT key FROM conv_push_open WHERE key = ?", key).length > 0;
    const p: Pending = {
      key,
      session,
      chat: str(request.chat),
      conversation,
      card,
      turnId: tool ? str(request.turnId) || undefined : undefined,
      label: describeRequest(request),
      since: this.o.now(),
      cancel: undefined,
      // pushed by an earlier run of the daemon and not answered since: its notification is up already
      sent: pushed,
    };
    this.pending.set(key, p);
    if (!pushed) p.cancel = this.schedule(() => this.fire(p), this.graceMs);
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
    this.o.db.run(
      "INSERT OR REPLACE INTO conv_push_open (key, conversation, at) VALUES (?, ?, ?)",
      p.key,
      p.conversation.id,
      this.o.now(),
    );
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
    this.o.db.run("DELETE FROM conv_push_open WHERE key = ?", p.key);
    // Another request of the same conversation is still showing: its notification stays.
    for (const other of this.pending.values()) {
      if (other.sent && other.conversation.id === p.conversation.id) return;
    }
    this.resolve(p.conversation);
  }

  private endAll(which: (p: Pending) => boolean): void {
    for (const [key, p] of [...this.pending]) if (which(p)) this.untrack(p.session, key);
  }

  private turnEnded(chat: string, how: "complete" | "other"): void {
    const startedAt = this.turnStart.get(chat);
    this.turnStart.delete(chat);
    const session = this.o.host.sessionOfChat(chat);
    if (!session) return;
    this.endAll((p) => p.chat === chat);
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
