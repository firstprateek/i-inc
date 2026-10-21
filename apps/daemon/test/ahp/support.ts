// Test kit for the AHP host: a fake socket, a client that mirrors state with the official reducers (the
// way a real client does), and a scripted agent backend. No ACP, no processes.
import type { AgentInfo, Message, SessionConfigState } from "@microsoft/agent-host-protocol";
import type {
  AgentBackend,
  OpenedSession,
  OpenSessionRequest,
  ToolAnswer,
  TurnOutcome,
  TurnRun,
} from "../../src/ahp/backend.ts";
import { AhpHost, type Conn, type HostOptions, type Socket } from "../../src/ahp/host.ts";
import {
  ActionType,
  type ChannelState,
  type ChatAction,
  ConfirmationOptionKind,
  type Json,
  ResponsePartKind,
  ROOT,
  reduce,
  type StateAction,
  ToolCallConfirmationReason,
  ToolCallStatus,
  USER_ORIGIN,
} from "../../src/ahp/wire.ts";
import { openDb } from "../../src/db.ts";

// biome-ignore lint/suspicious/noExplicitAny: tests read protocol JSON loosely, the way a client would.
export type Any = any;

export class FakeSocket implements Socket {
  /** Every frame the host sent, parsed. */
  frames: Json[] = [];
  buffered = 0;
  closed: { code: number | undefined; reason: string | undefined } | undefined;
  pings = 0;
  throwOnSend = false;
  send(text: string): void {
    if (this.throwOnSend) throw new Error("socket is gone");
    this.frames.push(JSON.parse(text) as Json);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  ping(): void {
    this.pings++;
  }
}

export interface Envelope {
  channel: string;
  action: Json & { type: string };
  serverSeq: number;
  origin?: { clientId: string; clientSeq: number };
  rejectionReason?: string;
}

/** A client: sends frames to the host, mirrors the channels it subscribed to with the official reducers. */
export class TestClient {
  readonly socket = new FakeSocket();
  readonly conn: Conn;
  private nextId = 1;
  private clientSeq = 1;
  readonly states = new Map<string, ChannelState>();
  lastSeq = 0;
  /** Action envelopes received, in order (rejections included). */
  readonly envelopes: Envelope[] = [];
  /** Notifications other than actions. */
  readonly notes: Json[] = [];
  private cursor = 0;

  constructor(
    readonly host: AhpHost,
    readonly clientId = `client-${Math.random().toString(36).slice(2, 8)}`,
    authed = true,
  ) {
    const conn = host.connect(this.socket, authed);
    if (!conn) throw new Error("the host refused the connection");
    this.conn = conn;
  }

  /** Sends a request and returns the response frame (`result` or `error`). */
  async rpc(method: string, params: Json = {}): Promise<Json> {
    const id = this.nextId++;
    await this.host.receive(this.conn, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const res = this.socket.frames.find((f) => f.id === id);
    if (!res) throw new Error(`no response to ${method}`);
    this.absorb();
    return res;
  }

  /** Like rpc, but throws on an error response and returns the result. */
  async call(method: string, params: Json = {}): Promise<Any> {
    const res = await this.rpc(method, params);
    if (res.error) throw new Error(`${method}: ${JSON.stringify(res.error)}`);
    return res.result;
  }

  notify(method: string, params: Json): void {
    void this.host.receive(this.conn, JSON.stringify({ jsonrpc: "2.0", method, params }));
    this.absorb();
  }

  async init(subs: string[] = [ROOT]): Promise<Any> {
    const r = await this.call("initialize", {
      channel: ROOT,
      protocolVersions: ["1.0.0"],
      clientId: this.clientId,
      initialSubscriptions: subs,
    });
    this.lastSeq = r.serverSeq;
    for (const s of r.snapshots)
      this.states.set(s.resource, { kind: kindOf(s.resource), state: s.state } as ChannelState);
    this.absorb();
    return r;
  }

  async subscribe(channel: string, view?: Json): Promise<Any> {
    const r = await this.call("subscribe", { channel, ...(view ? { view } : {}) });
    this.states.set(channel, { kind: kindOf(channel), state: r.snapshot.state } as ChannelState);
    this.lastSeq = Math.max(this.lastSeq, r.snapshot.fromSeq);
    this.absorb();
    return r;
  }

  /** Dispatches a client action (write-ahead: applied locally only when the host echoes it). */
  dispatch(channel: string, action: Json): number {
    const clientSeq = this.clientSeq++;
    this.notify("dispatchAction", { channel, clientSeq, action });
    return clientSeq;
  }

  /** Applies frames received since the last call to the mirrored state. */
  absorb(): void {
    for (; this.cursor < this.socket.frames.length; this.cursor++) {
      const f = this.socket.frames[this.cursor] as Json;
      if (f.method === "action") {
        const env = f.params as Envelope;
        this.envelopes.push(env);
        if (env.rejectionReason) continue;
        const c = this.states.get(env.channel);
        if (c) this.states.set(env.channel, reduce(c, env.action as unknown as StateAction));
        if (env.serverSeq > this.lastSeq) this.lastSeq = env.serverSeq;
      } else if (typeof f.method === "string") {
        this.notes.push(f);
      }
    }
  }

  /** Actions received (not rejections) for a channel. */
  actions(channel?: string): Envelope[] {
    this.absorb();
    return this.envelopes.filter((e) => !e.rejectionReason && (!channel || e.channel === channel));
  }
  rejections(): Envelope[] {
    this.absorb();
    return this.envelopes.filter((e) => e.rejectionReason);
  }
  state<T = Any>(channel: string): T {
    this.absorb();
    return this.states.get(channel)?.state as T;
  }

  /** Sends reconnect on this (fresh) connection and applies the result like a real client. */
  async reconnect(lastSeen: number, subs: string[]): Promise<Any> {
    const r = await this.call("reconnect", {
      channel: ROOT,
      clientId: this.clientId,
      lastSeenServerSeq: lastSeen,
      subscriptions: subs,
    });
    if (r.type === "snapshot") {
      for (const s of r.snapshots)
        this.states.set(s.resource, { kind: kindOf(s.resource), state: s.state } as ChannelState);
      this.lastSeq = r.snapshots.length ? Math.max(...r.snapshots.map((s: Any) => s.fromSeq)) : lastSeen;
    } else {
      for (const e of r.actions as Envelope[]) {
        const c = this.states.get(e.channel);
        if (c) this.states.set(e.channel, reduce(c, e.action as unknown as StateAction));
        this.lastSeq = Math.max(this.lastSeq, e.serverSeq);
      }
    }
    this.absorb();
    return r;
  }

  disconnect(): void {
    this.host.disconnect(this.conn);
  }
}

export const kindOf = (uri: string): "root" | "session" | "chat" =>
  uri === ROOT ? "root" : uri.startsWith("ahp-session:") ? "session" : "chat";

export const userMessage = (text: string, extra: Json = {}): Message =>
  ({ text, origin: USER_ORIGIN, ...extra }) as Message;

export function turnStarted(text: string, turnId: string = crypto.randomUUID(), extra: Json = {}): Json {
  return {
    type: ActionType.ChatTurnStarted,
    turnId,
    startedAt: new Date().toISOString(),
    message: userMessage(text, extra),
  };
}

/** A deferred value, to hold a scripted agent at a point until the test lets it go. */
export function gate<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export const modes = [
  { id: "ask", name: "Always ask" },
  { id: "edits", name: "Accept edits" },
  { id: "plan", name: "Plan only" },
  { id: "bypass", name: "Bypass permissions" },
];

export const agentConfig = (): SessionConfigState => ({
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        title: "Mode",
        sessionMutable: true,
        enum: modes.map((m) => m.id),
        enumLabels: modes.map((m) => m.name),
      },
      model: { type: "string", title: "Model", sessionMutable: false, enum: ["a", "b"] },
    },
  },
  values: { mode: "bypass", model: "a" },
});

export type Script = (run: TurnRun, backend: ScriptedBackend) => Promise<TurnOutcome>;

/** An agent backend whose turns are scripts that stream the chat actions a test wants. */
export class ScriptedBackend implements AgentBackend {
  script: Script = async (run) => {
    this.text(run, "Hello");
    return { kind: "complete" };
  };
  multipleChats = false;
  withConfig = true;
  failOpen: Error | undefined;
  failSetConfig: Error | undefined;
  opened: OpenSessionRequest[] = [];
  closed: string[] = [];
  closedChats: string[] = [];
  configs: Json[] = [];
  answers: { toolCallId: string; answer: ToolAnswer }[] = [];
  cancelled: TurnRun[] = [];
  runs: TurnRun[] = [];
  private confirmations = new Map<string, (a: ToolAnswer) => void>();

  agents(): AgentInfo[] {
    return [
      {
        provider: "fake",
        displayName: "Fake agent",
        description: "Scripted",
        models: [],
        capabilities: this.multipleChats ? { multipleChats: {} } : {},
      },
    ];
  }
  async openSession(req: OpenSessionRequest): Promise<OpenedSession> {
    if (this.failOpen) throw this.failOpen;
    this.opened.push(req);
    return this.withConfig ? { config: agentConfig() } : {};
  }
  async openChat(): Promise<void> {}
  async closeChat(_s: string, chat: string): Promise<void> {
    this.closedChats.push(chat);
  }
  async closeSession(session: string): Promise<void> {
    this.closed.push(session);
  }
  runTurn(run: TurnRun): Promise<TurnOutcome> {
    this.runs.push(run);
    return this.script(run, this);
  }
  cancelTurn(run: TurnRun): void {
    this.cancelled.push(run);
  }
  answerToolCall(_run: TurnRun, toolCallId: string, answer: ToolAnswer): void {
    this.answers.push({ toolCallId, answer });
    this.confirmations.get(toolCallId)?.(answer);
  }
  async setConfig(_session: string, values: Json): Promise<void> {
    this.configs.push(values);
    if (this.failSetConfig) throw this.failSetConfig;
  }

  // Script helpers
  text(run: TurnRun, content: string, id = `${run.turnId}:md`): void {
    run.emit({
      type: ActionType.ChatResponsePart,
      turnId: run.turnId,
      part: { kind: ResponsePartKind.Markdown, id, content },
    });
  }
  delta(run: TurnRun, content: string, id = `${run.turnId}:md`): void {
    run.emit({ type: ActionType.ChatDelta, turnId: run.turnId, partId: id, content });
  }
  tool(run: TurnRun, id: string, name = "execute", title = `Run ${id}`): void {
    run.emit({
      type: ActionType.ChatToolCallStart,
      turnId: run.turnId,
      toolCallId: id,
      toolName: name,
      displayName: title,
    });
    run.emit({
      type: ActionType.ChatToolCallReady,
      turnId: run.turnId,
      toolCallId: id,
      invocationMessage: title,
      confirmed: ToolCallConfirmationReason.NotNeeded,
    });
  }
  done(run: TurnRun, id: string, text = "ok", success = true): void {
    run.emit({
      type: ActionType.ChatToolCallComplete,
      turnId: run.turnId,
      toolCallId: id,
      result: { success, pastTenseMessage: "Ran", content: [{ type: "text", text } as never] },
    });
  }
  /** A tool call that waits for the owner: pending-confirmation with the four ACP-style options. */
  ask(run: TurnRun, id: string): Promise<ToolAnswer> {
    run.emit({
      type: ActionType.ChatToolCallStart,
      turnId: run.turnId,
      toolCallId: id,
      toolName: "execute",
      displayName: "Run rm -rf build",
    });
    run.emit({
      type: ActionType.ChatToolCallReady,
      turnId: run.turnId,
      toolCallId: id,
      invocationMessage: "Run rm -rf build",
      confirmationTitle: "Run rm -rf build",
      options: [
        { id: "allow-once", label: "Allow once", kind: ConfirmationOptionKind.Approve, group: 0 },
        { id: "allow-always", label: "Always allow", kind: ConfirmationOptionKind.Approve, group: 1 },
        { id: "reject-once", label: "Deny", kind: ConfirmationOptionKind.Deny, group: 0 },
        { id: "reject-always", label: "Always deny", kind: ConfirmationOptionKind.Deny, group: 1 },
      ],
    });
    return new Promise((resolve) => this.confirmations.set(id, resolve));
  }
}

export interface Rig {
  host: AhpHost;
  backend: ScriptedBackend;
  db: Awaited<ReturnType<typeof openDb>>;
  client(id?: string): TestClient;
  /** Creates a conversation-less session directly and returns its URIs. */
  session(): Promise<{ session: string; chat: string }>;
  time: { now: number };
}

export async function rig(o: Partial<HostOptions> & { path?: string } = {}): Promise<Rig> {
  const db = o.db ?? (await openDb(o.path ?? ":memory:"));
  const backend = (o.backend as ScriptedBackend | undefined) ?? new ScriptedBackend();
  const time = { now: 1_700_000_000_000 };
  const host = new AhpHost({ ...o, db, backend, now: () => time.now });
  return {
    host,
    backend,
    db,
    time,
    client: (id) => new TestClient(host, id),
    session: () => host.createSession({ provider: "fake", workingDirectories: [] }),
  };
}

export const noop = (_: ChatAction | undefined) => {};
export { ToolCallStatus };
