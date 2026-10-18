// Wires the daemon together over one database. main.ts calls this on the host; tests call it with
// an in-memory database and the core's fakes.
import type {
  Agent,
  ChatSession,
  Clock,
  Harness,
  HelperModel,
  MachineProvider,
  Workspace,
} from "@i-inc/core";
import { type ApiOptions, createApi } from "./api.ts";
import { ChatLog } from "./chat.ts";
import { Daemon, type DaemonDeps } from "./daemon.ts";
import { openDb } from "./db.ts";
import type { TokenSource } from "./github.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { LiveEvents } from "./live.ts";
import { type PushService, WebPushSender } from "./push.ts";
import { Registry } from "./registry.ts";
import { migrate } from "./schema.ts";
import { SessionStore } from "./sessions.ts";
import { SqliteEventStore } from "./store.ts";
import { Tickets } from "./tickets.ts";

/** A port, or a way to make it from the registry (real mode's recipes and usage live there). */
export type FromRegistry<T> = T | ((registry: Registry) => T);

export interface AppOptions extends ApiOptions {
  dbPath: string;
  /** Where brains and the handbook live: git repos on the host, never pushed. */
  knowledgeDir: string;
  clock: Clock;
  sessions?: SessionStore;
  machines: FromRegistry<MachineProvider>;
  agent: FromRegistry<Agent>;
  harness: FromRegistry<Harness>;
  /** Branches and PRs on GitHub; absent in demo mode. */
  workspace?: FromRegistry<Workspace>;
  helper: HelperModel;
  chat: ChatSession;
  tokens?: FromRegistry<TokenSource>;
  live?: LiveEvents;
  log?: (msg: string) => void;
  push?: FromRegistry<PushService>;
  configDir?: string;
}

export async function createApp(o: AppOptions) {
  const db = await openDb(o.dbPath);
  migrate(db);
  const registry = new Registry(db);
  const live = o.live ?? new LiveEvents();
  registry.onChange = (kind) => {
    if (kind === "employee" || kind === "team") {
      live.notifyOffice();
    }
  };

  const make = <T>(port: FromRegistry<T>): T =>
    typeof port === "function" ? (port as (r: Registry) => T)(registry) : port;

  const store = new SqliteEventStore(db);
  store.onAppend = (id) => live.notifyTicket(id);

  const tickets = new Tickets(db);
  tickets.onChange = (id) => live.notifyTicket(id);

  const deps: DaemonDeps = {
    clock: o.clock,
    store,
    sessions: o.sessions ?? new SessionStore(db, o.clock),
    registry,
    tickets,
    machines: make(o.machines),
    agent: make(o.agent),
    harness: make(o.harness),
    ...(o.workspace ? { workspace: make(o.workspace) } : {}),
    ...(o.tokens ? { tokens: make(o.tokens) } : {}),
    helper: o.helper,
    chat: o.chat,
    chatLog: new ChatLog(db),
    knowledge: new KnowledgeStore(o.knowledgeDir),
    db,
    push: o.push ? make(o.push) : new WebPushSender(registry, o.configDir ? { configDir: o.configDir } : {}),
    live,
    ...(o.log ? { log: o.log } : {}),
  };
  const daemon = new Daemon(deps);
  daemon.ensureKnowledge();
  const handle = createApi(daemon, deps, {
    ...(o.token ? { token: o.token } : {}),
    ...(o.hosts ? { hosts: o.hosts } : {}),
    ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
  });
  return { db, deps, daemon, handle, live };
}
