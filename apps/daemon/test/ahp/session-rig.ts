// A conversation rig: the AHP host over the real session host, with a fake sandbox behind it.
import type { Engine } from "@i-inc/core";
import type { UsageReport } from "../../src/acp.ts";
import { AhpHost, type HostOptions } from "../../src/ahp/host.ts";
import { type ConversationInfo, SessionHost, type SessionHostOptions } from "../../src/ahp/session-host.ts";
import { ActionType, ResponsePartKind, ROOT, ToolCallStatus } from "../../src/ahp/wire.ts";
import { openDb } from "../../src/db.ts";
import type { AccountRateLimit } from "../../src/registry.ts";
import { claude, codex, FakeSandbox } from "./fake-acp.ts";
import { type Any, TestClient, turnStarted } from "./support.ts";

export const until = async (cond: () => unknown, ms = 4000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 4));
  }
};

export const engines: Engine[] = [claude, codex];
export const teams: Record<string, string> = { ada: "engineering", kit: "engineering", zed: "design" };

export interface SessionRig {
  sandbox: FakeSandbox;
  sessions: SessionHost;
  host: AhpHost;
  db: Awaited<ReturnType<typeof openDb>>;
  time: { now: number };
  copies: ConversationInfo[];
  usage: UsageReport[];
  limits: { accountId: string; limit: AccountRateLimit }[];
  logs: string[];
  /** Makes a conversation (a session and its chat), as the conversation service does. */
  create(
    id?: string,
    o?: { employee?: string; provider?: string; mode?: string; project?: string },
  ): Promise<{ session: string; chat: string }>;
  /** A client subscribed to the root, a session and its chat. */
  client(c: { session: string; chat: string }, id?: string): Promise<TestClient>;
  /** Sends a message and waits for the turn to end. */
  say(client: TestClient, chat: string, text: string, extra?: Any): Promise<string>;
  /** A second host + session host over the same database, as after a restart. */
  restart(o?: Partial<SessionHostOptions>): Promise<SessionRig>;
}

export async function sessionRig(
  o: {
    path?: string;
    db?: SessionRig["db"];
    sandbox?: FakeSandbox;
    time?: { now: number };
    host?: Partial<SessionHostOptions>;
    ahp?: Partial<HostOptions>;
  } = {},
): Promise<SessionRig> {
  const db = o.db ?? (await openDb(o.path ?? ":memory:"));
  const sandbox = o.sandbox ?? new FakeSandbox();
  const time = o.time ?? { now: 1_800_000_000_000 };
  const copies: ConversationInfo[] = [];
  const usage: UsageReport[] = [];
  const limits: SessionRig["limits"] = [];
  const logs: string[] = [];
  const sessions = new SessionHost({
    launch: sandbox.launch,
    agents: () =>
      engines.map((e) => ({
        provider: e.id,
        displayName: e.id,
        description: `${e.harness} · ${e.model}`,
        models: [],
        capabilities: {},
      })),
    engine: (id) => engines.find((e) => e.id === id),
    teamOf: (employee) => teams[employee] ?? "engineering",
    workingCopy: async (c) => {
      copies.push(c);
    },
    credentials: (e, c) => ({
      ...(e.harness === "claude-code" ? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret" } : {}),
      I_INC_PORTS: `20000-20099`,
      I_INC_CONV: c.id,
    }),
    effort: () => "medium",
    onUsage: (u) => usage.push(u),
    onRateLimit: (accountId, limit) => limits.push({ accountId, limit }),
    now: () => time.now,
    cancelGraceMs: 80,
    startTimeoutMs: 1500,
    log: (m) => logs.push(m),
    ...o.host,
  });
  const host = new AhpHost({ db, backend: sessions, now: () => time.now, ...o.ahp });
  const rig: SessionRig = {
    sandbox,
    sessions,
    host,
    db,
    time,
    copies,
    usage,
    limits,
    logs,
    async create(id = "c1", c = {}) {
      return host.createSession({
        provider: c.provider ?? "opus",
        workingDirectories: [`file:///home/employee/work/conv-${id}`],
        ...(c.mode ? { config: { mode: c.mode } } : {}),
        meta: {
          "iinc.conversation": id,
          "iinc.employee": c.employee ?? "ada",
          ...(c.project ? { "iinc.project": c.project, "iinc.branch": `conv/${id}` } : {}),
        },
      });
    },
    async client(c, id) {
      const client = new TestClient(host, id);
      await client.init([ROOT, c.session, c.chat]);
      return client;
    },
    async say(client, chat, text, extra) {
      const turnId = `t${Math.random().toString(36).slice(2, 8)}`;
      client.dispatch(chat, turnStarted(text, turnId, extra));
      await until(
        () => !host.chatState(chat)?.activeTurn && host.chatState(chat)?.turns.some((t) => t.id === turnId),
        6000,
        `turn ${text}`,
      );
      return turnId;
    },
    async restart(over = {}) {
      return sessionRig({ db, sandbox, time, host: over, ...(o.ahp ? { ahp: o.ahp } : {}) });
    },
  };
  return rig;
}

/** The tool calls of a turn, by id. */
export function tools(turn: Any): Record<string, Any> {
  return Object.fromEntries(
    (turn?.responseParts ?? [])
      .filter((p: Any) => p.kind === ResponsePartKind.ToolCall)
      .map((p: Any) => [p.toolCall.toolCallId, p.toolCall]),
  );
}

export const pendingCall = (chatState: Any): Any =>
  chatState?.activeTurn?.responseParts.find(
    (p: Any) =>
      p.kind === ResponsePartKind.ToolCall && p.toolCall.status === ToolCallStatus.PendingConfirmation,
  )?.toolCall;

export { ActionType };
