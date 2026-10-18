// The daemon's HTTP API: plain Request -> Response (Bun.serve on the host, called directly in tests).
// It's served on 127.0.0.1, reached through an SSH tunnel. Other web pages the owner has open can
// still send it requests, so: only known Host headers (no DNS rebinding), writes must be JSON (which
// another site can't send without a CORS preflight, and none is ever allowed), and an Origin from
// anywhere else is refused. A bearer token can guard it as well.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  type AccountCost,
  type AgentHarness,
  answer,
  decide,
  defaultSwitchRules,
  type Employee,
  type Engine,
  fold,
  handleMessage,
  handOff,
  hiringProblems,
  type Id,
  knowledgeLog,
  type ProjectRelease,
  type ProposedEdit,
  retry,
  type SandboxStatus,
} from "@i-inc/core";
import type { Daemon, DaemonDeps } from "./daemon.ts";
import type { Change, Repo } from "./knowledge.ts";
import type { PushSubscription } from "./push.ts";
import type { NewTicket } from "./tickets.ts";
import {
  deskView,
  officeView,
  type PendingRelease,
  type PendingTicket,
  type TicketView,
  ticketView,
} from "./views.ts";

export interface ApiOptions {
  /**
   * When set, every request needs the token: as the `i_inc` cookie the web app gets from
   * `POST /api/login`, or as `Authorization: Bearer <token>`. Real mode always sets one.
   */
  token?: string;
  /** The Host headers it answers, such as "127.0.0.1:7420". Unset: any (tests). */
  hosts?: string[];
  /** Heartbeat interval for SSE in ms. Default 25_000. */
  heartbeatMs?: number;
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

  const pendingReleases = async (): Promise<PendingRelease[]> => {
    const allReleases = d.registry.releases();
    const allProjects = d.registry.projects();
    const allTickets = d.tickets.all();
    const out: PendingRelease[] = [];

    for (const project of allProjects) {
      const projectReleases = allReleases.filter((r) => r.project === project.id);
      const releasedTicketIds = new Set(projectReleases.flatMap((r) => r.ticketIds));
      const latestReleaseAt = projectReleases.length ? Math.max(...projectReleases.map((r) => r.at)) : null;

      const projectTickets = allTickets.filter((r) => r.ticket.project === project.id);
      const pendingTickets: PendingTicket[] = [];

      for (const record of projectTickets) {
        if (releasedTicketIds.has(record.ticket.id)) continue;
        const events = await d.store.read(record.ticket.id);
        const state = fold(events);
        if (state.outcome !== "merged") continue;
        if (latestReleaseAt !== null && (state.closedAt ?? 0) <= latestReleaseAt) continue;

        pendingTickets.push({
          id: record.ticket.id,
          title: record.ticket.title,
          ...(state.pushed ? { pushed: state.pushed } : {}),
        });
      }

      out.push({
        project: project.id,
        id: project.id,
        repo: project.repo,
        pendingTickets,
      });
    }

    return out;
  };

  const routes: [string, string, Handler][] = [
    ["GET", "/api/board", async () => json({ tickets: await views() })],

    [
      "GET",
      "/api/events",
      async (req) => {
        const encoder = new TextEncoder();
        let closed = false;
        let timer: ReturnType<typeof setInterval> | null = null;
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

        const onTicket = (id: Id) => {
          send(`event: ticket\ndata: ${JSON.stringify({ id })}\n\n`);
        };

        const onOffice = () => {
          send("event: office\ndata: {}\n\n");
        };

        const onAbort = () => {
          cleanup();
          try {
            controllerRef?.close();
          } catch {}
        };

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          if (d.live) {
            d.live.off("ticket", onTicket);
            d.live.off("office", onOffice);
          }
          req.signal?.removeEventListener("abort", onAbort);
        };

        const send = (chunk: string) => {
          if (closed || !controllerRef) return;
          if (controllerRef.desiredSize !== null && controllerRef.desiredSize <= 0) {
            cleanup();
            try {
              controllerRef.close();
            } catch {}
            return;
          }
          try {
            controllerRef.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };

        const stream = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controllerRef = controller;
              if (req.signal?.aborted) {
                cleanup();
                try {
                  controller.close();
                } catch {}
                return;
              }

              req.signal?.addEventListener("abort", onAbort);

              send(": connected\n\n");

              if (d.live) {
                d.live.on("ticket", onTicket);
                d.live.on("office", onOffice);
              }

              const interval = opts.heartbeatMs ?? 25_000;
              timer = setInterval(() => {
                send(": keepalive\n\n");
              }, interval);
              timer.unref?.();
            },
            cancel() {
              cleanup();
            },
          },
          { highWaterMark: 64 },
        );

        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      },
    ],

    ["GET", "/api/engines", async () => json({ engines: d.registry.engines() })],

    [
      "PUT",
      "/api/engines/:id",
      async (req, { id = "" }) => {
        const b = (await req.json()) as Partial<Engine>;
        const harnesses: AgentHarness[] = ["claude-code", "antigravity", "opencode"];
        if (!/^[a-z0-9-]{1,40}$/.test(id))
          return json({ error: "an engine id is lowercase letters, digits and dashes" }, 400);
        if (!b.harness || !harnesses.includes(b.harness)) {
          return json({ error: `harness must be one of ${harnesses.join(", ")}` }, 400);
        }
        if (typeof b.model !== "string" || !b.model.trim())
          return json({ error: "model names the model" }, 400);
        if (typeof b.accountId !== "string" || !d.registry.accounts().some((a) => a.id === b.accountId)) {
          return json({ error: "accountId must be an account added with PUT /api/accounts/:id" }, 400);
        }
        d.registry.addEngine({
          id,
          harness: b.harness,
          model: b.model,
          accountId: b.accountId,
          local: b.local === true,
        });
        return json({ engine: d.registry.engine(id) });
      },
    ],

    [
      "GET",
      "/api/accounts",
      async () => json({ accounts: d.registry.accounts(), rateLimits: d.registry.accountRateLimits() }),
    ],

    [
      "PUT",
      "/api/accounts/:id",
      async (req, { id = "" }) => {
        const b = (await req.json()) as Partial<AccountCost>;
        if (!/^[a-z0-9-]{1,40}$/.test(id))
          return json({ error: "an account id is lowercase letters, digits and dashes" }, 400);
        if (typeof b.name !== "string" || !b.name.trim())
          return json({ error: "name names the account" }, 400);
        const money = (v: unknown) => typeof v === "number" && v >= 0;
        d.registry.addAccount({
          id,
          name: b.name,
          ...(money(b.monthlyFee) ? { monthlyFee: b.monthlyFee as number } : {}),
          ...(money(b.pricePerMillionTokens)
            ? { pricePerMillionTokens: b.pricePerMillionTokens as number }
            : {}),
          ...(money(b.monthlyCap) ? { monthlyCap: b.monthlyCap as number } : {}),
        });
        return json({ account: d.registry.accounts().find((a) => a.id === id) });
      },
    ],

    ["GET", "/api/teams", async () => json({ teams: d.registry.teams() })],

    [
      "GET",
      "/api/sandboxes",
      async () => {
        const sandboxes: SandboxStatus[] = [];
        for (const t of d.registry.teams()) {
          const size = t.sandbox ?? { cpus: 6, memory: "12G" };
          const machine = `inc-${t.id}`;
          if (!d.machines.inspectSandbox) {
            sandboxes.push({
              team: t.id,
              machine,
              state: "error",
              cpus: size.cpus,
              memory: size.memory,
              signedIn: { claude: false, antigravity: false, github: false },
            });
            continue;
          }
          try {
            sandboxes.push(await d.machines.inspectSandbox(t.id, size));
          } catch {
            sandboxes.push({
              team: t.id,
              machine,
              state: "error",
              cpus: size.cpus,
              memory: size.memory,
              signedIn: { claude: false, antigravity: false, github: false },
            });
          }
        }
        return json({ sandboxes });
      },
    ],

    [
      "PUT",
      "/api/teams/:id",
      async (req, { id = "" }) => {
        const b = (await req.json()) as { name?: unknown; members?: unknown; sandbox?: unknown };
        if (!/^[a-z0-9-]{1,32}$/.test(id))
          return json({ error: "a team id is lowercase letters, digits and dashes" }, 400);
        if (typeof b.name !== "string" || !b.name.trim()) return json({ error: "name names the team" }, 400);
        const members = Array.isArray(b.members) ? b.members : [];
        const known = new Set(d.registry.employees().map((e) => e.id));
        if (!members.every((m) => typeof m === "string" && known.has(m))) {
          return json({ error: "members must be employees' ids" }, 400);
        }
        const box = b.sandbox as { cpus?: unknown; memory?: unknown } | undefined;
        if (
          box !== undefined &&
          !(
            Number.isInteger(box.cpus) &&
            (box.cpus as number) > 0 &&
            typeof box.memory === "string" &&
            /^\d+G$/.test(box.memory)
          )
        ) {
          return json({ error: 'sandbox is {"cpus": 6, "memory": "12G"}' }, 400);
        }
        // Someone joins one team at a time: joining this one takes them out of any other.
        for (const t of d.registry.teams()) {
          if (t.id !== id && t.members.some((m) => members.includes(m))) {
            d.registry.addTeam({ ...t, members: t.members.filter((m) => !members.includes(m)) });
          }
        }
        d.registry.addTeam({
          id,
          name: b.name,
          members: members as string[],
          ...(box ? { sandbox: { cpus: box.cpus as number, memory: box.memory as string } } : {}),
        });
        return json({ team: d.registry.teams().find((t) => t.id === id) });
      },
    ],

    [
      "POST",
      "/api/teams/:id/antigravity-callback",
      async (req, { id = "" }) => {
        const team = d.registry.teams().find((t) => t.id === id);
        if (!team) return json({ error: "no such team" }, 404);
        const b = (await req.json()) as { url?: unknown };
        if (typeof b.url !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(b.url)) {
          return json({ error: "expected an http://127.0.0.1:<port>/... callback URL" }, 400);
        }
        await d.machines.deliverCallback?.(id, b.url);
        return json({ ok: true });
      },
    ],

    ["GET", "/api/push/key", async () => json({ publicKey: d.push?.publicKey() ?? "" })],

    [
      "POST",
      "/api/push/subscribe",
      async (req) => {
        const b = (await req.json()) as Partial<PushSubscription>;
        if (!b || typeof b.endpoint !== "string" || !b.endpoint.trim()) {
          return json({ error: "endpoint is required" }, 400);
        }
        let url: URL;
        try {
          url = new URL(b.endpoint);
        } catch {
          return json({ error: "endpoint must be a valid URL" }, 400);
        }
        if (url.protocol !== "https:") {
          return json({ error: "endpoint must be https" }, 400);
        }
        await d.push?.subscribe(b as PushSubscription);
        return json({ ok: true });
      },
    ],

    [
      "POST",
      "/api/push/unsubscribe",
      async (req) => {
        const b = (await req.json()) as { endpoint?: unknown };
        if (!b || typeof b.endpoint !== "string" || !b.endpoint.trim()) {
          return json({ error: "endpoint is required" }, 400);
        }
        await d.push?.unsubscribe(b.endpoint.trim());
        return json({ ok: true });
      },
    ],

    ["GET", "/api/projects", async () => json({ projects: d.registry.projects() })],

    [
      "PUT",
      "/api/projects/:id",
      async (req, { id = "" }) => {
        const body = (await req.json()) as {
          repo?: unknown;
          checks?: unknown;
          mode?: unknown;
          protectedPaths?: unknown;
          followUpsPerDay?: unknown;
          autoRelease?: unknown;
        };
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
        if (body.mode !== undefined && body.mode !== "direct" && body.mode !== "owner-merges") {
          return json({ error: 'mode is "direct" or "owner-merges"' }, 400);
        }
        const paths = body.protectedPaths;
        if (
          paths !== undefined &&
          !(Array.isArray(paths) && paths.every((x) => typeof x === "string" && x.trim()))
        ) {
          return json({ error: "protectedPaths is a list of paths" }, 400);
        }
        const perDay = body.followUpsPerDay;
        if (perDay !== undefined && !(Number.isInteger(perDay) && (perDay as number) >= 0)) {
          return json({ error: "followUpsPerDay is a whole number" }, 400);
        }
        if (body.autoRelease !== undefined && typeof body.autoRelease !== "boolean") {
          return json({ error: "autoRelease must be a boolean" }, 400);
        }
        d.registry.addProject({
          id,
          repo: body.repo,
          checks,
          ...(body.mode ? { mode: body.mode } : {}),
          ...(paths ? { protectedPaths: paths as string[] } : {}),
          ...(perDay !== undefined ? { followUpsPerDay: perDay as number } : {}),
          ...(body.autoRelease !== undefined ? { autoRelease: body.autoRelease } : {}),
        });
        return json({ project: d.registry.project(id), policy: d.registry.projectPolicy(id) });
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
      "PUT",
      "/api/employees/:id",
      async (req, { id = "" }) => {
        let existing: Employee;
        try {
          existing = d.registry.employee(id);
        } catch {
          return json({ error: "no such employee" }, 404);
        }
        const b = (await req.json()) as Partial<Employee>;
        const updated: Employee = {
          ...existing,
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.role !== undefined ? { role: b.role } : {}),
          ...(b.duties !== undefined ? { duties: b.duties } : {}),
          ...(b.engines !== undefined ? { engines: b.engines } : {}),
          ...(b.switchRules !== undefined ? { switchRules: b.switchRules } : {}),
          ...(b.projects !== undefined ? { projects: b.projects } : {}),
          ...(b.standingOrders !== undefined ? { standingOrders: b.standingOrders } : {}),
          ...(b.workingHours !== undefined ? { workingHours: b.workingHours } : {}),
          ...(b.outbound !== undefined ? { outbound: b.outbound } : {}),
          id,
        };
        const problems = hiringProblems(
          updated,
          d.registry.engines(),
          d.registry.employees().filter((e) => e.id !== id),
        );
        if (problems.length) return json({ error: problems.join("; "), problems }, 400);
        d.registry.hire(updated);
        return json({ employee: d.registry.employee(id) });
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
        return json({
          employees: officeView(d.registry.employees(), all, states, d.registry, localHour),
          accounts: d.registry.accounts(),
          rateLimits: d.registry.accountRateLimits(),
        });
      },
    ],

    [
      "GET",
      "/api/desk",
      async () => {
        const view = deskView(await d.store.all(), d.registry, d.clock.now());
        const pending = await pendingReleases();
        return json({
          ...view,
          releases: d.registry.releases(),
          pendingReleases: pending,
        });
      },
    ],

    [
      "GET",
      "/api/releases",
      async () => {
        const pending = await pendingReleases();
        return json({ releases: d.registry.releases(), pending });
      },
    ],

    [
      "POST",
      "/api/projects/:id/release",
      async (req, { id = "" }) => {
        const project = d.registry.project(id);
        if (!project) return json({ error: "no such project" }, 404);

        const pending = await pendingReleases();
        const projectPending = pending.find((p) => p.project === id || p.id === id);
        const pendingTickets = projectPending?.pendingTickets ?? [];
        if (!pendingTickets.length) {
          return json({ error: "no unreleased merged tickets" }, 400);
        }

        const body = (await req.json().catch(() => ({}))) as { tag?: unknown };
        if (body.tag !== undefined && (typeof body.tag !== "string" || !body.tag.trim())) {
          return json({ error: "tag must be a non-empty string" }, 400);
        }

        const now = d.clock.now();
        const existing = d.registry.releases().filter((r) => r.project === id);
        const count = existing.length + 1;
        const defaultTag = `v${new Date(now).toISOString().slice(0, 10)}.${count}`;
        const tag = (typeof body.tag === "string" && body.tag.trim()) || defaultTag;

        const ticketIds = pendingTickets.map((t) => t.id);
        const commits = pendingTickets
          .map((t) => t.pushed)
          .filter((c): c is string => typeof c === "string" && Boolean(c));

        const release: ProjectRelease = {
          project: id,
          tag,
          at: now,
          ticketIds,
          commits,
        };

        d.registry.recordRelease(release);
        return json({ release }, 201);
      },
    ],

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

    ["POST", "/api/tickets/:id/retry", async (_req, p) => act(p.id, null, () => retry(ports, p.id ?? ""))],

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

  function getOwner(): { username: string; password_hash: string } | undefined {
    const [row] = d.db.all<{ username: string; password_hash: string }>(
      "SELECT username, password_hash FROM owner_account WHERE id = 1",
    );
    return row;
  }

  return async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const authStatus = req.method === "GET" && path === "/api/auth";
    const signup = req.method === "POST" && path === "/api/signup";
    const login = req.method === "POST" && path === "/api/login";
    const logout = req.method === "POST" && path === "/api/logout";
    if (opts.token && !authStatus && !signup && !login && !logout && !authorized(req, opts.token)) {
      return json({ error: "unauthorized" }, 401);
    }
    const host = req.headers.get("host") ?? "";
    if (opts.hosts && !opts.hosts.includes(host)) return json({ error: `not served as ${host}` }, 421);
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin");
      if (
        origin &&
        opts.hosts &&
        !opts.hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`)
      ) {
        return json({ error: "cross-site request refused" }, 403);
      }
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
        return json({ error: "writes must be application/json" }, 415);
      }
    }
    if (authStatus) {
      return json({ initialized: getOwner() !== undefined });
    }
    if (signup) {
      if (getOwner()) return json({ error: "owner account already exists" }, 409);
      const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (!username) return json({ error: "username is required" }, 400);
      if (typeof body.password !== "string" || body.password.length < 8) {
        return json({ error: "password must be at least 8 characters" }, 400);
      }
      d.db.run(
        "INSERT INTO owner_account (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)",
        username,
        hashPassword(body.password),
        d.clock.now(),
      );
      return jsonWithCookie({ ok: true, username }, 201, opts.token);
    }
    if (login) {
      const body = (await req.json().catch(() => ({}))) as {
        username?: unknown;
        password?: unknown;
        token?: unknown;
      };
      if (body.username !== undefined || body.password !== undefined) {
        const owner = getOwner();
        if (!owner) return json({ error: "create an owner account first" }, 400);
        if (
          typeof body.username !== "string" ||
          typeof body.password !== "string" ||
          body.username.trim() !== owner.username ||
          !verifyPassword(body.password, owner.password_hash)
        ) {
          return json({ error: "wrong username or password" }, 401);
        }
        return jsonWithCookie({ ok: true }, 200, opts.token);
      }
      if (!opts.token || typeof body.token !== "string" || !same(body.token, opts.token)) {
        await new Promise((r) => setTimeout(r, 1000)); // slows guessing
        return json({ error: "that's not the token" }, 401);
      }
      return jsonWithCookie({ ok: true }, 200, opts.token);
    }
    if (logout) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "i_inc=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        },
      });
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

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(":");
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Compares secrets in constant time. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The token as the web app's cookie, or as a bearer header. */
function authorized(req: Request, token: string): boolean {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const cookie = /(?:^|;\s*)i_inc=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return [bearer, cookie].some((t) => t !== undefined && same(t, token));
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

function jsonWithCookie(body: unknown, status: number, token?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(token
        ? {
            // HttpOnly: the page's scripts can't read it; Strict: other sites can't send it.
            "set-cookie": `i_inc=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          }
        : {}),
    },
  });
}
