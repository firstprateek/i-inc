// The daemon's HTTP API: plain Request -> Response (Bun.serve on the host, called directly in tests).
// It's served only on the tailnet; a bearer token guards it as well.
import {
  answer,
  decide,
  defaultSwitchRules,
  type Employee,
  fold,
  handleMessage,
  handOff,
  hiringProblems,
  type Id,
  knowledgeLog,
  type ProposedEdit,
} from "@i-inc/core";
import type { Daemon, DaemonDeps } from "./daemon.ts";
import type { Change, Repo } from "./knowledge.ts";
import type { NewTicket } from "./tickets.ts";
import { deskView, officeView, type TicketView, ticketView } from "./views.ts";

export interface ApiOptions {
  /** When set, every request needs `Authorization: Bearer <token>`. */
  token?: string;
}

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

export function createApi(daemon: Daemon, d: DaemonDeps, opts: ApiOptions = {}) {
  const ports = {
    clock: d.clock,
    store: d.store,
    machines: d.machines,
    agent: d.agent,
    harness: d.harness,
    company: d.registry,
    ...(d.workspace ? { workspace: d.workspace } : {}),
  };

  const views = async (): Promise<TicketView[]> => {
    const waiting = new Map(daemon.waiting.map((w) => [w.ticketId, w.reason]));
    const out: TicketView[] = [];
    for (const r of d.tickets.all()) {
      const events = await d.store.read(r.ticket.id);
      out.push(
        ticketView(r, await daemon.state(r.ticket.id), events, d.registry, waiting.get(r.ticket.id) ?? null),
      );
    }
    return out;
  };

  const routes: [string, string, Handler][] = [
    ["GET", "/api/board", async () => json({ tickets: await views() })],

    ["GET", "/api/engines", async () => json({ engines: d.registry.engines() })],

    ["GET", "/api/projects", async () => json({ projects: d.registry.projects() })],

    [
      "PUT",
      "/api/projects/:id",
      async (req, { id = "" }) => {
        const body = (await req.json()) as { repo?: unknown; checks?: unknown };
        const checks = Array.isArray(body.checks) ? body.checks : [];
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(id)) {
          return json(
            { error: "a project is named by up to 40 letters, digits, spaces, dots and dashes" },
            400,
          );
        }
        if (typeof body.repo !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(body.repo)) {
          return json({ error: "repo must be owner/name on GitHub" }, 400);
        }
        if (!checks.length || !checks.every((c) => typeof c === "string" && c.trim())) {
          return json({ error: "checks must be the recipe's commands, in order" }, 400);
        }
        d.registry.addProject({ id, repo: body.repo, checks });
        return json({ project: d.registry.project(id) });
      },
    ],
    [
      "GET",
      "/api/chat",
      async () => {
        const latest = d.chatLog.latest();
        return json({
          threads: d.registry.employees().map((e) => ({
            id: e.id,
            name: e.name,
            tint: e.tint ?? 0,
            role: e.role,
            last: latest.get(e.id) ?? null,
          })),
        });
      },
    ],

    [
      "GET",
      "/api/chat/:id",
      async (_, p) => {
        const e = d.registry.employees().find((x) => x.id === p.id);
        if (!e) return json({ error: "no such employee" }, 404);
        return json({
          employee: { id: e.id, name: e.name, tint: e.tint ?? 0, role: e.role },
          entries: d.chatLog.thread(e.id),
        });
      },
    ],

    [
      "POST",
      "/api/chat/:id",
      async (req, p) => {
        const e = d.registry.employees().find((x) => x.id === p.id);
        if (!e) return json({ error: "no such employee" }, 404);
        const { text, urgent } = (await req.json()) as { text?: string; urgent?: boolean };
        if (!text?.trim()) return json({ error: "say something" }, 400);
        const said = text.trim();
        d.chatLog.add(
          e.id,
          urgent
            ? { from: "owner", at: d.clock.now(), text: said, urgent: true }
            : { from: "owner", at: d.clock.now(), text: said },
        );

        // What the employee is on now, and a few notes from its recent tickets.
        const mine = [];
        for (const r of d.tickets.all()) {
          const s = fold(await d.store.read(r.ticket.id));
          if ((s.assignee ?? r.ticket.assignee) === e.id) mine.push({ r, s });
        }
        const current = mine.find(
          ({ s }) => s.created && ["running", "paused", "needs-you"].includes(s.status),
        );
        const notes = mine
          .slice(-3)
          .map(
            ({ r, s }) =>
              `#${r.ticket.id} ${r.ticket.title}: ${s.status}${s.outputs.plan ? `. Plan: ${s.outputs.plan}` : ""}`,
          )
          .join("\n");
        const out = await handleMessage(
          said,
          {
            employee: e,
            engine: d.registry.engine(e.engines.default),
            current: current ? { ...current.r.ticket, assignee: e.id } : null,
            notes,
            defaultProject: e.projects?.[0] ?? mine.at(-1)?.r.ticket.project ?? "General",
          },
          d.helper,
          d.chat,
        );

        const at = d.clock.now();
        if (out.kind === "answer") d.chatLog.add(e.id, { from: "employee", at, text: out.text });
        if (out.kind === "draft") {
          const t = d.tickets.create({ ...out.ticket, hold: true }, at);
          d.chatLog.add(e.id, {
            from: "employee",
            at,
            kind: "draft",
            ticketId: t.id,
            title: t.title,
            confirmed: false,
          });
        }
        if (out.kind === "errand") {
          const t = d.tickets.create(out.ticket, at);
          d.chatLog.add(e.id, { from: "employee", at, kind: "errand", ticketId: t.id, title: t.title });
          await daemon.tick();
        }
        if (out.kind === "note") {
          await d.store.append(out.ticketId, [
            urgent
              ? { type: "owner-message", at, text: said, urgent: true }
              : { type: "owner-message", at, text: said },
          ]);
          const stopped = urgent === true && daemon.interrupt(out.ticketId, e.id);
          d.chatLog.add(e.id, {
            from: "system",
            at,
            text: stopped
              ? `${e.name} stopped to read this, and carries on from there.`
              : urgent
                ? `${e.name} will see this when their next session starts.`
                : `${e.name} will see this at the next stage boundary.`,
          });
        }
        if (out.kind === "unavailable") d.chatLog.add(e.id, { from: "system", at, text: out.reason });
        return json({ entries: d.chatLog.thread(e.id) });
      },
    ],

    [
      "POST",
      "/api/chat/:id/drafts/:ticket",
      async (_, p) => {
        const r = d.tickets.get(p.ticket ?? "");
        if (!r?.hold || r.ticket.assignee !== p.id) return json({ error: "no such draft" }, 404);
        d.tickets.setHold(r.ticket.id, false);
        d.chatLog.confirm(p.id ?? "", r.ticket.id);
        await daemon.tick();
        return json({ ok: true });
      },
    ],

    ["GET", "/api/employees", async () => json({ employees: d.registry.employees() })],

    [
      "POST",
      "/api/employees",
      async (req) => {
        const body = (await req.json()) as Partial<Employee>;
        const hire: Employee = {
          id:
            body.id ??
            (body.name ?? "")
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, ""),
          name: body.name ?? "",
          role: body.role ?? "Senior Engineer",
          duties: body.duties ?? ["build", "review"],
          engines: body.engines ?? { default: "", fallbacks: [] },
          switchRules: body.switchRules ?? defaultSwitchRules,
          ...(body.projects ? { projects: body.projects } : {}),
          ...(body.standingOrders ? { standingOrders: body.standingOrders } : {}),
          ...(body.workingHours ? { workingHours: body.workingHours } : {}),
          ...(body.outbound ? { outbound: body.outbound } : {}),
        };
        const problems = hiringProblems(hire, d.registry.engines(), d.registry.employees());
        if (problems.length) return json({ error: problems.join("; "), problems }, 400);
        d.registry.hire(hire);
        // A brain from the template, and orientation as the first ticket (spec §5, "Hiring").
        d.knowledge.ensureBrain(hire);
        const pa = hire.role === "Personal Assistant";
        const orientation = d.tickets.create(
          {
            title: `Orientation for ${hire.name}`,
            project: pa ? "Home" : (hire.projects?.[0] ?? "General"),
            type: "orientation",
            effort: "low",
            doneWhen: ["the brain has a page for each project"],
            assignee: hire.id,
            priority: 100,
          },
          d.clock.now(),
        );
        await daemon.tick();
        return json({ employee: d.registry.employee(hire.id), orientation: orientation.id }, 201);
      },
    ],

    [
      "GET",
      "/api/office",
      async () => {
        const all = await views();
        const states = new Map(
          await Promise.all(all.map(async (v) => [v.id, await daemon.state(v.id)] as const)),
        );
        const offset = d.registry.settings().utcOffsetMinutes;
        const localHour = new Date(d.clock.now() + offset * 60_000).getUTCHours();
        return json({ employees: officeView(d.registry.employees(), all, states, d.registry, localHour) });
      },
    ],

    ["GET", "/api/desk", async () => json(deskView(await d.store.all(), d.registry, d.clock.now()))],

    [
      "POST",
      "/api/tickets",
      async (req) => {
        const body = (await req.json()) as NewTicket;
        const problem = validate(body);
        if (problem) return json({ error: problem }, 400);
        const ticket = d.tickets.create(body, d.clock.now());
        await daemon.tick();
        return json({ ticket }, 201);
      },
    ],

    [
      "GET",
      "/api/tickets/:id",
      async (_, p) => {
        const r = d.tickets.get(p.id ?? "");
        if (!r) return json({ error: "no such ticket" }, 404);
        const events = await d.store.read(r.ticket.id);
        const waiting = daemon.waiting.find((w) => w.ticketId === r.ticket.id)?.reason ?? null;
        return json({
          ticket: ticketView(r, await daemon.state(r.ticket.id), events, d.registry, waiting),
          events,
        });
      },
    ],

    [
      "POST",
      "/api/tickets/:id/answer",
      async (req, p) => {
        const { answer: a, note } = (await req.json()) as {
          answer: "approve" | "reject" | "builder" | "reviewer";
          note?: string;
        };
        return act(p.id, "needs-you", () => answer(ports, p.id ?? "", a, note));
      },
    ],

    [
      "POST",
      "/api/tickets/:id/decide",
      async (req, p) => {
        const { decision, note } = (await req.json()) as {
          decision: "approve" | "changes" | "reject";
          note?: string;
        };
        return act(p.id, "ready", () => decide(ports, p.id ?? "", decision, note));
      },
    ],

    [
      "POST",
      "/api/tickets/:id/handoff",
      async (req, p) => {
        const { to } = (await req.json()) as { to: Id };
        try {
          d.registry.employee(to);
        } catch {
          return json({ error: `no employee ${to}` }, 400);
        }
        return act(p.id, null, () => handOff(ports, p.id ?? "", to));
      },
    ],

    // Brains and the handbook (spec §5, "The brain"): read, diff, revert; approve policy changes.
    [
      "GET",
      "/api/knowledge/handbook",
      async () => {
        const repo: Repo = { kind: "handbook" };
        return json({
          pages: d.knowledge.pages(repo),
          history: named(d.knowledge.history(repo)),
          awaiting: (await awaiting()).map(proposal),
        });
      },
    ],
    [
      "GET",
      "/api/knowledge/brains/:id",
      async (_, p) => {
        const e = d.registry.employees().find((x) => x.id === p.id);
        if (!e) return json({ error: "no such employee" }, 404);
        const repo: Repo = { kind: "brain", id: e.id };
        return json({
          employee: { id: e.id, name: e.name, role: e.role, tint: e.tint ?? 0 },
          pages: d.knowledge.pages(repo),
          history: named(d.knowledge.history(repo)),
        });
      },
    ],
    [
      "GET",
      "/api/knowledge/recent",
      async () => {
        const all = [
          ...d.knowledge.history({ kind: "handbook" }, 20).map((c) => ({ ...c, repo: "handbook" })),
          ...d.registry
            .employees()
            .flatMap((e) =>
              d.knowledge
                .history({ kind: "brain", id: e.id }, 20)
                .map((c) => ({ ...c, repo: `brain:${e.id}` })),
            ),
        ];
        const learned = all.filter((c) => c.author && !c.revert).sort((a, b) => b.at - a.at);
        return json({ changes: named(learned.slice(0, 8)) });
      },
    ],
    [
      "POST",
      "/api/knowledge/:repo/revert",
      async (req, p) => {
        const repo = repoOf(p.repo ?? "");
        if (!repo) return json({ error: "no such brain" }, 404);
        const { commit } = (await req.json()) as { commit?: string };
        try {
          d.knowledge.revert(repo, commit ?? "");
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        return json({ history: named(d.knowledge.history(repo)) });
      },
    ],
    [
      "POST",
      "/api/knowledge/policies/:edit",
      async (req, p) => {
        const edit = (await awaiting()).find((x) => x.id === p.edit);
        if (!edit) return json({ error: "no such proposal" }, 404);
        const { approved } = (await req.json()) as { approved?: boolean };
        if (typeof approved !== "boolean") return json({ error: "approved must be true or false" }, 400);
        await d.store.append(edit.ticketId, [
          { type: "policy-decided", at: d.clock.now(), editId: edit.id, approved },
        ]);
        daemon.applyKnowledge(edit.ticketId, await d.store.read(edit.ticketId));
        return json({ ok: true });
      },
    ],
  ];

  /** Policy changes waiting for the owner, oldest first. */
  async function awaiting(): Promise<ProposedEdit[]> {
    const out: ProposedEdit[] = [];
    for (const r of d.tickets.all())
      out.push(...knowledgeLog(r.ticket.id, await d.store.read(r.ticket.id)).awaiting);
    return out.sort((a, b) => a.at - b.at);
  }

  function proposal(p: ProposedEdit) {
    return {
      id: p.id,
      ticketId: p.ticketId,
      author: nameOf(p.author),
      at: p.at,
      page: p.edit.page,
      text: p.edit.text,
    };
  }

  function nameOf(id: Id): string {
    return d.registry.employees().find((e) => e.id === id)?.name ?? id;
  }

  function named<T extends Change>(changes: T[]) {
    return changes.map((c) => ({ ...c, authorName: c.author ? nameOf(c.author) : null }));
  }

  function repoOf(key: string): Repo | null {
    if (key === "handbook") return { kind: "handbook" };
    const id = key.startsWith("brain:") ? key.slice(6) : null;
    return id && d.registry.employees().some((e) => e.id === id) ? { kind: "brain", id } : null;
  }

  /** Appends the owner's action if the ticket is in the right state, then runs the ticket on. */
  async function act(id: string | undefined, needs: "needs-you" | "ready" | null, fn: () => Promise<void>) {
    if (!id || !d.tickets.get(id)) return json({ error: "no such ticket" }, 404);
    const s = await daemon.state(id);
    if (needs && s.status !== needs) return json({ error: `ticket ${id} is ${s.status}, not ${needs}` }, 409);
    try {
      await fn();
    } catch (e) {
      return json({ error: String(e instanceof Error ? e.message : e) }, 409);
    }
    daemon.run(id);
    return json({ ok: true });
  }

  return async function handle(req: Request): Promise<Response> {
    if (opts.token && req.headers.get("authorization") !== `Bearer ${opts.token}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const url = new URL(req.url);
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const params = match(pattern, url.pathname);
      if (params) return handler(req, params);
    }
    return json({ error: "not found" }, 404);
  };
}

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i] ?? "";
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(b[i] ?? "");
    else if (seg !== b[i]) return null;
  }
  return params;
}

function validate(t: Partial<NewTicket>): string | null {
  if (!t.title?.trim()) return "a ticket needs a title";
  if (!t.project?.trim()) return "a ticket needs a project";
  if (!["fix", "feat", "chore", "errand"].includes(t.type ?? ""))
    return "type must be fix, feat, chore or errand";
  if (!["low", "medium", "high"].includes(t.effort ?? "")) return "effort must be low, medium or high";
  if (!Array.isArray(t.doneWhen)) return "doneWhen must be a list";
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
