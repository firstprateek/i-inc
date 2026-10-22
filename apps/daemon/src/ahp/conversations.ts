// Conversations: the product object behind an AHP session (docs/design/conversations.md).
//
// A conversation is a row here (who, which project, which branch, which engine, its title) and an AHP
// session with one chat in the host (everything that happened in it). The row is what the list, the
// archive and the picker read; the session is what a conversation screen subscribes to. The service
// keeps the two in step: a title or an archive set over AHP lands in the row, one set over REST
// lands in the session.

import type { Clock, Employee, Engine, Id } from "@i-inc/core";
import { type AgentInfo, AhpErrorCodes, JsonRpcErrorCodes } from "@microsoft/agent-host-protocol";
import type { Db } from "../db.ts";
import type { Registry } from "../registry.ts";
import type { ShipBrief } from "../view-types.ts";
import { type AhpHost, DEFAULT_TITLE, RpcError } from "./host.ts";
import {
  ActionType,
  activity,
  type Json,
  type SessionState,
  SessionStatus,
  type StateAction,
} from "./wire.ts";

export interface Conversation {
  id: string;
  employeeId: Id;
  /** The project's id, or null for a conversation with no project (an empty scratch folder). */
  project: string | null;
  /** The branch the working copy is on (`conv/<id>`), null with no project. */
  branch: string | null;
  title: string;
  /** The agent's permission mode now (null until the agent has said). */
  mode: string | null;
  engineId: Id;
  createdAt: number;
  archivedAt: number | null;
  ahpSession: string;
  ahpChat: string;
}

/** A conversation as the REST API shows it: the row plus what the host knows right now. */
export interface ConversationView extends Conversation {
  /** Present once the work was handed to a ticket or opened as a PR. */
  ship?: ShipBrief;
  /** The AHP status bits of the session (see wire.ts SessionStatus). */
  status: number;
  /** Something is waiting for the owner: a permission or a question. */
  needsYou: boolean;
  running: boolean;
  /** When anything last happened in it (ms). */
  modifiedAt: number;
}

export interface NewConversation {
  employeeId: Id;
  project?: string | null;
  title?: string;
  /** A mode the agent advertises, such as its bypass or plan mode. Absent: the agent's default. */
  mode?: string;
  engineId?: Id;
}

/** A refusal the API shows the owner: `status` is the HTTP status. */
export class ConversationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
    /** The AHP error code, when the refusal came from the host. */
    readonly code?: number,
  ) {
    super(message);
  }
}

type Row = {
  machine: string | null;
  disposed_at: number | null;
  id: string;
  employee_id: string;
  project: string | null;
  branch: string | null;
  title: string;
  mode: string | null;
  engine_id: string;
  created_at: number;
  archived_at: number | null;
  ahp_session: string;
  ahp_chat: string;
};

const toConversation = (r: Row): Conversation => ({
  id: r.id,
  employeeId: r.employee_id,
  project: r.project,
  branch: r.branch,
  title: r.title,
  mode: r.mode,
  engineId: r.engine_id,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
  ahpSession: r.ahp_session,
  ahpChat: r.ahp_chat,
});

/** A tombstone is kept this long after its working copy is seen to be gone. */
export const TOMBSTONE_DAYS = 7;

/** Where a conversation's working copy lives in its employee's sandbox. */
export const conversationDir = (id: string): string => `/home/employee/work/conv-${id}`;

/** The providers the host offers: one per engine. The session host (T59b) refines them per harness. */
export function agentsFromRegistry(registry: Registry): AgentInfo[] {
  return registry.engines().map((e: Engine) => ({
    provider: e.id,
    displayName: e.id,
    description: `${e.harness} · ${e.model}`,
    models: [],
    capabilities: {},
  }));
}

export class ConversationService {
  constructor(
    private readonly db: Db,
    private readonly host: AhpHost,
    private readonly registry: Registry,
    private readonly clock: Clock,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        project TEXT,
        branch TEXT,
        title TEXT NOT NULL,
        mode TEXT,
        engine_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        archived_at INTEGER,
        ahp_session TEXT NOT NULL,
        ahp_chat TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(ahp_session);
      CREATE INDEX IF NOT EXISTS idx_conversations_employee ON conversations(employee_id, created_at);
    `);
    // Added later: a tombstone for a conversation whose session was disposed, and the machine its copy is in.
    const have = db.all<{ name: string }>("PRAGMA table_info(conversations)").map((c) => c.name);
    if (!have.includes("disposed_at")) db.exec("ALTER TABLE conversations ADD COLUMN disposed_at INTEGER");
    if (!have.includes("machine")) db.exec("ALTER TABLE conversations ADD COLUMN machine TEXT");
    // When a cleanup pass found a disposed conversation's copy gone: the tombstone goes some days later.
    if (!have.includes("copy_gone_at")) db.exec("ALTER TABLE conversations ADD COLUMN copy_gone_at INTEGER");
    this.attach();
    this.reconcile();
  }

  /**
   * A cleanup pass found these conversations' working copies gone. A tombstone (a disposed
   * conversation kept only so its copy can be found) is dropped TOMBSTONE_DAYS after that.
   */
  copiesGone(ids: string[]): void {
    const now = this.clock.now();
    for (const id of ids) {
      this.db.run(
        "UPDATE conversations SET copy_gone_at = COALESCE(copy_gone_at, ?) WHERE id = ? AND disposed_at IS NOT NULL",
        now,
        id,
      );
    }
    this.pruneTombstones();
  }

  /** Drops tombstones whose copy has been gone for TOMBSTONE_DAYS; returns how many. */
  pruneTombstones(): number {
    const cutoff = this.clock.now() - TOMBSTONE_DAYS * 86_400_000;
    const before =
      this.db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM conversations WHERE disposed_at IS NOT NULL AND copy_gone_at IS NOT NULL AND copy_gone_at <= ?",
        cutoff,
      )[0]?.n ?? 0;
    if (before > 0) {
      this.db.run(
        "DELETE FROM conversations WHERE disposed_at IS NOT NULL AND copy_gone_at IS NOT NULL AND copy_gone_at <= ?",
        cutoff,
      );
    }
    return before;
  }

  /** Set by shipping: what to say about a conversation's ticket and PR in its row. */
  shipBrief: ((id: string) => ShipBrief | undefined) | undefined;

  /** Where an employee's conversations run (a machine name), for the cleanup to find their copies. */
  machineOf: ((employeeId: Id) => string | undefined) | undefined;

  /**
   * After a restart: a row whose session is gone (the daemon stopped between disposing the session
   * and noting it) becomes a tombstone, and a session with no row (it stopped between making the session
   * and its row) gets a tombstone row and is disposed, so the cleanup still finds the working copy.
   */
  private reconcile(): void {
    const now = this.clock.now();
    this.pruneTombstones();
    for (const r of this.db.all<Row>("SELECT * FROM conversations WHERE disposed_at IS NULL")) {
      if (!this.host.sessionState(r.ahp_session)) this.tombstone(r.ahp_session, now);
    }
    const known = new Set(this.db.all<{ id: string }>("SELECT id FROM conversations").map((r) => r.id));
    for (const session of this.host.sessions()) {
      const s = this.host.sessionState(session);
      const meta = (s?._meta ?? {}) as Json;
      const id = meta["iinc.conversation"];
      if (!s || typeof id !== "string" || known.has(id)) continue;
      this.db.run(
        `INSERT INTO conversations (id, employee_id, project, branch, title, mode, engine_id, created_at, archived_at, disposed_at, ahp_session, ahp_chat)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        id,
        String(meta["iinc.employee"] ?? ""),
        typeof meta["iinc.project"] === "string" ? meta["iinc.project"] : null,
        typeof meta["iinc.branch"] === "string" ? meta["iinc.branch"] : null,
        s.title,
        s.provider,
        now,
        now,
        now,
        session,
        s.defaultChat ?? "",
      );
      void this.host.disposeSession(session).catch(() => {});
    }
  }

  /** Marks a conversation's session as gone. The row stays (archived), so its working copy is cleaned like any archived one's. */
  private tombstone(session: string, now: number): void {
    this.db.run(
      "UPDATE conversations SET disposed_at = ?, archived_at = COALESCE(archived_at, ?) WHERE ahp_session = ?",
      now,
      now,
      session,
    );
  }

  /** Archived and disposed conversations, with where their working copies are: what the sandbox cleanup works from. */
  forCleanup(): {
    id: Id;
    employeeId: Id;
    project: string | null;
    archivedAt: number;
    machine: string | null;
  }[] {
    return this.db.all<Row>("SELECT * FROM conversations WHERE archived_at IS NOT NULL").map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      project: r.project,
      archivedAt: r.archived_at as number,
      machine: r.machine,
    }));
  }

  /** Wires the host's hooks: AHP clients can create conversations, rename and archive them too. */
  private attach(): void {
    const hooks = this.host.hooks;
    hooks.onApplied = (channel, action) => this.onApplied(channel, action);
    hooks.onCreateSession = async (p) => {
      const iinc = (p._meta as Json | undefined)?.iinc as Json | undefined;
      if (!iinc || typeof iinc.employeeId !== "string") {
        throw new RpcError(
          JsonRpcErrorCodes.InvalidParams,
          'createSession needs _meta.iinc = { "employeeId", "project"? }',
        );
      }
      try {
        await this.create({
          employeeId: iinc.employeeId,
          ...(typeof iinc.project === "string" ? { project: iinc.project } : {}),
          ...(typeof iinc.title === "string" ? { title: iinc.title } : {}),
          ...(typeof p.provider === "string" ? { engineId: p.provider } : {}),
          ...(typeof (p.config as Json | undefined)?.mode === "string"
            ? { mode: (p.config as Json).mode as string }
            : {}),
          session: String(p.channel),
        });
      } catch (e) {
        if (!(e instanceof ConversationError)) throw e;
        const code =
          e.code ??
          (e.status === 409
            ? AhpErrorCodes.Conflict
            : e.status === 502
              ? JsonRpcErrorCodes.InternalError
              : JsonRpcErrorCodes.InvalidParams);
        throw new RpcError(code, e.message);
      }
    };
    // A conversation's session is only disposed once it is archived.
    hooks.canDisposeSession = (session) => this.bySession(session)?.archivedAt != null;
    // Disposing forgets the session and its log, not the conversation's working copy in the sandbox:
    // the row stays, archived and marked disposed (hidden from the API), and the cleanup removes the
    // copy by the same rules as any archived conversation's.
    hooks.onSessionDisposed = (session) => this.tombstone(session, this.clock.now());
  }

  private onApplied(channel: string, action: StateAction): void {
    switch (action.type) {
      case ActionType.SessionTitleChanged:
        this.db.run("UPDATE conversations SET title = ? WHERE ahp_session = ?", action.title, channel);
        return;
      case ActionType.SessionIsArchivedChanged:
        this.db.run(
          "UPDATE conversations SET archived_at = ? WHERE ahp_session = ?",
          action.isArchived ? this.clock.now() : null,
          channel,
        );
        return;
      case ActionType.SessionConfigChanged: {
        const mode = (action.config as Json | undefined)?.mode;
        if (typeof mode === "string")
          this.db.run("UPDATE conversations SET mode = ? WHERE ahp_session = ?", mode, channel);
        return;
      }
    }
  }

  // ── reading ─────────────────────────────────────────────────────────────────────────────────

  private view(c: Conversation): ConversationView {
    const sum = this.host.summary(c.ahpSession);
    const status = sum?.status ?? SessionStatus.Idle;
    const ship = this.shipBrief?.(c.id);
    return {
      ...c,
      ...(ship ? { ship } : {}),
      status,
      needsYou: activity(status) === SessionStatus.InputNeeded,
      running:
        activity(status) === SessionStatus.InProgress || activity(status) === SessionStatus.InputNeeded,
      modifiedAt: sum ? Date.parse(sum.modifiedAt) : c.createdAt,
    };
  }

  get(id: string): ConversationView | undefined {
    const [r] = this.db.all<Row>("SELECT * FROM conversations WHERE id = ? AND disposed_at IS NULL", id);
    return r ? this.view(toConversation(r)) : undefined;
  }

  byChat(chat: string): Conversation | undefined {
    const [r] = this.db.all<Row>(
      "SELECT * FROM conversations WHERE ahp_chat = ? AND disposed_at IS NULL",
      chat,
    );
    return r ? toConversation(r) : undefined;
  }

  bySession(session: string): Conversation | undefined {
    const [r] = this.db.all<Row>("SELECT * FROM conversations WHERE ahp_session = ?", session);
    return r ? toConversation(r) : undefined;
  }

  /** Newest activity first. `archived`: only archived (true), only live (false, the default) or all ("all"). */
  list(opts: { archived?: boolean | "all"; employeeId?: Id } = {}): ConversationView[] {
    const where: string[] = ["disposed_at IS NULL"];
    const args: string[] = [];
    if (opts.archived !== "all")
      where.push(opts.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL");
    if (opts.employeeId) {
      where.push("employee_id = ?");
      args.push(opts.employeeId);
    }
    return this.db
      .all<Row>(`SELECT * FROM conversations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, ...args)
      .map((r) => this.view(toConversation(r)))
      .sort((a, b) => b.modifiedAt - a.modifiedAt || b.createdAt - a.createdAt);
  }

  // ── writing ─────────────────────────────────────────────────────────────────────────────────

  async create(input: NewConversation & { session?: string }): Promise<ConversationView> {
    let employee: Employee;
    try {
      employee = this.registry.employee(input.employeeId);
    } catch {
      throw new ConversationError(`no employee ${input.employeeId}`, 400);
    }
    const project = input.project ?? null;
    if (project !== null) {
      if (typeof project !== "string" || !this.registry.project(project)) {
        throw new ConversationError(`no project ${String(project)}`, 400);
      }
      if (employee.projects && !employee.projects.includes(project)) {
        throw new ConversationError(`${employee.name} doesn't work on ${project}`, 409);
      }
    }
    const engineId = input.engineId ?? employee.engines.perDuty?.build ?? employee.engines.default;
    if (!this.registry.engines().some((e) => e.id === engineId)) {
      throw new ConversationError(`no engine ${engineId}`, 400);
    }
    const title = input.title?.trim();
    if (input.title !== undefined && (!title || title.length > 200)) {
      throw new ConversationError("a title is 1 to 200 characters", 400);
    }
    if (input.mode !== undefined && (typeof input.mode !== "string" || input.mode.length > 100)) {
      throw new ConversationError("mode must be one of the agent's modes", 400);
    }
    const id = crypto.randomUUID().slice(0, 8);
    const branch = project === null ? null : `conv/${id}`;
    this.host.refreshAgents();
    let made: { session: string; chat: string };
    try {
      made = await this.host.createSession({
        ...(input.session ? { session: input.session } : {}),
        provider: engineId,
        title: title ?? DEFAULT_TITLE,
        // With no project the working directory is an empty scratch folder at the same place.
        workingDirectories: [`file://${conversationDir(id)}`],
        ...(input.mode ? { config: { mode: input.mode } } : {}),
        meta: {
          "iinc.conversation": id,
          "iinc.employee": employee.id,
          ...(project !== null ? { "iinc.project": project, "iinc.branch": branch } : {}),
        },
      });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : undefined;
      const status =
        code === AhpErrorCodes.SessionAlreadyExists || (e instanceof Error && e.name === "NoSlotError")
          ? 409
          : code === JsonRpcErrorCodes.InvalidParams || code === AhpErrorCodes.ProviderNotFound
            ? 400
            : 502;
      throw new ConversationError(e instanceof Error ? e.message : String(e), status, code);
    }
    const session = this.host.sessionState(made.session) as SessionState;
    const mode = typeof session.config?.values.mode === "string" ? session.config.values.mode : null;
    this.db.run(
      `INSERT INTO conversations (id, employee_id, project, branch, title, mode, engine_id, created_at, archived_at, ahp_session, ahp_chat, machine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      id,
      employee.id,
      project,
      branch,
      session.title,
      mode,
      engineId,
      this.clock.now(),
      made.session,
      made.chat,
      this.machineOf?.(employee.id) ?? null,
    );
    return this.get(id) as ConversationView;
  }

  /** Renames and archives, in the row and in the session, so every screen sees it. */
  update(id: string, patch: { title?: unknown; archived?: unknown }): ConversationView {
    const c = this.get(id);
    if (!c) throw new ConversationError("no such conversation", 404);
    // Everything is checked before anything is applied: a bad field changes nothing.
    let title: string | undefined;
    if (patch.title !== undefined) {
      title = typeof patch.title === "string" ? patch.title.trim() : "";
      if (!title || title.length > 200) throw new ConversationError("a title is 1 to 200 characters", 400);
    }
    if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
      throw new ConversationError("archived must be true or false", 400);
    }
    if (title !== undefined && title !== c.title) {
      this.host.apply(c.ahpSession, { type: ActionType.SessionTitleChanged, title });
    }
    if (patch.archived !== undefined) {
      if (patch.archived !== (c.archivedAt !== null)) {
        this.host.apply(c.ahpSession, {
          type: ActionType.SessionIsArchivedChanged,
          isArchived: patch.archived,
        });
        this.host.apply(c.ahpChat, { type: ActionType.ChatIsArchivedChanged, isArchived: patch.archived });
      }
    }
    return this.get(id) as ConversationView;
  }
}
