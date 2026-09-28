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
import { KnowledgeStore } from "./knowledge.ts";
import { Registry } from "./registry.ts";
import { migrate } from "./schema.ts";
import { SqliteEventStore } from "./store.ts";
import { Tickets } from "./tickets.ts";

/** A port, or a way to make it from the registry (real mode's recipes and usage live there). */
export type FromRegistry<T> = T | ((registry: Registry) => T);

export interface AppOptions extends ApiOptions {
  dbPath: string;
  /** Where brains and the handbook live: git repos on the host, never pushed. */
  knowledgeDir: string;
  clock: Clock;
  machines: MachineProvider;
  agent: FromRegistry<Agent>;
  harness: FromRegistry<Harness>;
  /** Branches and PRs on GitHub; absent in demo mode. */
  workspace?: FromRegistry<Workspace>;
  helper: HelperModel;
  chat: ChatSession;
  log?: (msg: string) => void;
}

export async function createApp(o: AppOptions) {
  const db = await openDb(o.dbPath);
  migrate(db);
  const registry = new Registry(db);
  const make = <T>(port: FromRegistry<T>): T =>
    typeof port === "function" ? (port as (r: Registry) => T)(registry) : port;
  const deps: DaemonDeps = {
    clock: o.clock,
    store: new SqliteEventStore(db),
    registry,
    tickets: new Tickets(db),
    machines: o.machines,
    agent: make(o.agent),
    harness: make(o.harness),
    ...(o.workspace ? { workspace: make(o.workspace) } : {}),
    helper: o.helper,
    chat: o.chat,
    chatLog: new ChatLog(db),
    knowledge: new KnowledgeStore(o.knowledgeDir),
    db,
    ...(o.log ? { log: o.log } : {}),
  };
  const daemon = new Daemon(deps);
  daemon.ensureKnowledge();
  const handle = createApi(daemon, deps, o.token ? { token: o.token } : {});
  return { db, deps, daemon, handle };
}
