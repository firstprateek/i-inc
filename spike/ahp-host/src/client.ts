// A test/demo AHP client built from the OFFICIAL @microsoft/agent-host-protocol client + ws transport,
// plus a small mirror (confirmed state per channel, via the official reducers) with the reconnect bookkeeping
// the SDK leaves to the app: lastSeenServerSeq, applying replay results, dropping rejected actions.
import {
  type ActionEnvelope,
  type InitializeResult,
  chatReducer,
  PROTOCOL_VERSION,
  type ReconnectResult,
  rootReducer,
  sessionReducer,
  SUPPORTED_PROTOCOL_VERSIONS,
  type StateAction,
} from "@microsoft/agent-host-protocol";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";

export const ROOT = "ahp-root://";
void PROTOCOL_VERSION;

export class Mirror {
  states = new Map<string, any>();
  lastSeq = 0;
  /** Every envelope delivered, in order (accepted and rejected). */
  log: ActionEnvelope[] = [];
  rejected: ActionEnvelope[] = [];

  applySnapshot(s: { resource: string; state: any; fromSeq: number }) {
    this.states.set(s.resource, s.state);
    this.lastSeq = Math.max(this.lastSeq, s.fromSeq);
  }

  apply(env: ActionEnvelope) {
    this.log.push(env);
    if (env.rejectionReason) {
      this.rejected.push(env);
      return;
    }
    if (env.serverSeq <= this.lastSeq && this.states.has(env.channel) && this.seen.has(env.serverSeq)) return; // duplicate
    this.seen.add(env.serverSeq);
    const st = this.states.get(env.channel);
    if (st) {
      const reducer = env.channel.startsWith("ahp-chat:") ? chatReducer : env.channel.startsWith("ahp-session:") ? sessionReducer : rootReducer;
      this.states.set(env.channel, (reducer as any)(st, env.action));
    }
    this.lastSeq = Math.max(this.lastSeq, env.serverSeq);
  }
  private seen = new Set<number>();

  chat(uri: string) {
    return this.states.get(uri);
  }
  types(channel?: string) {
    return this.log.filter((e) => !channel || e.channel === channel).map((e) => (e.action as any).type as string);
  }
}

export interface Connected {
  client: AhpClient;
  mirror: Mirror;
  init?: InitializeResult;
  reconnected?: ReconnectResult;
  subscribe(uri: string): Promise<void>;
  dispatch(channel: string, action: StateAction): number;
  request: AhpClient["request"];
  close(): Promise<void>;
}

/** Open a socket (Bun lets us send the auth header; a browser would send the i_inc cookie instead). */
export async function connect(
  url: string,
  clientId: string,
  o: { token?: string; mirror?: Mirror; reconnect?: string[]; subscribe?: string[] } = {},
): Promise<Connected> {
  const socket = new (WebSocket as any)(url, { headers: o.token ? { authorization: `Bearer ${o.token}` } : {} }) as WebSocket;
  await new Promise<void>((res, rej) => {
    socket.addEventListener("open", () => res());
    socket.addEventListener("error", () => rej(new Error("websocket error")));
  });
  const client = new AhpClient(WebSocketTransport.fromSocket(socket));
  client.connect();
  const mirror = o.mirror ?? new Mirror();
  const pump = async (sub: AsyncIterable<any>) => {
    for await (const ev of sub) if (ev.type === "action") mirror.apply(ev.params);
  };
  const c: Connected = {
    client,
    mirror,
    request: client.request.bind(client),
    async subscribe(uri) {
      const { result, subscription } = await client.subscribe(uri);
      if (result.snapshot) mirror.applySnapshot(result.snapshot);
      void pump(subscription);
    },
    dispatch: (channel, action) => client.dispatch(channel, action).clientSeq,
    close: async () => {
      socket.close();
      await client.shutdown().catch(() => {});
    },
  };
  if (o.reconnect) {
    // Attach local subscriptions first so replayed-then-live ordering can't lose an event.
    const subs = o.reconnect.map((u) => client.attachSubscription(u));
    const r = await client.reconnect({ clientId, lastSeenServerSeq: mirror.lastSeq, subscriptions: o.reconnect });
    c.reconnected = r;
    if (r.type === "replay") for (const a of r.actions) mirror.apply(a);
    else for (const s of r.snapshots) mirror.applySnapshot(s);
    for (const s of subs) void pump(s);
  } else {
    // Subscriptions are attached by initialSubscriptions; pump root.
    const init = await client.initialize({
      clientId,
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      initialSubscriptions: [ROOT],
    });
    c.init = init;
    for (const s of init.snapshots) mirror.applySnapshot(s);
    void pump(client.attachSubscription(ROOT));
  }
  for (const u of o.subscribe ?? []) await c.subscribe(u);
  return c;
}

export const until = async (cond: () => boolean, what: string, ms = 8000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
