// A tiny scripted AHP host for the connection tests: it speaks just enough JSON-RPC over an in-memory
// transport. The real host is exercised by the daemon's own tests and by the end-to-end run.
import type { ActionEnvelope } from "@microsoft/agent-host-protocol";
import { chatReducer } from "@microsoft/agent-host-protocol";
import { type AhpTransport, InMemoryTransport } from "@microsoft/agent-host-protocol/client";

// biome-ignore lint/suspicious/noExplicitAny: scripted JSON.
type Any = any;

export const SESSION = "ahp-session:/s1";
export const CHAT = "ahp-chat:/c1";

export const chatState = (over: Any = {}): Any => ({
  resource: CHAT,
  title: "New conversation",
  status: 1,
  modifiedAt: "2026-10-21T10:00:00.000Z",
  turns: [],
  ...over,
});
export const sessionState = (over: Any = {}): Any => ({
  provider: "opus",
  title: "New conversation",
  status: 1,
  lifecycle: "ready",
  activeClients: [],
  chats: [],
  defaultChat: CHAT,
  ...over,
});

export class FakeHost {
  seq = 100;
  readonly received: Any[] = [];
  readonly states = new Map<string, Any>();
  /** What the next `reconnect` answers; default: replay what was pushed since. */
  onReconnect: ((p: Any) => Any) | undefined;
  /** Throws for a fetchTurns whose cursor does not match. */
  windowCursor: string | undefined;
  readonly pushed: ActionEnvelope[] = [];
  closed = false;
  constructor(readonly transport: AhpTransport) {
    this.states.set("ahp-root://", { agents: [] });
    this.states.set(SESSION, sessionState());
    this.states.set(CHAT, chatState());
    void this.loop();
  }

  private async loop(): Promise<void> {
    for (;;) {
      const frame = await this.transport.recv().catch(() => null);
      if (frame?.kind !== "text") {
        this.closed = true;
        return;
      }
      const m = JSON.parse(frame.text) as Any;
      this.received.push(m);
      this.handle(m);
    }
  }

  private reply(id: Any, result: Any): void {
    void this.transport.send({ jsonrpc: "2.0", id, result } as never);
  }
  private fail(id: Any, code: number, message: string): void {
    void this.transport.send({ jsonrpc: "2.0", id, error: { code, message } } as never);
  }

  private snapshot(uri: string, turns?: number): Any {
    const state = this.states.get(uri);
    if (turns !== undefined && state?.turns && state.turns.length > turns) {
      const start = state.turns.length - turns;
      this.windowCursor = `before:${state.turns[start].id}`;
      return {
        resource: uri,
        state: { ...state, turns: state.turns.slice(start), turnsNextCursor: this.windowCursor },
        fromSeq: this.seq,
      };
    }
    return { resource: uri, state, fromSeq: this.seq };
  }

  private handle(m: Any): unknown {
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize":
        return this.reply(m.id, {
          protocolVersion: "1.0.0",
          serverSeq: this.seq,
          snapshots: (p.initialSubscriptions ?? [])
            .filter((u: string) => this.states.has(u))
            .map((u: string) => this.snapshot(u)),
        });
      case "reconnect":
        if (this.onReconnect) return this.reply(m.id, this.onReconnect(p));
        return this.fail(m.id, -32603, "no reconnect");
      case "subscribe": {
        if (!this.states.has(p.channel)) return this.fail(m.id, -32001, `no channel ${p.channel}`);
        return this.reply(m.id, { snapshot: this.snapshot(p.channel, p.view?.turns) });
      }
      case "fetchTurns": {
        const state = this.states.get(p.channel);
        if (p.cursor !== this.windowCursor) return this.fail(m.id, -32602, "unrecognised cursor");
        const end = state.turns.findIndex((t: Any) => `before:${t.id}` === p.cursor);
        const start = Math.max(0, end - 2);
        this.windowCursor = start > 0 ? `before:${state.turns[start].id}` : undefined;
        this.reply(m.id, null);
        return this.send(
          p.channel,
          {
            type: "chat/turnsLoaded",
            turns: state.turns.slice(start, end),
            ...(this.windowCursor ? { turnsNextCursor: this.windowCursor } : {}),
          },
          undefined,
          false,
        );
      }
      case "ping":
        return this.reply(m.id, null);
      default:
        if (m.id !== undefined) this.reply(m.id, null);
    }
  }

  /** Pushes an action to the client (a new serverSeq, unless it is a turnsLoaded page). */
  send(channel: string, action: Any, origin?: Any, bump = true): ActionEnvelope {
    if (bump) this.seq++;
    const env = { channel, action, serverSeq: this.seq, origin } as ActionEnvelope;
    if (bump) {
      this.pushed.push(env);
      const st = this.states.get(channel);
      if (st && channel.startsWith("ahp-chat:/")) this.states.set(channel, chatReducer(st, action));
    }
    void this.transport.send({ jsonrpc: "2.0", method: "action", params: env } as never);
    return env;
  }

  /** Echoes a refusal to the sender alone. */
  reject(channel: string, action: Any, origin: Any, reason: string): void {
    void this.transport.send({
      jsonrpc: "2.0",
      method: "action",
      params: { channel, action, serverSeq: this.seq, origin, rejectionReason: reason },
    } as never);
  }

  notify(method: string, params: Any): void {
    void this.transport.send({ jsonrpc: "2.0", method, params } as never);
  }

  /** The connection drops. */
  async drop(): Promise<void> {
    await this.transport.close();
  }
}

/** A connect function that hands out a fresh FakeHost for every attempt. */
export function hosts() {
  const made: FakeHost[] = [];
  let failNext = 0;
  const api = {
    made,
    /** Runs on every new host, before it answers anything. */
    onConnect: undefined as ((h: FakeHost) => void) | undefined,
    failNext(n: number) {
      failNext = n;
    },
    connect: async (): Promise<AhpTransport> => {
      if (failNext > 0) {
        failNext--;
        throw new Error("refused");
      }
      const [client, server] = InMemoryTransport.pair();
      const h = new FakeHost(server);
      const prev = made.at(-1);
      if (prev) {
        h.seq = prev.seq;
        for (const [k, v] of prev.states) h.states.set(k, v);
        h.pushed.push(...prev.pushed);
        h.windowCursor = prev.windowCursor;
      }
      made.push(h);
      api.onConnect?.(h);
      return client;
    },
  };
  return api;
}

export const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(cond: () => unknown, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(2);
  }
}

/** The element, or a clear failure: tests click and read things that must be there. */
export function must<T extends Element = HTMLElement>(n: Element | null | undefined): T {
  if (!n) throw new Error("expected the element to be there");
  return n as T;
}
