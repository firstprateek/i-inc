// A minimal AHP host: the daemon-side half of conversations.md, in about 600 lines.
//
//   AHP clients (WebSocket, JSON-RPC)  <->  AhpHost  <->  ACP agent (stdio)
//
// Authoritative state per channel (root, session, chat) is kept by running the OFFICIAL reducers from
// @microsoft/agent-host-protocol over a global, persisted action log. Everything agent-specific lives
// in map.ts. The transport (serve.ts) is a thin Bun.serve WebSocket wrapper around handle().
import {
  ActionType,
  type ActionEnvelope,
  AhpErrorCodes,
  type ChatAction,
  chatReducer,
  isClientDispatchable,
  JsonRpcErrorCodes,
  MessageKind,
  negotiateProtocolVersion,
  ResponsePartKind,
  rootReducer,
  sessionReducer,
  SessionLifecycle,
  SessionStatus,
  ToolCallStatus,
  TurnState,
  ConfirmationOptionKind,
} from "@microsoft/agent-host-protocol";
import { AcpConnection, type Json } from "./acp.ts";
import { configFromAcp, promptBlocks, TurnMapper } from "./map.ts";
import { Store } from "./store.ts";

const ROOT = "ahp-root://";
type Kind = "root" | "session" | "chat";
interface Chan {
  kind: Kind;
  state: any;
  sinceSnapshot: number;
}
export interface Conn {
  id: number;
  clientId?: string;
  subs: Set<string>;
  send(msg: unknown): void;
}
class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}
interface Run {
  turnId: string;
  startedAt: number;
  mapper: TurnMapper;
  permissions: Map<string, (outcome: Json) => void>;
  cancelled: boolean;
  usage?: Json;
  /** False until the previous turn's prompt has returned (ACP allows one prompt at a time per session). */
  live: boolean;
}
interface Live {
  conn: AcpConnection;
  caps: Json;
}

export interface HostOptions {
  dbPath: string;
  /** The ACP agent command (the daemon's machineLaunch). */
  agent: string[];
  snapshotEvery?: number;
  log?: (m: string) => void;
}

const reduce = (kind: Kind, state: any, action: any) =>
  kind === "chat" ? chatReducer(state, action) : kind === "session" ? sessionReducer(state, action) : rootReducer(state, action);

export class AhpHost {
  readonly store: Store;
  seq = 0;
  private chans = new Map<string, Chan>();
  private conns = new Set<Conn>();
  private lives = new Map<string, Live>(); // by session URI
  private runs = new Map<string, Run>(); // by chat URI
  private acpIds = new Map<string, string>(); // chat URI -> ACP sessionId
  private chatByAcp = new Map<string, string>();
  private log: (m: string) => void;

  constructor(private readonly o: HostOptions) {
    this.store = new Store(o.dbPath);
    this.log = o.log ?? (() => {});
    this.rebuild();
  }

  // ───────────────────────── state: rebuild, apply, broadcast ─────────────────────────

  /** Rebuild every channel: latest snapshot (or the recorded initial state) + the log tail, via the reducers. */
  private rebuild(): void {
    const rows = this.store.channels();
    if (!rows.some((r) => r.uri === ROOT)) {
      this.store.createChannel(ROOT, "root", { agents: this.agents() }, 0);
      rows.unshift({ uri: ROOT, kind: "root", initial: { agents: this.agents() }, created_seq: 0, meta: {} });
    }
    let tail = 0;
    for (const r of rows) {
      const snap = this.store.latestSnapshot(r.uri);
      let state = snap?.state ?? r.initial;
      const from = snap?.seq ?? r.created_seq;
      for (const a of this.store.channelActionsAfter(r.uri, from)) (state = reduce(r.kind as Kind, state, a.action)), tail++;
      this.chans.set(r.uri, { kind: r.kind as Kind, state, sinceSnapshot: 0 });
      if (r.meta?.acpSessionId) {
        this.acpIds.set(r.uri, r.meta.acpSessionId);
        this.chatByAcp.set(r.meta.acpSessionId, r.uri);
      }
    }
    this.seq = this.store.maxSeq();
    this.log(`rebuilt ${rows.length} channels at serverSeq ${this.seq}; replayed ${tail} actions after snapshots`);
    // Turns that were running when the host died are failed (spec: lifecycle, "Unexpected Disconnection").
    for (const [uri, c] of this.chans) {
      if (c.kind === "chat" && c.state.activeTurn) {
        const t = c.state.activeTurn;
        this.apply(uri, {
          type: ActionType.ChatError, turnId: t.id, duration: Math.max(0, Date.now() - Date.parse(t.startedAt)),
          part: { kind: ResponsePartKind.Error, resumable: false, error: { errorType: "host_restarted", message: "The host restarted while this turn was running." } },
        });
        this.log(`recovered interrupted turn ${t.id} on ${uri}`);
      }
    }
  }

  private agents() {
    return [{
      provider: "fake-acp", displayName: "Fake ACP agent", description: "Scripted ACP agent",
      models: [], capabilities: {},
    }];
  }

  state<T = any>(uri: string): T | undefined {
    return this.chans.get(uri)?.state;
  }

  /** Reduce, persist, broadcast: the only way state changes. Returns the sequenced envelope. */
  apply(channel: string, action: any, origin?: { clientId: string; clientSeq: number }): ActionEnvelope {
    const c = this.chans.get(channel);
    if (!c) throw new RpcError(AhpErrorCodes.SessionNotFound, `no channel ${channel}`);
    c.state = reduce(c.kind, c.state, action);
    const seq = ++this.seq;
    this.store.append({ seq, channel, action, origin, at: Date.now() });
    if (++c.sinceSnapshot >= (this.o.snapshotEvery ?? 50)) {
      this.store.snapshot(channel, seq, c.state);
      c.sinceSnapshot = 0;
    }
    const env: ActionEnvelope = { channel, action, serverSeq: seq, origin };
    for (const conn of this.conns) if (conn.subs.has(channel)) conn.send({ jsonrpc: "2.0", method: "action", params: env });
    if (c.kind === "chat") this.afterChatAction(channel);
    return env;
  }

  private notify(channel: string, method: string, params: Json): void {
    for (const conn of this.conns) if (conn.subs.has(channel)) conn.send({ jsonrpc: "2.0", method, params: { channel, ...params } });
  }

  private sessionOf(chat: string): string {
    for (const [uri, c] of this.chans) if (c.kind === "session" && c.state.chats.some((x: any) => x.resource === chat)) return uri;
    throw new RpcError(AhpErrorCodes.SessionNotFound, `chat ${chat} has no session`);
  }

  /** Keep the session catalog and the "needs you" roll-up consistent with a chat (spec: Chat aggregation). */
  private afterChatAction(chatUri: string): void {
    const chat = this.chans.get(chatUri)!.state;
    let sessionUri: string;
    try {
      sessionUri = this.sessionOf(chatUri);
    } catch {
      return;
    }
    const session = this.chans.get(sessionUri)!.state;
    const entry = session.chats.find((x: any) => x.resource === chatUri);
    const changes: Json = {};
    for (const k of ["status", "title", "activity", "modifiedAt"]) if (entry?.[k] !== chat[k]) changes[k] = chat[k];
    if (Object.keys(changes).length) {
      this.apply(sessionUri, { type: ActionType.SessionChatUpdated, chat: chatUri, changes });
      if ("status" in changes) {
        this.notify(ROOT, "root/sessionSummaryChanged", { session: sessionUri, changes: { status: chat.status } });
      }
    }
    // inputNeeded roll-up: one entry per pending tool confirmation
    const want = new Map<string, any>();
    for (const p of chat.activeTurn?.responseParts ?? []) {
      if (p.kind === ResponsePartKind.ToolCall && p.toolCall.status === ToolCallStatus.PendingConfirmation) {
        want.set(`${chatUri}#${p.toolCall.toolCallId}`, { id: `${chatUri}#${p.toolCall.toolCallId}`, chat: chatUri, kind: "toolConfirmation", turnId: chat.activeTurn.id, toolCall: p.toolCall });
      }
    }
    const have: any[] = (this.chans.get(sessionUri)!.state.inputNeeded ?? []).filter((r: any) => r.chat === chatUri);
    for (const r of have) if (!want.has(r.id)) this.apply(sessionUri, { type: ActionType.SessionInputNeededRemoved, id: r.id });
    for (const [id, r] of want) if (!have.some((h) => h.id === id)) this.apply(sessionUri, { type: ActionType.SessionInputNeededSet, request: r });
  }

  // ───────────────────────── JSON-RPC surface ─────────────────────────

  addConn(conn: Conn): void {
    this.conns.add(conn);
  }
  dropConn(conn: Conn): void {
    this.conns.delete(conn);
  }

  private snapshot(uri: string) {
    const c = this.chans.get(uri);
    if (!c) throw new RpcError(AhpErrorCodes.SessionNotFound, `no channel ${uri}`);
    return { resource: uri, state: c.state, fromSeq: this.seq };
  }

  /** One incoming text frame. Requests get a response; notifications don't. */
  async handle(conn: Conn, text: string): Promise<void> {
    let msg: Json;
    try {
      msg = JSON.parse(text);
    } catch {
      return conn.send({ jsonrpc: "2.0", id: null, error: { code: JsonRpcErrorCodes.ParseError, message: "parse error" } });
    }
    const isRequest = msg.id !== undefined;
    try {
      const result = await this.dispatchMethod(conn, String(msg.method), msg.params ?? {});
      if (isRequest) conn.send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    } catch (e) {
      if (!isRequest) return;
      const err = e instanceof RpcError ? e : new RpcError(JsonRpcErrorCodes.InternalError, String((e as Error)?.message ?? e));
      conn.send({ jsonrpc: "2.0", id: msg.id, error: { code: err.code, message: err.message, ...(err.data ? { data: err.data } : {}) } });
    }
  }

  private async dispatchMethod(conn: Conn, method: string, p: Json): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const v = negotiateProtocolVersion(p.protocolVersions ?? []);
        if (!v) throw new RpcError(AhpErrorCodes.UnsupportedProtocolVersion, "unsupported protocol version", { supportedVersions: ["1.0.0", "0.9.0"] });
        conn.clientId = p.clientId;
        const snapshots = (p.initialSubscriptions ?? []).filter((u: string) => this.chans.has(u)).map((u: string) => (conn.subs.add(u), this.snapshot(u)));
        return { protocolVersion: v, serverSeq: this.seq, serverInfo: { name: "i-inc-ahp-spike", version: "0.0.0" }, snapshots };
      }
      case "ping":
        return {};
      case "authenticate":
        // Our agents declare no protectedResources: nothing to push. (Transport auth happened at upgrade.)
        return {};
      case "subscribe": {
        const snap = this.snapshot(p.channel);
        conn.subs.add(p.channel);
        return { snapshot: snap };
      }
      case "unsubscribe":
        conn.subs.delete(p.channel);
        return;
      case "reconnect":
        return this.reconnect(conn, p);
      case "listSessions":
        return { items: [...this.chans].filter(([, c]) => c.kind === "session").map(([uri, c]) => this.summary(uri, c.state)) };
      case "createSession":
        return this.createSession(conn, p);
      case "createChat":
        await this.createChat(p.channel, p.chat ?? `ahp-chat:/${crypto.randomUUID()}`);
        return {};
      case "disposeSession":
        return this.disposeSession(p.channel);
      case "dispatchAction":
        return this.dispatch(conn, p.channel, p.clientSeq, p.action);
      case "resourceRead": {
        const m = /^ahp-content:\/(.+)$/.exec(String(p.uri));
        const blob = m && this.store.getBlob(m[1]!);
        if (!blob) throw new RpcError(JsonRpcErrorCodes.InvalidParams, `not found: ${p.uri}`);
        return { data: new TextDecoder().decode(blob.data), encoding: "utf-8", contentType: blob.mime };
      }
      case "completions": {
        const commands: Json[] = this.state(this.sessionOf(p.channel))?._meta?.["iinc.commands"] ?? [];
        const q = String(p.text).slice(0, p.offset);
        const word = /\/(\w*)$/.exec(q)?.[1];
        if (word === undefined) return { items: [] };
        return {
          items: commands.filter((c) => c.name.startsWith(word)).map((c) => ({
            insertText: `/${c.name}`, rangeStart: q.length - word.length - 1, rangeEnd: q.length,
            attachment: { type: "simple", label: `/${c.name}`, modelRepresentation: `/${c.name}` },
          })),
        };
      }
      case "fetchTurns":
        return {};
      default:
        throw new RpcError(JsonRpcErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  private summary(uri: string, s: any) {
    const { lifecycle: _l, activeClients: _a, config: _c, inputNeeded: _i, ...meta } = s;
    return { resource: uri, createdAt: s.chats[0]?.modifiedAt ?? new Date().toISOString(), modifiedAt: s.chats[0]?.modifiedAt ?? new Date().toISOString(), ...meta };
  }

  /** reconnect: replay the log tail for the client's subscriptions, or fresh snapshots if the tail was pruned. */
  private reconnect(conn: Conn, p: Json) {
    conn.clientId = p.clientId;
    const subs: string[] = p.subscriptions ?? [];
    const missing = subs.filter((u) => !this.chans.has(u));
    const live = subs.filter((u) => this.chans.has(u));
    if (p.lastSeenServerSeq < this.store.floor()) {
      for (const u of live) conn.subs.add(u);
      return { type: "snapshot", snapshots: live.map((u) => this.snapshot(u)) };
    }
    for (const u of live) conn.subs.add(u); // sync handler: nothing can interleave with the replay below
    const actions = this.store.actionsAfter(p.lastSeenServerSeq, live).map((r) => ({
      channel: r.channel, action: r.action, serverSeq: r.seq, origin: r.origin,
    }));
    return { type: "replay", actions, missing };
  }

  // ───────────────────────── sessions and chats ─────────────────────────

  private async ensureLive(sessionUri: string): Promise<Live> {
    const have = this.lives.get(sessionUri);
    if (have && !have.conn.exited) return have;
    const conn = new AcpConnection(this.o.agent);
    conn.onNotification = (m, params) => m === "session/update" && this.onUpdate(params);
    conn.onRequest = (m, params) => this.onAgentRequest(m, params);
    const init = await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "i.inc", version: "0.1.0" },
    });
    if (init.error) throw new RpcError(JsonRpcErrorCodes.InternalError, `agent did not start: ${init.error.message}`);
    const live = { conn, caps: init.result?.agentCapabilities ?? {} };
    this.lives.set(sessionUri, live);
    return live;
  }

  /** Make the ACP session for a chat exist: session/load when we have an id and the agent can, else session/new. */
  private async ensureAcpSession(sessionUri: string, chatUri: string): Promise<Json> {
    const live = await this.ensureLive(sessionUri);
    const known = this.acpIds.get(chatUri);
    const cwd = this.o.agent.length ? process.cwd() : "/";
    if (known && this.chatByAcp.get(known) === chatUri && this.loaded.has(chatUri)) return {};
    if (known && live.caps.loadSession) {
      const r = await live.conn.request("session/load", { sessionId: known, cwd, mcpServers: [] });
      if (!r.error) {
        this.loaded.add(chatUri);
        this.log(`resumed ${chatUri} with session/load(${known})`);
        return r.result ?? {};
      }
    }
    const r = await live.conn.request("session/new", { cwd, mcpServers: [] });
    if (r.error) throw new RpcError(JsonRpcErrorCodes.InternalError, `session/new failed: ${r.error.message}`);
    const id = String(r.result.sessionId);
    this.acpIds.set(chatUri, id);
    this.chatByAcp.set(id, chatUri);
    this.loaded.add(chatUri);
    this.store.setMeta(chatUri, { acpSessionId: id, sessionUri });
    return r.result;
  }
  private loaded = new Set<string>();
  private tails = new Map<string, Promise<void>>();

  private async createSession(conn: Conn, p: Json) {
    const uri: string = p.channel;
    if (this.chans.has(uri)) throw new RpcError(AhpErrorCodes.SessionAlreadyExists, "session exists");
    if (p.provider && p.provider !== "fake-acp") throw new RpcError(AhpErrorCodes.ProviderNotFound, `no provider ${p.provider}`);
    const now = new Date().toISOString();
    const initial = {
      provider: "fake-acp", title: "New session", status: SessionStatus.Idle, lifecycle: SessionLifecycle.Creating,
      workingDirectories: p.workingDirectories, activeClients: [], chats: [],
    };
    this.store.createChannel(uri, "session", initial, this.seq);
    this.chans.set(uri, { kind: "session", state: initial, sinceSnapshot: 0 });
    const chatUri = `ahp-chat:/${crypto.randomUUID()}`;
    try {
      const first = await this.createChat(uri, chatUri, true);
      // The session's config schema comes from what the ACP agent advertised (modes + select options).
      const cfg = configFromAcp(first.modes, first.configOptions);
      // GAP: no action sets the config *schema* after creation; we rebuild the creation record instead.
      this.chans.get(uri)!.state = { ...this.chans.get(uri)!.state, config: cfg };
      this.store.snapshot(uri, this.seq, this.chans.get(uri)!.state);
      if (p.config) this.apply(uri, { type: ActionType.SessionConfigChanged, config: p.config });
      this.apply(uri, { type: ActionType.SessionDefaultChatChanged, defaultChat: chatUri });
      this.apply(uri, { type: ActionType.SessionReady });
    } catch (e) {
      this.apply(uri, { type: ActionType.SessionCreationFailed, error: { errorType: "creation_failed", message: String((e as Error).message) } });
      throw e;
    }
    this.notify(ROOT, "root/sessionAdded", { summary: this.summary(uri, this.state(uri)) });
    return {};
  }

  private async createChat(sessionUri: string, chatUri: string, isDefault = false): Promise<Json> {
    if (!this.chans.has(sessionUri)) throw new RpcError(AhpErrorCodes.SessionNotFound, "no such session");
    const acp = await this.ensureAcpSessionFor(sessionUri, chatUri);
    const now = new Date().toISOString();
    const initial = { resource: chatUri, title: "New chat", status: SessionStatus.Idle, modifiedAt: now, turns: [] };
    this.store.createChannel(chatUri, "chat", initial, this.seq, { acpSessionId: this.acpIds.get(chatUri), sessionUri });
    this.chans.set(chatUri, { kind: "chat", state: initial, sinceSnapshot: 0 });
    this.apply(sessionUri, {
      type: ActionType.SessionChatAdded,
      summary: { resource: chatUri, title: initial.title, status: initial.status, modifiedAt: now },
    });
    return acp;
  }

  /** createChat before the chat channel exists: bind the ACP session first (the chat URI is known). */
  private async ensureAcpSessionFor(sessionUri: string, chatUri: string): Promise<Json> {
    return this.ensureAcpSession(sessionUri, chatUri);
  }

  private disposeSession(uri: string) {
    this.lives.get(uri)?.conn.kill();
    this.lives.delete(uri);
    return {};
  }

  // ───────────────────────── client actions ─────────────────────────

  private reject(conn: Conn, channel: string, clientSeq: number, action: any, reason: string): void {
    // Rejected actions are echoed to the sender only, carry the current serverSeq, and don't consume one.
    conn.send({
      jsonrpc: "2.0", method: "action",
      params: { channel, action, serverSeq: this.seq, origin: { clientId: conn.clientId, clientSeq }, rejectionReason: reason },
    });
  }

  private dispatch(conn: Conn, channel: string, clientSeq: number, action: any): void {
    const c = this.chans.get(channel);
    if (!c) return; // spec: silently ignore actions for unknown channels
    const dispatchable: boolean = isClientDispatchable(action);
    if (!dispatchable) return this.reject(conn, channel, clientSeq, action, `${action.type} is not client-dispatchable`);
    const origin = { clientId: conn.clientId ?? `conn-${conn.id}`, clientSeq };
    const st = c.state;
    switch (action.type) {
      case ActionType.ChatTurnStarted: {
        if (st.activeTurn) return this.reject(conn, channel, clientSeq, action, "a turn is already running (queue the message instead)");
        this.apply(channel, action, origin);
        void this.runTurn(channel, action);
        return;
      }
      case ActionType.ChatTurnCancelled: {
        if (!st.activeTurn || st.activeTurn.id !== action.turnId) return this.reject(conn, channel, clientSeq, action, "no such active turn");
        this.apply(channel, { ...action, duration: Date.now() - Date.parse(st.activeTurn.startedAt) }, origin);
        this.cancelRun(channel);
        return;
      }
      case ActionType.ChatToolCallConfirmed: {
        const tc = st.activeTurn?.responseParts.find((p: any) => p.kind === ResponsePartKind.ToolCall && p.toolCall.toolCallId === action.toolCallId)?.toolCall;
        // First confirmation wins: afterwards the call is no longer pending-confirmation.
        if (tc?.status !== ToolCallStatus.PendingConfirmation) return this.reject(conn, channel, clientSeq, action, `tool call ${action.toolCallId} is not awaiting confirmation (already answered)`);
        this.apply(channel, action, origin);
        const run = this.runs.get(channel);
        run?.mapper.confirmed(action.toolCallId, action.approved);
        run?.permissions.get(action.toolCallId)?.(run.mapper.permissionOutcome(action.toolCallId, action.approved, action.selectedOptionId));
        run?.permissions.delete(action.toolCallId);
        return;
      }
      case ActionType.SessionConfigChanged: {
        const props = st.config?.schema.properties ?? {};
        for (const [k, v] of Object.entries(action.config as Json)) {
          const prop = props[k];
          if (!prop?.sessionMutable) return this.reject(conn, channel, clientSeq, action, `config ${k} is not mutable`);
          if (prop.enum && !prop.enum.includes(v)) return this.reject(conn, channel, clientSeq, action, `${String(v)} is not a valid ${k}`);
        }
        this.apply(channel, action, origin);
        void this.pushConfigToAgent(channel, action.config);
        return;
      }
      case ActionType.ChatPendingMessageSet:
      case ActionType.ChatPendingMessageRemoved:
      case ActionType.ChatQueuedMessagesReordered:
      case ActionType.ChatDraftChanged:
      case ActionType.ChatIsReadChanged:
      case ActionType.ChatIsArchivedChanged:
      case ActionType.SessionTitleChanged:
      case ActionType.SessionIsReadChanged:
      case ActionType.SessionIsArchivedChanged: {
        this.apply(channel, action, origin);
        if (action.type === ActionType.ChatPendingMessageSet) this.drainQueue(channel);
        return;
      }
      default:
        return this.reject(conn, channel, clientSeq, action, `${action.type} is not supported by this host`);
    }
  }

  private async pushConfigToAgent(sessionUri: string, config: Json) {
    const live = this.lives.get(sessionUri);
    if (!live) return;
    for (const chat of this.state(sessionUri).chats) {
      const sessionId = this.acpIds.get(chat.resource);
      if (!sessionId) continue;
      for (const [k, v] of Object.entries(config)) {
        if (k === "mode") await live.conn.request("session/set_mode", { sessionId, modeId: v });
        else await live.conn.request("session/set_config_option", { sessionId, configId: k, value: v });
      }
    }
  }

  // ───────────────────────── turns ─────────────────────────

  private async runTurn(chatUri: string, started: any): Promise<void> {
    const sessionUri = this.sessionOf(chatUri);
    const turnId: string = started.turnId;
    const emit = (a: ChatAction) => {
      const s = this.state(chatUri);
      if (s.activeTurn?.id === turnId) this.apply(chatUri, a); // late updates after a cancel are dropped
    };
    const mapper = new TurnMapper(
      turnId,
      emit,
      (text, mime = "text/plain") => {
        const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32);
        this.store.putBlob(hash, mime, new TextEncoder().encode(text));
        return { uri: `ahp-content:/${hash}`, sizeHint: text.length, contentType: mime };
      },
      (kind, u) => this.onSideUpdate(sessionUri, chatUri, kind, u),
    );
    const run: Run = { turnId, startedAt: Date.parse(started.startedAt), mapper, permissions: new Map(), cancelled: false, live: false };
    this.runs.set(chatUri, run);
    const previous = this.tails.get(chatUri) ?? Promise.resolve();
    let release!: () => void;
    this.tails.set(chatUri, new Promise<void>((r) => (release = r)));
    // Auto-title from the first message (GAP: no chat/titleChanged action; the session title carries it).
    if (this.state(chatUri).turns.length === 0 && this.state(sessionUri).title === "New session") {
      this.apply(sessionUri, { type: ActionType.SessionTitleChanged, title: String(started.message.text).slice(0, 60) });
    }
    try {
      await previous;
      run.live = true;
      await this.ensureAcpSession(sessionUri, chatUri);
      const live = this.lives.get(sessionUri)!;
      const res = await live.conn.request("session/prompt", { sessionId: this.acpIds.get(chatUri), prompt: promptBlocks(started.message) });
      const duration = Date.now() - run.startedAt;
      if (this.state(chatUri).activeTurn?.id !== turnId) return; // already ended by a client-dispatched cancel
      if (res.error) {
        this.apply(chatUri, {
          type: ActionType.ChatError, turnId, duration,
          part: { kind: ResponsePartKind.Error, resumable: false, error: { errorType: "agent_error", message: String(res.error.message) } },
        });
        return;
      }
      const usage = res.result?._meta?.usage;
      if (usage || run.usage) {
        this.apply(chatUri, { type: ActionType.ChatUsage, turnId, usage: { ...usage, ...(run.usage ? { _meta: run.usage } : {}) } });
      }
      const stop = String(res.result?.stopReason ?? "end_turn");
      if (stop === "end_turn") mapper.finish();
      if (stop === "cancelled") this.apply(chatUri, { type: ActionType.ChatTurnCancelled, turnId, duration });
      else if (stop === "end_turn") this.apply(chatUri, { type: ActionType.ChatTurnComplete, turnId, duration });
      else this.apply(chatUri, {
        type: ActionType.ChatError, turnId, duration,
        part: { kind: ResponsePartKind.Error, resumable: false, error: { errorType: stop, message: `The agent stopped: ${stop}` } },
      });
    } catch (e) {
      if (this.state(chatUri).activeTurn?.id === turnId) {
        this.apply(chatUri, {
          type: ActionType.ChatError, turnId, duration: Date.now() - run.startedAt,
          part: { kind: ResponsePartKind.Error, resumable: false, error: { errorType: "host_error", message: String((e as Error).message) } },
        });
      }
    } finally {
      mapper.closed = true;
      if (this.runs.get(chatUri) === run) this.runs.delete(chatUri);
      release();
      this.drainQueue(chatUri);
    }
  }

  private cancelRun(chatUri: string): void {
    const run = this.runs.get(chatUri);
    if (!run) return;
    run.cancelled = true;
    // ACP: answer outstanding permission requests with `cancelled`, then notify session/cancel.
    for (const resolve of run.permissions.values()) resolve({ outcome: "cancelled" });
    run.permissions.clear();
    const sessionUri = this.sessionOf(chatUri);
    this.lives.get(sessionUri)?.conn.notify("session/cancel", { sessionId: this.acpIds.get(chatUri) });
  }

  /** Queued messages (and, for lack of mid-turn injection in ACP, steering ones) start as the next turn. */
  private drainQueue(chatUri: string): void {
    const s = this.state(chatUri);
    if (s.activeTurn || !s.queuedMessages?.length) return;
    const next = s.queuedMessages.find((m: any) => m.kind === "steering") ?? s.queuedMessages[0];
    const started = { type: ActionType.ChatTurnStarted, turnId: crypto.randomUUID(), startedAt: new Date().toISOString(), message: next.message, queuedMessageId: next.id };
    this.apply(chatUri, started);
    void this.runTurn(chatUri, started);
  }

  // ───────────────────────── ACP -> host callbacks ─────────────────────────

  private onUpdate(params: Json): void {
    const chatUri = this.chatByAcp.get(params.sessionId);
    if (!chatUri) return;
    const run = this.runs.get(chatUri);
    const u = params.update as Json;
    if (run?.live) run.mapper.update(u);
    else if (["current_mode_update", "config_option_update", "available_commands_update"].includes(u.sessionUpdate)) {
      this.onSideUpdate(this.sessionOf(chatUri), chatUri, u.sessionUpdate, u);
    } // anything else outside a turn is a session/load replay or a late update: dropped
  }

  private onSideUpdate(sessionUri: string, _chat: string, kind: string, u: Json): void {
    const s = this.state(sessionUri);
    if (kind === "current_mode_update" && s.config?.values.mode !== u.currentModeId) {
      this.apply(sessionUri, { type: ActionType.SessionConfigChanged, config: { mode: u.currentModeId } });
    } else if (kind === "config_option_update") {
      const values: Json = {};
      for (const o of (u.configOptions ?? []) as Json[]) if (o.type === "select" && s.config?.values[o.id] !== o.currentValue) values[o.id] = o.currentValue;
      if (Object.keys(values).length) this.apply(sessionUri, { type: ActionType.SessionConfigChanged, config: values });
    } else if (kind === "available_commands_update") {
      // GAP: no first-class slash-command list; kept in session _meta and served through `completions`.
      this.apply(sessionUri, { type: ActionType.SessionMetaChanged, _meta: { ...s._meta, "iinc.commands": u.availableCommands } });
    } else if (kind === "usage") {
      const run = this.runs.get(_chat);
      if (run) run.usage = { contextUsed: u.used, contextSize: u.size };
    }
  }

  private onAgentRequest(method: string, params: Json): Promise<unknown> {
    if (method !== "session/request_permission") return Promise.reject(new Error(`not offered: ${method}`));
    const chatUri = this.chatByAcp.get(params.sessionId);
    const run = chatUri ? this.runs.get(chatUri) : undefined;
    if (!chatUri || !run?.live) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    return new Promise((resolve) => {
      const toolCallId = String(params.toolCall.toolCallId);
      run.permissions.set(toolCallId, (outcome: Json) => resolve({ outcome }));
      run.mapper.permission(params);
    });
  }

  /** Snapshot every channel at the current serverSeq and drop the log below it. Reconnects older than this get snapshots. */
  pruneToSnapshots(): void {
    for (const [uri, c] of this.chans) this.store.snapshot(uri, this.seq, c.state);
    this.store.prune(this.seq);
    this.log(`pruned action log up to serverSeq ${this.seq}`);
  }

  close(): void {
    for (const l of this.lives.values()) l.conn.kill();
    this.lives.clear();
    this.store.close();
  }

  /** Test hook: ACP agent pids. */
  pids(): number[] {
    return [...this.lives.values()].map((l) => l.conn.pid);
  }
}
