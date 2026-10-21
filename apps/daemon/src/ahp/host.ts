// The AHP host: the daemon's authoritative state for conversations, spoken to clients as AHP 1.0.
//
//   clients (JSON-RPC over a WebSocket)  <->  AhpHost  <->  AgentBackend (ACP, in the session host)
//
// Every channel (the root, one per session, one per chat) holds the state the OFFICIAL reducers of
// `@microsoft/agent-host-protocol` produce from one host-wide, persisted action log. A client
// subscribes, gets a snapshot with the `serverSeq` it is current to, then every later action in
// order; after a disconnect it `reconnect`s with the last `serverSeq` it saw and gets the missed
// actions from the log (or fresh snapshots when the log no longer reaches back that far).
//
// This file knows the protocol and nothing about agents; the transport (transport.ts) knows
// sockets and nothing about the protocol. See docs/design/ahp-spike.md for the findings behind it.
import { createHash } from "node:crypto";
import {
  type ActionEnvelope,
  type AgentInfo,
  AhpErrorCodes,
  type ChatSummary,
  type ContentRef,
  isClientDispatchable,
  JsonRpcErrorCodes,
  type Message,
  type MessageAttachment,
  negotiateProtocolVersion,
  type SessionConfigState,
  type SessionSummary,
} from "@microsoft/agent-host-protocol";
import type { Db } from "../db.ts";
import { sniffImage } from "../images.ts";
import type { AgentBackend, ToolAnswer, TurnOutcome, TurnRun } from "./backend.ts";
import { type Caps, defaultCaps, sanitizeAction } from "./sanitize.ts";
import { AhpStore, defaultLimits, type Limits } from "./store.ts";
import {
  ActionType,
  activity,
  type ChannelKind,
  type ChannelState,
  type ChatState,
  ConfirmationOptionKind,
  channelKind,
  type Json,
  PendingMessageKind,
  PROTOCOL_VERSIONS,
  ResponsePartKind,
  ROOT,
  type RootState,
  reduce,
  SessionInputRequestKind,
  SessionLifecycle,
  type SessionState,
  SessionStatus,
  type StateAction,
  ToolCallCancellationReason,
  ToolCallConfirmationReason,
  ToolCallStatus,
  USER_ORIGIN,
} from "./wire.ts";

export const DEFAULT_TITLE = "New conversation";

/** What a socket must offer the host. The Bun glue in transport.ts adapts `ServerWebSocket` to it. */
export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued to the peer and not yet written: the slow-consumer signal. */
  bufferedAmount(): number;
  /** A protocol-level ping, where the socket has one. */
  ping?(): void;
}

export interface TransportLimits {
  /** A frame bigger than this closes the connection (1009). Images travel in turnStarted, as base64. */
  maxMessageBytes: number;
  /** More queued output than this and the client is dropped (1013); it reconnects and replays. */
  maxBufferedBytes: number;
  maxSubscriptions: number;
  maxConnections: number;
  maxMessagesPerSecond: number;
  /** No frame or pong for this long and the connection is closed. */
  idleCloseMs: number;
  /** A reconnect needing more replayed actions than this gets snapshots instead. */
  maxReplayActions: number;
  /** Turns per page for fetchTurns. */
  turnsPage: number;
}

export const defaultTransportLimits: TransportLimits = {
  maxMessageBytes: 24 * 1024 * 1024,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxSubscriptions: 64,
  maxConnections: 32,
  maxMessagesPerSecond: 100,
  idleCloseMs: 90_000,
  maxReplayActions: 5000,
  turnsPage: 20,
};

/** What a prompt may carry. Images are checked by their bytes. */
export const attachmentLimits = {
  count: 6,
  imageBytes: 10 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  textChars: 200_000,
  /** Bigger than this and an embedded attachment moves out of the log into a content blob. */
  inlineChars: 4096,
};

export interface HostOptions {
  db: Db;
  backend: AgentBackend;
  now?: () => number;
  log?: (message: string) => void;
  limits?: Partial<Limits & TransportLimits>;
  caps?: Partial<Caps>;
  /** Checks a token pushed with `authenticate`. Absent: no token is accepted that way. */
  verifyToken?: (token: string) => boolean;
}

/** Hooks the conversation service sets after the host exists. Read at call time. */
export interface HostHooks {
  /** What `createSession` does when a client calls it: the daemon makes conversations. Absent: refused. */
  onCreateSession?: (params: Json, conn: Conn) => Promise<void>;
  /** May a client dispose this session? Absent: yes. */
  canDisposeSession?: (session: string) => boolean;
  /** Called after every action is persisted and sent. */
  onApplied?: (channel: string, action: StateAction) => void;
  /** Called after a session is disposed. */
  onSessionDisposed?: (session: string) => void;
}

export class Conn {
  clientId: string | undefined;
  /** initialize or reconnect has happened. */
  ready = false;
  authed: boolean;
  closed = false;
  subs = new Set<string>();
  /** The `turnsNextCursor` each subscribed chat's windowed snapshot ended with (fetchTurns pages it). */
  windows = new Map<string, string>();
  lastActive: number;
  authFailures = 0;
  private windowStart = 0;
  private windowCount = 0;
  constructor(
    readonly id: number,
    readonly socket: Socket,
    authed: boolean,
    now: number,
  ) {
    this.authed = authed;
    this.lastActive = now;
    this.windowStart = now;
  }
  /** Counts a frame; false once this second's allowance is spent. */
  allow(now: number, perSecond: number): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    return ++this.windowCount <= perSecond;
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
const invalid = (m: string) => new RpcError(JsonRpcErrorCodes.InvalidParams, m);

interface Channel {
  uri: string;
  c: ChannelState;
  createdAt: number;
  meta: Json;
  sinceSnapshot: number;
  /** The newest log row of this channel (0: none yet). */
  lastSeq: number;
}

interface Run {
  turnId: string;
  startedAt: number;
  controller: AbortController;
  run: TurnRun;
  done: Promise<void>;
  /** The turn was ended by the host (cancelled, disposed) and the backend's outcome no longer counts. */
  over: boolean;
}

const str = (v: unknown, name: string, max = 2048): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw invalid(`${name} must be a string`);
  return v;
};
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export class AhpHost {
  readonly store: AhpStore;
  readonly limits: TransportLimits;
  readonly hooks: HostHooks = {};
  private readonly caps: Caps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private seq = 0;
  private readonly chans = new Map<string, Channel>();
  private readonly chatSession = new Map<string, string>();
  private readonly conns = new Set<Conn>();
  private nextConn = 1;
  private readonly runs = new Map<string, Run>();
  /** Per chat: the previous turn's backend call, so the next prompt waits for it to wind down. */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly creating = new Set<string>();
  private readonly lastSummary = new Map<string, string>();
  private closed = false;

  constructor(private readonly o: HostOptions) {
    const { snapshotEvery, retainMs, maxActionRows, maxBlobBytes, ...transport } = o.limits ?? {};
    this.store = new AhpStore(o.db, {
      snapshotEvery: snapshotEvery ?? defaultLimits.snapshotEvery,
      retainMs: retainMs ?? defaultLimits.retainMs,
      maxActionRows: maxActionRows ?? defaultLimits.maxActionRows,
      maxBlobBytes: maxBlobBytes ?? defaultLimits.maxBlobBytes,
    });
    this.limits = { ...defaultTransportLimits, ...transport };
    this.caps = { ...defaultCaps, ...o.caps };
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.rebuild();
  }

  // ───────────────────────────── state: rebuild, apply, broadcast ─────────────────────────────

  /** Every channel from its latest snapshot (or initial state) plus the log after it, by the reducers. */
  private rebuild(): void {
    const rows = this.store.channels();
    const lastSeqs = this.store.lastSeqByChannel();
    if (!rows.some((r) => r.uri === ROOT)) {
      const initial: RootState = { agents: this.o.backend.agents() };
      const row = {
        uri: ROOT,
        kind: "root" as const,
        initial,
        createdSeq: 0,
        createdAt: this.now(),
        meta: {},
      };
      this.store.createChannel(row);
      rows.unshift(row);
    }
    this.seq = this.store.maxSeq();
    let replayed = 0;
    for (const r of rows) {
      const snap = this.store.latestSnapshot(r.uri);
      let c = { kind: r.kind, state: snap?.state ?? r.initial } as ChannelState;
      for (const a of this.store.channelActionsAfter(r.uri, snap?.seq ?? r.createdSeq)) {
        c = reduce(c, a.action as StateAction);
        replayed++;
      }
      this.chans.set(r.uri, {
        uri: r.uri,
        c,
        createdAt: r.createdAt,
        meta: r.meta,
        sinceSnapshot: 0,
        lastSeq: Math.max(lastSeqs.get(r.uri) ?? 0, snap?.seq ?? 0, r.createdSeq),
      });
      if (c.kind === "session") for (const chat of c.state.chats) this.chatSession.set(chat.resource, r.uri);
    }
    this.log(`ahp: rebuilt ${rows.length} channels at serverSeq ${this.seq}, replayed ${replayed} actions`);
    this.refreshAgents();
    // What was running when the host stopped did not finish (spec: unexpected disconnection).
    for (const ch of this.chans.values()) {
      if (ch.c.kind === "session" && ch.c.state.lifecycle === SessionLifecycle.Creating) {
        this.apply(ch.uri, {
          type: ActionType.SessionCreationFailed,
          error: {
            errorType: "host_restarted",
            message: "The host restarted while this session was starting.",
          },
        });
      }
      if (ch.c.kind === "chat" && ch.c.state.activeTurn) {
        const t = ch.c.state.activeTurn;
        this.apply(ch.uri, {
          type: ActionType.ChatError,
          turnId: t.id,
          duration: Math.max(0, this.now() - Date.parse(t.startedAt)),
          part: {
            kind: ResponsePartKind.Error,
            resumable: false,
            error: {
              errorType: "host_restarted",
              message: "The daemon restarted while this turn was running. Send a message to carry on.",
            },
          },
        });
        this.log(`ahp: ended the turn ${t.id} that was running on ${ch.uri}`);
      }
    }
    this.prune();
  }

  /** The root channel's agents follow the backend's providers. */
  refreshAgents(): void {
    const root = this.chans.get(ROOT);
    if (root?.c.kind !== "root") return;
    const agents = this.o.backend.agents();
    if (JSON.stringify(agents) !== JSON.stringify(root.c.state.agents)) {
      this.apply(ROOT, { type: ActionType.RootAgentsChanged, agents });
    }
  }

  /** Drops log rows that snapshots cover and are past retention or over the cap. */
  prune(): void {
    // A channel with log rows but no snapshot of them gets one first, so its old rows can go.
    const snaps = this.store.snapshotSeqByChannel();
    for (const ch of this.chans.values()) {
      if (ch.lastSeq > (snaps.get(ch.uri) ?? 0)) this.store.snapshot(ch.uri, ch.lastSeq, ch.c.state);
    }
    const removed = this.store.prune(this.now());
    if (removed > 0) this.log(`ahp: pruned ${removed} log rows`);
  }

  state<T = unknown>(uri: string): T | undefined {
    return this.chans.get(uri)?.c.state as T | undefined;
  }
  sessionState(uri: string): SessionState | undefined {
    const c = this.chans.get(uri)?.c;
    return c?.kind === "session" ? c.state : undefined;
  }
  chatState(uri: string): ChatState | undefined {
    const c = this.chans.get(uri)?.c;
    return c?.kind === "chat" ? c.state : undefined;
  }
  /** The newest serverSeq. */
  get serverSeq(): number {
    return this.seq;
  }
  sessionOfChat(chat: string): string | undefined {
    return this.chatSession.get(chat);
  }
  sessions(): string[] {
    return [...this.chans].filter(([, ch]) => ch.c.kind === "session").map(([uri]) => uri);
  }
  connectionCount(): number {
    return this.conns.size;
  }

  /** Host-side metadata of a channel, kept in the database (the session host keeps its ACP ids here). */
  channelMeta(uri: string): Json {
    return this.chans.get(uri)?.meta ?? {};
  }
  setChannelMeta(uri: string, patch: Json): void {
    const ch = this.chans.get(uri);
    if (!ch) return;
    ch.meta = { ...ch.meta, ...patch };
    this.store.setMeta(uri, ch.meta);
  }

  /** Stores content behind an `ahp-content:` URI (diffs, offloaded attachments). */
  putContent(data: string | Uint8Array, mime = "text/plain"): ContentRef {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    this.store.putBlob(hash, mime, bytes, this.now());
    return { uri: `ahp-content:/${hash}`, sizeHint: bytes.byteLength, contentType: mime };
  }

  /**
   * Reduces, persists, then sends: the only way state changes. The state does not move if the
   * write fails. Returns the sequenced envelope.
   */
  apply(channel: string, action: StateAction, origin?: ActionEnvelope["origin"]): ActionEnvelope {
    const ch = this.chans.get(channel);
    if (!ch) throw new RpcError(AhpErrorCodes.NotFound, `no channel ${channel}`);
    const next = reduce(ch.c, action);
    const seq = this.seq + 1;
    const snapshotDue = ch.sinceSnapshot + 1 >= this.store.limits.snapshotEvery;
    this.store.append(
      { seq, channel, at: this.now(), action, ...(origin ? { origin } : {}) },
      snapshotDue ? next.state : undefined,
    );
    this.seq = seq;
    ch.c = next;
    ch.lastSeq = seq;
    ch.sinceSnapshot = snapshotDue ? 0 : ch.sinceSnapshot + 1;
    const env: ActionEnvelope = { channel, action, serverSeq: seq, origin };
    this.broadcast(channel, env);
    this.hooks.onApplied?.(channel, action);
    if (
      ch.c.kind === "chat" &&
      action.type !== ActionType.ChatDelta &&
      action.type !== ActionType.ChatReasoning
    ) {
      this.afterChat(channel);
    } else if (ch.c.kind === "session") {
      this.noteSummary(channel);
    }
    return env;
  }

  /**
   * An action from the agent side (a backend, the mapper): redacted and capped on the way in. For
   * a turn's own actions use `TurnRun.emit`, which also drops them once the turn is over.
   */
  emit(channel: string, action: StateAction): ActionEnvelope {
    return this.apply(channel, sanitizeAction(action, this.caps));
  }

  private broadcast(channel: string, env: ActionEnvelope): void {
    const text = JSON.stringify({ jsonrpc: "2.0", method: "action", params: env });
    for (const conn of [...this.conns]) if (conn.subs.has(channel)) this.sendText(conn, text);
  }

  private notify(channel: string, method: string, params: Json): void {
    const text = JSON.stringify({ jsonrpc: "2.0", method, params: { channel, ...params } });
    for (const conn of [...this.conns]) if (conn.subs.has(channel)) this.sendText(conn, text);
  }

  private sendText(conn: Conn, text: string): void {
    if (conn.closed) return;
    try {
      // A client that cannot keep up is dropped, not buffered without end: it reconnects and replays.
      if (conn.socket.bufferedAmount() > this.limits.maxBufferedBytes) {
        this.drop(conn, 1013, "slow consumer: reconnect to catch up");
        return;
      }
      conn.socket.send(text);
    } catch {
      this.drop(conn, 1011, "send failed");
    }
  }

  private send(conn: Conn, msg: Json): void {
    this.sendText(conn, JSON.stringify({ jsonrpc: "2.0", ...msg }));
  }

  // ───────────────────────────── summaries and roll-ups ─────────────────────────────

  /** The status a session list shows: the default chat's activity, promoted by any chat that needs you or failed. */
  private sessionStatus(uri: string): number {
    const s = this.sessionState(uri);
    if (!s) return SessionStatus.Idle;
    const chats = s.chats.map((c) => this.chatState(c.resource)).filter((c): c is ChatState => !!c);
    const main = chats.find((c) => c.resource === s.defaultChat) ?? chats[chats.length - 1];
    let act = main ? activity(main.status) : SessionStatus.Idle;
    if (chats.some((c) => activity(c.status) === SessionStatus.InputNeeded)) act = SessionStatus.InputNeeded;
    else if (chats.some((c) => activity(c.status) === SessionStatus.Error)) act = SessionStatus.Error;
    return (s.status & ~31) | act;
  }

  summary(uri: string): SessionSummary | undefined {
    const ch = this.chans.get(uri);
    if (ch?.c.kind !== "session") return undefined;
    const s = ch.c.state;
    const modified = Math.max(
      ch.createdAt,
      ...s.chats.map((c) => Date.parse(this.chatState(c.resource)?.modifiedAt ?? c.modifiedAt) || 0),
    );
    return {
      resource: uri,
      provider: s.provider,
      title: s.title,
      status: this.sessionStatus(uri),
      ...(s.activity !== undefined ? { activity: s.activity } : {}),
      ...(s.workingDirectories ? { workingDirectories: s.workingDirectories } : {}),
      createdAt: new Date(ch.createdAt).toISOString(),
      modifiedAt: new Date(modified).toISOString(),
      chats: s.chats.map((c) => ({
        resource: c.resource,
        title: c.title,
        status: this.chatState(c.resource)?.status ?? c.status,
      })),
      ...(s.defaultChat ? { defaultChat: s.defaultChat } : {}),
      ...(s._meta ? { _meta: s._meta } : {}),
    } as SessionSummary;
  }

  /** Tells root subscribers when what a session list shows has changed (spec: root/sessionSummaryChanged). */
  private noteSummary(uri: string): void {
    const sum = this.summary(uri);
    if (!sum) return;
    const key = JSON.stringify([sum.status, sum.title, sum.activity, sum.modifiedAt, sum.chats]);
    const before = this.lastSummary.get(uri);
    this.lastSummary.set(uri, key);
    if (before !== undefined && before !== key) {
      this.notify(ROOT, "root/sessionSummaryChanged", {
        session: uri,
        changes: { status: sum.status, title: sum.title, modifiedAt: sum.modifiedAt, chats: sum.chats },
      });
    }
  }

  /**
   * After a chat action: the session's chat catalogue follows the chat (spec: chat aggregation),
   * and `inputNeeded` lists every tool confirmation and question waiting for someone, so "needs
   * you" lists and notifications need no per-chat subscription.
   */
  private afterChat(chatUri: string): void {
    const sessionUri = this.chatSession.get(chatUri);
    const chat = this.chatState(chatUri);
    const session = sessionUri ? this.sessionState(sessionUri) : undefined;
    if (!sessionUri || !chat || !session) return;
    const entry = session.chats.find((c) => c.resource === chatUri);
    const changes: Partial<ChatSummary> = {};
    if (entry?.status !== chat.status) changes.status = chat.status;
    if (entry?.modifiedAt !== chat.modifiedAt) changes.modifiedAt = chat.modifiedAt;
    if (chat.activity !== undefined && entry?.activity !== chat.activity) changes.activity = chat.activity;
    if (Object.keys(changes).length)
      this.apply(sessionUri, { type: ActionType.SessionChatUpdated, chat: chatUri, changes });

    const want = new Map<string, Json>();
    for (const p of chat.activeTurn?.responseParts ?? []) {
      if (p.kind === ResponsePartKind.ToolCall && p.toolCall.status === ToolCallStatus.PendingConfirmation) {
        const id = `${chatUri}#${p.toolCall.toolCallId}`;
        want.set(id, {
          id,
          chat: chatUri,
          kind: SessionInputRequestKind.ToolConfirmation,
          turnId: chat.activeTurn?.id,
          toolCall: p.toolCall,
        });
      } else if (p.kind === ResponsePartKind.InputRequest && p.response === undefined) {
        const id = `${chatUri}#${p.request.id}`;
        want.set(id, { id, chat: chatUri, kind: SessionInputRequestKind.ChatInput, request: p.request });
      }
    }
    const have = (this.sessionState(sessionUri)?.inputNeeded ?? []).filter((r) => r.chat === chatUri);
    for (const r of have) {
      if (!want.has(r.id)) this.apply(sessionUri, { type: ActionType.SessionInputNeededRemoved, id: r.id });
    }
    for (const [id, request] of want) {
      const old = have.find((h) => h.id === id);
      if (!old || JSON.stringify(old) !== JSON.stringify(request)) {
        this.apply(sessionUri, { type: ActionType.SessionInputNeededSet, request: request as never });
      }
    }
  }

  // ───────────────────────────── connections ─────────────────────────────

  /** A new socket. Undefined (and the socket closed) when the host is full. */
  connect(socket: Socket, authed = true): Conn | undefined {
    if (this.closed || this.conns.size >= this.limits.maxConnections) {
      socket.close(1013, "too many connections");
      return undefined;
    }
    const conn = new Conn(this.nextConn++, socket, authed, this.now());
    this.conns.add(conn);
    return conn;
  }

  /** Forgets a connection: its subscriptions and windows go with it, so nothing keeps it alive. */
  disconnect(conn: Conn): void {
    conn.closed = true;
    conn.subs.clear();
    conn.windows.clear();
    this.conns.delete(conn);
  }

  private drop(conn: Conn, code: number, reason: string): void {
    if (conn.closed) return;
    this.disconnect(conn);
    try {
      conn.socket.close(code, reason);
    } catch {
      // already gone
    }
  }

  /** Protocol-level pings to every connection, and the idle ones closed. Call it from a timer. */
  keepalive(): void {
    const t = this.now();
    for (const conn of [...this.conns]) {
      if (t - conn.lastActive > this.limits.idleCloseMs) this.drop(conn, 1001, "idle");
      else {
        try {
          conn.socket.ping?.();
        } catch {
          this.drop(conn, 1011, "ping failed");
        }
      }
    }
  }

  /** A pong, or any sign of life. */
  touch(conn: Conn): void {
    conn.lastActive = this.now();
  }

  /** Stops everything: runs aborted, connections closed. The database stays open (the app owns it). */
  close(): void {
    this.closed = true;
    for (const r of this.runs.values()) {
      r.over = true;
      r.controller.abort();
    }
    for (const conn of [...this.conns]) this.drop(conn, 1001, "daemon stopping");
  }

  // ───────────────────────────── JSON-RPC surface ─────────────────────────────

  /** One incoming text frame. */
  receive(conn: Conn, text: string): void | Promise<void> {
    if (conn.closed) return;
    this.touch(conn);
    if (text.length > this.limits.maxMessageBytes) return this.drop(conn, 1009, "message too big");
    if (!conn.allow(this.now(), this.limits.maxMessagesPerSecond)) {
      return this.drop(conn, 1008, "too many messages");
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.send(conn, {
        id: null,
        error: { code: JsonRpcErrorCodes.ParseError, message: "parse error" },
      });
    }
    if (!isObj(msg) || typeof msg.method !== "string") {
      return this.send(conn, {
        id: isObj(msg) && (typeof msg.id === "number" || typeof msg.id === "string") ? msg.id : null,
        error: { code: JsonRpcErrorCodes.InvalidRequest, message: "not a JSON-RPC request" },
      });
    }
    const id = msg.id;
    const isRequest = typeof id === "number" || typeof id === "string";
    const params = isObj(msg.params) ? msg.params : {};
    let result: unknown;
    try {
      result = this.dispatchMethod(conn, msg.method, params, isRequest);
    } catch (e) {
      if (isRequest) return this.fail(conn, id, e);
      if (!(e instanceof RpcError))
        this.log(`ahp: ${msg.method} failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      return;
    }
    // A synchronous result is sent now, before anything else can interleave with a snapshot or replay.
    if (!(result instanceof Promise)) {
      if (isRequest) this.send(conn, { id, result: result ?? null });
      return;
    }
    return result.then(
      (r) => {
        if (isRequest && !conn.closed) this.send(conn, { id, result: r ?? null });
      },
      (e) => {
        if (isRequest && !conn.closed) this.fail(conn, id, e);
      },
    );
  }

  private fail(conn: Conn, id: unknown, e: unknown): void {
    const err =
      e instanceof RpcError
        ? e
        : new RpcError(JsonRpcErrorCodes.InternalError, e instanceof Error ? e.message : String(e));
    if (!(e instanceof RpcError))
      this.log(`ahp: internal error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    this.send(conn, {
      id,
      error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) },
    });
  }

  private dispatchMethod(conn: Conn, method: string, p: Json, isRequest: boolean): unknown {
    if (method === "ping") return null;
    if (method === "authenticate") return this.authenticate(conn, p);
    if (!conn.authed) throw new RpcError(AhpErrorCodes.AuthRequired, "authenticate first", { resources: [] });
    if (method !== "initialize" && method !== "reconnect" && !conn.ready) {
      throw new RpcError(JsonRpcErrorCodes.InvalidRequest, "initialize first");
    }
    switch (method) {
      case "initialize":
        return this.initialize(conn, p);
      case "reconnect":
        return this.reconnect(conn, p);
      case "subscribe": {
        const uri = str(p.channel, "channel");
        if (conn.subs.size >= this.limits.maxSubscriptions && !conn.subs.has(uri)) {
          throw invalid(`at most ${this.limits.maxSubscriptions} subscriptions per connection`);
        }
        const snapshot = this.snapshotFor(conn, uri, isObj(p.view) ? p.view : undefined);
        conn.subs.add(uri);
        return { snapshot };
      }
      case "unsubscribe":
        conn.subs.delete(str(p.channel, "channel"));
        conn.windows.delete(str(p.channel, "channel"));
        return undefined;
      case "dispatchAction":
        this.dispatch(conn, p);
        return undefined;
      case "listSessions":
        return this.listSessions(p);
      case "createSession":
        return this.createSessionCommand(conn, p);
      case "disposeSession":
        return this.disposeSessionCommand(str(p.channel, "channel"));
      case "createChat":
        return this.createChatCommand(p);
      case "disposeChat":
        return this.disposeChat(str(p.channel, "channel"));
      case "fetchTurns":
        return this.fetchTurns(conn, p);
      case "resourceRead":
        return this.resourceRead(p);
      case "completions":
        return this.completions(p);
      default:
        // Notifications we don't know are ignored; unknown requests are told so.
        if (!isRequest) return undefined;
        throw new RpcError(JsonRpcErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  private authenticate(conn: Conn, p: Json): null {
    if (conn.authed) return null;
    const token = typeof p.token === "string" ? p.token : "";
    if (this.o.verifyToken?.(token)) {
      conn.authed = true;
      return null;
    }
    if (++conn.authFailures >= 3) this.drop(conn, 1008, "authentication failed");
    throw new RpcError(AhpErrorCodes.AuthRequired, "that token is not accepted", { resources: [] });
  }

  private initialize(conn: Conn, p: Json): unknown {
    const offered = Array.isArray(p.protocolVersions)
      ? p.protocolVersions.filter((v) => typeof v === "string")
      : [];
    let version: string | undefined;
    try {
      version = negotiateProtocolVersion(offered);
    } catch {
      throw invalid("protocolVersions must be MAJOR.MINOR.PATCH strings");
    }
    // We speak exactly 1.0.0: a client that offers 1.0.0 gets it; 0.9.x and other lines get -32005.
    if (!version || !offered.includes(PROTOCOL_VERSIONS[0])) {
      throw new RpcError(AhpErrorCodes.UnsupportedProtocolVersion, "unsupported protocol version", {
        supportedVersions: [...PROTOCOL_VERSIONS],
      });
    }
    conn.clientId = str(p.clientId, "clientId", 256);
    conn.ready = true;
    const initial = Array.isArray(p.initialSubscriptions) ? p.initialSubscriptions : [];
    if (initial.length > this.limits.maxSubscriptions) {
      throw invalid(`at most ${this.limits.maxSubscriptions} subscriptions per connection`);
    }
    const snapshots: unknown[] = [];
    for (const u of initial) {
      if (typeof u !== "string" || !this.chans.has(u)) continue;
      snapshots.push(this.snapshotFor(conn, u));
      conn.subs.add(u);
    }
    return {
      protocolVersion: PROTOCOL_VERSIONS[0],
      serverSeq: this.seq,
      serverInfo: { name: "i-inc", title: "i.inc daemon", version: "1" },
      snapshots,
    };
  }

  private snapshotFor(conn: Conn, uri: string, view?: Json): unknown {
    const ch = this.chans.get(uri);
    if (!ch) {
      throw new RpcError(
        channelKind(uri) === "session" || channelKind(uri) === "chat"
          ? AhpErrorCodes.SessionNotFound
          : AhpErrorCodes.NotFound,
        `no channel ${uri}`,
      );
    }
    let state: unknown = ch.c.state;
    conn.windows.delete(uri);
    if (ch.c.kind === "chat" && typeof view?.turns === "number" && view.turns >= 0) {
      // A windowed snapshot: the last N completed turns and a cursor for the older ones.
      const turns = ch.c.state.turns;
      const keep = Math.floor(view.turns);
      if (turns.length > keep) {
        const start = turns.length - keep;
        const cursor = `before:${keep === 0 ? "END" : turns[start]?.id}`;
        conn.windows.set(uri, cursor);
        state = { ...ch.c.state, turns: turns.slice(start), turnsNextCursor: cursor };
      }
    }
    return { resource: uri, state, fromSeq: this.seq };
  }

  /** Older turns for a chat the connection holds a windowed snapshot of (spec: fetchTurns). */
  private fetchTurns(conn: Conn, p: Json): null {
    const uri = str(p.channel, "channel");
    const chat = this.chatState(uri);
    if (!chat || !conn.subs.has(uri))
      throw new RpcError(AhpErrorCodes.SessionNotFound, `not subscribed to ${uri}`);
    const held = conn.windows.get(uri);
    const cursor = p.cursor === undefined ? held : str(p.cursor, "cursor");
    if (cursor === undefined) return null; // nothing older than what the client holds
    if (cursor !== held) throw invalid("unrecognised cursor");
    const end =
      cursor === "before:END" ? chat.turns.length : chat.turns.findIndex((t) => t.id === cursor.slice(7));
    if (end < 0) throw invalid("unrecognised cursor");
    const start = Math.max(0, end - this.limits.turnsPage);
    const next = start > 0 ? `before:${chat.turns[start]?.id}` : undefined;
    if (next) conn.windows.set(uri, next);
    else conn.windows.delete(uri);
    // Sent to this client only and without a serverSeq of its own: other clients hold other windows.
    this.send(conn, {
      method: "action",
      params: {
        channel: uri,
        action: {
          type: ActionType.ChatTurnsLoaded,
          turns: chat.turns.slice(start, end),
          ...(next ? { turnsNextCursor: next } : {}),
        },
        serverSeq: this.seq,
      },
    });
    return null;
  }

  /** Replays what the client missed from the log, or sends snapshots when the log no longer reaches back. */
  private reconnect(conn: Conn, p: Json): unknown {
    conn.clientId = str(p.clientId, "clientId", 256);
    const last = p.lastSeenServerSeq;
    if (typeof last !== "number" || !Number.isFinite(last) || last < 0)
      throw invalid("lastSeenServerSeq must be a number");
    const subs = Array.isArray(p.subscriptions)
      ? p.subscriptions.filter((u): u is string => typeof u === "string")
      : [];
    if (subs.length > this.limits.maxSubscriptions) {
      throw invalid(`at most ${this.limits.maxSubscriptions} subscriptions per connection`);
    }
    conn.ready = true;
    const live = subs.filter((u) => this.chans.has(u));
    const missing = subs.filter((u) => !this.chans.has(u));
    let replayCount = 0;
    if (last <= this.seq && last >= this.store.floor()) {
      for (const u of live) replayCount += this.store.countChannelActionsAfter(u, last);
    }
    for (const u of live) conn.subs.add(u);
    for (const u of live) conn.windows.delete(u);
    if (last > this.seq || last < this.store.floor() || replayCount > this.limits.maxReplayActions) {
      return { type: "snapshot", snapshots: live.map((u) => this.snapshotFor(conn, u)) };
    }
    const actions = live
      .flatMap((u) => this.store.channelActionsAfter(u, last))
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({ channel: r.channel, action: r.action, serverSeq: r.seq, origin: r.origin }));
    return { type: "replay", actions, missing };
  }

  private listSessions(p: Json): unknown {
    const limit = typeof p.limit === "number" ? Math.min(200, Math.max(1, Math.floor(p.limit))) : 50;
    const offset = typeof p.cursor === "string" && /^\d+$/.test(p.cursor) ? Number(p.cursor) : 0;
    const all = this.sessions()
      .map((u) => this.summary(u))
      .filter((s): s is SessionSummary => !!s)
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    const items = all.slice(offset, offset + limit);
    return { items, ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}) };
  }

  private resourceRead(p: Json): unknown {
    const uri = str(p.uri, "uri", 4096);
    const hash = /^ahp-content:\/([0-9a-f]{32})$/.exec(uri)?.[1];
    const blob = hash ? this.store.getBlob(hash) : undefined;
    if (!blob) throw new RpcError(AhpErrorCodes.NotFound, `not found: ${uri}`);
    const asText = p.encoding !== "base64" && /^(text\/|application\/json)/.test(blob.mime);
    return {
      data: asText ? new TextDecoder().decode(blob.data) : Buffer.from(blob.data).toString("base64"),
      encoding: asText ? "utf-8" : "base64",
      contentType: blob.mime,
    };
  }

  /** Slash commands from the agent's `available_commands_update`, kept in the session's `_meta`. */
  private completions(p: Json): unknown {
    const chat = str(p.channel, "channel");
    const session = this.sessionState(this.chatSession.get(chat) ?? chat);
    const commands = ((session?._meta as Json | undefined)?.["iinc.commands"] ?? []) as {
      name: string;
      description?: string;
    }[];
    const upto = String(p.text ?? "").slice(0, Number(p.offset ?? 0));
    const word = /(?:^|\s)\/([\w:-]*)$/.exec(upto)?.[1];
    if (word === undefined || !Array.isArray(commands)) return { items: [] };
    return {
      items: commands
        .filter((c) => typeof c.name === "string" && c.name.startsWith(word))
        .slice(0, 50)
        .map((c) => ({
          insertText: `/${c.name}`,
          rangeStart: upto.length - word.length - 1,
          rangeEnd: upto.length,
          attachment: { type: "simple", label: `/${c.name}`, modelRepresentation: `/${c.name}` },
        })),
    };
  }

  // ───────────────────────────── sessions and chats ─────────────────────────────

  private async createSessionCommand(conn: Conn, p: Json): Promise<null> {
    if (!this.hooks.onCreateSession)
      throw new RpcError(
        JsonRpcErrorCodes.MethodNotFound,
        "sessions are created through the conversations API",
      );
    await this.hooks.onCreateSession(p, conn);
    return null;
  }

  /**
   * Creates a session and its first chat. The backend opens the agent side first (its modes and
   * options become the session's config schema, which cannot change afterwards), then the channels
   * are created and the lifecycle actions logged.
   */
  async createSession(spec: {
    session?: string;
    provider: string;
    title?: string;
    workingDirectories?: string[];
    config?: Json;
    meta?: Json;
  }): Promise<{ session: string; chat: string }> {
    const session = spec.session ?? `ahp-session:/${crypto.randomUUID()}`;
    if (channelKind(session) !== "session" || session.length > 200)
      throw invalid("session must be an ahp-session: URI");
    if (this.chans.has(session) || this.creating.has(session)) {
      throw new RpcError(AhpErrorCodes.SessionAlreadyExists, "session already exists");
    }
    const agent = this.o.backend.agents().find((a) => a.provider === spec.provider);
    if (!agent) throw new RpcError(AhpErrorCodes.ProviderNotFound, `no agent for provider ${spec.provider}`);
    const chat = `ahp-chat:/${crypto.randomUUID()}`;
    this.creating.add(session);
    try {
      const opened = await this.o.backend.openSession({
        session,
        chat,
        provider: spec.provider,
        workingDirectories: spec.workingDirectories ?? [],
        ...(spec.config ? { config: spec.config } : {}),
        meta: spec.meta ?? {},
      });
      if (spec.config && Object.keys(spec.config).length > 0 && !opened.config) {
        throw invalid("this agent has no config to set");
      }
      const config = opened.config ? this.withRequested(opened.config, spec.config) : undefined;
      const title = (opened.title ?? spec.title ?? DEFAULT_TITLE).slice(0, 200);
      const meta = { ...(spec.meta ?? {}), ...(opened.meta ?? {}) };
      const now = this.now();
      const stamp = new Date(now).toISOString();
      const sessionInitial: SessionState = {
        provider: spec.provider,
        title,
        status: SessionStatus.Idle,
        lifecycle: SessionLifecycle.Creating,
        ...(spec.workingDirectories?.length ? { workingDirectories: spec.workingDirectories } : {}),
        activeClients: [],
        chats: [],
        ...(config ? { config } : {}),
        ...(Object.keys(meta).length ? { _meta: meta } : {}),
      };
      const chatInitial: ChatState = {
        resource: chat,
        title,
        status: SessionStatus.Idle,
        modifiedAt: stamp,
        turns: [],
      };
      this.store.transaction(() => {
        this.store.createChannel({
          uri: session,
          kind: "session",
          initial: sessionInitial,
          createdSeq: this.seq,
          createdAt: now,
          meta: {},
        });
        this.store.createChannel({
          uri: chat,
          kind: "chat",
          initial: chatInitial,
          createdSeq: this.seq,
          createdAt: now,
          meta: { session },
        });
      });
      const base = { sinceSnapshot: 0, lastSeq: this.seq, createdAt: now, meta: {} as Json };
      this.chans.set(session, { ...base, uri: session, c: { kind: "session", state: sessionInitial } });
      this.chans.set(chat, {
        ...base,
        uri: chat,
        c: { kind: "chat", state: chatInitial },
        meta: { session },
      });
      this.chatSession.set(chat, session);
      this.apply(session, {
        type: ActionType.SessionChatAdded,
        summary: { resource: chat, title, status: SessionStatus.Idle, modifiedAt: stamp },
      });
      this.apply(session, { type: ActionType.SessionDefaultChatChanged, defaultChat: chat });
      this.apply(session, { type: ActionType.SessionReady });
      this.lastSummary.delete(session);
      this.noteSummary(session);
      const sum = this.summary(session);
      if (sum) this.notify(ROOT, "root/sessionAdded", { summary: sum });
      return { session, chat };
    } finally {
      this.creating.delete(session);
    }
  }

  /** The values the client asked for, where the agent's schema allows them, over the agent's own. */
  private withRequested(config: SessionConfigState, requested?: Json): SessionConfigState {
    if (!requested) return config;
    const values = { ...config.values };
    for (const [k, v] of Object.entries(requested)) {
      const prop = config.schema.properties[k];
      if (!prop) throw invalid(`unknown config ${k}`);
      if (prop.enum && !prop.enum.includes(v as never)) throw invalid(`${String(v)} is not a valid ${k}`);
      values[k] = v;
    }
    return { ...config, values };
  }

  private async disposeSessionCommand(uri: string): Promise<null> {
    if (!this.sessionState(uri)) throw new RpcError(AhpErrorCodes.SessionNotFound, "no such session");
    if (this.hooks.canDisposeSession && !this.hooks.canDisposeSession(uri)) {
      throw new RpcError(AhpErrorCodes.Conflict, "archive the conversation before disposing its session");
    }
    await this.disposeSession(uri);
    return null;
  }

  /** Forgets a session, its chats and their log for good. */
  async disposeSession(uri: string): Promise<void> {
    const s = this.sessionState(uri);
    if (!s) return;
    const chats = s.chats.map((c) => c.resource);
    for (const chat of chats) this.stopRun(chat);
    try {
      await this.o.backend.closeSession(uri);
    } catch (e) {
      this.log(`ahp: closing ${uri} failed: ${e instanceof Error ? e.message : e}`);
    }
    for (const u of [uri, ...chats]) {
      this.chans.delete(u);
      this.chatSession.delete(u);
      this.tails.delete(u);
      for (const conn of this.conns) {
        conn.subs.delete(u);
        conn.windows.delete(u);
      }
    }
    this.lastSummary.delete(uri);
    this.store.deleteChannels([uri, ...chats]);
    this.notify(ROOT, "root/sessionRemoved", { session: uri });
    this.hooks.onSessionDisposed?.(uri);
  }

  private async createChatCommand(p: Json): Promise<null> {
    const sessionUri = str(p.channel, "channel");
    const session = this.sessionState(sessionUri);
    if (!session) throw new RpcError(AhpErrorCodes.SessionNotFound, "no such session");
    const chat = str(p.chat, "chat");
    if (channelKind(chat) !== "chat" || chat.length > 200) throw invalid("chat must be an ahp-chat: URI");
    if (this.chans.has(chat)) throw new RpcError(AhpErrorCodes.AlreadyExists, "chat already exists");
    if (p.source !== undefined) throw invalid("forking and side chats are not supported");
    const agent = this.o.backend.agents().find((a) => a.provider === session.provider);
    if (!agent?.capabilities?.multipleChats)
      throw invalid(`${session.provider} does not support more than one chat per session`);
    await this.o.backend.openChat?.(sessionUri, chat);
    const now = this.now();
    const stamp = new Date(now).toISOString();
    const initial: ChatState = {
      resource: chat,
      title: "New chat",
      status: SessionStatus.Idle,
      modifiedAt: stamp,
      turns: [],
    };
    this.store.createChannel({
      uri: chat,
      kind: "chat",
      initial,
      createdSeq: this.seq,
      createdAt: now,
      meta: { session: sessionUri },
    });
    this.chans.set(chat, {
      uri: chat,
      c: { kind: "chat", state: initial },
      createdAt: now,
      meta: { session: sessionUri },
      sinceSnapshot: 0,
      lastSeq: this.seq,
    });
    this.chatSession.set(chat, sessionUri);
    this.apply(sessionUri, {
      type: ActionType.SessionChatAdded,
      summary: { resource: chat, title: initial.title, status: initial.status, modifiedAt: stamp },
    });
    if (isObj(p.initialMessage)) {
      const message = this.checkMessage(p.initialMessage);
      this.startClientTurn(chat, { turnId: crypto.randomUUID(), startedAt: stamp, message }, undefined);
    }
    return null;
  }

  private async disposeChat(chat: string): Promise<null> {
    const sessionUri = this.chatSession.get(chat);
    const session = sessionUri ? this.sessionState(sessionUri) : undefined;
    if (!sessionUri || !session) throw new RpcError(AhpErrorCodes.SessionNotFound, "no such chat");
    if (session.defaultChat === chat || session.chats.length <= 1) {
      throw new RpcError(AhpErrorCodes.Conflict, "the default chat of a session cannot be disposed");
    }
    this.stopRun(chat);
    await this.o.backend.closeChat?.(sessionUri, chat);
    this.apply(sessionUri, { type: ActionType.SessionChatRemoved, chat });
    // Inputs it was waiting for go with it.
    for (const r of this.sessionState(sessionUri)?.inputNeeded ?? []) {
      if (r.chat === chat) this.apply(sessionUri, { type: ActionType.SessionInputNeededRemoved, id: r.id });
    }
    this.chans.delete(chat);
    this.chatSession.delete(chat);
    this.tails.delete(chat);
    for (const conn of this.conns) {
      conn.subs.delete(chat);
      conn.windows.delete(chat);
    }
    this.store.deleteChannels([chat]);
    return null;
  }

  // ───────────────────────────── what clients dispatch ─────────────────────────────

  /** Rejections go to the sender alone, carry the current serverSeq and use none (spec: Actions). */
  private reject(conn: Conn, channel: string, clientSeq: number, action: unknown, reason: string): void {
    this.send(conn, {
      method: "action",
      params: {
        channel,
        action,
        serverSeq: this.seq,
        origin: { clientId: conn.clientId, clientSeq },
        rejectionReason: reason,
      },
    });
  }

  private dispatch(conn: Conn, p: Json): undefined {
    const channel = str(p.channel, "channel");
    const clientSeq = typeof p.clientSeq === "number" ? p.clientSeq : 0;
    const action = p.action;
    const ch = this.chans.get(channel);
    if (!ch) return undefined; // the spec: actions for unknown channels are ignored
    const refuse = (why: string): undefined => {
      this.reject(conn, channel, clientSeq, action, why);
      return undefined;
    };
    if (!isObj(action) || typeof action.type !== "string") return refuse("not an action");
    const a = action as unknown as StateAction;
    if (!isClientDispatchable(a as never)) return refuse(`${a.type} is not client-dispatchable`);
    const kind: ChannelKind = ch.c.kind;
    if (!a.type.startsWith(`${kind}/`)) return refuse(`${a.type} does not belong on a ${kind} channel`);
    const origin = { clientId: conn.clientId ?? `conn-${conn.id}`, clientSeq };
    try {
      this.dispatchChecked(conn, ch, a, origin, refuse);
    } catch (e) {
      if (e instanceof RpcError) refuse(e.message);
      else throw e;
    }
  }

  private dispatchChecked(
    _conn: Conn,
    ch: Channel,
    a: StateAction,
    origin: NonNullable<ActionEnvelope["origin"]>,
    no: (why: string) => undefined,
  ): undefined {
    const channel = ch.uri;
    if (ch.c.kind === "chat") {
      const st = ch.c.state;
      switch (a.type) {
        case ActionType.ChatTurnStarted: {
          if (st.activeTurn) return no("a turn is already running: queue the message instead");
          if (st.turns.some((t) => t.id === a.turnId)) return no("that turn id was used already");
          if (typeof a.turnId !== "string" || a.turnId.length === 0 || a.turnId.length > 128)
            return no("turnId must be a short string");
          if (Number.isNaN(Date.parse(a.startedAt))) return no("startedAt must be a timestamp");
          const message = this.checkMessage(a.message);
          this.startClientTurn(channel, { turnId: a.turnId, startedAt: a.startedAt, message }, origin);
          return;
        }
        case ActionType.ChatTurnCancelled: {
          if (!st.activeTurn || st.activeTurn.id !== a.turnId) return no("no such active turn");
          this.cancelTurn(channel, origin);
          return;
        }
        case ActionType.ChatToolCallConfirmed: {
          const tc = st.activeTurn?.responseParts.find(
            (p) => p.kind === ResponsePartKind.ToolCall && p.toolCall.toolCallId === a.toolCallId,
          );
          const call = tc?.kind === ResponsePartKind.ToolCall ? tc.toolCall : undefined;
          // The first answer wins: afterwards the call is no longer pending, so the others land here.
          if (
            !st.activeTurn ||
            a.turnId !== st.activeTurn.id ||
            call?.status !== ToolCallStatus.PendingConfirmation
          ) {
            return no(`tool call ${a.toolCallId} is not waiting for an answer (someone answered it already)`);
          }
          let option = undefined as ToolAnswer["selectedOption"];
          if (a.selectedOptionId !== undefined) {
            option = call.options?.find((o) => o.id === a.selectedOptionId);
            if (!option) return no("that is not one of the options");
            if ((option.kind === ConfirmationOptionKind.Approve) !== a.approved)
              return no("the option and the answer disagree");
          }
          if (a.approved && a.confirmed !== ToolCallConfirmationReason.UserAction)
            return no("confirmed must be user-action");
          if (
            !a.approved &&
            a.reason !== ToolCallCancellationReason.Denied &&
            a.reason !== ToolCallCancellationReason.Skipped
          ) {
            return no("a denial needs a reason");
          }
          // Nothing but the user's answer may carry over: no edited input (ACP cannot take one).
          const clean = a.approved ? { ...a, editedToolInput: undefined } : a;
          this.apply(channel, clean as StateAction, origin);
          const run = this.runs.get(channel);
          if (run) {
            this.o.backend.answerToolCall(run.run, a.toolCallId, {
              approved: a.approved,
              ...(a.selectedOptionId !== undefined ? { selectedOptionId: a.selectedOptionId } : {}),
              ...(option ? { selectedOption: option } : {}),
            });
          }
          return;
        }
        case ActionType.ChatPendingMessageSet: {
          if (a.kind !== PendingMessageKind.Steering && a.kind !== PendingMessageKind.Queued)
            return no("unknown pending message kind");
          if (typeof a.id !== "string" || a.id.length === 0 || a.id.length > 128)
            return no("id must be a short string");
          const message = this.checkMessage(a.message);
          this.apply(channel, { ...a, message }, origin);
          this.drain(channel);
          return;
        }
        case ActionType.ChatPendingMessageRemoved:
        case ActionType.ChatQueuedMessagesReordered:
        case ActionType.ChatIsReadChanged:
        case ActionType.ChatIsArchivedChanged:
          this.apply(channel, a, origin);
          return;
        case ActionType.ChatDraftChanged: {
          if (a.draft) a.draft = this.checkMessage(a.draft);
          this.apply(channel, a, origin);
          return;
        }
        case ActionType.ChatInputAnswerChanged:
          this.apply(channel, a, origin);
          return;
        case ActionType.ChatInputCompleted: {
          this.apply(channel, a, origin);
          const run = this.runs.get(channel);
          if (run)
            this.o.backend.answerInput?.(run.run, a.requestId, a.response, a.answers as Json | undefined);
          return;
        }
        default:
          return no(`${a.type} is not supported by this host`);
      }
    }
    if (ch.c.kind === "session") {
      switch (a.type) {
        case ActionType.SessionTitleChanged: {
          if (typeof a.title !== "string" || a.title.trim().length === 0)
            return no("a title cannot be empty");
          this.apply(channel, { ...a, title: a.title.trim().slice(0, 200) }, origin);
          return;
        }
        case ActionType.SessionIsReadChanged:
        case ActionType.SessionIsArchivedChanged:
          this.apply(channel, a, origin);
          return;
        case ActionType.SessionConfigChanged: {
          const config = ch.c.state.config;
          const values = isObj(a.config) ? a.config : undefined;
          if (!config || !values) return no("this session has no config to change");
          for (const [k, v] of Object.entries(values)) {
            const prop = config.schema.properties[k];
            if (!prop) return no(`unknown config ${k}`);
            if (!prop.sessionMutable) return no(`${k} cannot be changed once the session has started`);
            if (prop.enum && !prop.enum.includes(v as never)) return no(`${String(v)} is not a valid ${k}`);
          }
          if (a.replace) return no("config values are changed one at a time");
          const before = Object.fromEntries(Object.keys(values).map((k) => [k, config.values[k]]));
          this.apply(channel, a, origin);
          void this.o.backend.setConfig(channel, values).catch((e: unknown) => {
            this.log(
              `ahp: the agent refused ${JSON.stringify(values)} on ${channel}: ${e instanceof Error ? e.message : e}`,
            );
            if (this.sessionState(channel))
              this.apply(channel, { type: ActionType.SessionConfigChanged, config: before });
          });
          return;
        }
        default:
          return no(`${a.type} is not supported by this host`);
      }
    }
    return no(`${a.type} is not supported by this host`);
  }

  // ───────────────────────────── messages ─────────────────────────────

  /**
   * Checks what a client sent as a message and returns it in the form the log keeps: the text as
   * is, big embedded attachments moved into content blobs and replaced by references.
   */
  private checkMessage(m: unknown): Message {
    if (!isObj(m) || typeof m.text !== "string") throw invalid("a message needs text");
    if (m.text.length > attachmentLimits.textChars)
      throw invalid(`a message is at most ${attachmentLimits.textChars} characters`);
    if ((m.origin as Json | undefined)?.kind !== "user")
      throw invalid("a client's message must have the user origin");
    const attachments = m.attachments;
    if (attachments !== undefined && !Array.isArray(attachments)) throw invalid("attachments must be a list");
    if ((attachments?.length ?? 0) > attachmentLimits.count)
      throw invalid(`at most ${attachmentLimits.count} attachments`);
    const out: MessageAttachment[] = [];
    for (const raw of (attachments ?? []) as unknown[]) {
      if (!isObj(raw) || typeof raw.type !== "string" || typeof raw.label !== "string")
        throw invalid("a bad attachment");
      if (raw.type === "annotations" || raw.type === "chat")
        throw invalid(`${raw.type} attachments are not supported`);
      if (raw.type !== "embeddedResource") {
        out.push(raw as unknown as MessageAttachment);
        continue;
      }
      if (typeof raw.data !== "string" || typeof raw.contentType !== "string")
        throw invalid("a bad embedded attachment");
      const bytes = Buffer.from(raw.data, "base64");
      const image = raw.contentType.startsWith("image/");
      if (image) {
        if (bytes.byteLength > attachmentLimits.imageBytes) throw invalid(`${raw.label} is over 10 MB`);
        const kind = sniffImage(bytes);
        if (!kind) throw invalid(`${raw.label} isn't a PNG, JPEG, WebP or GIF`);
        raw.contentType = kind;
      } else if (bytes.byteLength > attachmentLimits.fileBytes) {
        throw invalid(`${raw.label} is over 1 MB`);
      }
      if (raw.data.length <= attachmentLimits.inlineChars) {
        out.push(raw as unknown as MessageAttachment);
        continue;
      }
      const ref = this.putContent(bytes, String(raw.contentType));
      const { data: _data, selection, ...rest } = raw;
      out.push({
        ...rest,
        type: "resource",
        uri: ref.uri,
        contentType: ref.contentType,
        sizeHint: ref.sizeHint,
        ...(selection ? { selection } : {}),
        _meta: { ...(isObj(raw._meta) ? raw._meta : {}), "iinc.embedded": true },
      } as unknown as MessageAttachment);
    }
    return {
      text: m.text,
      origin: USER_ORIGIN,
      ...(out.length ? { attachments: out } : {}),
      ...(m.model ? { model: m.model } : {}),
      ...(isObj(m._meta) ? { _meta: m._meta } : {}),
    } as unknown as Message;
  }

  /** A message as the backend should see it: attachments we offloaded are put back as embedded data. */
  inflate(m: Message): Message {
    if (
      !m.attachments?.some((a) => a.type === "resource" && (a._meta as Json | undefined)?.["iinc.embedded"])
    )
      return m;
    const attachments = m.attachments.map((a) => {
      if (a.type !== "resource" || !(a._meta as Json | undefined)?.["iinc.embedded"]) return a;
      const hash = /^ahp-content:\/([0-9a-f]{32})$/.exec(a.uri)?.[1];
      const blob = hash ? this.store.getBlob(hash) : undefined;
      if (!blob)
        return {
          type: "simple",
          label: a.label,
          modelRepresentation: `${a.label} (no longer available)`,
        } as MessageAttachment;
      return {
        type: "embeddedResource",
        label: a.label,
        data: Buffer.from(blob.data).toString("base64"),
        contentType: blob.mime,
      } as MessageAttachment;
    });
    return { ...m, attachments };
  }

  // ───────────────────────────── turns ─────────────────────────────

  /** Records a client's turn (making it the session's title if it is the first) and starts the agent on it. */
  private startClientTurn(
    chat: string,
    t: { turnId: string; startedAt: string; message: Message; queuedMessageId?: string },
    origin: ActionEnvelope["origin"],
  ): void {
    const st = this.chatState(chat);
    const sessionUri = this.chatSession.get(chat);
    if (!st || !sessionUri) return;
    const session = this.sessionState(sessionUri);
    const first = st.turns.length === 0 && !st.activeTurn;
    this.apply(
      chat,
      {
        type: ActionType.ChatTurnStarted,
        turnId: t.turnId,
        startedAt: t.startedAt,
        message: t.message,
        ...(t.queuedMessageId ? { queuedMessageId: t.queuedMessageId } : {}),
      },
      origin,
    );
    if (first && session?.title === DEFAULT_TITLE && t.message.text.trim()) {
      const title = t.message.text.trim().split("\n")[0]?.slice(0, 60) ?? "";
      if (title)
        this.apply(sessionUri, {
          type: ActionType.SessionTitleChanged,
          title: sanitizeAction(title, this.caps),
        });
    }
    this.startRun(chat, sessionUri, t.turnId, t.message);
  }

  private startRun(chat: string, session: string, turnId: string, message: Message): void {
    const controller = new AbortController();
    const startedAt = this.now();
    const run: Run = {
      turnId,
      startedAt,
      controller,
      over: false,
      done: Promise.resolve(),
      run: {
        session,
        chat,
        turnId,
        message: this.inflate(message),
        signal: controller.signal,
        emit: (action) => {
          const live = this.runs.get(chat);
          if (!live || live.turnId !== turnId || live.over || this.chatState(chat)?.activeTurn?.id !== turnId)
            return false;
          const t = (action as { turnId?: string }).turnId;
          if (t !== undefined && t !== turnId) return false;
          this.emit(chat, action);
          return true;
        },
      },
    };
    this.runs.set(chat, run);
    const previous = this.tails.get(chat) ?? Promise.resolve();
    const done = (async () => {
      let outcome: TurnOutcome;
      try {
        await previous;
        outcome = run.over ? { kind: "cancelled" } : await this.o.backend.runTurn(run.run);
      } catch (e) {
        outcome = {
          kind: "error",
          errorType: "host_error",
          message: e instanceof Error ? e.message : String(e),
        };
      }
      this.finishTurn(chat, run, outcome);
    })();
    run.done = done;
    this.tails.set(chat, done);
    void done.then(() => {
      if (this.runs.get(chat) === run) this.runs.delete(chat);
      this.drain(chat);
    });
  }

  private finishTurn(chat: string, run: Run, outcome: TurnOutcome): void {
    const active = this.chatState(chat)?.activeTurn;
    if (run.over || active?.id !== run.turnId) return; // ended already (cancelled, disposed)
    run.over = true;
    const duration = Math.max(0, this.now() - run.startedAt);
    const base = { turnId: run.turnId, duration };
    if (outcome.kind === "complete") this.apply(chat, { type: ActionType.ChatTurnComplete, ...base });
    else if (outcome.kind === "cancelled") this.apply(chat, { type: ActionType.ChatTurnCancelled, ...base });
    else {
      this.emit(chat, {
        type: ActionType.ChatError,
        ...base,
        part: {
          kind: ResponsePartKind.Error,
          resumable: outcome.resumable ?? false,
          error: { errorType: outcome.errorType, message: outcome.message },
        },
      });
    }
  }

  private cancelTurn(chat: string, origin?: ActionEnvelope["origin"]): void {
    const st = this.chatState(chat);
    const run = this.runs.get(chat);
    if (!st?.activeTurn) return;
    const duration = Math.max(0, this.now() - Date.parse(st.activeTurn.startedAt));
    if (run) {
      run.over = true;
      run.controller.abort();
    }
    // Ended at once, for every client; the agent's late updates are dropped by `emit`.
    this.apply(chat, { type: ActionType.ChatTurnCancelled, turnId: st.activeTurn.id, duration }, origin);
    if (run) this.o.backend.cancelTurn?.(run.run);
  }

  /** Ends a chat's run without recording an outcome (the chat is going away). */
  private stopRun(chat: string): void {
    const run = this.runs.get(chat);
    if (!run) return;
    run.over = true;
    run.controller.abort();
    this.o.backend.cancelTurn?.(run.run);
    this.runs.delete(chat);
  }

  /**
   * When a chat is idle, starts its next pending message. A steering message goes first: ACP has no
   * way to inject into a running turn, so "steer" means "next, ahead of the queue".
   */
  private drain(chat: string): void {
    const st = this.chatState(chat);
    if (!st || st.activeTurn || this.runs.has(chat) || this.closed) return;
    const next = st.steeringMessage ?? st.queuedMessages?.[0];
    if (!next) return;
    this.startClientTurn(
      chat,
      {
        turnId: crypto.randomUUID(),
        startedAt: new Date(this.now()).toISOString(),
        message: next.message,
        queuedMessageId: next.id,
      },
      undefined,
    );
  }

  /** Test and shutdown helper: resolves when no turn is running. */
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.all([...this.runs.values()].map((r) => r.done));
  }

  /** Agents the root channel offers. */
  agents(): AgentInfo[] {
    return (this.state<RootState>(ROOT)?.agents ?? []) as AgentInfo[];
  }
}
