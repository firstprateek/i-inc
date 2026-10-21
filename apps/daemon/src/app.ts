// Wires the daemon together over one database. main.ts calls this on the host; tests call it with
// an in-memory database and the core's fakes.
import { dirname } from "node:path";
import type {
  Agent,
  ChatSession,
  Clock,
  Harness,
  HelperModel,
  MachineProvider,
  Workspace,
} from "@i-inc/core";
import { type AgentBackend, NoAgentBackend } from "./ahp/backend.ts";
import { ConversationPush, type ConversationPushOptions } from "./ahp/conversation-push.ts";
import { agentsFromRegistry, ConversationService } from "./ahp/conversations.ts";
import { AhpHost, type TransportLimits } from "./ahp/host.ts";
import { AhpTransport } from "./ahp/transport.ts";
import { type ApiOptions, createApi } from "./api.ts";
import { same } from "./auth.ts";
import { BrainIndex } from "./brain-index.ts";
import { ChatLog } from "./chat.ts";
import { Daemon, type DaemonDeps } from "./daemon.ts";
import { type Db, openDb } from "./db.ts";
import { DeployNotifier } from "./deploys.ts";
import type { TokenSource } from "./github.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { LiveEvents } from "./live.ts";
import { Proposals } from "./proposals.ts";
import { type PushService, WebPushSender } from "./push.ts";
import { Registry } from "./registry.ts";
import { migrate } from "./schema.ts";
import { SessionStore } from "./sessions.ts";
import { type MachineOps, Storage, type StoragePaths } from "./storage.ts";
import { SqliteEventStore } from "./store.ts";
import { Tickets } from "./tickets.ts";

/**
 * A port, or a way to make it from the registry (real mode's recipes and usage live there) and the
 * backlog (the workspace reads a ticket's images from it).
 */
export type FromRegistry<T> = T | ((registry: Registry, tickets: Tickets) => T);

export interface AppOptions extends ApiOptions {
  dbPath: string;
  /** Where brains and the handbook live: git repos on the host, never pushed. */
  knowledgeDir: string;
  /** The brain's search index: a disposable SQLite file (`<home>/brain-index.db`). Default: in memory. */
  brainIndexPath?: string;
  /** The FTS5 capability check, replaceable in tests (the default makes a throwaway FTS5 table). */
  brainProbe?: (db: Db) => void;
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
  /** Point the projects flow at a stand-in GitHub (tests, the end-to-end run). Unset: api.github.com. */
  githubApi?: string;
  githubFetch?: typeof fetch;
  live?: LiveEvents;
  log?: (msg: string) => void;
  push?: FromRegistry<PushService>;
  configDir?: string;
  /**
   * Where retention works (T52): the folder with the database and its backups, the logs, and big
   * folders to measure. Default: the database's folder (the knowledge folder for ":memory:").
   */
  storagePaths?: Partial<StoragePaths>;
  /** Ask machines to hand freed blocks back to the host (`fstrim`). Default: yes. */
  trimMachines?: boolean;
  /** What runs the agents behind conversations. Default: nothing yet (the session host, T59b). */
  ahpBackend?: FromRegistry<AgentBackend>;
  ahpLimits?: Partial<TransportLimits>;
  /** Timings of the conversation pushes (T65), for tests: the grace, the re-look, a long reply, the scheduler. */
  ahpPush?: Partial<
    Pick<ConversationPushOptions, "graceMs" | "recheckMs" | "longTurnMs" | "maxWaitMs" | "schedule">
  >;
  /** Let an AHP client upgrade without credentials and push the token with `authenticate` (off by default). */
  ahpDeferredAuth?: boolean;
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

  const tickets = new Tickets(db);
  tickets.onChange = (id) => live.notifyTicket(id);

  const proposals = new Proposals(db);
  proposals.onChange = () => live.notifyOffice();

  const make = <T>(port: FromRegistry<T>): T =>
    typeof port === "function" ? (port as (r: Registry, t: Tickets) => T)(registry, tickets) : port;

  const store = new SqliteEventStore(db);
  store.onAppend = (id) => live.notifyTicket(id);

  const knowledge = new KnowledgeStore(o.knowledgeDir, () => o.clock.now());
  // Fails here, at startup, with a clear message, if this SQLite has no FTS5.
  const brain = await BrainIndex.open(o.brainIndexPath ?? ":memory:", knowledge, o.log, {
    ...(o.brainProbe ? { probe: o.brainProbe } : {}),
  });

  const deps: DaemonDeps = {
    clock: o.clock,
    store,
    sessions: o.sessions ?? new SessionStore(db, o.clock),
    registry,
    tickets,
    proposals,
    machines: make(o.machines),
    agent: make(o.agent),
    harness: make(o.harness),
    ...(o.workspace ? { workspace: make(o.workspace) } : {}),
    ...(o.tokens ? { tokens: make(o.tokens) } : {}),
    ...(o.githubApi ? { githubApi: o.githubApi } : {}),
    ...(o.githubFetch ? { githubFetch: o.githubFetch } : {}),
    helper: o.helper,
    chat: o.chat,
    chatLog: new ChatLog(db),
    knowledge,
    brain,
    db,
    push: o.push ? make(o.push) : new WebPushSender(registry, o.configDir ? { configDir: o.configDir } : {}),
    live,
    ...(o.log ? { log: o.log } : {}),
  };
  const token = o.token;
  const backend: AgentBackend = o.ahpBackend
    ? make(o.ahpBackend)
    : new NoAgentBackend(() => agentsFromRegistry(registry));
  const host = new AhpHost({
    db,
    backend,
    now: () => o.clock.now(),
    ...(o.log ? { log: o.log } : {}),
    ...(o.ahpLimits ? { limits: o.ahpLimits } : {}),
    ...(token ? { verifyToken: (t: string) => same(t, token) } : {}),
  });
  // The root channel offers one agent per engine: it follows the registry.
  const officeChanged = registry.onChange;
  registry.onChange = (kind) => {
    officeChanged?.(kind);
    if (kind === "engine") host.refreshAgents();
  };
  const conversations = new ConversationService(db, host, registry, o.clock);
  deps.conversations = conversations;
  // A permission or a question nobody is looking at becomes a push that opens the card (T65).
  const conversationPush = new ConversationPush({
    host,
    conversations,
    registry,
    db,
    push: deps.push,
    now: () => o.clock.now(),
    ...(o.log ? { log: o.log } : {}),
    ...o.ahpPush,
  });
  // Turning "Conversations need me" off drops the requests still in their grace.
  const settingsWatcher = registry.onChange;
  registry.onChange = (kind) => {
    settingsWatcher?.(kind);
    if (kind === "settings") conversationPush.settingsChanged();
  };
  const transport = new AhpTransport(host, {
    ...(token ? { token } : {}),
    ...(o.hosts ? { hosts: o.hosts } : {}),
    ...(o.ahpDeferredAuth ? { deferredAuth: true } : {}),
  });
  const daemon = new Daemon(deps);
  const ops = deps.machines as unknown as Partial<MachineOps>;
  const storage = new Storage({
    db,
    clock: o.clock,
    registry,
    tickets,
    events: store,
    paths: {
      home: o.dbPath === ":memory:" ? o.knowledgeDir : dirname(o.dbPath),
      dbPath: o.dbPath,
      knowledgeDir: o.knowledgeDir,
      ...o.storagePaths,
    },
    ...(ops.machineFor && ops.listMachines && ops.runIn ? { ops: ops as MachineOps } : {}),
    ...(deps.push ? { push: deps.push } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.trimMachines !== undefined ? { trim: o.trimMachines } : {}),
    machineBusy: (machine) => daemon.machineBusy(machine),
    hostBusy: () => daemon.busy(),
    ticketActive: (id) => daemon.isRunning(id),
    archivedConversations: () => conversations.forCleanup(),
    copiesGone: (ids) => conversations.copiesGone(ids),
    footprint: () => ({
      ...daemon.footprint(),
      ...(ops.footprint ? ops.footprint() : {}),
    }),
  });
  deps.storage = storage;
  daemon.storage = storage;
  // A conversation remembers which machine its copy is in, so a team change can't strand it.
  conversations.machineOf = (employeeId) => storage.machineOf(employeeId);
  // Conversations count as work: the health check, the deployer's drain and VACUUM see their turns,
  // and a machine with a live conversation agent is neither cleaned nor stopped.
  daemon.onBusy(() => host.busy());
  if (backend.liveEmployees) {
    const live = () => backend.liveEmployees?.() ?? [];
    daemon.onMachineBusy((machine) => live().some((e) => storage.machineOf(e) === machine));
  }
  backend.attachApp?.({ storage, awake: (id) => daemon.noteAwake(id) });
  // The index follows every commit from here on, including the first commits of a new install's
  // repos; then one look at each repo's HEAD brings in whatever changed while the daemon was down
  // (nothing, usually: it costs one `git rev-list` a repo, and an install's first boot has nothing
  // to read). A rebuild from scratch is for a changed schema, which `BrainIndex.open` already did.
  knowledge.onCommit = (repo, paths) => brain.follow(repo, paths);
  daemon.ensureKnowledge();
  brain.refresh();
  const handle = createApi(daemon, deps, {
    ...(o.token ? { token: o.token } : {}),
    ...(o.hosts ? { hosts: o.hosts } : {}),
    ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
    ...(o.version ? { version: o.version } : {}),
    ...(o.deploysPath ? { deploysPath: o.deploysPath } : {}),
  });
  // Tells the owner (push) about a failed deploy the deployer recorded; main.ts calls check() on a timer.
  const deploys = new DeployNotifier({
    path: o.deploysPath,
    db,
    push: deps.push,
    now: () => o.clock.now(),
    ...(o.log ? { log: o.log } : {}),
  });
  return {
    db,
    deps,
    daemon,
    handle,
    live,
    storage,
    deploys,
    ahp: { host, transport, conversations, backend, push: conversationPush },
  };
}
