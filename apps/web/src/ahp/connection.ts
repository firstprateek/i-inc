// The AHP connection manager (T60): one WebSocket to the daemon's `/ahp`, over the official client.
//
// What it does, and what the views can rely on:
// - Connects, negotiates 1.0.0, subscribes to the root channel and to whichever session and chat channels
//   a view is `watch`ing. State is held by the official reducers, once per channel (nothing is stored twice).
// - Applies actions in `serverSeq` order, skipping any a snapshot or replay already included.
// - After a drop it reconnects with backoff and asks for a replay from `lastSeenServerSeq`; when the host
//   answers with snapshots (its log no longer reaches back) it takes those. Never a silent freeze: `info`
//   says what the connection is doing, and the shell shows a banner.
// - Batches change notifications to one per animation frame, so a streaming turn costs one render a frame.
// - Remembers who answered each tool confirmation, so a card can say "Allowed on another device".
// - Releases everything on `stop()`: the socket, the timers, the listeners and the channel state.
import type {
  ActionEnvelope,
  CompletionItem,
  InitializeResult,
  ReconnectResult,
  Snapshot,
} from "@microsoft/agent-host-protocol";
import {
  AhpClient,
  type AhpTransport,
  type ClientEvent,
  RpcError,
} from "@microsoft/agent-host-protocol/client";
import {
  ActionType,
  type ChannelState,
  type ChatState,
  PROTOCOL_VERSION,
  ROOT,
  type RootState,
  reduce,
  type SessionState,
  type StateAction,
  tagged,
} from "./wire.ts";

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "stopped" | "failed";

export interface ConnectionInfo {
  status: ConnectionStatus;
  /** Failed attempts in a row since the last time it was open. */
  attempt: number;
  /** When the next attempt starts (ms since the epoch), while waiting between attempts. */
  retryAt: number | null;
  /** The last thing that went wrong, in words. */
  error: string | null;
  /** True once it has been open at least once, so a drop is a "reconnecting" rather than a first connect. */
  everOpen: boolean;
}

/** An action this client sent that the host refused (for instance a confirmation another device answered first). */
export interface Rejection {
  channel: string;
  action: StateAction;
  reason: string;
}

/** Who answered a tool confirmation, and how. `byMe` is false for another device. */
export interface Confirmation {
  byMe: boolean;
  approved: boolean;
  optionId?: string;
}

export interface ConnectionOptions {
  /** Opens a transport to the host. Called again for every attempt. */
  connect: () => Promise<AhpTransport>;
  clientId?: string;
  /** Wait before attempt n (1-based), in ms. */
  backoff?: (attempt: number) => number;
  /** Runs `fn` on the next animation frame (a microtask-ish timer where there are no frames). */
  schedule?: (fn: () => void) => () => void;
  now?: () => number;
  requestTimeoutMs?: number;
  /** A protocol ping this often; 0 turns it off. */
  pingMs?: number;
  /** Turns older than this many are paged in with fetchTurns. */
  turnsWindow?: number;
  log?: (message: string) => void;
}

interface Chan {
  uri: string;
  refs: number;
  view?: { turns: number } | undefined;
  cs: ChannelState | undefined;
  /** The `serverSeq` this channel's state includes. */
  seq: number;
  /** Actions that arrived before the snapshot did. */
  buffer: ActionEnvelope[];
  /** Set while a `subscribe` for it is in flight, so it is not sent twice. */
  subscribing: Promise<void> | undefined;
  loading: (() => void) | undefined;
  gone: boolean;
}

export const defaultBackoff = (attempt: number): number =>
  Math.min(15_000, 500 * 2 ** Math.min(attempt - 1, 5)) * (0.8 + Math.random() * 0.4);

const frame = (fn: () => void): (() => void) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(() => fn());
    return () => cancelAnimationFrame(id);
  }
  const t = setTimeout(fn, 16);
  return () => clearTimeout(t);
};

const MAX_CONFIRMATIONS = 500;
const MAX_CONTENT = 120;

export class AhpConnection {
  readonly clientId: string;
  private readonly o: ConnectionOptions;
  private infoNow: ConnectionInfo = {
    status: "idle",
    attempt: 0,
    retryAt: null,
    error: null,
    everOpen: false,
  };
  private readonly chans = new Map<string, Chan>();
  private client: AhpClient | undefined;
  private gen = 0;
  private started = false;
  /** The highest `serverSeq` received; what a reconnect replays from. */
  private lastSeen: number | undefined;
  private syncing = false;
  private held: ActionEnvelope[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly infoListeners = new Set<(i: ConnectionInfo) => void>();
  private readonly changeListeners = new Set<(uris: Set<string>) => void>();
  private readonly rejectionListeners = new Set<(r: Rejection) => void>();
  private readonly rosterListeners = new Set<() => void>();
  private changed = new Set<string>();
  private rosterChanged = false;
  private cancelFlush: (() => void) | undefined;
  private readonly confirmations = new Map<string, Confirmation>();
  private readonly content = new Map<string, Promise<Content>>();

  constructor(o: ConnectionOptions) {
    this.o = o;
    this.clientId = o.clientId ?? `web-${Math.random().toString(36).slice(2, 10)}`;
    this.chans.set(ROOT, this.newChan(ROOT, 1));
  }

  // ───────────────────────────── observing ─────────────────────────────

  get info(): ConnectionInfo {
    return this.infoNow;
  }

  onInfo(fn: (i: ConnectionInfo) => void): () => void {
    this.infoListeners.add(fn);
    return () => this.infoListeners.delete(fn);
  }

  /** Called at most once a frame with the channels that changed. */
  onChange(fn: (uris: Set<string>) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onRejected(fn: (r: Rejection) => void): () => void {
    this.rejectionListeners.add(fn);
    return () => this.rejectionListeners.delete(fn);
  }

  /** Conversations came, went or changed summary (root notifications; not replayed, so re-list after a reconnect). */
  onRoster(fn: () => void): () => void {
    this.rosterListeners.add(fn);
    return () => this.rosterListeners.delete(fn);
  }

  channel(uri: string): ChannelState | undefined {
    return this.chans.get(uri)?.cs;
  }
  root(): RootState | undefined {
    const c = this.channel(ROOT);
    return c?.kind === "root" ? c.state : undefined;
  }
  session(uri: string): SessionState | undefined {
    const c = this.channel(uri);
    return c?.kind === "session" ? c.state : undefined;
  }
  chat(uri: string): ChatState | undefined {
    const c = this.channel(uri);
    return c?.kind === "chat" ? c.state : undefined;
  }
  /** True when the host said the channel no longer exists (the conversation was disposed). */
  isGone(uri: string): boolean {
    return this.chans.get(uri)?.gone === true;
  }
  /** Who answered a tool confirmation, if this connection saw it happen. */
  confirmation(toolCallId: string): Confirmation | undefined {
    return this.confirmations.get(toolCallId);
  }
  /** How many channels this connection holds (tests and memory checks). */
  get channelCount(): number {
    return this.chans.size;
  }
  get lastSeenServerSeq(): number | undefined {
    return this.lastSeen;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    this.setInfo({ status: "connecting", attempt: 0, retryAt: null, error: null });
    void this.attempt();
  }

  /** Closes the socket and lets go of every channel, timer and listener-visible state. */
  stop(): void {
    this.started = false;
    this.gen++;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.cancelFlush?.();
    this.cancelFlush = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) void client.shutdown().catch(() => {});
    for (const [uri] of this.chans) if (uri !== ROOT) this.chans.delete(uri);
    const root = this.chans.get(ROOT);
    if (root) {
      root.cs = undefined;
      root.buffer = [];
      root.seq = 0;
    }
    this.held = [];
    this.syncing = false;
    this.lastSeen = undefined;
    this.changed.clear();
    this.confirmations.clear();
    this.content.clear();
    this.setInfo({ status: "stopped", retryAt: null });
  }

  /** Try again now, instead of waiting out the backoff (a "Retry now" button, the network coming back). */
  retryNow(): void {
    if (!this.started || this.infoNow.status === "open" || this.infoNow.status === "connecting") return;
    clearTimeout(this.retryTimer);
    this.setInfo({ status: this.infoNow.everOpen ? "reconnecting" : "connecting", retryAt: null });
    void this.attempt();
  }

  /**
   * Holds a channel open for a view; returns the release. The first watcher subscribes, the last one
   * unsubscribes and drops the state. A chat can ask for a window of its last `turns` turns.
   */
  watch(uri: string, view?: { turns: number }): () => void {
    let ch = this.chans.get(uri);
    if (!ch) {
      ch = this.newChan(uri, 0);
      this.chans.set(uri, ch);
    }
    ch.refs++;
    ch.gone = false;
    if (view && !ch.view) ch.view = view;
    if (ch.refs === 1 || !ch.cs) void this.subscribeIfOpen(ch);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(uri);
    };
  }

  private release(uri: string): void {
    const ch = this.chans.get(uri);
    if (!ch || uri === ROOT) return;
    if (--ch.refs > 0) return;
    this.chans.delete(uri);
    this.changed.delete(uri);
    const client = this.client;
    if (client && this.infoNow.status === "open") void client.unsubscribe(uri).catch(() => {});
  }

  private newChan(uri: string, refs: number): Chan {
    return {
      uri,
      refs,
      cs: undefined,
      seq: 0,
      buffer: [],
      subscribing: undefined,
      loading: undefined,
      gone: false,
    };
  }

  // ───────────────────────────── connecting ─────────────────────────────

  private setInfo(patch: Partial<ConnectionInfo>): void {
    this.infoNow = { ...this.infoNow, ...patch };
    for (const fn of [...this.infoListeners]) fn(this.infoNow);
  }

  private async attempt(): Promise<void> {
    const gen = ++this.gen;
    let client: AhpClient | undefined;
    try {
      const transport = await this.o.connect();
      if (gen !== this.gen) {
        await transport.close();
        return;
      }
      client = new AhpClient(transport, { requestTimeoutMs: this.o.requestTimeoutMs ?? 15_000 });
      client.connect();
      this.client = client;
      this.syncing = true;
      this.held = [];
      const events = client.events();
      void this.pump(gen, client, events);
      await this.handshake(gen, client);
      if (gen !== this.gen) return;
      this.syncing = false;
      const held = this.held;
      this.held = [];
      for (const env of held) this.apply(env);
      this.setInfo({ status: "open", attempt: 0, retryAt: null, error: null, everOpen: true });
      this.markAll();
      this.rosterChanged = true;
      this.scheduleFlush();
      this.startPing(gen, client);
      // Channels a view asked for while it was connecting.
      for (const ch of this.chans.values()) if (!ch.cs && ch.refs > 0) void this.subscribeIfOpen(ch);
    } catch (e) {
      if (gen !== this.gen) return;
      this.syncing = false;
      if (client) void client.shutdown().catch(() => {});
      if (this.client === client) this.client = undefined;
      this.failed(e);
    }
  }

  private async handshake(gen: number, client: AhpClient): Promise<void> {
    const wanted = [...this.chans.values()].filter((c) => c.refs > 0);
    const held = wanted.filter((c) => c.cs).map((c) => c.uri);
    if (this.lastSeen !== undefined && held.length > 0) {
      try {
        const result = await client.reconnect({
          clientId: this.clientId,
          lastSeenServerSeq: this.lastSeen,
          subscriptions: held,
        });
        if (gen !== this.gen) return;
        this.applyReconnect(result);
        return;
      } catch (e) {
        if (e instanceof RpcError && e.code === -32005) throw e;
        this.o.log?.(`ahp: reconnect failed (${e instanceof Error ? e.message : e}); starting fresh`);
        // Fall through to a fresh initialize, and take new snapshots of everything.
        for (const c of this.chans.values()) {
          c.cs = undefined;
          c.seq = 0;
          c.buffer = [];
        }
      }
    }
    const initial = [ROOT, ...wanted.filter((c) => c.uri !== ROOT && c.view === undefined).map((c) => c.uri)];
    const result: InitializeResult = await client.initialize({
      clientId: this.clientId,
      protocolVersions: [PROTOCOL_VERSION],
      initialSubscriptions: initial,
    });
    if (gen !== this.gen) return;
    this.lastSeen = result.serverSeq;
    for (const snap of result.snapshots) this.takeSnapshot(snap);
    // Channels held from before that the fresh start did not restore are gone or windowed: resubscribe.
    for (const c of wanted) if (c.uri !== ROOT && !c.cs) c.buffer = [];
  }

  private applyReconnect(result: ReconnectResult): void {
    if (result.type === "snapshot") {
      for (const snap of result.snapshots) this.takeSnapshot(snap);
      // A channel the host no longer has simply gets no snapshot: it is gone.
      for (const ch of this.chans.values()) {
        if (ch.refs > 0 && ch.uri !== ROOT && ch.cs && !result.snapshots.some((s) => s.resource === ch.uri)) {
          this.markGone(ch);
        }
      }
      return;
    }
    for (const uri of result.missing) {
      const ch = this.chans.get(uri);
      if (ch) this.markGone(ch);
    }
    for (const env of result.actions) this.apply(env);
  }

  private markGone(ch: Chan): void {
    ch.cs = undefined;
    ch.gone = true;
    ch.buffer = [];
    this.changed.add(ch.uri);
    this.scheduleFlush();
  }

  private takeSnapshot(snap: Snapshot): void {
    const ch = this.chans.get(snap.resource);
    if (!ch) return;
    const cs = tagged(snap.resource, snap.state);
    if (!cs) return;
    ch.cs = cs;
    ch.seq = snap.fromSeq;
    ch.gone = false;
    const buffered = ch.buffer;
    ch.buffer = [];
    for (const env of buffered) this.apply(env);
    this.changed.add(ch.uri);
    this.scheduleFlush();
  }

  /** Whatever was connecting or open is over: note why, and schedule the next attempt. */
  private failed(e: unknown): void {
    this.gen++;
    const attempt = this.infoNow.attempt + 1;
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof RpcError && e.code === -32005) {
      this.setInfo({ status: "failed", error: "This host speaks a different protocol version.", attempt });
      return;
    }
    const wait = (this.o.backoff ?? defaultBackoff)(attempt);
    const now = (this.o.now ?? Date.now)();
    this.setInfo({
      status: this.infoNow.everOpen ? "reconnecting" : "connecting",
      attempt,
      error: message,
      retryAt: now + wait,
    });
    this.markAll();
    clearTimeout(this.retryTimer);
    if (!this.started) return;
    this.retryTimer = setTimeout(() => {
      if (!this.started) return;
      this.setInfo({ retryAt: null });
      void this.attempt();
    }, wait);
  }

  /** The socket closed under us: wait, then try again. */
  private dropped(gen: number, client: AhpClient, why: string): void {
    if (gen !== this.gen || !this.started) return;
    clearInterval(this.pingTimer);
    void client.shutdown().catch(() => {});
    if (this.client === client) this.client = undefined;
    this.syncing = false;
    this.held = [];
    this.failed(new Error(why));
  }

  private async pump(
    gen: number,
    client: AhpClient,
    events: AsyncIterableIterator<ClientEvent>,
  ): Promise<void> {
    try {
      for await (const { event } of events) {
        if (gen !== this.gen) return;
        switch (event.type) {
          case "action":
            if (this.syncing) this.held.push(event.params);
            else this.apply(event.params);
            break;
          case "sessionAdded":
          case "sessionRemoved":
          case "sessionSummaryChanged":
            this.rosterChanged = true;
            this.scheduleFlush();
            break;
          default:
            break;
        }
      }
    } catch {
      // the client reports the failure through the end of the stream
    }
    this.dropped(gen, client, "The connection to the host closed.");
  }

  private startPing(gen: number, client: AhpClient): void {
    clearInterval(this.pingTimer);
    const every = this.o.pingMs ?? 20_000;
    if (!every) return;
    this.pingTimer = setInterval(() => {
      client.ping().catch(() => this.dropped(gen, client, "The host stopped answering."));
    }, every);
  }

  // ───────────────────────────── applying actions ─────────────────────────────

  private apply(env: ActionEnvelope): void {
    const action = env.action as {
      type: string;
      toolCallId?: string;
      approved?: boolean;
      selectedOptionId?: string;
    };
    if (env.rejectionReason !== undefined) {
      if (env.origin?.clientId === this.clientId) {
        for (const fn of [...this.rejectionListeners])
          fn({ channel: env.channel, action: env.action, reason: env.rejectionReason });
      }
      return;
    }
    const ch = this.chans.get(env.channel);
    if (!ch) return;
    if (!ch.cs) {
      if (ch.buffer.length < 20_000) ch.buffer.push(env);
      return;
    }
    const paging = action.type === ActionType.ChatTurnsLoaded;
    if (!paging && env.serverSeq <= ch.seq) return; // a snapshot or an earlier replay already had it
    try {
      ch.cs = reduce(ch.cs, env.action);
    } catch (e) {
      this.o.log?.(`ahp: could not apply ${action.type}: ${e instanceof Error ? e.message : e}`);
      void this.resnapshot(ch);
      return;
    }
    if (!paging) {
      ch.seq = env.serverSeq;
      if (this.lastSeen === undefined || env.serverSeq > this.lastSeen) this.lastSeen = env.serverSeq;
    } else {
      const done = ch.loading;
      ch.loading = undefined;
      done?.();
    }
    if (action.type === ActionType.ChatToolCallConfirmed && action.toolCallId) {
      this.confirmations.set(action.toolCallId, {
        byMe: env.origin?.clientId === this.clientId,
        approved: action.approved === true,
        ...(action.selectedOptionId ? { optionId: action.selectedOptionId } : {}),
      });
      if (this.confirmations.size > MAX_CONFIRMATIONS) {
        const oldest = this.confirmations.keys().next().value;
        if (oldest !== undefined) this.confirmations.delete(oldest);
      }
    }
    this.changed.add(env.channel);
    this.scheduleFlush();
  }

  private markAll(): void {
    for (const uri of this.chans.keys()) this.changed.add(uri);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.cancelFlush) return;
    this.cancelFlush = (this.o.schedule ?? frame)(() => this.flush());
  }

  private flush(): void {
    this.cancelFlush = undefined;
    const uris = this.changed;
    this.changed = new Set();
    const roster = this.rosterChanged;
    this.rosterChanged = false;
    if (uris.size) for (const fn of [...this.changeListeners]) fn(uris);
    if (roster) for (const fn of [...this.rosterListeners]) fn();
  }

  // ───────────────────────────── channels ─────────────────────────────

  private subscribeIfOpen(ch: Chan): Promise<void> {
    if (ch.uri === ROOT || ch.cs || this.infoNow.status !== "open" || !this.client) return Promise.resolve();
    if (ch.subscribing) return ch.subscribing;
    const client = this.client;
    const p = (async () => {
      try {
        const { result } = await client.subscribe(ch.uri, ch.view ? { view: { turns: ch.view.turns } } : {});
        if (result.snapshot) this.takeSnapshot(result.snapshot);
      } catch (e) {
        if (
          e instanceof RpcError &&
          (e.code === -32001 || e.code === -32002 || /no channel/.test(e.message))
        ) {
          ch.gone = true;
          this.changed.add(ch.uri);
          this.scheduleFlush();
        } else {
          this.o.log?.(`ahp: subscribe ${ch.uri} failed: ${e instanceof Error ? e.message : e}`);
        }
      } finally {
        ch.subscribing = undefined;
      }
    })();
    ch.subscribing = p;
    return p;
  }

  /** Takes a fresh snapshot of a channel (after a failed reduction or a cursor the host no longer knows). */
  async resnapshot(ch: Chan | string, turns?: number): Promise<void> {
    const c = typeof ch === "string" ? this.chans.get(ch) : ch;
    const client = this.client;
    if (!c || !client || this.infoNow.status !== "open") return;
    if (turns !== undefined) c.view = { turns };
    c.cs = undefined;
    c.seq = 0;
    c.buffer = [];
    c.subscribing = undefined;
    await this.subscribeIfOpen(c);
  }

  /** Pages older turns of a chat in. Resolves when they have arrived (or the host had no more). */
  async fetchTurns(chat: string): Promise<void> {
    const ch = this.chans.get(chat);
    const state = ch?.cs?.kind === "chat" ? ch.cs.state : undefined;
    const client = this.client;
    if (!ch || !state?.turnsNextCursor || !client || this.infoNow.status !== "open") return;
    if (ch.loading) return;
    const loaded = new Promise<void>((resolve) => {
      ch.loading = resolve;
    });
    try {
      await client.request("fetchTurns", { channel: chat, cursor: state.turnsNextCursor });
      await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 4000))]);
    } catch {
      // The host forgot our window (it does after a reconnect): ask for a bigger one outright.
      ch.loading = undefined;
      await this.resnapshot(ch, state.turns.length + (this.o.turnsWindow ?? 20));
    } finally {
      ch.loading = undefined;
    }
  }

  // ───────────────────────────── sending ─────────────────────────────

  /** Sends a client action. The host echoes it (with the next `serverSeq`) when it accepts it. */
  dispatch(
    channel: string,
    action: StateAction,
  ): { ok: true; clientSeq: number } | { ok: false; error: string } {
    const client = this.client;
    if (!client || this.infoNow.status !== "open")
      return { ok: false, error: "Not connected to the host yet." };
    try {
      return { ok: true, clientSeq: client.dispatch(channel, action).clientSeq };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Slash-command completions for a chat, from the host. */
  async completions(chat: string, text: string, offset: number): Promise<CompletionItem[]> {
    const client = this.client;
    if (!client || this.infoNow.status !== "open") return [];
    const r = await client.completions({ kind: "userMessage" as never, channel: chat, text, offset });
    return r.items;
  }

  /** The text (or data URL, for an image) behind an `ahp-content:` URI; kept for the next time. */
  readContent(uri: string): Promise<Content> {
    const cached = this.content.get(uri);
    if (cached) {
      this.content.delete(uri);
      this.content.set(uri, cached);
      return cached;
    }
    const client = this.client;
    if (!client || this.infoNow.status !== "open")
      return Promise.reject(new Error("Not connected to the host yet."));
    const p = client
      .resourceRead({ uri })
      .then(
        (r): Content =>
          r.encoding === ("utf-8" as never)
            ? { text: r.data, contentType: r.contentType }
            : /^image\//.test(r.contentType ?? "")
              ? { dataUrl: `data:${r.contentType};base64,${r.data}`, contentType: r.contentType }
              : { text: safeDecode(r.data), contentType: r.contentType },
      );
    p.catch(() => this.content.delete(uri));
    this.content.set(uri, p);
    if (this.content.size > MAX_CONTENT) {
      const oldest = this.content.keys().next().value;
      if (oldest !== undefined) this.content.delete(oldest);
    }
    return p;
  }
}

export interface Content {
  text?: string;
  dataUrl?: string;
  contentType: string | undefined;
}

function safeDecode(b64: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}
