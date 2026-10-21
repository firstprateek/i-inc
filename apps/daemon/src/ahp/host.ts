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
  type ChatDeltaAction,
  type ChatReasoningAction,
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
const CUT_MARKER = "\n[…cut: a part of a reply is kept to its first 2 MB]";

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
  /** An ordinary frame is at most this big; only a message with attachments may be bigger (up to maxMessageBytes). */
  maxFrameBytes: number;
  /** A socket that has not authenticated may send frames of at most this size. */
  maxUnauthenticatedFrameBytes: number;
  /** Frames refused as too big, per connection, before it is closed. */
  maxAbuse: number;
  /** Sockets that upgraded without credentials (deferred auth), at most, apart from the authenticated ones. */
  maxUnauthenticated: number;
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
  /** Streamed text pieces are joined for this many ms, or this many characters. */
  deltaFlushMs: number;
  deltaFlushChars: number;
  /** The log is pruned this often (ms), and after this many actions, as well as at startup. */
  pruneEveryMs: number;
  pruneEveryActions: number;
  /** Chats kept in memory once idle and unwatched; the rest are read from disk when needed. */
  maxLoadedChats: number;
  /** The same, by size: bytes of JSON across the chats in memory. */
  maxLoadedBytes: number;
}

export const defaultTransportLimits: TransportLimits = {
  maxMessageBytes: 14 * 1024 * 1024,
  maxUnauthenticatedFrameBytes: 64 * 1024,
  maxAbuse: 3,
  maxFrameBytes: 1024 * 1024,
  maxUnauthenticated: 8,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxSubscriptions: 64,
  maxConnections: 32,
  maxMessagesPerSecond: 100,
  idleCloseMs: 90_000,
  maxReplayActions: 5000,
  turnsPage: 20,
  deltaFlushMs: 25,
  deltaFlushChars: 16_384,
  pruneEveryMs: 3_600_000,
  pruneEveryActions: 5000,
  maxLoadedChats: 20,
  maxLoadedBytes: 50 * 1024 * 1024,
};

/** What a prompt may carry. Images are checked by their bytes. */
export const attachmentLimits = {
  count: 6,
  /** All the attachments of one message together: the frame limit is sized to this. */
  totalBytes: 10 * 1024 * 1024,
  imageBytes: 10 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  textChars: 256_000,
  /** A draft is kept in every snapshot of the chat, so it is small. */
  draftChars: 64_000,
  /** Ids, labels and other short strings a client sends. */
  shortChars: 256,
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
  abuse = 0;
  /** Actions refused on this connection, ever. */
  rejects = 0;
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
  kind: ChannelKind;
  /**
   * The channel's state. A chat that is idle and that nobody is looking at is dropped from memory
   * (undefined) and rebuilt from its snapshot and log when next needed; the root and sessions are
   * small and always held.
   */
  c: ChannelState | undefined;
  /** The state the channel was created with, to rebuild it from. */
  initial: unknown;
  /** When it was last used (a counter), for the least-recently-used choice. */
  touched: number;
  /** Roughly how big its state is (bytes of JSON), as of its last snapshot or load. */
  bytes: number;
  createdAt: number;
  meta: Json;
  sinceSnapshot: number;
  /** The newest log row of this channel (0: none yet). */
  lastSeq: number;
  /** Bytes of log since the last snapshot, the size of the state then, and when it was taken (ms). */
  logBytes: number;
  stateBytes: number;
  snapshotAt: number;
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
/** Is this a dispatchAction of a message with an embedded attachment: the one kind of frame that may be big? */
function carriesAttachment(msg: Json): boolean {
  if (msg.method !== "dispatchAction" || !isObj(msg.params) || !isObj(msg.params.action)) return false;
  const a = msg.params.action;
  if (a.type !== ActionType.ChatTurnStarted && a.type !== ActionType.ChatPendingMessageSet) return false;
  const attachments = isObj(a.message) ? a.message.attachments : undefined;
  return (
    Array.isArray(attachments) &&
    attachments.some((x) => isObj(x) && x.type === "embeddedResource" && typeof x.data === "string")
  );
}
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
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private actionsSincePrune = 0;
  private pruneSoon = false;
  private tick = 0;

  constructor(private readonly o: HostOptions) {
    const {
      snapshotEvery,
      snapshotMinBytes,
      snapshotMinMs,
      retainMs,
      maxActionRows,
      maxBlobBytes,
      ...transport
    } = o.limits ?? {};
    this.store = new AhpStore(o.db, {
      snapshotEvery: snapshotEvery ?? defaultLimits.snapshotEvery,
      snapshotMinBytes: snapshotMinBytes ?? defaultLimits.snapshotMinBytes,
      snapshotMinMs: snapshotMinMs ?? defaultLimits.snapshotMinMs,
      retainMs: retainMs ?? defaultLimits.retainMs,
      maxActionRows: maxActionRows ?? defaultLimits.maxActionRows,
      maxBlobBytes: maxBlobBytes ?? defaultLimits.maxBlobBytes,
    });
    this.limits = { ...defaultTransportLimits, ...transport };
    this.caps = { ...defaultCaps, ...o.caps };
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    o.backend.attach?.(this);
    this.rebuild();
    // Pruning at startup alone would let a daemon that runs for months keep every row it ever wrote.
    this.pruneTimer = setInterval(() => this.pruneQuietly(), this.limits.pruneEveryMs);
    this.pruneTimer.unref?.();
  }

  private pruneQuietly(): void {
    this.actionsSincePrune = 0;
    this.pruneSoon = false;
    try {
      this.prune();
    } catch (e) {
      this.log(`ahp: pruning failed: ${e instanceof Error ? e.message : e}`);
    }
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
    const snapSeqs = this.store.snapshotSeqByChannel();
    for (const r of rows) {
      const ch: Channel = {
        uri: r.uri,
        kind: r.kind,
        c: undefined,
        initial: r.initial,
        touched: 0,
        bytes: 0,
        createdAt: r.createdAt,
        meta: r.meta,
        sinceSnapshot: 0,
        logBytes: 0,
        stateBytes: 0,
        snapshotAt: 0,
        lastSeq: Math.max(lastSeqs.get(r.uri) ?? 0, snapSeqs.get(r.uri) ?? 0, r.createdSeq),
      };
      this.chans.set(r.uri, ch);
      // Chats stay on disk until someone needs them; only one that was mid-turn when the host died
      // (or from before this was recorded) is read now, to end its turn.
      if (r.kind === "chat" && r.meta.active === false) continue;
      const c = this.cs(ch);
      if (c.kind === "session") for (const chat of c.state.chats) this.chatSession.set(chat.resource, r.uri);
    }
    this.log(
      `ahp: rebuilt ${rows.length} channels at serverSeq ${this.seq}, ${this.loadedChats} chats held in memory`,
    );
    this.refreshAgents();
    // What was running when the host stopped did not finish (spec: unexpected disconnection).
    for (const ch of [...this.chans.values()]) {
      const c = ch.c;
      if (!c) continue;
      if (c.kind === "session" && c.state.lifecycle === SessionLifecycle.Creating) {
        this.apply(ch.uri, {
          type: ActionType.SessionCreationFailed,
          error: {
            errorType: "host_restarted",
            message: "The host restarted while this session was starting.",
          },
        });
      }
      if (c.kind === "chat" && c.state.activeTurn) {
        const t = c.state.activeTurn;
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
    if (root?.kind !== "root") return;
    const agents = this.o.backend.agents();
    if (JSON.stringify(agents) !== JSON.stringify((this.cs(root).state as RootState).agents)) {
      this.apply(ROOT, { type: ActionType.RootAgentsChanged, agents });
    }
  }

  /** Drops log rows that snapshots cover and are past retention or over the cap. */
  prune(): void {
    // A channel with log rows but no snapshot of them gets one first, so its old rows can go.
    const snaps = this.store.snapshotSeqByChannel();
    for (const ch of [...this.chans.values()]) {
      if (ch.lastSeq > (snaps.get(ch.uri) ?? 0)) this.store.snapshot(ch.uri, ch.lastSeq, this.cs(ch).state);
    }
    const removed = this.store.prune(this.now());
    if (removed > 0) this.log(`ahp: pruned ${removed} log rows`);
  }

  state<T = unknown>(uri: string): T | undefined {
    const ch = this.chans.get(uri);
    return ch ? (this.cs(ch).state as T) : undefined;
  }
  sessionState(uri: string): SessionState | undefined {
    const ch = this.chans.get(uri);
    if (ch?.kind !== "session") return undefined;
    return this.cs(ch).state as SessionState;
  }
  chatState(uri: string): ChatState | undefined {
    const ch = this.chans.get(uri);
    if (ch?.kind !== "chat") return undefined;
    return this.cs(ch).state as ChatState;
  }
  /** Is a turn running in this chat? Does not read a chat that is out of memory (it has none). */
  hasActiveTurn(uri: string): boolean {
    const ch = this.chans.get(uri);
    return !!ch?.c && ch.c.kind === "chat" && !!ch.c.state.activeTurn;
  }
  /** Chats held in memory now (the rest are on disk). */
  get loadedChats(): number {
    let n = 0;
    for (const ch of this.chans.values()) if (ch.kind === "chat" && ch.c) n++;
    return n;
  }

  /**
   * A channel's state, read from its snapshot and log if it is out of memory. Using one makes it the
   * most recently used, and may put the least recently used idle chats out of memory.
   */
  private cs(ch: Channel): ChannelState {
    if (ch.kind === "chat") this.flushDeltas(ch.uri);
    ch.touched = ++this.tick;
    if (!ch.c) {
      const snap = this.store.latestSnapshot(ch.uri);
      let c = { kind: ch.kind, state: snap?.state ?? ch.initial } as ChannelState;
      for (const a of this.store.channelActionsAfter(ch.uri, snap?.seq ?? 0))
        c = reduce(c, a.action as StateAction);
      ch.c = c;
      ch.bytes = snap?.bytes ?? 0;
      this.trim(ch);
    }
    return ch.c;
  }

  /** May this chat leave memory? Not while it is working, being looked at, or the one in use. */
  private evictable(ch: Channel, keep: Channel): boolean {
    if (ch === keep || ch.kind !== "chat" || !ch.c || ch.c.kind !== "chat" || ch.c.state.activeTurn)
      return false;
    if (this.runs.has(ch.uri)) return false;
    for (const conn of this.conns) if (conn.subs.has(ch.uri)) return false;
    return true;
  }

  /** Puts idle chats out of memory, least recently used first, down to the limits. */
  private trim(keep: Channel): void {
    const held = [...this.chans.values()].filter((c) => c.kind === "chat" && c.c);
    let bytes = held.reduce((n, c) => n + c.bytes, 0);
    let count = held.length;
    if (count <= this.limits.maxLoadedChats && bytes <= this.limits.maxLoadedBytes) return;
    for (const ch of held.sort((a, b) => a.touched - b.touched)) {
      if (count <= this.limits.maxLoadedChats && bytes <= this.limits.maxLoadedBytes) break;
      if (!this.evictable(ch, keep) || !ch.c) continue;
      // Leave a snapshot at the newest action, so it comes back without replaying a long tail.
      if (ch.lastSeq > this.store.snapshotSeq(ch.uri)) {
        ch.bytes = this.store.snapshot(ch.uri, ch.lastSeq, ch.c.state);
        ch.sinceSnapshot = 0;
      }
      ch.c = undefined;
      count--;
      bytes -= ch.bytes;
    }
  }
  /** The newest serverSeq. */
  get serverSeq(): number {
    return this.seq;
  }
  sessionOfChat(chat: string): string | undefined {
    return this.chatSession.get(chat);
  }
  sessions(): string[] {
    return [...this.chans].filter(([, ch]) => ch.kind === "session").map(([uri]) => uri);
  }
  /** Is any turn running (including one waiting for a slot or for the agent to start)? */
  busy(): boolean {
    return this.runs.size > 0;
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
    this.flushDeltas(channel);
    const next = reduce(this.cs(ch), action);
    const seq = this.seq + 1;
    const json = JSON.stringify(action);
    const at = this.now();
    // A snapshot costs as much as the state is big, so it is taken when the log since the last one is
    // at least that big (a state that grows is not rewritten on every few actions), and not within
    // a few seconds of the last. An idle channel is snapshotted by the prune.
    const lim = this.store.limits;
    const logBytes = ch.logBytes + json.length;
    const snapshotDue =
      ch.sinceSnapshot + 1 >= lim.snapshotEvery &&
      logBytes >= Math.max(lim.snapshotMinBytes, ch.stateBytes) &&
      at - ch.snapshotAt >= lim.snapshotMinMs;
    const size = this.store.append(
      { seq, channel, at, action, json, ...(origin ? { origin } : {}) },
      snapshotDue ? next.state : undefined,
    );
    this.seq = seq;
    ch.c = next;
    ch.logBytes = snapshotDue ? 0 : logBytes;
    if (snapshotDue) {
      ch.stateBytes = size ?? 0;
      ch.snapshotAt = at;
    }
    if (size !== undefined) ch.bytes = size;
    ch.lastSeq = seq;
    // A lot of writing since the last prune: do it soon, but not inside this action.
    if (++this.actionsSincePrune >= this.limits.pruneEveryActions && !this.pruneSoon) {
      this.pruneSoon = true;
      setTimeout(() => this.pruneQuietly(), 0).unref?.();
    }
    ch.sinceSnapshot = snapshotDue ? 0 : ch.sinceSnapshot + 1;
    const env: ActionEnvelope = { channel, action, serverSeq: seq, origin };
    this.broadcast(channel, env);
    try {
      this.hooks.onApplied?.(channel, action);
    } catch (e) {
      this.log(`ahp: onApplied failed for ${action.type}: ${e instanceof Error ? e.message : e}`);
    }
    if (
      ch.kind === "chat" &&
      action.type !== ActionType.ChatDelta &&
      action.type !== ActionType.ChatReasoning
    ) {
      this.afterChat(channel);
      this.trim(ch);
    } else if (ch.kind === "session") {
      this.noteSummary(channel);
    }
    return env;
  }

  /**
   * An action from the agent side (a backend, the mapper): redacted and capped on the way in. For
   * a turn's own actions use `TurnRun.emit`, which also drops them once the turn is over.
   */
  emit(channel: string, action: StateAction): ActionEnvelope | undefined {
    if (action.type === ActionType.ChatDelta || action.type === ActionType.ChatReasoning) {
      this.queueDelta(channel, action);
      return undefined;
    }
    return this.apply(channel, sanitizeAction(action, this.caps));
  }

  // ── streaming text: many small deltas become few actions ─────────────────────────────────────

  private readonly pendingDeltas = new Map<
    string,
    { action: ChatDeltaAction | ChatReasoningAction; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * An agent streams a reply in tiny pieces. Pieces of the same part that follow each other are joined
   * into one delta, sent and kept after a few milliseconds or 16 KB, whichever is first; anything else
   * for the chat (another part, a tool call, the end of the turn) sends it first, so order holds.
   */
  private queueDelta(channel: string, a: ChatDeltaAction | ChatReasoningAction): void {
    if (!this.chans.has(channel)) return;
    const cur = this.pendingDeltas.get(channel);
    if (
      cur &&
      cur.action.type === a.type &&
      cur.action.turnId === a.turnId &&
      cur.action.partId === a.partId
    ) {
      cur.action = { ...cur.action, content: cur.action.content + a.content };
      if (cur.action.content.length >= this.limits.deltaFlushChars) this.flushDeltas(channel);
      return;
    }
    this.flushDeltas(channel);
    const timer = setTimeout(() => this.flushDeltas(channel), this.limits.deltaFlushMs);
    timer.unref?.();
    this.pendingDeltas.set(channel, { action: a, timer });
  }

  /** Sends the joined delta waiting for this chat, if any. */
  private flushDeltas(channel: string): void {
    const p = this.pendingDeltas.get(channel);
    if (!p) return;
    this.pendingDeltas.delete(channel);
    clearTimeout(p.timer);
    const c = this.chans.get(channel)?.c;
    if (c?.kind !== "chat") return; // a chat with text waiting is mid-turn, so it is in memory
    // A part is kept to maxPart characters: the rest is cut, once, with a marker, and nothing more is added.
    const part = c.state.activeTurn?.responseParts.find(
      (x) =>
        (x.kind === ResponsePartKind.Markdown || x.kind === ResponsePartKind.Reasoning) &&
        x.id === p.action.partId,
    );
    let action = p.action;
    if (part && (part.kind === ResponsePartKind.Markdown || part.kind === ResponsePartKind.Reasoning)) {
      const room = this.caps.maxPart - part.content.length;
      if (room <= 0) return;
      if (action.content.length > room) {
        action = { ...action, content: `${action.content.slice(0, room)}${CUT_MARKER}` };
      }
    }
    this.apply(channel, sanitizeAction(action, this.caps));
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
    // The session's catalogue follows its chats (afterChat), so a list never reads a chat from disk.
    const chats = s.chats;
    const main = chats.find((c) => c.resource === s.defaultChat) ?? chats[chats.length - 1];
    let act = main ? activity(main.status) : SessionStatus.Idle;
    if (chats.some((c) => activity(c.status) === SessionStatus.InputNeeded)) act = SessionStatus.InputNeeded;
    else if (chats.some((c) => activity(c.status) === SessionStatus.Error)) act = SessionStatus.Error;
    return (s.status & ~31) | act;
  }

  summary(uri: string): SessionSummary | undefined {
    const ch = this.chans.get(uri);
    if (ch?.kind !== "session") return undefined;
    const s = this.cs(ch).state as SessionState;
    const modified = Math.max(ch.createdAt, ...s.chats.map((c) => Date.parse(c.modifiedAt) || 0));
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
        status: c.status,
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
    // Whether a turn is running is kept with the chat's record, so a restart knows which chats to read.
    const ch = this.chans.get(chatUri);
    if (ch && (ch.meta.active === true) !== !!chat.activeTurn)
      this.setChannelMeta(chatUri, { active: !!chat.activeTurn });
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
    if (this.closed || this.full(authed)) {
      socket.close(1013, "too many connections");
      return undefined;
    }
    const conn = new Conn(this.nextConn++, socket, authed, this.now());
    this.conns.add(conn);
    return conn;
  }

  /** Are there as many connections of this kind as there may be? Unauthenticated sockets have a small pool of their own. */
  full(authed: boolean): boolean {
    let n = 0;
    for (const c of this.conns) if (c.authed === authed) n++;
    return n >= (authed ? this.limits.maxConnections : this.limits.maxUnauthenticated);
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
    for (const channel of [...this.pendingDeltas.keys()]) this.flushDeltas(channel);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
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
    if (!conn.authed && text.length > this.limits.maxUnauthenticatedFrameBytes) {
      return this.drop(conn, 1009, "message too big");
    }
    if (!conn.allow(this.now(), this.limits.maxMessagesPerSecond)) {
      return this.drop(conn, 1008, "too many messages");
    }
    // Only a message that really carries an attachment may be bigger than the frame cap. A frame
    // that cannot be one is refused without being parsed; one that might be is parsed and checked.
    const big = text.length > this.limits.maxFrameBytes;
    if (big && !(text.includes('"dispatchAction"') && text.includes('"embeddedResource"'))) {
      return this.tooBig(conn, text);
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
    if (big && !carriesAttachment(msg)) return this.tooBig(conn, text);
    const id = msg.id;
    const isRequest = typeof id === "number" || typeof id === "string";
    const params = isObj(msg.params) ? msg.params : {};
    let result: unknown;
    const rejected = conn.rejects;
    try {
      result = this.dispatchMethod(conn, msg.method, params, isRequest);
      // A big frame that was refused, or went to a channel that isn't there, was not a proper attachment message.
      if (big && (conn.rejects > rejected || !this.chans.has(String(params.channel)))) this.strike(conn);
    } catch (e) {
      // A big frame that turns out not to be a proper attachment message counts as abuse.
      if (big) this.strike(conn);
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

  /** Refuses a frame over the cap with an error naming the request, and closes a connection that keeps doing it. */
  private tooBig(conn: Conn, text: string): void {
    const id = /"id"\s*:\s*(\d{1,15}|"[^"\\]{0,64}")/.exec(text.slice(0, 1024))?.[1];
    this.send(conn, {
      id: id === undefined ? null : (JSON.parse(id) as number | string),
      error: {
        code: JsonRpcErrorCodes.InvalidRequest,
        message: `message too large: at most ${this.limits.maxFrameBytes} bytes, unless it carries an attachment`,
      },
    });
    this.strike(conn);
  }

  /** One more oversized or malformed big message; a connection that keeps sending them is closed. */
  private strike(conn: Conn): void {
    if (++conn.abuse >= this.limits.maxAbuse) this.drop(conn, 1008, "too many oversized messages");
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
    // The spec has a client initialize first and authenticate after; until it has, it gets no state.
    if (!conn.authed && method !== "initialize") {
      throw new RpcError(AhpErrorCodes.AuthRequired, "authenticate first", { resources: [] });
    }
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
      // Into the authenticated pool, which may itself be full.
      if (this.full(true)) {
        queueMicrotask(() => this.drop(conn, 1013, "too many connections"));
        throw new RpcError(AhpErrorCodes.Conflict, "too many connections");
      }
      conn.authed = true;
      return null;
    }
    // Dropped after the error has gone out, so the client knows why.
    if (++conn.authFailures >= 3) queueMicrotask(() => this.drop(conn, 1008, "authentication failed"));
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
    // Before authenticating there is no state to subscribe to: the subscriptions come after.
    const initial =
      conn.authed && Array.isArray(p.initialSubscriptions) ? [...new Set(p.initialSubscriptions)] : [];
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
    const c = this.cs(ch);
    let state: unknown = c.state;
    conn.windows.delete(uri);
    if (c.kind === "chat" && typeof view?.turns === "number" && view.turns >= 0) {
      // A windowed snapshot: the last N completed turns and a cursor for the older ones.
      const turns = c.state.turns;
      const keep = Math.floor(view.turns);
      if (turns.length > keep) {
        const start = turns.length - keep;
        const cursor = `before:${keep === 0 ? "END" : turns[start]?.id}`;
        conn.windows.set(uri, cursor);
        state = { ...c.state, turns: turns.slice(start), turnsNextCursor: cursor };
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
    const subs = [
      ...new Set(
        Array.isArray(p.subscriptions)
          ? p.subscriptions.filter((u): u is string => typeof u === "string")
          : [],
      ),
    ];
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
    let opened: Awaited<ReturnType<AgentBackend["openSession"]>> | undefined;
    try {
      opened = await this.o.backend.openSession({
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
          meta: { session, active: false },
        });
      });
      const base = {
        sinceSnapshot: 0,
        lastSeq: this.seq,
        createdAt: now,
        bytes: 0,
        touched: ++this.tick,
        logBytes: 0,
        stateBytes: 0,
        snapshotAt: 0,
      };
      this.chans.set(session, {
        ...base,
        uri: session,
        kind: "session",
        initial: sessionInitial,
        c: { kind: "session", state: sessionInitial },
        meta: {},
      });
      this.chans.set(chat, {
        ...base,
        uri: chat,
        kind: "chat",
        initial: chatInitial,
        c: { kind: "chat", state: chatInitial },
        meta: { session, active: false },
      });
      this.chatSession.set(chat, session);
      this.apply(session, {
        type: ActionType.SessionChatAdded,
        summary: { resource: chat, title, status: SessionStatus.Idle, modifiedAt: stamp },
      });
      this.apply(session, { type: ActionType.SessionDefaultChatChanged, defaultChat: chat });
      this.apply(session, { type: ActionType.SessionReady });
      this.o.backend.afterCreate?.(session, chat);
      this.lastSummary.delete(session);
      this.noteSummary(session);
      const sum = this.summary(session);
      if (sum) this.notify(ROOT, "root/sessionAdded", { summary: sum });
      return { session, chat };
    } catch (e) {
      // The agent side opened but the session did not come to be: let the backend let go of it.
      if (opened && !this.chans.has(session)) await this.o.backend.closeSession(session).catch(() => {});
      throw e;
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
      meta: { session: sessionUri, active: false },
    });
    this.chans.set(chat, {
      uri: chat,
      kind: "chat",
      initial,
      c: { kind: "chat", state: initial },
      touched: ++this.tick,
      bytes: 0,
      createdAt: now,
      meta: { session: sessionUri, active: false },
      sinceSnapshot: 0,
      logBytes: 0,
      stateBytes: 0,
      snapshotAt: 0,
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
    conn.rejects++;
    this.send(conn, {
      method: "action",
      params: {
        channel,
        // Only what it was, not what it carried: a rejected action may be huge.
        action: { type: isObj(action) ? String(action.type).slice(0, 64) : "unknown" },
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
    const kind: ChannelKind = ch.kind;
    if (!a.type.startsWith(`${kind}/`)) return refuse(`${a.type} does not belong on a ${kind} channel`);
    const origin = { clientId: conn.clientId ?? `conn-${conn.id}`, clientSeq };
    try {
      this.dispatchChecked(conn, ch, a, origin, refuse);
    } catch (e) {
      if (e instanceof RpcError) refuse(e.message);
      else throw e;
    }
  }

  /**
   * What clients may do, action by action. Each case reads only the fields it knows, checks and caps
   * them, and applies a new object built from those: nothing a client adds rides along into the log,
   * the snapshots or the other clients.
   */
  private dispatchChecked(
    _conn: Conn,
    ch: Channel,
    a: StateAction,
    origin: NonNullable<ActionEnvelope["origin"]>,
    no: (why: string) => undefined,
  ): undefined {
    const channel = ch.uri;
    const raw = a as unknown as Json;
    const short = (v: unknown, name: string) => str(v, name, attachmentLimits.shortChars);
    const c = this.cs(ch);
    if (c.kind === "chat") {
      const st = c.state;
      switch (a.type) {
        case ActionType.ChatTurnStarted: {
          if (st.activeTurn) return no("a turn is already running: queue the message instead");
          const turnId = typeof a.turnId === "string" ? a.turnId : "";
          if (turnId.length === 0 || turnId.length > 128) return no("turnId must be a short string");
          if (st.turns.some((t) => t.id === turnId)) return no("that turn id was used already");
          if (
            typeof a.startedAt !== "string" ||
            a.startedAt.length > 64 ||
            Number.isNaN(Date.parse(a.startedAt))
          )
            return no("startedAt must be a timestamp");
          const message = this.checkMessage(a.message);
          this.startClientTurn(channel, { turnId, startedAt: a.startedAt, message }, origin);
          return;
        }
        case ActionType.ChatTurnCancelled: {
          if (!st.activeTurn || st.activeTurn.id !== a.turnId) return no("no such active turn");
          this.cancelTurn(channel, origin);
          return;
        }
        case ActionType.ChatToolCallConfirmed: {
          const toolCallId = short(raw.toolCallId, "toolCallId");
          const tc = st.activeTurn?.responseParts.find(
            (p) => p.kind === ResponsePartKind.ToolCall && p.toolCall.toolCallId === toolCallId,
          );
          const call = tc?.kind === ResponsePartKind.ToolCall ? tc.toolCall : undefined;
          // The first answer wins: afterwards the call is no longer pending, so the others land here.
          if (
            !st.activeTurn ||
            a.turnId !== st.activeTurn.id ||
            call?.status !== ToolCallStatus.PendingConfirmation
          ) {
            return no(`tool call ${toolCallId} is not waiting for an answer (someone answered it already)`);
          }
          const approved = raw.approved;
          if (typeof approved !== "boolean") return no("approved must be true or false");
          const selectedOptionId =
            raw.selectedOptionId === undefined ? undefined : short(raw.selectedOptionId, "selectedOptionId");
          let option = undefined as ToolAnswer["selectedOption"];
          if (selectedOptionId !== undefined) {
            option = call.options?.find((o) => o.id === selectedOptionId);
            if (!option) return no("that is not one of the options");
            if ((option.kind === ConfirmationOptionKind.Approve) !== approved)
              return no("the option and the answer disagree");
          }
          const base = { type: ActionType.ChatToolCallConfirmed, turnId: st.activeTurn.id, toolCallId };
          // Only the user's answer carries over: no edited input (ACP cannot take one), no other fields.
          let clean: Json;
          if (approved) {
            if (raw.confirmed !== ToolCallConfirmationReason.UserAction)
              return no("confirmed must be user-action");
            clean = { ...base, approved: true, confirmed: ToolCallConfirmationReason.UserAction };
          } else {
            if (
              raw.reason !== ToolCallCancellationReason.Denied &&
              raw.reason !== ToolCallCancellationReason.Skipped
            ) {
              return no("a denial needs a reason");
            }
            clean = {
              ...base,
              approved: false,
              reason: raw.reason,
              ...(typeof raw.reasonMessage === "string"
                ? { reasonMessage: raw.reasonMessage.slice(0, 2000) }
                : {}),
              ...(raw.userSuggestion !== undefined
                ? { userSuggestion: this.checkMessage(raw.userSuggestion) }
                : {}),
            };
          }
          if (selectedOptionId !== undefined) clean.selectedOptionId = selectedOptionId;
          this.apply(channel, clean as unknown as StateAction, origin);
          const run = this.runs.get(channel);
          if (run) {
            this.o.backend.answerToolCall(run.run, toolCallId, {
              approved,
              ...(selectedOptionId !== undefined ? { selectedOptionId } : {}),
              ...(option ? { selectedOption: option } : {}),
            });
          }
          return;
        }
        case ActionType.ChatPendingMessageSet: {
          if (raw.kind !== PendingMessageKind.Steering && raw.kind !== PendingMessageKind.Queued)
            return no("unknown pending message kind");
          const id = typeof raw.id === "string" ? raw.id : "";
          if (id.length === 0 || id.length > 128) return no("id must be a short string");
          const message = this.checkMessage(raw.message);
          this.apply(
            channel,
            { type: ActionType.ChatPendingMessageSet, kind: raw.kind, id, message },
            origin,
          );
          this.drain(channel);
          return;
        }
        case ActionType.ChatPendingMessageRemoved: {
          if (raw.kind !== PendingMessageKind.Steering && raw.kind !== PendingMessageKind.Queued)
            return no("unknown pending message kind");
          this.apply(
            channel,
            { type: ActionType.ChatPendingMessageRemoved, kind: raw.kind, id: short(raw.id, "id") },
            origin,
          );
          return;
        }
        case ActionType.ChatQueuedMessagesReordered: {
          const order = raw.order;
          if (!Array.isArray(order) || order.length > 200) return no("order must be a list of message ids");
          this.apply(
            channel,
            { type: ActionType.ChatQueuedMessagesReordered, order: order.map((x) => short(x, "order")) },
            origin,
          );
          return;
        }
        case ActionType.ChatIsReadChanged: {
          if (typeof raw.isRead !== "boolean") return no("isRead must be true or false");
          this.apply(channel, { type: ActionType.ChatIsReadChanged, isRead: raw.isRead }, origin);
          return;
        }
        case ActionType.ChatIsArchivedChanged: {
          if (typeof raw.isArchived !== "boolean") return no("isArchived must be true or false");
          this.apply(channel, { type: ActionType.ChatIsArchivedChanged, isArchived: raw.isArchived }, origin);
          return;
        }
        case ActionType.ChatDraftChanged: {
          const draft =
            raw.draft === undefined ? undefined : this.checkMessage(raw.draft, attachmentLimits.draftChars);
          this.apply(channel, { type: ActionType.ChatDraftChanged, ...(draft ? { draft } : {}) }, origin);
          return;
        }
        case ActionType.ChatInputAnswerChanged: {
          const requestId = short(raw.requestId, "requestId");
          const questionId = short(raw.questionId, "questionId");
          const request = this.openInput(st, requestId);
          if (!request) return no(`input request ${requestId} is not open (it was answered, or never asked)`);
          if (!request.questions?.some((q) => q.id === questionId))
            return no("no such question in that request");
          const answer = raw.answer === undefined ? undefined : this.checkAnswer(raw.answer);
          this.apply(
            channel,
            {
              type: ActionType.ChatInputAnswerChanged,
              requestId,
              questionId,
              ...(answer ? { answer } : {}),
            } as never,
            origin,
          );
          return;
        }
        case ActionType.ChatInputCompleted: {
          const requestId = short(raw.requestId, "requestId");
          // First wins, like a tool confirmation: once completed the request is no longer open.
          const request = this.openInput(st, requestId);
          if (!request)
            return no(`input request ${requestId} is not open (someone answered it already, or never asked)`);
          if (raw.response !== "accept" && raw.response !== "decline" && raw.response !== "cancel")
            return no("response must be accept, decline or cancel");
          const answers: Json = {};
          if (isObj(raw.answers)) {
            const entries = Object.entries(raw.answers);
            if (entries.length > 64) return no("too many answers");
            for (const [q, v] of entries) {
              if (!request.questions?.some((x) => x.id === q)) return no("no such question in that request");
              answers[q] = this.checkAnswer(v);
            }
          }
          this.apply(
            channel,
            {
              type: ActionType.ChatInputCompleted,
              requestId,
              response: raw.response,
              ...(Object.keys(answers).length ? { answers } : {}),
            } as never,
            origin,
          );
          const run = this.runs.get(channel);
          if (run) this.o.backend.answerInput?.(run.run, requestId, raw.response, answers);
          return;
        }
        default:
          return no(`${a.type} is not supported by this host`);
      }
    }
    if (c.kind === "session") {
      switch (a.type) {
        case ActionType.SessionTitleChanged: {
          if (typeof raw.title !== "string" || raw.title.trim().length === 0)
            return no("a title cannot be empty");
          this.apply(
            channel,
            { type: ActionType.SessionTitleChanged, title: raw.title.trim().slice(0, 200) },
            origin,
          );
          return;
        }
        case ActionType.SessionIsReadChanged: {
          if (typeof raw.isRead !== "boolean") return no("isRead must be true or false");
          this.apply(channel, { type: ActionType.SessionIsReadChanged, isRead: raw.isRead }, origin);
          return;
        }
        case ActionType.SessionIsArchivedChanged: {
          if (typeof raw.isArchived !== "boolean") return no("isArchived must be true or false");
          this.apply(
            channel,
            { type: ActionType.SessionIsArchivedChanged, isArchived: raw.isArchived },
            origin,
          );
          return;
        }
        case ActionType.SessionConfigChanged: {
          const config = c.state.config;
          const asked = isObj(raw.config) ? raw.config : undefined;
          if (!config || !asked) return no("this session has no config to change");
          if (raw.replace) return no("config values are changed one at a time");
          const keys = Object.keys(asked);
          if (keys.length === 0 || keys.length > 64) return no("change between 1 and 64 values");
          const values: Json = {};
          for (const k of keys) {
            const v = asked[k];
            const prop = config.schema.properties[k];
            if (!prop) return no(`unknown config ${k.slice(0, 64)}`);
            if (!prop.sessionMutable) return no(`${k} cannot be changed once the session has started`);
            if (
              !(v === null || ["string", "number", "boolean"].includes(typeof v)) ||
              (typeof v === "string" && v.length > 256)
            )
              return no(`${k} must be a short string, a number or a boolean`);
            if (prop.enum && !prop.enum.includes(v as never)) return no(`${String(v)} is not a valid ${k}`);
            values[k] = v;
          }
          const before = Object.fromEntries(keys.map((k) => [k, config.values[k]]));
          this.apply(channel, { type: ActionType.SessionConfigChanged, config: values }, origin);
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

  /** The input request with this id if it is still waiting for an answer in the running turn. */
  private openInput(st: ChatState, requestId: string) {
    for (const p of st.activeTurn?.responseParts ?? []) {
      if (
        p.kind === ResponsePartKind.InputRequest &&
        p.response === undefined &&
        p.request.id === requestId
      ) {
        return p.request;
      }
    }
    return undefined;
  }

  /** An answer to a question, as a small value of one of the known shapes. */
  private checkAnswer(v: unknown): never {
    if (!isObj(v) || typeof v.state !== "string") throw invalid("a bad answer");
    if (JSON.stringify(v).length > 16_000) throw invalid("an answer is at most 16 KB");
    if (v.state === "skipped") {
      const free = Array.isArray(v.freeformValues)
        ? v.freeformValues.filter((x) => typeof x === "string").slice(0, 16)
        : undefined;
      return { state: "skipped", ...(free ? { freeformValues: free } : {}) } as never;
    }
    if (
      (v.state !== "draft" && v.state !== "submitted") ||
      !isObj(v.value) ||
      typeof v.value.kind !== "string"
    )
      throw invalid("a bad answer");
    const val = v.value;
    const ok =
      (val.kind === "text" && typeof val.value === "string") ||
      (val.kind === "number" && typeof val.value === "number") ||
      (val.kind === "boolean" && typeof val.value === "boolean") ||
      (val.kind === "selected" && typeof val.value === "string") ||
      (val.kind === "selected-many" &&
        Array.isArray(val.value) &&
        val.value.every((x) => typeof x === "string"));
    if (!ok) throw invalid("a bad answer");
    const free = Array.isArray(val.freeformValues)
      ? val.freeformValues.filter((x) => typeof x === "string").slice(0, 16)
      : undefined;
    return {
      state: v.state,
      value: { kind: val.kind, value: val.value, ...(free ? { freeformValues: free } : {}) },
    } as never;
  }

  // ───────────────────────────── messages ─────────────────────────────

  /**
   * Checks what a client sent as a message and returns it in the form the log keeps: the text as
   * is, big embedded attachments moved into content blobs and replaced by references.
   */
  private checkMessage(m: unknown, maxText: number = attachmentLimits.textChars): Message {
    if (!isObj(m) || typeof m.text !== "string") throw invalid("a message needs text");
    if (m.text.length > maxText) throw invalid(`a message is at most ${maxText} characters`);
    if ((m.origin as Json | undefined)?.kind !== "user")
      throw invalid("a client's message must have the user origin");
    const attachments = m.attachments;
    if (attachments !== undefined && !Array.isArray(attachments)) throw invalid("attachments must be a list");
    if ((attachments?.length ?? 0) > attachmentLimits.count)
      throw invalid(`at most ${attachmentLimits.count} attachments`);
    const short = (v: unknown, name: string, max = attachmentLimits.shortChars) => str(v, name, max);
    const out: MessageAttachment[] = [];
    let total = 0;
    for (const raw of (attachments ?? []) as unknown[]) {
      if (!isObj(raw) || typeof raw.type !== "string") throw invalid("a bad attachment");
      const label = short(raw.label, "label");
      if (raw.type === "simple") {
        out.push({
          type: "simple",
          label,
          ...(typeof raw.modelRepresentation === "string"
            ? { modelRepresentation: raw.modelRepresentation.slice(0, 2000) }
            : {}),
        } as unknown as MessageAttachment);
        continue;
      }
      if (raw.type === "resource") {
        out.push({
          type: "resource",
          label,
          uri: short(raw.uri, "uri", 2048),
          ...(typeof raw.contentType === "string" ? { contentType: raw.contentType.slice(0, 128) } : {}),
          ...(typeof raw.sizeHint === "number" ? { sizeHint: raw.sizeHint } : {}),
        } as unknown as MessageAttachment);
        continue;
      }
      if (raw.type !== "embeddedResource") throw invalid(`${raw.type} attachments are not supported`);
      if (typeof raw.data !== "string" || typeof raw.contentType !== "string")
        throw invalid("a bad embedded attachment");
      const bytes = Buffer.from(raw.data, "base64");
      total += bytes.byteLength;
      if (total > attachmentLimits.totalBytes) throw invalid("attachments are at most 10 MB together");
      let contentType = raw.contentType.slice(0, 128);
      if (contentType.startsWith("image/")) {
        if (bytes.byteLength > attachmentLimits.imageBytes) throw invalid(`${label} is over 10 MB`);
        const kind = sniffImage(bytes);
        if (!kind) throw invalid(`${label} isn't a PNG, JPEG, WebP or GIF`);
        contentType = kind;
      } else if (bytes.byteLength > attachmentLimits.fileBytes) {
        throw invalid(`${label} is over 1 MB`);
      }
      if (raw.data.length <= attachmentLimits.inlineChars) {
        out.push({
          type: "embeddedResource",
          label,
          data: raw.data,
          contentType,
        } as unknown as MessageAttachment);
        continue;
      }
      const ref = this.putContent(bytes, contentType);
      out.push({
        type: "resource",
        label,
        uri: ref.uri,
        contentType: ref.contentType,
        sizeHint: ref.sizeHint,
        _meta: { "iinc.embedded": true },
      } as unknown as MessageAttachment);
    }
    return {
      text: m.text,
      origin: USER_ORIGIN,
      ...(out.length ? { attachments: out } : {}),
      ...(isObj(m.model) && typeof m.model.id === "string" && m.model.id.length <= 128
        ? { model: { id: m.model.id } }
        : {}),
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
          // (peeks at the state without sending waiting text: this runs for every piece of a stream)
          const state = this.chans.get(chat)?.c;
          const active = state?.kind === "chat" ? state.state.activeTurn : undefined;
          if (!live || live.turnId !== turnId || live.over || active?.id !== turnId) return false;
          const t = (action as { turnId?: string }).turnId;
          if (t !== undefined && t !== turnId) return false;
          try {
            this.emit(chat, action);
            return true;
          } catch (e) {
            // The write failed (disk full?): the state did not move, so the agent is told it was dropped.
            this.log(`ahp: dropped ${action.type} on ${chat}: ${e instanceof Error ? e.message : e}`);
            return false;
          }
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
      try {
        this.finishTurn(chat, run, outcome);
      } catch (e) {
        this.log(
          `ahp: could not record the end of turn ${turnId} on ${chat}: ${e instanceof Error ? e.message : e}`,
        );
      }
    })();
    run.done = done;
    this.tails.set(chat, done);
    void done.then(() => {
      if (this.runs.get(chat) === run) this.runs.delete(chat);
      try {
        this.drain(chat);
      } catch (e) {
        this.log(`ahp: could not start the next message on ${chat}: ${e instanceof Error ? e.message : e}`);
      }
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
