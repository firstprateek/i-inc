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
    this.attach();
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
    hooks.onSessionDisposed = (session) => {
      this.db.run("DELETE FROM conversations WHERE ahp_session = ?", session);
    };
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
    return {
      ...c,
      status,
      needsYou: activity(status) === SessionStatus.InputNeeded,
      running:
        activity(status) === SessionStatus.InProgress || activity(status) === SessionStatus.InputNeeded,
      modifiedAt: sum ? Date.parse(sum.modifiedAt) : c.createdAt,
    };
  }

  get(id: string): ConversationView | undefined {
    const [r] = this.db.all<Row>("SELECT * FROM conversations WHERE id = ?", id);
    return r ? this.view(toConversation(r)) : undefined;
  }

  bySession(session: string): Conversation | undefined {
    const [r] = this.db.all<Row>("SELECT * FROM conversations WHERE ahp_session = ?", session);
    return r ? toConversation(r) : undefined;
  }

  /** Newest activity first. `archived`: only archived (true), only live (false, the default) or all ("all"). */
  list(opts: { archived?: boolean | "all"; employeeId?: Id } = {}): ConversationView[] {
    const where: string[] = [];
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
        workingDirectories: project === null ? [] : [`file://${conversationDir(id)}`],
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
        code === AhpErrorCodes.SessionAlreadyExists
          ? 409
          : code === JsonRpcErrorCodes.InvalidParams || code === AhpErrorCodes.ProviderNotFound
            ? 400
            : 502;
      throw new ConversationError(e instanceof Error ? e.message : String(e), status, code);
    }
    const session = this.host.sessionState(made.session) as SessionState;
    const mode = typeof session.config?.values.mode === "string" ? session.config.values.mode : null;
    this.db.run(
      `INSERT INTO conversations (id, employee_id, project, branch, title, mode, engine_id, created_at, archived_at, ahp_session, ahp_chat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
    );
    return this.get(id) as ConversationView;
  }

  /** Renames and archives, in the row and in the session, so every screen sees it. */
  update(id: string, patch: { title?: unknown; archived?: unknown }): ConversationView {
    const c = this.get(id);
    if (!c) throw new ConversationError("no such conversation", 404);
    if (patch.title !== undefined) {
      const title = typeof patch.title === "string" ? patch.title.trim() : "";
      if (!title || title.length > 200) throw new ConversationError("a title is 1 to 200 characters", 400);
      if (title !== c.title) this.host.apply(c.ahpSession, { type: ActionType.SessionTitleChanged, title });
    }
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== "boolean")
        throw new ConversationError("archived must be true or false", 400);
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
