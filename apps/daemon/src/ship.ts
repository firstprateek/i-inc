// Shipping a conversation's work (T62b, docs/design/conversations.md "Make this a ticket"):
//
//  - "Make this a ticket": the conversation's branch and working copy become a ticket's. The ticket
//    enters the pipeline at the checks (pick-up, plan and build are done: the conversation did them), then
//    review and prove, and ends as the project says: a PR for the owner (owner-merges), or a push to main
//    (direct). While it runs the conversation's agent is stopped and the conversation takes no message
//    ("This work is now ticket #N"), so two agents never share a working copy. When the ticket is done or has
//    failed, the conversation carries on from the branch as the ticket left it.
//  - "Open a PR" (owner-merges only): the quick path that skips the pipeline: commit, push as the bot, a
//    draft PR with a generated title and body.
//
// Both commit what is uncommitted first, after the scan for credentials (ship-git.ts). Both are safe to
// repeat: a second click finds the first one's result. Nothing here pushes to main; the gates do.

import {
  type Clock,
  defaultProjectPolicy,
  type Employee,
  fold,
  type Id,
  planFor,
  type Ticket,
  type TicketEvent,
} from "@i-inc/core";
import type { AgentBackend } from "./ahp/backend.ts";
import { type ConversationService, type ConversationView, conversationDir } from "./ahp/conversations.ts";
import { type AhpHost, DEFAULT_TITLE } from "./ahp/host.ts";
import { redactText } from "./ahp/sanitize.ts";
import type { Db } from "./db.ts";
import { type PrChecks, type PrInfo, UpstreamGitHubError } from "./github.ts";
import { describeGitHubError } from "./github-projects.ts";
import type { LiveEvents } from "./live.ts";
import type { Project, Registry } from "./registry.ts";
import { type CopyReport, type ShipCopy, type ShipPort, ShipRefusal, secretsSentence } from "./ship-git.ts";
import type { SqliteEventStore } from "./store.ts";
import type { Tickets } from "./tickets.ts";
import type { ShipBrief, ShipMode, ShipView } from "./view-types.ts";
import { ticketView } from "./views.ts";

/** A refusal the API shows the owner as a sentence. */
export class ShipError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 424 | 429,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ShippingDeps {
  db: Db;
  clock: Clock;
  registry: Registry;
  tickets: Tickets;
  store: SqliteEventStore;
  conversations: ConversationService;
  host: AhpHost;
  backend: AgentBackend;
  port: ShipPort;
  live: LiveEvents;
  /** Wakes the employee's machine. */
  ensureUp: (employeeId: Id) => Promise<void>;
  /** Tells the daemon the machine was woken, so it is stopped and cleaned like the rest. */
  awake?: (employeeId: Id) => void;
  /** Starts the pipeline for what the scheduler hasn't seen yet. */
  tick: () => Promise<void>;
  log?: (msg: string) => void;
}

interface Handover {
  conversation: string;
  ticket: Id | null;
}

const PENDING_MS = 10 * 60_000;
const PR_CACHE_MS = 20_000;

const clean = (s: string, max: number) => redactText(s.replace(/\s+/g, " ").trim()).slice(0, max);

/** A conventional-commit type for a title: a fix when it says so, else a feature. */
export function typeOf(title: string): "fix" | "feat" {
  return /\b(fix(es|ed)?|bug|broken|crash(es)?|regression|typo)\b/i.test(title) ? "fix" : "feat";
}

export class Shipping {
  private readonly inflight = new Map<string, { kind: "ticket" | "pr"; promise: Promise<unknown> }>();
  /** Conversations a quick action (the PR) is working in right now: they take no message meanwhile. */
  private readonly quick = new Set<string>();
  private readonly prCache = new Map<
    string,
    { at: number; info: PrInfo | null; checks: PrChecks | null; problem?: string }
  >();
  private releasing = new Set<string>();

  constructor(private readonly d: ShippingDeps) {
    d.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_tickets (
        conversation_id TEXT NOT NULL,
        ticket_id TEXT,
        created_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_tickets_active
        ON conversation_tickets(conversation_id) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_conversation_tickets_ticket ON conversation_tickets(ticket_id);
      CREATE TABLE IF NOT EXISTS conversation_prs (
        conversation_id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        node_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    d.conversations.shipBrief = (id) => this.brief(id);
    d.host.hooks.canStartTurn = (chat) => this.blocked(chat);
    d.live.on("ticket", (id: string) => {
      void this.onTicket(String(id)).catch((e) => d.log?.(`shipping: ${String(e)}`));
    });
    this.reconcile();
  }

  // ───────────────────────────── what the rest of the daemon asks ─────────────────────────────

  private active(conversation: string): Handover | undefined {
    const [r] = this.d.db.all<{ conversation_id: string; ticket_id: string | null }>(
      "SELECT conversation_id, ticket_id FROM conversation_tickets WHERE conversation_id = ? AND released_at IS NULL",
      conversation,
    );
    return r ? { conversation: r.conversation_id, ticket: r.ticket_id } : undefined;
  }

  private prRow(conversation: string) {
    const [r] = this.d.db.all<{ number: number; url: string; node_id: string }>(
      "SELECT number, url, node_id FROM conversation_prs WHERE conversation_id = ?",
      conversation,
    );
    return r;
  }

  /** The list rows' summary: cheap, no GitHub. */
  brief(conversation: string): ShipBrief | undefined {
    const h = this.active(conversation);
    const pr = this.prRow(conversation);
    if (!h && !pr) return undefined;
    return {
      ticket: h ? { id: h.ticket ?? "", held: true } : null,
      pr: pr ? { number: pr.number, url: pr.url } : null,
    };
  }

  /** Why this chat can't take a turn now: its working copy is a ticket's, or is being shipped. */
  private blocked(chat: string): string | undefined {
    const conv = this.d.conversations.byChat(chat);
    if (!conv) return undefined;
    const h = this.active(conv.id);
    if (h) {
      return h.ticket
        ? `This work is now ticket #${h.ticket}. The conversation can't change the code until the ticket is done: open the ticket to follow it.`
        : "i.inc is turning this conversation's work into a ticket. Try again in a moment.";
    }
    if (this.quick.has(conv.id)) return "i.inc is shipping this conversation's work. Try again in a moment.";
    return undefined;
  }

  // ───────────────────────────── the pieces ─────────────────────────────

  private context(id: string): {
    conv: ConversationView;
    project: Project;
    mode: ShipMode;
    employee: Employee;
    copy: ShipCopy;
  } {
    const conv = this.d.conversations.get(id);
    if (!conv) throw new ShipError("There is no such conversation.", 404, "not-found");
    if (conv.project === null || conv.branch === null) {
      throw new ShipError(
        "This conversation has no project, so it has no code to ship. Start a conversation on a project to ship its changes.",
        409,
        "no-project",
      );
    }
    const project = this.d.registry.project(conv.project);
    if (!project) {
      throw new ShipError(
        `${conv.project} isn't a project any more, so this work has nowhere to go.`,
        409,
        "no-project",
      );
    }
    let employee: Employee;
    try {
      employee = this.d.registry.employee(conv.employeeId);
    } catch {
      throw new ShipError(
        "The employee who had this conversation has left, so it can't be shipped.",
        409,
        "no-employee",
      );
    }
    const policy = this.d.registry.projectPolicy(project.id);
    return {
      conv,
      project,
      mode: policy.mode,
      employee,
      copy: {
        employee,
        repo: project.repo,
        base: project.defaultBranch || "main",
        protectedPaths: policy.protectedPaths ?? defaultProjectPolicy.protectedPaths,
        branch: conv.branch,
        cwd: conversationDir(conv.id),
      },
    };
  }

  private requireOpen(conv: ConversationView): void {
    if (conv.archivedAt !== null) {
      throw new ShipError(
        "This conversation is archived. Bring it back from the archive first.",
        409,
        "archived",
      );
    }
  }

  /** GitHub's problems are said for the owner, never in GitHub's words. */
  private github<T>(work: Promise<T>): Promise<T> {
    return work.catch((e) => {
      if (e instanceof UpstreamGitHubError) {
        const p = describeGitHubError(e);
        throw new ShipError(
          p.error,
          p.status === 429 ? 429 : 424,
          p.code,
          p.retryAfter ? { retryAfter: p.retryAfter } : {},
        );
      }
      throw e;
    });
  }

  /** The employee's machine is up, or the owner is told it wasn't. */
  private async wake(employee: Employee): Promise<void> {
    try {
      await this.d.ensureUp(employee.id);
    } catch (e) {
      throw new ShipError(
        `Couldn't wake ${employee.name}'s machine: ${e instanceof Error ? e.message : String(e)}`,
        424,
        "machine",
      );
    }
    this.d.awake?.(employee.id);
  }

  private refusal(e: unknown): never {
    if (e instanceof ShipRefusal) throw new ShipError(e.message, e.code === "git" ? 424 : 409, e.code);
    throw e;
  }

  /** The chat as the summary reads it: what was asked, in the owner's words. */
  private asked(conv: ConversationView): string[] {
    const turns = this.d.host.chatState(conv.ahpChat)?.turns ?? [];
    return turns.map((t) => clean(t.message.text, 400)).filter(Boolean);
  }

  private suggest(conv: ConversationView, employee: Employee, report: CopyReport | undefined) {
    const asked = this.asked(conv);
    const first = asked[0] ?? "";
    const fresh = conv.title && conv.title !== DEFAULT_TITLE ? conv.title : "";
    const title = clean(fresh || first || `Work from a conversation with ${employee.name}`, 120);
    const changed = report?.files.length
      ? `Changed ${report.files.length} file${report.files.length === 1 ? "" : "s"} (+${report.files.reduce((n, f) => n + f.added, 0)} −${report.files.reduce((n, f) => n + f.removed, 0)}): ${report.files
          .slice(0, 8)
          .map((f) => f.path)
          .join(", ")}${report.files.length > 8 ? ", …" : ""}.`
      : "";
    const description = [
      `Made from a conversation with ${employee.name}, where the work was already built.`,
      first ? `Asked: ${first}` : "",
      asked.length > 1 && asked.at(-1) !== first ? `Latest ask: ${asked.at(-1)}` : "",
      changed,
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
    const doneWhen = [
      first
        ? `Does what the conversation asked: ${first.slice(0, 140)}`
        : "Does what the conversation set out to do",
      "The project's checks pass",
    ];
    return { title, doneWhen, description };
  }

  // ───────────────────────────── reading ─────────────────────────────

  async view(id: string, o: { preview?: boolean } = {}): Promise<ShipView> {
    const conv = this.d.conversations.get(id);
    if (!conv) throw new ShipError("There is no such conversation.", 404, "not-found");
    const base: ShipView = {
      project: conv.project,
      mode: null,
      canTicket: false,
      canPr: false,
      ticket: await this.ticketOf(id),
      pr: await this.prOf(id, conv),
    };
    let ctx: ReturnType<Shipping["context"]> | undefined;
    try {
      ctx = this.context(id);
    } catch (e) {
      if (e instanceof ShipError) return { ...base, reason: e.message };
      throw e;
    }
    base.mode = ctx.mode;
    const held = base.ticket?.held === true;
    const why =
      conv.archivedAt !== null
        ? "This conversation is archived. Bring it back from the archive first."
        : held
          ? `This work is now ticket #${base.ticket?.id}.`
          : undefined;
    base.canTicket = !why;
    base.canPr = !why && ctx.mode === "owner-merges";
    if (why) base.reason = why;
    else if (ctx.mode === "direct") {
      base.reason = "This project pushes straight to main after a review, so its way there is a ticket.";
    }
    if (!o.preview) return base;
    let report: CopyReport | undefined;
    if (!held) {
      try {
        await this.wake(ctx.employee);
        report = await this.d.port.inspect(ctx.copy);
      } catch (e) {
        base.problem =
          e instanceof ShipRefusal
            ? e.message
            : e instanceof Error
              ? `Couldn't look at the working copy: ${e.message}`
              : "Couldn't look at the working copy.";
      }
    }
    if (report) {
      const blockers: string[] = [];
      if (report.secrets.length) {
        blockers.push(
          `${report.secrets.map((s) => s.path).join(", ")} look${report.secrets.length === 1 ? "s" : ""} like ${report.secrets.length === 1 ? "it holds" : "they hold"} a credential`,
        );
      }
      if (report.tooBig) blockers.push("the change is too big to check for credentials");
      if (!report.files.length) blockers.push("nothing has changed yet");
      base.copy = {
        branch: ctx.copy.branch,
        files: report.files,
        uncommitted: report.uncommitted.length,
        ahead: report.ahead,
        protectedPaths: report.protectedPaths,
        pushed: report.remote !== "" && report.remote === report.head,
        blockers,
      };
    }
    base.suggestion = this.suggest(conv, ctx.employee, report);
    return base;
  }

  private async ticketOf(id: string): Promise<ShipView["ticket"]> {
    const [r] = this.d.db.all<{ ticket_id: string | null; released_at: number | null }>(
      "SELECT ticket_id, released_at FROM conversation_tickets WHERE conversation_id = ? AND ticket_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      id,
    );
    if (!r?.ticket_id)
      return this.active(id)
        ? { id: "", title: "", status: "queued", stage: null, live: "Starting", held: true, outcome: null }
        : null;
    const rec = this.d.tickets.get(r.ticket_id);
    if (!rec) return null;
    const events = await this.d.store.read(rec.ticket.id);
    const state = fold(events);
    const v = ticketView(rec, state, events, this.d.registry, null);
    const stage =
      v.stages.find((s) => s.state === "current")?.id ?? v.stages.find((s) => s.state === "todo")?.id ?? null;
    return {
      id: v.id,
      title: v.title,
      status: v.status,
      stage,
      live: v.live,
      held: r.released_at === null,
      outcome: v.outcome,
    };
  }

  private async prOf(id: string, conv: ConversationView): Promise<ShipView["pr"]> {
    const row = this.prRow(id);
    if (!row || conv.project === null) return null;
    const repo = this.d.registry.project(conv.project)?.repo;
    const cached = this.prCache.get(id);
    const now = this.d.clock.now();
    let entry = cached && now - cached.at < PR_CACHE_MS ? cached : undefined;
    if (!entry && repo) {
      try {
        const info = await this.d.port.prs.get(repo, row.number);
        const checks = info.headSha ? await this.d.port.prs.checks(repo, info.headSha) : null;
        entry = { at: now, info, checks };
      } catch (e) {
        const problem =
          e instanceof UpstreamGitHubError
            ? describeGitHubError(e).error
            : "Couldn't ask GitHub about the pull request.";
        entry = { at: now, info: cached?.info ?? null, checks: cached?.checks ?? null, problem };
      }
      this.prCache.set(id, entry);
    }
    return {
      number: row.number,
      url: row.url,
      state: entry?.info?.state ?? "unknown",
      draft: entry?.info?.draft ?? true,
      checks: entry?.checks ?? null,
      ...(entry?.problem ? { problem: entry.problem } : {}),
    };
  }

  // ───────────────────────────── make this a ticket ─────────────────────────────

  async makeTicket(
    id: string,
    input: { title?: string; doneWhen?: string[]; description?: string },
  ): Promise<{ ticket: Ticket; created: boolean }> {
    const running = this.inflight.get(id);
    if (running) {
      if (running.kind !== "ticket") {
        throw new ShipError(
          "Another shipping action is running for this conversation. Wait for it to finish.",
          409,
          "busy",
        );
      }
      return { ...((await running.promise) as { ticket: Ticket }), created: false };
    }
    const existing = this.active(id);
    if (existing?.ticket) {
      const rec = this.d.tickets.get(existing.ticket);
      if (rec) return { ticket: rec.ticket, created: false };
    }
    const promise = this.createTicket(id, input);
    this.inflight.set(id, { kind: "ticket", promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(id);
    }
  }

  private async createTicket(
    id: string,
    input: { title?: string; doneWhen?: string[]; description?: string },
  ): Promise<{ ticket: Ticket; created: boolean }> {
    const ctx = this.context(id);
    this.requireOpen(ctx.conv);
    if (!this.d.registry.employees().some((e) => e.id === ctx.employee.id)) {
      throw new ShipError("The employee who had this conversation has left.", 409, "no-employee");
    }
    const now = this.d.clock.now();
    // The conversation is claimed first: from here no message reaches its agent.
    try {
      this.d.db.run(
        "INSERT INTO conversation_tickets (conversation_id, ticket_id, created_at) VALUES (?, NULL, ?)",
        id,
        now,
      );
    } catch {
      const again = this.active(id);
      const rec = again?.ticket ? this.d.tickets.get(again.ticket) : undefined;
      if (rec) return { ticket: rec.ticket, created: false };
      throw new ShipError("This conversation is already being made into a ticket.", 409, "busy");
    }
    const undo = () =>
      this.d.db.run("DELETE FROM conversation_tickets WHERE conversation_id = ? AND ticket_id IS NULL", id);
    try {
      if (this.d.backend.hold && !this.d.backend.hold(ctx.conv.ahpSession)) {
        throw new ShipError(
          `${ctx.employee.name} is still working in this conversation. Stop the turn (or wait for it to end), then make it a ticket.`,
          409,
          "busy",
        );
      }
      await this.wake(ctx.employee);
      const before = await this.d.port.inspect(ctx.copy).catch((e) => this.refusal(e));
      if (!before.files.length) {
        throw new ShipError(
          "There's nothing to ship yet: this conversation hasn't changed any files in the project.",
          409,
          "nothing",
        );
      }
      const title = clean(input.title ?? "", 200) || this.suggest(ctx.conv, ctx.employee, before).title;
      const suggestion = this.suggest(ctx.conv, ctx.employee, before);
      const description = clean(input.description ?? "", 2000) || suggestion.description;
      const doneWhen = input.doneWhen?.length
        ? input.doneWhen.map((d) => clean(d, 300)).filter(Boolean)
        : suggestion.doneWhen;
      const type = typeOf(title);
      if (before.secrets.length || before.tooBig) {
        this.refusal(new ShipRefusal(secretsSentence(before), "secrets"));
      }
      if (before.uncommitted.length) {
        await this.d.port
          .commit(
            ctx.copy,
            `${type}: ${title}\n\nCommitted by i.inc when ${ctx.conv.title === DEFAULT_TITLE ? "a conversation" : `the conversation "${clean(ctx.conv.title, 80)}"`} became a ticket.`,
          )
          .catch((e) => this.refusal(e));
      }
      let pr: { number?: number; url?: string; nodeId?: string } = {};
      if (ctx.mode === "owner-merges") {
        await this.github(this.d.port.push(ctx.copy).catch((e) => this.refusal(e)));
        const opened = await this.github(this.openPrFor(ctx, title, this.prBody(ctx, before, description)));
        pr = { number: opened.number, url: opened.url, nodeId: opened.nodeId };
      }
      const ticket = this.d.tickets.create(
        {
          title,
          project: ctx.project.id,
          type,
          effort: "medium",
          doneWhen,
          assignee: ctx.employee.id,
          reason: description,
          conversation: ctx.conv.id,
          branch: ctx.copy.branch,
          hold: true,
        },
        now,
      );
      const stages = planFor(ticket, this.d.registry.projectPolicy(ticket.project)).stages;
      const built = `${description}\n(Built in the conversation before it became this ticket.)`.slice(
        0,
        2400,
      );
      const events: TicketEvent[] = [
        { type: "ticket-created", at: now, ticketId: ticket.id },
        {
          type: "pr-opened",
          at: now,
          pr: { branch: ctx.copy.branch, ...pr },
          employeeId: ctx.employee.id,
        },
        ...stages.slice(0, Math.max(0, stages.indexOf("checks"))).map(
          (stage): TicketEvent => ({
            type: "stage-finished",
            at: now,
            stage,
            ...(stage === "plan"
              ? { output: `Skipped: the plan was the conversation with ${ctx.employee.name}.` }
              : stage === "build"
                ? { output: built }
                : {}),
          }),
        ),
      ];
      await this.d.store.append(ticket.id, events);
      this.d.db.run(
        "UPDATE conversation_tickets SET ticket_id = ? WHERE conversation_id = ? AND ticket_id IS NULL",
        ticket.id,
        id,
      );
      this.d.tickets.setHold(ticket.id, false);
      this.d.log?.(`conversation ${id} became ticket ${ticket.id} (${ctx.mode})`);
      void this.d.tick().catch(() => {});
      return { ticket, created: true };
    } catch (e) {
      undo();
      throw e;
    }
  }

  // ───────────────────────────── open a PR ─────────────────────────────

  async openPr(
    id: string,
    input: { title?: string; body?: string },
  ): Promise<{ pr: { number: number; url: string; draft: boolean }; created: boolean; pushed: boolean }> {
    const running = this.inflight.get(id);
    if (running) {
      if (running.kind !== "pr") {
        throw new ShipError(
          "Another shipping action is running for this conversation. Wait for it to finish.",
          409,
          "busy",
        );
      }
      const r = (await running.promise) as { pr: { number: number; url: string; draft: boolean } };
      return { ...r, created: false, pushed: false };
    }
    const promise = this.makePr(id, input);
    this.inflight.set(id, { kind: "pr", promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(id);
    }
  }

  private openPrFor(ctx: ReturnType<Shipping["context"]>, title: string, body: string) {
    return (async () => {
      const found = await this.d.port.prs.find(ctx.copy.repo, ctx.copy.branch);
      const pr =
        found ??
        (await this.d.port.prs.openDraft(ctx.copy.repo, {
          head: ctx.copy.branch,
          base: ctx.copy.base,
          title: `${typeOf(title)}: ${title}`.slice(0, 200),
          body,
        }));
      const now = this.d.clock.now();
      this.d.db.run(
        `INSERT INTO conversation_prs (conversation_id, number, url, node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET number = excluded.number, url = excluded.url, node_id = excluded.node_id, updated_at = excluded.updated_at`,
        ctx.conv.id,
        pr.number,
        pr.url,
        pr.nodeId,
        now,
        now,
      );
      this.prCache.delete(ctx.conv.id);
      return { ...pr, existed: found !== null };
    })();
  }

  private prBody(ctx: ReturnType<Shipping["context"]>, report: CopyReport, description: string): string {
    const files = report.files.slice(0, 30).map((f) => `- \`${f.path}\` (+${f.added} −${f.removed})`);
    return redactText(
      [
        `Opened from an i.inc conversation with ${ctx.employee.name}. It is a draft: it has not been through i.inc's checks and review. To have the pipeline check, review and prove it first, make the conversation a ticket.`,
        "",
        description,
        "",
        `Changes (${report.files.length} file${report.files.length === 1 ? "" : "s"}):`,
        ...files,
        ...(report.files.length > 30 ? [`- … and ${report.files.length - 30} more`] : []),
        ...(report.protectedPaths.length
          ? [
              "",
              `This touches protected paths (${report.protectedPaths.join(", ")}): look at those with care.`,
            ]
          : []),
      ].join("\n"),
    ).slice(0, 6000);
  }

  private async makePr(
    id: string,
    input: { title?: string; body?: string },
  ): Promise<{ pr: { number: number; url: string; draft: boolean }; created: boolean; pushed: boolean }> {
    const ctx = this.context(id);
    this.requireOpen(ctx.conv);
    if (ctx.mode !== "owner-merges") {
      throw new ShipError(
        `${ctx.project.id} pushes straight to main after a review, so there is no pull request to open. Make this a ticket: it is reviewed first.`,
        409,
        "direct-mode",
      );
    }
    const h = this.active(id);
    if (h) {
      throw new ShipError(
        `This work is now ticket #${h.ticket ?? "…"}: its pull request comes from the ticket. Open the ticket to follow it.`,
        409,
        "ticket",
      );
    }
    this.quick.add(id);
    try {
      if (this.d.backend.hold && !this.d.backend.hold(ctx.conv.ahpSession)) {
        throw new ShipError(
          `${ctx.employee.name} is still working in this conversation. Stop the turn (or wait for it to end), then open the PR.`,
          409,
          "busy",
        );
      }
      await this.wake(ctx.employee);
      const before = await this.d.port.inspect(ctx.copy).catch((e) => this.refusal(e));
      if (!before.files.length) {
        throw new ShipError(
          "There's nothing to ship yet: this conversation hasn't changed any files in the project.",
          409,
          "nothing",
        );
      }
      if (before.secrets.length || before.tooBig)
        this.refusal(new ShipRefusal(secretsSentence(before), "secrets"));
      const suggestion = this.suggest(ctx.conv, ctx.employee, before);
      const title = clean(input.title ?? "", 200) || suggestion.title;
      if (before.uncommitted.length) {
        await this.d.port
          .commit(
            ctx.copy,
            `${typeOf(title)}: ${title}\n\nCommitted by i.inc when the conversation's work became a pull request.`,
          )
          .catch((e) => this.refusal(e));
      }
      await this.github(this.d.port.push(ctx.copy).catch((e) => this.refusal(e)));
      const body = input.body
        ? redactText(input.body).slice(0, 6000)
        : this.prBody(ctx, before, suggestion.description);
      const opened = await this.github(this.openPrFor(ctx, title, body));
      this.d.log?.(
        `conversation ${id}: pull request #${opened.number} ${opened.existed ? "updated" : "opened"}`,
      );
      const draft = opened.existed
        ? await this.d.port.prs.get(ctx.copy.repo, opened.number).then(
            (p) => p.draft,
            () => true,
          )
        : true;
      return {
        pr: { number: opened.number, url: opened.url, draft },
        created: !opened.existed,
        pushed: true,
      };
    } finally {
      this.quick.delete(id);
    }
  }

  // ───────────────────────────── the ticket ends ─────────────────────────────

  /** A ticket's events changed: if it is a conversation's and it ended, the conversation gets its copy back. */
  async onTicket(ticketId: string): Promise<void> {
    const [row] = this.d.db.all<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversation_tickets WHERE ticket_id = ? AND released_at IS NULL",
      ticketId,
    );
    if (!row || this.releasing.has(ticketId)) return;
    const s = fold(await this.d.store.read(ticketId));
    if (s.status !== "done" && s.status !== "failed") return;
    this.releasing.add(ticketId);
    try {
      this.release(
        row.conversation_id,
        ticketId,
        s.status === "failed" ? `failed: ${s.failure?.reason ?? "it did not finish"}` : (s.outcome ?? "done"),
      );
    } finally {
      this.releasing.delete(ticketId);
    }
  }

  private release(conversation: string, ticketId: Id, how: string): void {
    this.d.db.run(
      "UPDATE conversation_tickets SET released_at = ? WHERE conversation_id = ? AND ticket_id = ? AND released_at IS NULL",
      this.d.clock.now(),
      conversation,
      ticketId,
    );
    const conv = this.d.conversations.get(conversation);
    if (!conv) return;
    const merged = how === "merged" || how === "done";
    this.d.backend.resumed?.(
      conv.ahpSession,
      `[i.inc] While you were away, ticket #${ticketId} took over this branch (${conv.branch}) and ended: ${how}. It may have added commits or rebased the branch${merged ? ", and its work may already be on the main branch" : ""}. Check git status and git log, and re-read files before you edit them.`,
    );
    this.d.host.resumeChat(conv.ahpChat);
    this.d.log?.(`conversation ${conversation} has its working copy back (ticket ${ticketId}: ${how})`);
  }

  /**
   * The owner retries a failed ticket that came from a conversation: the ticket takes the working copy
   * back, so the conversation's agent must not be using it. Refused while a turn runs.
   */
  reclaim(ticketId: Id): void {
    const rec = this.d.tickets.get(ticketId);
    const conversation = rec?.ticket.conversation;
    if (!conversation) return;
    if (this.active(conversation)?.ticket === ticketId) return;
    const conv = this.d.conversations.get(conversation);
    if (!conv) return;
    const other = this.active(conversation);
    if (other) {
      throw new ShipError(
        `The conversation's working copy is now ticket #${other.ticket ?? "…"}'s, so ticket ${ticketId} can't run on it. Wait for that ticket to finish.`,
        409,
        "ticket",
      );
    }
    this.d.db.run(
      "INSERT INTO conversation_tickets (conversation_id, ticket_id, created_at) VALUES (?, ?, ?)",
      conversation,
      ticketId,
      this.d.clock.now(),
    );
    if (this.d.backend.hold && !this.d.backend.hold(conv.ahpSession)) {
      this.d.db.run(
        "DELETE FROM conversation_tickets WHERE conversation_id = ? AND ticket_id = ? AND released_at IS NULL",
        conversation,
        ticketId,
      );
      throw new ShipError(
        `${conv.title} is working in that folder right now. Stop its turn first, then try the ticket again.`,
        409,
        "busy",
      );
    }
  }

  /** After a restart: a claim whose ticket never came to be is let go, and tickets that ended while the daemon was down hand back their copies. */
  private reconcile(): void {
    const stale = this.d.clock.now() - PENDING_MS;
    this.d.db.run(
      "DELETE FROM conversation_tickets WHERE ticket_id IS NULL AND released_at IS NULL AND created_at <= ?",
      stale,
    );
    for (const r of this.d.db.all<{ ticket_id: string | null }>(
      "SELECT ticket_id FROM conversation_tickets WHERE released_at IS NULL AND ticket_id IS NOT NULL",
    )) {
      if (r.ticket_id) void this.onTicket(r.ticket_id).catch(() => {});
    }
  }
}
