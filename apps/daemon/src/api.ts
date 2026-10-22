// The daemon's HTTP API: plain Request -> Response (Bun.serve on the host, called directly in tests).
// It's served on 127.0.0.1, reached through an SSH tunnel. Other web pages the owner has open can
// still send it requests, so: only known Host headers (no DNS rebinding), writes must be JSON (which
// another site can't send without a CORS preflight, and none is ever allowed), and an Origin from
// anywhere else is refused. A bearer token can guard it as well. The one exception to JSON, images
// for a ticket, must carry a custom header, which needs a preflight too (see isUpload).

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import {
  type AccountCost,
  type AgentHarness,
  answer,
  buildQuery,
  decide,
  defaultSwitchRules,
  type Employee,
  type Engine,
  fold,
  handleMessage,
  handOff,
  hiringProblems,
  homeSandbox,
  type Id,
  isHomeEmployee,
  isLocalEngine,
  knowledgeLog,
  type ProjectRelease,
  type ProposedEdit,
  parseScope,
  retry,
  type SandboxStatus,
  type Scope,
  sharedHomeProblems,
  type Ticket,
  type TicketState,
} from "@i-inc/core";
import { ConversationError } from "./ahp/conversations.ts";
import { authorized, hostAllowed, originAllowed, same } from "./auth.ts";
import { type BrainChange, RevertError } from "./brain-harvest.ts";
import { ACCEPTED_LABEL, type Daemon, type DaemonDeps } from "./daemon.ts";
import { readDeploys } from "./deploys.ts";
import {
  bootstrapRepo,
  inspectRepo,
  isTemplate,
  isValidBranch,
  isValidRepo,
  markRegistered,
  NotEmptyError,
  TEMPLATES,
  UpstreamGitHubError,
} from "./github.ts";
import {
  CannotCreate,
  CreateInProgress,
  describeGitHubError,
  GitHubProjects,
  isValidRepoName,
  logLine,
  newRepoUrl,
} from "./github-projects.ts";
import { sniffImage } from "./images.ts";
import type { Change, Repo } from "./knowledge.ts";
import { type ProposalStatus, RECOVERED_BODY } from "./proposals.ts";
import { type NotifySettings, notifyKeys, notifySettings, type PushSubscription } from "./push.ts";
import { defaultTeam, type Project } from "./registry.ts";
import { ShipError } from "./ship.ts";
import type { NewAttachment, NewTicket } from "./tickets.ts";
import {
  allRateLimits,
  deskView,
  enrichAccounts,
  officeView,
  type PendingRelease,
  type PendingTicket,
  proposalView,
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
  /** The sha of the release that is running, for GET /api/health. */
  version?: string;
  /** ~/.i-inc/deploys.jsonl, which the deployer writes, for GET /api/deploys. */
  deploysPath?: string;
}

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

/** Project names the web app's addresses use for its own pages (`#/company/projects/add`). */
const RESERVED_PROJECT_IDS = new Set(["add", "new"]);

/** Why a project name can't be used, or null when it can. */
function projectIdProblem(id: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(id)) {
    return "a project is named by up to 40 letters, digits, spaces, dots and dashes";
  }
  if (RESERVED_PROJECT_IDS.has(id.trim().toLowerCase())) {
    return `"${id}" is kept for the app's own pages: pick another project name`;
  }
  return null;
}

/** What a model id may be: 1 to 100 of these characters, so no control characters or line breaks. */
const validModel = /^[A-Za-z0-9._:/@+ -]{1,100}$/;

const inFlightBootstraps = new Set<string>();
/** Repos being bootstrapped right now, by lower-cased owner/name: one project per repo, however it is named. */
const inFlightRepos = new Set<string>();

/** Writes that can run for minutes: the daemon counts them as busy (the chat turn tracks itself). */
const longRunning = new Set([
  "POST /api/conversations/:id/ticket",
  "POST /api/conversations/:id/pr",
  "POST /api/conversations/:id/take-back",
  "POST /api/projects/:id/bootstrap",
  "POST /api/sandboxes/:team/retry",
  "POST /api/teams/:id/antigravity-callback",
]);

export function createApi(daemon: Daemon, d: DaemonDeps, opts: ApiOptions = {}) {
  const lastSandboxRetry = new Map<string, number>();
  /** Does this team have a PA in it? */
  const holdsHome = (t: { members: string[] }): boolean =>
    d.registry.employees().some((e) => t.members.includes(e.id) && isHomeEmployee(e));
  /**
   * A team (and so a sandbox) for a PA alone: the one it already works in if nobody else does, else
   * `home-<id>`, made now with the small home size. `made` says whether this call made it, for undoing.
   */
  const homeTeamFor = (e: Employee): { id: string; made: boolean } => {
    const teams = d.registry.teams();
    const mine = teams.find((t) => t.members.includes(e.id));
    if (mine?.members.every((m) => m === e.id)) return { id: mine.id, made: false };
    const base = `home-${e.id}`.slice(0, 32);
    const sole = teams.find((t) => t.id === base);
    if (sole?.members.every((m) => m === e.id)) return { id: sole.id, made: false };
    let n = 0;
    let id = base;
    const taken = new Set(teams.map((t) => t.id));
    while (taken.has(id)) id = `${base.slice(0, 29)}-${++n}`;
    d.registry.addTeam({ id, name: `${e.name}'s home`, members: [], sandbox: { ...homeSandbox } });
    return { id, made: true };
  };
  /** The employees who work in a team's sandbox. */
  const membersOf = (teamId: string): Employee[] => {
    const team = d.registry.teams().find((t) => t.id === teamId);
    return d.registry.employees().filter((e) => team?.members.includes(e.id));
  };
  const startedAt = d.clock.now();
  const gh = new GitHubProjects(d.tokens, {
    now: () => d.clock.now(),
    ...(d.githubApi ? { api: d.githubApi } : {}),
    ...(d.githubFetch ? { fetch: d.githubFetch } : {}),
    ...(d.log ? { log: d.log } : {}),
  });
  /** A GitHub failure as the API answers it: a sentence for the owner and a code, never GitHub's own words. */
  const upstream = (e: unknown, what: string, extra: Record<string, unknown> = {}): Response => {
    console.error(`[github] ${what}: ${logLine(e)}`);
    const p = describeGitHubError(e);
    const res = json(
      {
        ...extra,
        error: p.error,
        code: p.code,
        ...(p.retryAfter !== undefined ? { retryAfter: p.retryAfter } : {}),
      },
      p.status,
    );
    if (p.retryAfter !== undefined) res.headers.set("retry-after", String(p.retryAfter));
    return res;
  };
  /** The projects a chat draft for this employee can be filed under: the ones it works on (C12). */
  const projectChoices = (e: Employee): string[] => e.projects ?? d.registry.projects().map((pr) => pr.id);
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
        ticketView(
          r,
          await daemon.state(r.ticket.id),
          events,
          d.registry,
          waiting.get(r.ticket.id) ?? null,
          daemon.waitingUntil[r.ticket.id] ?? null,
        ),
      );
    }
    return out;
  };

  /** GitHub's numeric id of a repo the bot can see (from the cached list), or undefined when it can't be told. */
  const repoIdOf = async (repo: string): Promise<number | undefined> => {
    if (!gh.configured) return undefined;
    try {
      const list = await gh.repos();
      return list.repos.find((r) => r.fullName.toLowerCase() === repo.toLowerCase())?.id;
    } catch {
      return undefined;
    }
  };

  /** Records, as projects are read, the GitHub id of those that don't have one (told by name, from the cached list). */
  const backfillRepoIds = async () => {
    const missing = d.registry.projects().filter((p) => p.repoId === undefined);
    if (!missing.length || !gh.configured) return;
    let repos: { fullName: string; id?: number }[];
    try {
      repos = (await gh.repos()).repos;
    } catch {
      return;
    }
    for (const p of missing) {
      const id = repos.find((r) => r.fullName.toLowerCase() === p.repo.toLowerCase())?.id;
      if (id !== undefined) d.registry.addProject({ ...p, repoId: id });
    }
  };

  /** The project that already uses this repo: by GitHub's id when both are known (a rename keeps it), and by name. */
  const projectUsing = (repo: string, repoId: number | undefined, except?: string) =>
    d.registry
      .projects()
      .find(
        (p) =>
          p.id !== except &&
          (p.repo.toLowerCase() === repo.toLowerCase() || (repoId !== undefined && p.repoId === repoId)),
      );

  /** One line for a ticket in a project's list: how it ended, or where it is. */
  const ticketLine = (st: TicketState): string => st.outcome ?? st.status;

  /**
   * A project's status line (C14): how its work reaches main, the checks, its last ticket and how many
   * pull requests are open. All from our own records, so it costs no GitHub call.
   */
  const projectStatus = async (p: Project) => {
    const mine = d.tickets.all().filter((r) => r.ticket.project === p.id);
    let openTickets = 0;
    const openPrs: { ticketId: string; number?: number; url: string }[] = [];
    for (const r of mine) {
      const st = await daemon.state(r.ticket.id);
      if (st.outcome) continue;
      openTickets++;
      const url = st.pr?.url;
      if (st.pr && typeof url === "string" && url.startsWith("https://github.com/")) {
        openPrs.push({
          ticketId: r.ticket.id,
          ...(st.pr.number !== undefined ? { number: st.pr.number } : {}),
          url,
        });
      }
    }
    const last = mine[mine.length - 1];
    const lastTicket = last
      ? {
          id: last.ticket.id,
          title: last.ticket.title,
          at: last.createdAt,
          status: ticketLine(await daemon.state(last.ticket.id)),
        }
      : null;
    return {
      id: p.id,
      repo: p.repo,
      repoUrl: isValidRepo(p.repo) ? `https://github.com/${p.repo}` : null,
      mode: d.registry.projectPolicy(p.id).mode,
      checks: p.checks,
      ...(p.defaultBranch ? { defaultBranch: p.defaultBranch } : {}),
      lastTicket,
      openTickets,
      openPrs,
    };
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
        const harnesses: AgentHarness[] = ["claude-code", "antigravity", "opencode", "codex"];
        if (!/^[a-z0-9-]{1,40}$/.test(id))
          return json({ error: "an engine id is lowercase letters, digits and dashes" }, 400);
        const existing = d.registry.engines().find((e) => e.id === id);
        // Create-only (`If-None-Match: *`, as HTTP means it): adding must never replace an engine that is there.
        if (existing && req.headers.get("if-none-match") === "*") {
          return json(
            {
              error: `an engine called ${id} already exists (${existing.model} on ${existing.harness}): pick another id`,
              code: "exists",
            },
            412,
          );
        }
        const harness = b.harness ?? existing?.harness;
        if (!harness || !harnesses.includes(harness)) {
          return json({ error: `harness must be one of ${harnesses.join(", ")}` }, 400);
        }
        const model = b.model ?? existing?.model;
        if (typeof model !== "string" || !model.trim()) return json({ error: "model names the model" }, 400);
        // A model id from the owner (or a script) ends up in prompts, ACP calls and stuck reasons, so
        // it's checked for every harness. A stored engine that the request doesn't touch is left alone.
        if (b.model !== undefined && !validModel.test(model)) {
          return json(
            {
              error:
                "model must be 1 to 100 characters of letters, digits, spaces and . _ : / @ + - (no line breaks or other control characters)",
            },
            400,
          );
        }
        const accountId = b.accountId ?? existing?.accountId;
        if (typeof accountId !== "string" || !d.registry.accounts().some((a) => a.id === accountId)) {
          return json({ error: "accountId must be an account added with PUT /api/accounts/:id" }, 400);
        }
        const local = b.local !== undefined ? b.local === true : (existing?.local ?? false);
        if (harness === "codex" && local) {
          if (existing && existing.harness !== "codex") {
            return json({ error: "Codex runs in the cloud and cannot be local; turn off Local first" }, 400);
          }
          return json({ error: "Codex is a cloud harness and cannot be marked local" }, 400);
        }
        // A PA's sandbox has no internet, so every engine it uses must stay a local one: this can't turn one
        // into a cloud engine under it (hiringProblems checks the same when the PA is hired or edited).
        if (!isLocalEngine({ local, harness })) {
          const users = d.registry
            .employees()
            .filter(
              (e) =>
                isHomeEmployee(e) &&
                [
                  e.engines.default,
                  ...Object.values(e.engines.perDuty ?? {}),
                  ...e.engines.fallbacks,
                ].includes(id),
            );
          if (users.length) {
            return json(
              {
                error: `${users.map((e) => e.name).join(", ")} works on home data and its sandbox has no internet, so ${id} has to stay a local engine: give ${users.length > 1 ? "them" : "it"} another engine first`,
              },
              409,
            );
          }
        }
        d.registry.addEngine({
          id,
          harness,
          model,
          accountId,
          local,
        });
        return json({ engine: d.registry.engine(id) });
      },
    ],

    [
      "DELETE",
      "/api/engines/:id",
      async (_req, { id = "" }) => {
        const ok = d.registry.removeEngine(id);
        if (!ok) return json({ error: "no such engine" }, 404);
        return json({ ok: true });
      },
    ],

    [
      "GET",
      "/api/accounts",
      async () => {
        const now = d.clock.now();
        const accounts = enrichAccounts(d.registry.accounts(), d.registry, d.db, now);
        const rateLimits = allRateLimits(accounts, d.registry, now);
        return json({ accounts, rateLimits });
      },
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
        const taken = d.registry.accounts().find((a) => a.id === id);
        if (taken && req.headers.get("if-none-match") === "*") {
          return json(
            {
              error: `an account called ${id} already exists (${taken.name}): pick another id`,
              code: "exists",
            },
            412,
          );
        }
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

    [
      "DELETE",
      "/api/accounts/:id",
      async (_req, { id = "" }) => {
        const ok = d.registry.removeAccount(id);
        if (!ok) return json({ error: "no such account" }, 404);
        return json({ ok: true });
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
              signedIn: { claude: false, antigravity: false, codex: false, github: false },
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
              signedIn: { claude: false, antigravity: false, codex: false, github: false },
            });
          }
        }
        return json({ sandboxes });
      },
    ],

    // C23: what the daemon keeps and how much room it takes (T52).
    [
      "GET",
      "/api/storage",
      async () => (d.storage ? json(await d.storage.report()) : json({ error: "storage isn't set up" }, 404)),
    ],

    [
      "PUT",
      "/api/storage/settings",
      async (req) => {
        if (!d.storage) return json({ error: "storage isn't set up" }, 404);
        const body = await readObject(req);
        if (body === null) return json({ error: "send a JSON object of settings" }, 400);
        const r = d.storage.update(body);
        return "error" in r ? json(r, 400) : json(r);
      },
    ],

    // Dry run unless the body says `{ "dryRun": false }`.
    [
      "POST",
      "/api/storage/cleanup",
      async (req) => {
        if (!d.storage) return json({ error: "storage isn't set up" }, 404);
        const body = await readObject(req);
        if (body === null) return json({ error: "send a JSON object" }, 400);
        if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
          return json({ error: "dryRun must be true or false" }, 400);
        }
        return json(await d.storage.cleanupNow({ dryRun: body.dryRun !== false }));
      },
    ],

    [
      "POST",
      "/api/sandboxes/:team/retry",
      async (_req, { team = "" }) => {
        const found =
          d.registry.teams().find((t) => t.id === team) ??
          (team === defaultTeam.id ? defaultTeam : undefined);
        if (!found) return json({ error: `no team ${team}` }, 404);
        const now = d.clock.now();
        const last = lastSandboxRetry.get(team) ?? 0;
        if (now - last < 10_000) {
          return json({ error: "too many retry requests, try again shortly" }, 429);
        }
        lastSandboxRetry.set(team, now);
        const size = found.sandbox ?? { cpus: 6, memory: "12G" };
        let sandbox: SandboxStatus;
        if (d.machines.retrySandbox) {
          sandbox = await d.machines.retrySandbox(team, size);
        } else if (d.machines.inspectSandbox) {
          sandbox = await d.machines.inspectSandbox(team, size);
        } else {
          sandbox = {
            team,
            machine: `inc-${team}`,
            state: "error",
            cpus: size.cpus,
            memory: size.memory,
            signedIn: { claude: false, antigravity: false, codex: false, github: false },
          };
        }
        void daemon.tick().catch(() => {});
        return json({ ok: true, sandbox });
      },
    ],

    [
      "PUT",
      "/api/teams/:id",
      async (req, { id = "" }) => {
        const b = (await req.json()) as { name?: unknown; members?: unknown; sandbox?: unknown };
        if (!/^[a-z0-9-]{1,32}$/.test(id))
          return json({ error: "a team id is lowercase letters, digits and dashes" }, 400);
        // Create-only (`If-None-Match: *`): the owner is adding a team, not rewriting one that is there.
        const present = d.registry.teams().find((t) => t.id === id);
        if (present && req.headers.get("if-none-match") === "*") {
          return json(
            {
              error: `a team called ${id} already exists (${present.name}): pick another name`,
              code: "exists",
            },
            412,
          );
        }
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
        // Taking a PA out of its team would land it in the shared sandbox (emptying a home team does).
        const before = d.registry.teams().find((t) => t.id === id);
        const left = d.registry
          .employees()
          .filter(
            (e) =>
              isHomeEmployee(e) && before?.members.includes(e.id) && !(members as string[]).includes(e.id),
          );
        if (left.length) {
          return json(
            {
              error: `${left.map((e) => e.name).join(", ")} works on home data and needs a sandbox of its own, so it can't be taken out of ${before?.name ?? id} this way`,
            },
            409,
          );
        }
        // A PA's home data must not share a sandbox (and a Unix user) with anyone else.
        const crowd = sharedHomeProblems(
          b.name,
          d.registry.employees().filter((e) => (members as string[]).includes(e.id)),
        );
        if (crowd.length) return json({ error: crowd.join("; "), problems: crowd }, 400);
        d.registry.setTeam({
          id,
          name: b.name,
          members: members as string[],
          ...(box ? { sandbox: { cpus: box.cpus as number, memory: box.memory as string } } : {}),
        });
        return json({ team: d.registry.teams().find((t) => t.id === id) });
      },
    ],

    [
      "DELETE",
      "/api/teams/:id",
      async (_req, { id = "" }) => {
        // Deleting a team puts its people in the company's shared sandbox: not for a PA's home data.
        const team = d.registry.teams().find((t) => t.id === id);
        if (team && holdsHome(team)) {
          const who = d.registry
            .employees()
            .filter((e) => team.members.includes(e.id) && isHomeEmployee(e))
            .map((e) => e.name);
          return json(
            {
              error: `${team.name} holds ${who.join(", ")}, who works on home data and needs a sandbox of its own, so it can't be deleted`,
            },
            409,
          );
        }
        const ok = d.registry.removeTeam(id);
        if (!ok) return json({ error: "no such team" }, 404);
        return json({ ok: true });
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

    // C2 (T65): what the owner is notified about, beyond tickets. One setting for every device.
    [
      "GET",
      "/api/push/settings",
      async () => json({ settings: notifySettings(d.registry.settings().notify) }),
    ],

    [
      "PUT",
      "/api/push/settings",
      async (req) => {
        const body = await readObject(req);
        if (body === null) return json({ error: "send a JSON object of settings" }, 400);
        const patch: Partial<NotifySettings> = {};
        for (const [key, value] of Object.entries(body)) {
          if (!(notifyKeys as string[]).includes(key)) return json({ error: `unknown setting ${key}` }, 400);
          if (typeof value !== "boolean") return json({ error: `${key} must be true or false` }, 400);
          patch[key as keyof NotifySettings] = value;
        }
        d.registry.setSettings({ notify: { ...d.registry.settings().notify, ...patch } });
        return json({ settings: notifySettings(d.registry.settings().notify) });
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
          defaultBranch?: unknown;
        };
        const checks = Array.isArray(body.checks) ? body.checks : [];
        const idProblem = projectIdProblem(id);
        if (idProblem && !d.registry.project(id)) return json({ error: idProblem }, 400);
        const normId = id.toLowerCase();
        if (d.registry.projects().some((p) => p.id.toLowerCase() === normId && p.id !== id)) {
          return json({ error: `project ID "${id}" conflicts with an existing project` }, 409);
        }
        if (typeof body.repo !== "string" || !isValidRepo(body.repo)) {
          return json({ error: "repo must be valid owner/name on GitHub" }, 400);
        }
        if (!checks.length || !checks.every((c) => typeof c === "string" && c.trim())) {
          return json({ error: "checks must be the recipe's commands, in order" }, 400);
        }
        await backfillRepoIds();
        const priorProject = d.registry.project(id);
        const sameRepo = priorProject?.repo.toLowerCase() === body.repo.toLowerCase();
        const repoId =
          sameRepo && priorProject?.repoId !== undefined ? priorProject.repoId : await repoIdOf(body.repo);
        const usedBy = projectUsing(body.repo, repoId, id);
        if (usedBy) {
          return json(
            {
              error: `${body.repo} is already the project "${usedBy.id}". A repo can be one project only.`,
              code: "in-use",
              project: usedBy.id,
            },
            409,
          );
        }
        if (body.mode !== undefined && body.mode !== "direct" && body.mode !== "owner-merges") {
          return json({ error: 'mode is "direct" or "owner-merges"' }, 400);
        }
        if (
          body.defaultBranch !== undefined &&
          (typeof body.defaultBranch !== "string" || !isValidBranch(body.defaultBranch))
        ) {
          return json({ error: "defaultBranch must be a valid git branch name up to 100 characters" }, 400);
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
        const existingProj = d.registry.project(id);
        const defaultBranch =
          typeof body.defaultBranch === "string" && body.defaultBranch.trim()
            ? body.defaultBranch.trim()
            : existingProj?.defaultBranch;
        d.registry.addProject({
          id,
          repo: body.repo,
          checks,
          ...(body.mode ? { mode: body.mode } : {}),
          ...(paths ? { protectedPaths: paths as string[] } : {}),
          ...(perDay !== undefined ? { followUpsPerDay: perDay as number } : {}),
          ...(body.autoRelease !== undefined ? { autoRelease: body.autoRelease } : {}),
          ...(defaultBranch ? { defaultBranch } : {}),
          ...(repoId !== undefined ? { repoId } : {}),
        });
        return json({ project: d.registry.project(id), policy: d.registry.projectPolicy(id) });
      },
    ],

    [
      "DELETE",
      "/api/projects/:id",
      async (_req, { id = "" }) => {
        const ok = d.registry.removeProject(id);
        if (!ok) return json({ error: "no such project" }, 404);
        return json({ ok: true });
      },
    ],

    [
      "GET",
      "/api/github/status",
      async () => {
        try {
          return json(await gh.status());
        } catch (e) {
          return upstream(e, "status failed");
        }
      },
    ],

    [
      "GET",
      "/api/github/repos",
      async (req) => {
        if (!gh.configured) return json({ repos: [], configured: false });
        try {
          const refresh = new URL(req.url).searchParams.get("refresh") === "1";
          const list = await gh.repos(refresh);
          await backfillRepoIds();
          const projects = d.registry.projects();
          const ids = projects.flatMap((p) => (p.repoId === undefined ? [] : [p.repoId]));
          return json({
            configured: true,
            repos: markRegistered(
              list.repos,
              projects.map((p) => p.repo),
              ids,
            ),
            fetchedAt: list.fetchedAt,
            ...(list.warning ? { warning: list.warning } : {}),
            ...(list.throttled ? { throttled: true } : {}),
          });
        } catch (e) {
          return upstream(e, "failed to list repos", { repos: [] });
        }
      },
    ],

    // Creates an empty repo through the bot. GitHub allows that only in an organization the App is
    // installed on and with Administration: write; anywhere else this answers 409 with the link for
    // the owner to create the repo themselves (docs/handoff.md, "Adding or creating a project").
    [
      "POST",
      "/api/github/repos",
      async (req) => {
        if (!gh.configured) return json({ error: "GitHub integration is not configured" }, 400);
        const body = await readObject(req);
        if (!body) return json({ error: "send a JSON object" }, 400);
        if (!isValidRepoName(body.name)) {
          return json(
            { error: "a repository name is up to 100 letters, digits, dots, dashes and underscores" },
            400,
          );
        }
        const visibility = body.visibility ?? "private";
        if (visibility !== "private" && visibility !== "public") {
          return json({ error: 'visibility is "private" or "public"' }, 400);
        }
        if (
          body.description !== undefined &&
          (typeof body.description !== "string" || body.description.length > 350)
        ) {
          return json({ error: "description is up to 350 characters" }, 400);
        }
        try {
          const repo = await gh.create({
            name: body.name,
            visibility,
            ...(typeof body.description === "string" && body.description.trim()
              ? { description: body.description.trim() }
              : {}),
          });
          return json({ repo }, 201);
        } catch (e) {
          if (e instanceof CannotCreate) {
            return json(
              {
                error: e.create.detail,
                code: "cannot-create",
                reason: e.create.reason,
                manualUrl: newRepoUrl(body.name, visibility),
              },
              409,
            );
          }
          if (e instanceof CreateInProgress) {
            return json({ error: e.message, code: "in-progress" }, 409);
          }
          return upstream(e, "failed to create a repo");
        }
      },
    ],

    [
      "GET",
      "/api/github/repos/:owner/:name/inspect",
      async (_req, { owner = "", name = "" }) => {
        if (!gh.configured) return json({ error: "GitHub integration is not configured" }, 400);
        const repo = `${owner}/${name}`;
        if (!isValidRepo(repo)) {
          return json({ error: "invalid repository owner or name" }, 400);
        }
        try {
          if (!(await gh.canSee(repo))) {
            return json(
              {
                error: `The i.inc bot can't see ${repo}. Give i.inc access to it on GitHub, then refresh.`,
                code: "not-accessible",
              },
              403,
            );
          }
          return json(await inspectRepo(gh.source, owner, name, gh.fetchDeps));
        } catch (e) {
          return upstream(e, "failed to inspect a repo");
        }
      },
    ],

    // Every project with a status line: mode, checks, the last ticket and how many pull requests are open.
    // The counts come from our own tickets (no GitHub call), so the list is cheap to reload.
    [
      "GET",
      "/api/project-overview",
      async () => {
        await backfillRepoIds();
        const out = [];
        for (const p of d.registry.projects()) out.push(await projectStatus(p));
        return json({ projects: out });
      },
    ],

    [
      "GET",
      "/api/projects/:id",
      async (_req, { id = "" }) => {
        await backfillRepoIds();
        const p = d.registry.project(id);
        if (!p) return json({ error: "no such project" }, 404);
        const status = await projectStatus(p);
        const recent = [...d.tickets.all()]
          .filter((r) => r.ticket.project === p.id)
          .reverse()
          .slice(0, 8);
        const tickets = [];
        for (const r of recent) {
          const st = await daemon.state(r.ticket.id);
          tickets.push({
            id: r.ticket.id,
            title: r.ticket.title,
            type: r.ticket.type,
            at: r.createdAt,
            status: ticketLine(st),
          });
        }
        const releases = d.registry
          .releases()
          .filter((r) => r.project === p.id)
          .sort((a, b) => b.at - a.at)
          .slice(0, 5);
        return json({ project: p, policy: d.registry.projectPolicy(p.id), ...status, tickets, releases });
      },
    ],

    [
      "POST",
      "/api/projects/:id/bootstrap",
      async (req, { id = "" }) => {
        const idProblem = projectIdProblem(id);
        if (idProblem) return json({ error: idProblem }, 400);

        const normalizedId = id.trim().toLowerCase();
        if (
          inFlightBootstraps.has(normalizedId) ||
          d.registry.projects().some((p) => p.id.toLowerCase() === normalizedId)
        ) {
          return json({ error: `project "${id}" already exists` }, 409);
        }

        inFlightBootstraps.add(normalizedId);
        let repoKey: string | null = null;
        let idKey: string | null = null;
        try {
          const body = (await req.json().catch(() => ({}))) as {
            repo?: unknown;
            mode?: unknown;
            template?: unknown;
            description?: unknown;
            employees?: unknown;
            checks?: unknown;
            protectedPaths?: unknown;
            autoRelease?: unknown;
            force?: unknown;
            defaultBranch?: unknown;
          };

          if (typeof body.repo !== "string" || !isValidRepo(body.repo)) {
            return json({ error: "repo must be valid owner/name on GitHub" }, 400);
          }
          const repo = body.repo;
          // One project per repo, whatever the project is called and however the repo's case is written.
          const using = projectUsing(repo, undefined);
          if (using || inFlightRepos.has(repo.toLowerCase())) {
            return json(
              {
                error: using
                  ? `${repo} is already the project "${using.id}". A repo can be one project only.`
                  : `${repo} is being added right now. Wait for that to finish.`,
                code: "in-use",
                ...(using ? { project: using.id } : {}),
              },
              409,
            );
          }
          repoKey = repo.toLowerCase();
          inFlightRepos.add(repoKey);

          // The same repo under a new name (renamed or transferred on GitHub) is told by GitHub's id.
          await backfillRepoIds();
          const repoId = await repoIdOf(repo);
          if (repoId !== undefined) {
            const idLock = `#${repoId}`;
            const sameById = projectUsing(repo, repoId);
            if (sameById || inFlightRepos.has(idLock)) {
              // Not ours: leave idKey unset, so this request's finally can't release the other one's lock.
              return json(
                {
                  error: sameById
                    ? `${repo} is already the project "${sameById.id}" (as ${sameById.repo}). A repo can be one project only.`
                    : `${repo} is being added right now. Wait for that to finish.`,
                  code: "in-use",
                  ...(sameById ? { project: sameById.id } : {}),
                },
                409,
              );
            }
            inFlightRepos.add(idLock);
            idKey = idLock;
          }

          if (body.mode !== undefined && body.mode !== "direct" && body.mode !== "owner-merges") {
            return json({ error: 'mode must be "direct" or "owner-merges"' }, 400);
          }
          const mode = body.mode === "owner-merges" ? "owner-merges" : "direct";

          if (
            body.description !== undefined &&
            (typeof body.description !== "string" || body.description.length > 500)
          ) {
            return json({ error: "description must be a string up to 500 characters" }, 400);
          }

          if (
            body.defaultBranch !== undefined &&
            (typeof body.defaultBranch !== "string" || !isValidBranch(body.defaultBranch))
          ) {
            return json({ error: "defaultBranch must be a valid git branch name up to 100 characters" }, 400);
          }

          if (body.checks !== undefined) {
            if (
              !Array.isArray(body.checks) ||
              body.checks.length > 20 ||
              body.checks.some((c) => typeof c !== "string" || c.length > 200)
            ) {
              return json(
                { error: "checks must be an array of at most 20 strings, up to 200 characters each" },
                400,
              );
            }
          }

          if (body.protectedPaths !== undefined) {
            if (
              !Array.isArray(body.protectedPaths) ||
              body.protectedPaths.length > 50 ||
              body.protectedPaths.some((p) => typeof p !== "string" || p.length > 200)
            ) {
              return json(
                { error: "protectedPaths must be an array of at most 50 strings, up to 200 characters each" },
                400,
              );
            }
          }

          if (body.template !== undefined && !isTemplate(body.template)) {
            return json({ error: `template must be one of: ${TEMPLATES.join(", ")}` }, 400);
          }

          if (gh.configured) {
            try {
              if (!(await gh.canSee(repo))) {
                return json(
                  {
                    error: `The i.inc bot can't see ${repo}. Give i.inc access to it on GitHub, then try again.`,
                    code: "not-accessible",
                  },
                  403,
                );
              }
            } catch (e) {
              return upstream(e, "failed to check access before bootstrap");
            }
          }

          let bootstrapped = false;
          let commits = 0;
          const force = body.force === true;

          if (isTemplate(body.template)) {
            if (!gh.configured) {
              return json({ error: "GitHub integration is required to bootstrap starter files" }, 400);
            }

            const [owner = "", name = ""] = repo.split("/");
            try {
              const inspect = await inspectRepo(gh.source, owner, name, gh.fetchDeps);
              if (!inspect.empty && !force) {
                return json(
                  {
                    error:
                      "This repository already has files, so i.inc won't write a starter into it. Add it as an existing repo instead, or pick another name.",
                    code: "not-empty",
                    empty: false,
                  },
                  409,
                );
              }
            } catch (e) {
              return upstream(e, "failed to inspect before bootstrap");
            }

            // Only a carry-on needs to know who the bot is: it may continue from commits the bot wrote.
            const botLogin = force ? await gh.botLogin() : undefined;
            try {
              const res = await bootstrapRepo(
                gh.source,
                {
                  repo,
                  template: body.template,
                  ...(typeof body.description === "string" ? { description: body.description } : {}),
                  ...(typeof body.defaultBranch === "string" ? { defaultBranch: body.defaultBranch } : {}),
                  ...(force ? { force: true } : {}),
                  ...(botLogin ? { botLogin } : {}),
                },
                gh.fetchDeps,
              );
              bootstrapped = res.bootstrapped;
              commits = res.commits;
              gh.invalidate();
            } catch (e) {
              gh.invalidate();
              if (e instanceof NotEmptyError) {
                return json(
                  {
                    error: e.message,
                    code: "not-empty",
                    empty: false,
                    ...((e.written ?? 0) > 0 ? { resumable: true } : {}),
                  },
                  409,
                );
              }
              // Some files may be in already, if this run wrote any: running it again (confirmed) carries on.
              const wrote = e instanceof UpstreamGitHubError && (e.written ?? 0) > 0;
              return upstream(e, "failed to bootstrap", wrote ? { resumable: true } : {});
            }
          }

          let checks: string[] = [];
          if (Array.isArray(body.checks) && body.checks.length > 0) {
            checks = body.checks.filter((c): c is string => typeof c === "string" && Boolean(c.trim()));
          } else if (body.template === "python") {
            checks = ["pytest"];
          } else if (body.template === "web") {
            checks = ["pnpm install", "pnpm check", "pnpm test", "pnpm build"];
          } else if (body.template === "minimal") {
            checks = ["echo ok"];
          } else {
            checks = ["pnpm install", "pnpm test"];
          }

          const protectedPaths = Array.isArray(body.protectedPaths)
            ? body.protectedPaths.filter((p): p is string => typeof p === "string" && Boolean(p.trim()))
            : [".github/"];

          const defaultBranch =
            typeof body.defaultBranch === "string" && body.defaultBranch.trim()
              ? body.defaultBranch.trim()
              : undefined;

          d.registry.addProject({
            id,
            repo,
            checks,
            mode,
            protectedPaths,
            autoRelease: body.autoRelease === true,
            ...(defaultBranch ? { defaultBranch } : {}),
            ...(repoId !== undefined ? { repoId } : {}),
          });

          if (Array.isArray(body.employees)) {
            const empIds = new Set(body.employees.filter((e): e is string => typeof e === "string"));
            for (const emp of d.registry.employees()) {
              if (empIds.has(emp.id)) {
                const currentProjects = emp.projects ?? [];
                if (!currentProjects.includes(id)) {
                  d.registry.hire({
                    ...emp,
                    projects: [...currentProjects, id],
                  });
                }
              }
            }
          }

          return json({ project: d.registry.project(id), bootstrapped, commits }, 201);
        } finally {
          inFlightBootstraps.delete(normalizedId);
          if (repoKey) inFlightRepos.delete(repoKey);
          if (idKey) inFlightRepos.delete(idKey);
        }
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
          current: currentView((await workOf(e)).current),
        });
      },
    ],

    [
      "POST",
      "/api/chat/:id",
      async (req, p) => {
        const e = d.registry.employees().find((x) => x.id === p.id);
        if (!e) return json({ error: "no such employee" }, 404);
        const message = await readMessage(req);
        if ("error" in message) return json({ error: message.error }, message.status);
        const { text, urgent, ticket, images } = message;
        const said = text?.trim() ?? "";
        if (!said && !images.length) return json({ error: "say something" }, 400);
        const { mine, current } = await workOf(e);
        if (images.length) return imageNote(e, current, { said, urgent, ticket, images });
        d.chatLog.add(
          e.id,
          urgent
            ? { from: "owner", at: d.clock.now(), text: said, urgent: true }
            : { from: "owner", at: d.clock.now(), text: said },
        );

        // A few notes from its recent tickets.
        const notes = mine
          .slice(-3)
          .map(
            ({ r, s }) =>
              `#${r.ticket.id} ${r.ticket.title}: ${s.status}${s.outputs.plan ? `. Plan: ${s.outputs.plan}` : ""}`,
          )
          .join("\n");
        // The last project it worked on, but only one it may work on (the scheduler refuses the rest).
        const recentProject = mine
          .map(({ r }) => r.ticket.project)
          .reverse()
          .find((pr) => !e.projects || e.projects.includes(pr));
        // A chat turn is work a VACUUM or a restart would cut short.
        const out = await daemon.track(
          handleMessage(
            said,
            {
              employee: e,
              engine: d.registry.engine(e.engines.default),
              current: current ? { ...current.r.ticket, assignee: e.id } : null,
              notes,
              defaultProject: recentProject ?? e.projects?.[0] ?? "General",
              companyProjects: d.registry.projects().map((pr) => pr.id),
            },
            d.helper,
            d.chat,
          ),
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
            project: t.project,
            inferred: out.inferred,
            ...(out.ambiguous ? { ambiguous: out.ambiguous } : {}),
            choices: projectChoices(e).includes(t.project)
              ? projectChoices(e)
              : [...projectChoices(e), t.project],
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
        return json({ entries: d.chatLog.thread(e.id), current: currentView((await workOf(e)).current) });
      },
    ],

    [
      "POST",
      "/api/chat/:id/drafts/:ticket",
      async (req, p) => {
        const r = d.tickets.get(p.ticket ?? "");
        if (!r?.hold || r.ticket.assignee !== p.id) return json({ error: "no such draft" }, 404);
        // The owner may change the project before it goes on the board, but only to one of the employee's.
        const raw = await req.text();
        let parsed: unknown = {};
        if (raw.trim() !== "") {
          try {
            parsed = JSON.parse(raw);
          } catch {
            return json({ error: "send a JSON object" }, 400);
          }
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return json({ error: "send a JSON object" }, 400);
        }
        const body = parsed as { project?: unknown };
        const emp = d.registry.employees().find((x) => x.id === p.id);
        let project: string | undefined;
        if (body.project !== undefined && body.project !== null) {
          if (typeof body.project !== "string" || !emp || !projectChoices(emp).includes(body.project)) {
            return json({ error: "that isn't one of this employee's projects" }, 400);
          }
          project = body.project;
        }
        // A draft that named several projects (or one the employee can't use) waits for the owner's pick.
        const entry = d.chatLog
          .thread(p.id ?? "")
          .find((x) => "kind" in x && x.kind === "draft" && x.ticketId === r.ticket.id);
        if (entry && "ambiguous" in entry && entry.ambiguous?.length && project === undefined) {
          return json({ error: "choose a project first" }, 400);
        }
        if (project !== undefined && project !== r.ticket.project) d.tickets.setProject(r.ticket.id, project);
        d.tickets.setHold(r.ticket.id, false);
        d.chatLog.confirm(p.id ?? "", r.ticket.id, project);
        await daemon.tick();
        return json({ ok: true, project: project ?? r.ticket.project });
      },
    ],

    // Conversations (C22): the list, creation and the row-level edits. What happens inside one is AHP, at /ahp.
    [
      "GET",
      "/api/conversations",
      async (req) => {
        if (!d.conversations) return json({ error: "conversations are not enabled" }, 404);
        const q = new URL(req.url).searchParams;
        const archived = q.get("archived");
        const employee = q.get("employee");
        return json({
          conversations: d.conversations.list({
            archived: archived === "all" ? "all" : archived === "true" || archived === "1",
            ...(employee ? { employeeId: employee } : {}),
          }),
        });
      },
    ],

    [
      "GET",
      "/api/conversations/:id",
      async (_req, p) => {
        const c = d.conversations?.get(p.id ?? "");
        return c ? json({ conversation: c }) : json({ error: "no such conversation" }, 404);
      },
    ],

    [
      "POST",
      "/api/conversations",
      async (req) => {
        if (!d.conversations) return json({ error: "conversations are not enabled" }, 404);
        const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (typeof b !== "object" || b === null || Array.isArray(b)) {
          return json({ error: "send a JSON object" }, 400);
        }
        if (typeof b.employeeId !== "string") return json({ error: "employeeId is required" }, 400);
        // A field of the wrong type is an error, not a field that was left out.
        for (const [name, v, nullable] of [
          ["project", b.project, true],
          ["title", b.title, false],
          ["mode", b.mode, false],
          ["engineId", b.engineId, false],
        ] as const) {
          if (v !== undefined && !(typeof v === "string" || (nullable && v === null))) {
            return json({ error: `${name} must be ${nullable ? "a string or null" : "a string"}` }, 400);
          }
        }
        try {
          const conversation = await d.conversations.create({
            employeeId: b.employeeId,
            ...(b.project === null || typeof b.project === "string" ? { project: b.project } : {}),
            ...(typeof b.title === "string" ? { title: b.title } : {}),
            ...(typeof b.mode === "string" ? { mode: b.mode } : {}),
            ...(typeof b.engineId === "string" ? { engineId: b.engineId } : {}),
          });
          return json({ conversation }, 201);
        } catch (e) {
          if (e instanceof ConversationError) return json({ error: e.message }, e.status);
          throw e;
        }
      },
    ],

    [
      "PATCH",
      "/api/conversations/:id",
      async (req, p) => {
        if (!d.conversations) return json({ error: "conversations are not enabled" }, 404);
        const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (typeof b !== "object" || b === null || Array.isArray(b)) {
          return json({ error: "send a JSON object" }, 400);
        }
        try {
          return json({ conversation: d.conversations.update(p.id ?? "", b) });
        } catch (e) {
          if (e instanceof ConversationError) return json({ error: e.message }, e.status);
          throw e;
        }
      },
    ],

    // Shipping a conversation's work (T62b, C22): what it would commit and where it goes, a ticket made
    // from it, or a pull request. All three are refused, with a sentence, for a conversation without a project.
    [
      "GET",
      "/api/conversations/:id/ship",
      async (req, p) => {
        const shipping = d.shipping;
        if (!shipping)
          return json({ error: "GitHub isn't set up yet, so a conversation's work can't be shipped." }, 409);
        const q = new URL(req.url).searchParams;
        const preview = q.get("preview");
        if (preview !== null && preview !== "1") return json({ error: "preview must be 1" }, 400);
        try {
          return json({ ship: await shipping.view(p.id ?? "", { preview: preview === "1" }) });
        } catch (e) {
          return shipFailure(e);
        }
      },
    ],

    [
      "POST",
      "/api/conversations/:id/ticket",
      async (req, p) => {
        const shipping = d.shipping;
        if (!shipping)
          return json({ error: "GitHub isn't set up yet, so a conversation's work can't be shipped." }, 409);
        const body = await readObject(req);
        if (!body) return json({ error: "send a JSON object" }, 400);
        const bad = shipBodyProblem(body, ["title", "description", "doneWhen", "confirmBinary"]);
        if (bad) return json({ error: bad }, 400);
        if (body.doneWhen !== undefined) {
          const w = body.doneWhen;
          if (
            !Array.isArray(w) ||
            w.length < 1 ||
            w.length > 10 ||
            w.some((x) => typeof x !== "string" || !x.trim() || x.length > 300)
          ) {
            return json({ error: "doneWhen is a list of 1 to 10 items, each up to 300 characters" }, 400);
          }
        }
        try {
          const r = await shipping.makeTicket(p.id ?? "", {
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(Array.isArray(body.doneWhen) ? { doneWhen: body.doneWhen as string[] } : {}),
            ...(body.confirmBinary === true ? { confirmBinary: true } : {}),
          });
          return json({ ticket: r.ticket, created: r.created }, r.created ? 201 : 200);
        } catch (e) {
          return shipFailure(e);
        }
      },
    ],

    [
      "POST",
      "/api/conversations/:id/pr",
      async (req, p) => {
        const shipping = d.shipping;
        if (!shipping)
          return json({ error: "GitHub isn't set up yet, so a conversation's work can't be shipped." }, 409);
        const body = await readObject(req);
        if (!body) return json({ error: "send a JSON object" }, 400);
        const bad = shipBodyProblem(body, ["title", "body", "confirmBinary"]);
        if (bad) return json({ error: bad }, 400);
        try {
          const r = await shipping.openPr(p.id ?? "", {
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.body === "string" ? { body: body.body } : {}),
            ...(body.confirmBinary === true ? { confirmBinary: true } : {}),
          });
          return json({ pr: r.pr, created: r.created }, r.created ? 201 : 200);
        } catch (e) {
          return shipFailure(e);
        }
      },
    ],

    [
      "POST",
      "/api/conversations/:id/take-back",
      async (req, p) => {
        const shipping = d.shipping;
        if (!shipping) {
          return json({ error: "GitHub isn't set up yet, so a conversation's work can't be shipped." }, 409);
        }
        const body = await readObject(req);
        if (!body) return json({ error: "send a JSON object" }, 400);
        const bad = shipBodyProblem(body, []);
        if (bad) return json({ error: bad }, 400);
        if (!d.conversations?.get(p.id ?? "")) return json({ error: "There is no such conversation." }, 404);
        try {
          return json({ ok: true, ...(await shipping.takeBack(p.id ?? "")) });
        } catch (e) {
          return shipFailure(e);
        }
      },
    ],

    ["GET", "/api/employees", async () => json({ employees: d.registry.employees() })],

    [
      "POST",
      "/api/employees",
      async (req) => {
        const body = (await req.json()) as Partial<Employee> & { teamId?: unknown };
        const teams = d.registry.teams();
        let teamId: string | undefined;
        // A PA (home data) always works in a team of its own: the web form sends none, and a team that
        // is named but has other members is not an error the form could avoid, so it is replaced by a
        // home team (an empty named team is used as it is).
        let ownTeam = false;
        const wantsHome = isHomeEmployee({ role: body.role ?? "" });
        if (body.teamId !== undefined) {
          if (typeof body.teamId !== "string" || !teams.some((team) => team.id === body.teamId)) {
            return json({ error: "teamId must name an existing team" }, 400);
          }
          teamId = body.teamId;
        } else if (wantsHome) {
          ownTeam = true;
        } else {
          // A PA's home team is nobody else's: it is not "the only team" to be hired into.
          const open = teams.filter((t) => !holdsHome(t));
          if (open.length === 1) teamId = open[0]?.id;
          else if (open.length > 1) return json({ error: "choose a team before hiring" }, 400);
        }
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
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          ...(body.projects ? { projects: body.projects } : {}),
          ...(body.standingOrders ? { standingOrders: body.standingOrders } : {}),
          ...(body.workingHours ? { workingHours: body.workingHours } : {}),
          ...(body.outbound ? { outbound: body.outbound } : {}),
        };
        const problems = hiringProblems(hire, d.registry.engines(), d.registry.employees());
        if (problems.length) return json({ error: problems.join("; "), problems }, 400);
        if (teamId && isHomeEmployee(hire) && membersOf(teamId).length > 0) {
          teamId = undefined;
          ownTeam = true;
        }
        if (teamId) {
          const team = d.registry.teams().find((t) => t.id === teamId);
          const crowd = sharedHomeProblems(team?.name ?? teamId, [...membersOf(teamId), hire]);
          if (crowd.length) return json({ error: crowd.join("; "), problems: crowd }, 400);
        }
        let madeTeam: string | undefined;
        if (ownTeam) {
          const home = homeTeamFor(hire);
          teamId = home.id;
          if (home.made) madeTeam = home.id;
        }
        try {
          if (teamId) d.registry.saveEmployeeInTeam(hire, teamId);
          else d.registry.hire(hire);
        } catch (err) {
          // A hire that failed leaves no empty home team behind.
          if (madeTeam) d.registry.removeTeam(madeTeam);
          throw err;
        }
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
        const b = (await req.json()) as Partial<Employee> & { teamId?: unknown };
        if (b.teamId !== undefined) {
          if (typeof b.teamId !== "string" || !d.registry.teams().some((team) => team.id === b.teamId)) {
            return json({ error: "teamId must name an existing team" }, 400);
          }
        }
        const updated: Employee = {
          ...existing,
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.role !== undefined ? { role: b.role } : {}),
          ...(b.duties !== undefined ? { duties: b.duties } : {}),
          ...(b.engines !== undefined ? { engines: b.engines } : {}),
          ...(b.switchRules !== undefined ? { switchRules: b.switchRules } : {}),
          ...(b.prompt !== undefined ? { prompt: b.prompt } : {}),
          ...(b.effort !== undefined ? { effort: b.effort } : {}),
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
        // Where the employee will work: the team named, or (for a change of role into a home-data role)
        // the one it is in now. A PA never shares a sandbox with anyone: a PA whose team is, or would
        // be, shared is moved to a team of its own rather than refused (the web form can't avoid that);
        // anyone else put into a PA's team is refused.
        const target =
          typeof b.teamId === "string"
            ? b.teamId
            : b.role !== undefined && isHomeEmployee(updated) && !isHomeEmployee(existing)
              ? d.registry.teamOf(id).id
              : undefined;
        let moveTo: string | undefined;
        if (target !== undefined) {
          const named = d.registry.teams().find((t) => t.id === target);
          const others = (
            named ? membersOf(target) : d.registry.machineMates(id).map((m) => d.registry.employee(m))
          ).filter((m) => m.id !== id);
          if (isHomeEmployee(updated) && others.length > 0) {
            moveTo = homeTeamFor(updated).id;
          } else {
            const crowd = sharedHomeProblems(named?.name ?? "The company's sandbox", [...others, updated]);
            if (crowd.length) return json({ error: crowd.join("; "), problems: crowd }, 400);
          }
        }
        if (moveTo) d.registry.saveEmployeeInTeam(updated, moveTo);
        else if (typeof b.teamId === "string") d.registry.saveEmployeeInTeam(updated, b.teamId);
        else d.registry.hire(updated);
        if (b.prompt !== undefined || b.role !== undefined || b.name !== undefined) {
          d.knowledge.updatePersonality(id, updated.name, updated.role, updated.prompt);
        }
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
        const now = d.clock.now();
        const offset = d.registry.settings().utcOffsetMinutes;
        const localHour = new Date(now + offset * 60_000).getUTCHours();
        const accounts = enrichAccounts(d.registry.accounts(), d.registry, d.db, now);
        const rateLimits = allRateLimits(accounts, d.registry, now);
        return json({
          employees: officeView(d.registry.employees(), all, states, d.registry, localHour),
          accounts,
          rateLimits,
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

    ["GET", "/api/deploys", async () => json({ deploys: readDeploys(opts.deploysPath, 20) })],

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
        const upload = await readTicket(req);
        if ("error" in upload) return json({ error: upload.error }, upload.status);
        const { body, images } = upload;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return json({ error: "the ticket must be a JSON object" }, 400);
        }
        // `createdBy` marks a ticket an agent filed itself, and the accepted-proposal label keeps a
        // ticket out of the daily follow-up count. Only the daemon's own paths set them, never a client.
        delete body.createdBy;
        if (body.labels !== undefined) {
          if (!Array.isArray(body.labels) || body.labels.some((l) => typeof l !== "string")) {
            return json({ error: "labels must be a list of strings" }, 400);
          }
          body.labels = body.labels.filter((l) => l !== ACCEPTED_LABEL);
        }
        if (!body.effort && body.assignee) {
          try {
            const emp = d.registry.employee(body.assignee);
            if (emp.effort) body.effort = emp.effort;
          } catch {}
        }
        const problem = validate(body);
        if (problem) return json({ error: problem }, 400);
        const ticket = d.tickets.create(body, d.clock.now(), images);
        await daemon.tick();
        return json({ ticket }, 201);
      },
    ],

    // C20: follow-ups that went over the daily budget wait here for the owner.
    [
      "GET",
      "/api/proposals",
      async (req) => {
        const status = new URL(req.url).searchParams.get("status");
        if (status !== null && !["open", "accepted", "declined"].includes(status)) {
          return json({ error: "status must be open, accepted or declined" }, 400);
        }
        const list = d.proposals.list((status as ProposalStatus | null) ?? undefined);
        return json({ proposals: list.map((p) => proposalView(p, d.registry)) });
      },
    ],
    [
      "POST",
      "/api/proposals/:id/accept",
      async (req, p) => {
        const body = await readObject(req);
        if (!body) return json({ error: "the body must be a JSON object" }, 400);
        if (body.assignee !== undefined && (typeof body.assignee !== "string" || !body.assignee.trim())) {
          return json({ error: "assignee must be an employee id" }, 400);
        }
        const found = proposalFor(p.id);
        if (!found) return json({ error: "no such proposal" }, 404);
        if (found.status !== "open")
          return json({ error: `proposal ${found.id} is already ${found.status}` }, 409);
        if (!d.registry.project(found.project)) {
          return json(
            {
              error: `${found.project} isn't a project any more, so this can't be filed; decline it instead`,
            },
            409,
          );
        }
        let assignee: Id;
        if (typeof body.assignee === "string") {
          let employee: Employee;
          try {
            employee = d.registry.employee(body.assignee);
          } catch {
            return json({ error: `no employee ${body.assignee}` }, 400);
          }
          if (employee.projects && !employee.projects.includes(found.project)) {
            return json({ error: `${employee.name} doesn't work on ${found.project}` }, 409);
          }
          assignee = employee.id;
        } else {
          assignee = usualAssignee(found.proposedBy, found.project);
        }
        // Claim it first, so of two accepts at once only one files a ticket.
        const now = d.clock.now();
        if (!d.proposals.decide(found.id, "accepted", now)) {
          const cur = d.proposals.get(found.id);
          return json({ error: `proposal ${found.id} is already ${cur?.status ?? "decided"}` }, 409);
        }
        let ticket: ReturnType<typeof d.tickets.create>;
        try {
          // The label keeps it out of the daily follow-up count: accepting was the owner's call.
          ticket = d.tickets.create(
            {
              title: found.title,
              project: found.project,
              type: found.type,
              effort: found.effort,
              doneWhen: found.doneWhen,
              ...(assignee ? { assignee } : {}),
              createdBy: found.proposedBy,
              ...(found.body && found.body !== RECOVERED_BODY ? { reason: found.body } : {}),
              labels: ["follow-up", ACCEPTED_LABEL],
            },
            now,
          );
        } catch (e) {
          d.proposals.reopen(found.id);
          return json({ error: String(e instanceof Error ? e.message : e) }, 500);
        }
        d.proposals.setTicket(found.id, ticket.id);
        d.log?.(`proposal ${found.id} accepted as ticket ${ticket.id}: ${found.title}`);
        await daemon.tick();
        const proposal = d.proposals.get(found.id) as NonNullable<ReturnType<typeof d.proposals.get>>;
        return json({ proposal: proposalView(proposal, d.registry), ticket }, 201);
      },
    ],
    [
      "POST",
      "/api/proposals/:id/decline",
      async (req, p) => {
        const body = await readObject(req);
        if (!body) return json({ error: "the body must be a JSON object" }, 400);
        const found = proposalFor(p.id);
        if (!found) return json({ error: "no such proposal" }, 404);
        if (!d.proposals.decide(found.id, "declined", d.clock.now())) {
          const cur = d.proposals.get(found.id);
          return json({ error: `proposal ${found.id} is already ${cur?.status ?? "decided"}` }, 409);
        }
        d.log?.(`proposal ${found.id} declined: ${found.title}`);
        const proposal = d.proposals.get(found.id) as NonNullable<ReturnType<typeof d.proposals.get>>;
        return json({ proposal: proposalView(proposal, d.registry) });
      },
    ],

    [
      "POST",
      "/api/tickets/:id/attachments",
      async (req, p) => {
        const r = d.tickets.get(p.id ?? "");
        if (!r) return json({ error: "no such ticket" }, 404);
        if ((await daemon.state(r.ticket.id)).status === "done") {
          return json({ error: `ticket ${r.ticket.id} is done` }, 409);
        }
        const upload = await readUpload(req);
        if ("error" in upload) return json({ error: upload.error }, upload.status);
        const images = await readImages(upload.form);
        if ("error" in images) return json({ error: images.error }, images.status);
        if (!images.length) return json({ error: "add at least one image" }, 400);
        const problem = roomFor(r.ticket.id, images.length);
        if (problem) return json({ error: problem }, 400);
        const attachments = await attachImages(r.ticket.id, images);
        await daemon.tick();
        return json({ attachments }, 201);
      },
    ],

    [
      "GET",
      "/api/tickets/:id/attachments/:n",
      async (_, p) => {
        const n = Number(p.n);
        const [file] = Number.isInteger(n) && n > 0 ? d.tickets.attachments(p.id ?? "", n) : [];
        if (!file) return json({ error: "no such image" }, 404);
        return new Response(file.data, {
          headers: {
            "content-type": file.mime,
            "content-length": String(file.size),
            "x-content-type-options": "nosniff",
            // The name is already letters, digits, dots, dashes and underscores (tickets.ts).
            "content-disposition": `inline; filename="${file.name}"`,
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, max-age=86400",
          },
        });
      },
    ],

    [
      "GET",
      "/api/tickets/:id",
      async (_, p) => {
        const r = d.tickets.get(p.id ?? "");
        if (!r) return json({ error: "no such ticket" }, 404);
        const events = await d.store.read(r.ticket.id);
        const wait = daemon.waiting.find((w) => w.ticketId === r.ticket.id);
        const view = ticketView(
          r,
          await daemon.state(r.ticket.id),
          events,
          d.registry,
          wait?.reason ?? null,
          daemon.waitingUntil[r.ticket.id] ?? null,
        );
        if (view.fromConversation) {
          view.fromConversation.title = d.conversations?.get(view.fromConversation.id)?.title ?? null;
        }
        return json({ ticket: view, events });
      },
    ],

    [
      "GET",
      "/api/tickets/:id/sessions",
      async (_, p) => {
        const r = d.tickets.get(p.id ?? "");
        if (!r) return json({ error: "no such ticket" }, 404);
        return json({ sessions: d.sessions.list(p.id ?? "") });
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
        type Body = { decision: "approve" | "changes" | "reject"; note?: string };
        // "Not quite" may come with images, as a `decision` JSON field and `image` files.
        let body: Body;
        let images: NewAttachment[] = [];
        if (isMultipart(req)) {
          const upload = await readUpload(req);
          if ("error" in upload) return json({ error: upload.error }, upload.status);
          const raw = upload.form.get("decision");
          try {
            body = JSON.parse(typeof raw === "string" ? raw : "") as Body;
          } catch {
            return json({ error: "the decision field must be JSON" }, 400);
          }
          const read = await readImages(upload.form);
          if ("error" in read) return json({ error: read.error }, read.status);
          images = read;
          if (images.length && body.decision !== "changes") {
            return json({ error: "images go with a request for changes" }, 400);
          }
          const problem = d.tickets.get(p.id ?? "") ? roomFor(p.id ?? "", images.length) : null;
          if (problem) return json({ error: problem }, 400);
        } else {
          body = (await req.json()) as Body;
        }
        return act(p.id, "ready", async () => {
          // The images come first, so the Build session that follows the decision has them.
          if (images.length) await attachImages(p.id ?? "", images);
          await decide(ports, p.id ?? "", body.decision, body.note);
        });
      },
    ],

    [
      "POST",
      "/api/tickets/:id/retry",
      async (_req, p) =>
        act(p.id, null, async () => {
          // A failed ticket made from a conversation takes the conversation's working copy back first.
          if ((await daemon.state(p.id ?? "")).status === "failed") await d.shipping?.reclaim(p.id ?? "");
          await retry(ports, p.id ?? "");
        }),
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
        // A ticket nobody has started has no work to hand over: it is assigned, which is what the
        // scheduler reads (a "reassigned" event on a ticket that never ran changes nothing).
        const r = d.tickets.get(p.id ?? "");
        if (r && !(await daemon.state(r.ticket.id)).created) return assignUnstarted(r.ticket.id, to);
        return act(p.id, null, () => handOff(ports, p.id ?? "", to));
      },
    ],

    // C17: the owner picks who does a ticket that hasn't started (the one the scheduler can't place).
    [
      "POST",
      "/api/tickets/:id/assign",
      async (req, p) => {
        const { to } = (await req.json()) as { to?: Id };
        if (!d.tickets.get(p.id ?? "")) return json({ error: "no such ticket" }, 404);
        return assignUnstarted(p.id ?? "", to);
      },
    ],

    // C19: the brain's search index, read-only (docs/design/brain.md). Owner-only like every route.
    [
      "GET",
      "/api/brain/search",
      async (req) => {
        d.brain.refresh(); // a repo changed behind the daemon's back (the migration) shows at once
        const url = new URL(req.url);
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return json({ error: "q is required" }, 400);
        const scopes = scopesParam(url.searchParams.get("scope"));
        if (scopes instanceof Response) return scopes;
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        const results = d.brain.search(buildQuery(q), scopes, limit).map((h) => ({
          scope: h.scope,
          slug: h.slug,
          title: h.title,
          description: h.description,
          snippet: h.snippet,
          updated: h.updated,
        }));
        return json({ results });
      },
    ],
    [
      "GET",
      "/api/brain/map",
      async (req) => {
        d.brain.refresh();
        const url = new URL(req.url);
        const scope = url.searchParams.get("scope");
        if (!scope || scope === "all") return json({ error: "scope is required" }, 400);
        const scopes = scopesParam(scope);
        if (scopes instanceof Response) return scopes;
        const built = d.brain.mapFor(scopes[0] as Scope);
        const section = url.searchParams.get("section");
        if (section === null) {
          return json({ scope, lines: built.root, sections: Object.keys(built.sections) });
        }
        const lines = Object.hasOwn(built.sections, section) ? built.sections[section] : undefined;
        if (!lines) return json({ error: "no such section" }, 404);
        return json({ scope, section, lines, sections: Object.keys(built.sections) });
      },
    ],

    // C19 (T58): the Brain changes feed. Every change the daemon collected from an agent's brain copy,
    // committed or refused, newest first, and the owner's one-click undo.
    [
      "GET",
      "/api/brain/changes",
      async (req) => {
        const url = new URL(req.url);
        const scope = url.searchParams.get("scope") ?? "";
        if (scope && (scope === "all" || !parseScope(scope))) {
          return json({ error: "scope must be company, team:<id> or brain:<id>" }, 400);
        }
        const employee = url.searchParams.get("employee") ?? "";
        if (employee && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(employee)) {
          return json({ error: "employee must be an employee id" }, 400);
        }
        const status = url.searchParams.get("status") ?? "";
        if (status && status !== "committed" && status !== "rejected") {
          return json({ error: "status must be committed or rejected" }, 400);
        }
        const before = url.searchParams.get("before");
        if (before !== null && !/^\d{1,12}$/.test(before))
          return json({ error: "before must be an entry id" }, 400);
        const page = d.brainHarvest.feedPage({
          ...(scope ? { scope } : {}),
          ...(employee ? { employee } : {}),
          ...(status ? { status: status as "committed" | "rejected" } : {}),
          ...(before !== null ? { before: Number(before) } : {}),
          limit: Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50)),
        });
        const names = new Map(d.registry.employees().map((e) => [e.id, e.name]));
        const who = (id: string) => ({ id, name: names.get(id) ?? id });
        return json({
          changes: page.changes.map((c) => changeView(c, who)),
          next: page.next,
          facets: { scopes: page.facets.scopes, employees: page.facets.employees.map(who) },
        });
      },
    ],
    [
      "POST",
      "/api/brain/changes/:id/revert",
      async (_req, p) => {
        const id = p.id ?? "";
        if (!/^\d{1,12}$/.test(id)) return json({ error: "no such change" }, 404);
        try {
          const change = d.brainHarvest.revert(Number(id));
          d.brain.refresh();
          return json({ change: changeView(change, (id) => ({ id, name: nameOf(id) })) });
        } catch (e) {
          if (e instanceof RevertError) return json({ error: e.message }, e.status);
          throw e;
        }
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

  /** A `scope` query value as the scopes to search: all of them, or one that exists. */
  function scopesParam(raw: string | null): Scope[] | Response {
    if (raw === null || raw === "" || raw === "all") return d.brain.scopes();
    const parsed = parseScope(raw);
    if (!parsed) return json({ error: "scope must be all, company, team:<id> or brain:<id>" }, 400);
    if (parsed.kind === "brain" && !d.registry.employees().some((e) => e.id === parsed.id)) {
      return json({ error: "no such brain" }, 404);
    }
    if (parsed.kind === "team" && !d.registry.teams().some((t) => t.id === parsed.id)) {
      return json({ error: "no such team" }, 404);
    }
    return [raw as Scope];
  }

  function repoOf(key: string): Repo | null {
    if (key === "handbook") return { kind: "handbook" };
    const id = key.startsWith("brain:") ? key.slice(6) : null;
    return id && d.registry.employees().some((e) => e.id === id) ? { kind: "brain", id } : null;
  }

  /** The employee's tickets, oldest first, and the one it is on now (running, paused or waiting on the owner). */
  async function workOf(e: Employee) {
    const mine = [];
    for (const r of d.tickets.all()) {
      const s = fold(await d.store.read(r.ticket.id));
      if ((s.assignee ?? r.ticket.assignee) === e.id) mine.push({ r, s });
    }
    const current = mine.find(({ s }) => s.created && ["running", "paused", "needs-you"].includes(s.status));
    return { mine, current };
  }

  /** What the chat composer needs to know about the current ticket: where images would go, and the room left. */
  function currentView(c: Awaited<ReturnType<typeof workOf>>["current"]) {
    if (!c) return null;
    const { id, title, attachments } = c.r.ticket;
    return { id, title, images: attachments?.length ?? 0 };
  }

  /**
   * A chat message with images (#16). The composer said which ticket they're for, so it skips the
   * helper and goes to that ticket as a note, the same way "Add images" and a note each would.
   */
  async function imageNote(
    e: Employee,
    current: Awaited<ReturnType<typeof workOf>>["current"],
    m: { said: string; urgent: boolean; ticket: Id | undefined; images: NewAttachment[] },
  ): Promise<Response> {
    if (!current || current.r.ticket.id !== m.ticket) {
      const error = current
        ? `${e.name} is on #${current.r.ticket.id} now, not #${m.ticket ?? "?"}`
        : `${e.name} isn't on a ticket now`;
      return json({ error, current: currentView(current) }, 409);
    }
    const id = current.r.ticket.id;
    const problem = roomFor(id, m.images.length);
    if (problem) return json({ error: problem }, 400);
    // The images come first, so a session that starts on the note has them.
    const attachments = await attachImages(id, m.images);
    const at = d.clock.now();
    d.chatLog.add(e.id, {
      from: "owner",
      at,
      text: m.said,
      ...(m.urgent ? { urgent: true } : {}),
      images: { ticketId: id, ns: attachments.map((a) => a.n) },
    });
    if (m.said) {
      await d.store.append(id, [
        m.urgent
          ? { type: "owner-message", at, text: m.said, urgent: true }
          : { type: "owner-message", at, text: m.said },
      ]);
    }
    const stopped = m.urgent && daemon.interrupt(id, e.id);
    const these = attachments.length === 1 ? "the image" : `the ${attachments.length} images`;
    d.chatLog.add(e.id, {
      from: "system",
      at,
      text: stopped
        ? `${e.name} stopped to read this, and carries on from there.`
        : m.urgent || !m.said
          ? `${e.name} will see ${m.said ? `this and ${these}` : these} when their next session starts.`
          : `${e.name} will see ${these} when their next session starts, and this at the next stage boundary.`,
    });
    return json({ entries: d.chatLog.thread(e.id), current: currentView((await workOf(e)).current) });
  }

  /** Why a ticket can't take `count` more images, or null when it can. */
  function roomFor(id: Id, count: number): string | null {
    const has = d.tickets.get(id)?.ticket.attachments?.length ?? 0;
    return has + count > imageLimits.perTicket
      ? `a ticket takes at most ${imageLimits.perTicket} images, and this one has ${has}`
      : null;
  }

  /**
   * Stores images for a ticket that exists, and records them in its events, so a run that's under
   * way copies them into the worktree before its next session.
   */
  async function attachImages(id: Id, images: NewAttachment[]) {
    const at = d.clock.now();
    const attachments = d.tickets.attach(id, images, at);
    await d.store.append(id, [{ type: "owner-attached", at, attachments }]);
    return attachments;
  }

  /** A proposal by its URL id (whole numbers only), or undefined. */
  function proposalFor(id: string | undefined) {
    return id !== undefined && /^[1-9][0-9]{0,15}$/.test(id) ? d.proposals.get(Number(id)) : undefined;
  }

  /**
   * Who does an accepted proposal, by the same rule as assigning a ticket (C17): the agent who
   * proposed it if they work on the project, else whoever usually builds there. Empty if nobody does.
   */
  function usualAssignee(proposer: Id, project: string): Id {
    try {
      const e = d.registry.employee(proposer);
      if (!e.projects || e.projects.includes(project)) return e.id;
    } catch {}
    const stub: Ticket = {
      id: "",
      title: "",
      project,
      type: "chore",
      effort: "medium",
      doneWhen: [],
      assignee: "",
    };
    return d.registry.pickEmployee("build", stub, [])?.id ?? "";
  }

  /** Appends the owner's action if the ticket is in the right state, then runs the ticket on. */
  /** Assigns a ticket that has not started (C17) and lets the scheduler start it. */
  async function assignUnstarted(id: Id, to: Id | undefined): Promise<Response> {
    const r = d.tickets.get(id);
    if (!r) return json({ error: "no such ticket" }, 404);
    let employee: Employee;
    try {
      employee = d.registry.employee(to ?? "");
    } catch {
      return json({ error: `no employee ${to ?? ""}`.trim() }, 400);
    }
    if ((await daemon.state(id)).created) {
      return json({ error: `ticket ${id} already started — use handoff` }, 409);
    }
    if (employee.projects && !employee.projects.includes(r.ticket.project)) {
      return json({ error: `${employee.name} doesn't work on ${r.ticket.project}` }, 409);
    }
    d.tickets.assign(id, employee.id, null);
    await daemon.tick();
    const fresh = d.tickets.get(id) as NonNullable<ReturnType<typeof d.tickets.get>>;
    const wait = daemon.waiting.find((w) => w.ticketId === id);
    return json({
      ok: true,
      ticket: ticketView(
        fresh,
        await daemon.state(id),
        await d.store.read(id),
        d.registry,
        wait?.reason ?? null,
        daemon.waitingUntil[id] ?? null,
      ),
    });
  }

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
    // The deployer polls this without a login. It says nothing but the release's sha, whether work is
    // running, and when it started; the Host check below still applies.
    const healthCheck = req.method === "GET" && path === "/api/health";
    const signup = req.method === "POST" && path === "/api/signup";
    const login = req.method === "POST" && path === "/api/login";
    const logout = req.method === "POST" && path === "/api/logout";
    if (
      opts.token &&
      !authStatus &&
      !healthCheck &&
      !signup &&
      !login &&
      !logout &&
      !authorized(req, opts.token)
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    const host = req.headers.get("host") ?? "";
    if (!hostAllowed(opts.hosts, host)) return json({ error: `not served as ${host}` }, 421);
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (!originAllowed(opts.hosts, req.headers.get("origin"))) {
        return json({ error: "cross-site request refused" }, 403);
      }
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json") && !isUpload(req, path)) {
        return json({ error: "writes must be application/json" }, 415);
      }
    }
    if (authStatus) {
      return json({ initialized: getOwner() !== undefined });
    }
    if (healthCheck) {
      return json({ ok: true, version: opts.version ?? "unknown", busy: daemon.busy(), startedAt });
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
      // A restart would cut these short, so the deployer waits for them (GET /api/health, busy).
      if (params)
        return longRunning.has(`${method} ${pattern}`)
          ? daemon.track(handler(req, params))
          : handler(req, params);
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

function safeDecodeURIComponent(str: string): string | null {
  try {
    return decodeURIComponent(str);
  } catch {
    return null;
  }
}

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/");
  const b = path.split("/");
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = a[i] ?? "";
    if (seg.startsWith(":")) {
      const decoded = safeDecodeURIComponent(b[i] ?? "");
      if (decoded === null) return null;
      params[seg.slice(1)] = decoded;
    } else if (seg !== b[i]) return null;
  }
  return params;
}

/** The images a ticket may carry: `count` per request (#12), `perTicket` in all (#15). */
export const imageLimits = { count: 6, bytes: 10 * 1024 * 1024, perTicket: 24 };

/** The paths that take images: a new ticket, more for one, a "Not quite" reply, and a chat message. */
const uploadPaths = /^\/api\/(?:tickets(?:\/[A-Za-z0-9_-]+\/(?:attachments|decide))?|chat\/[A-Za-z0-9_-]+)$/;

const isMultipart = (req: Request) =>
  (req.headers.get("content-type") ?? "").startsWith("multipart/form-data");

/**
 * Images come as multipart/form-data, which another site could send without a CORS preflight. So
 * they must also carry the `x-i-inc-upload` header, which no other site can add without a
 * preflight, and none is ever allowed: the JSON-only wall holds.
 */
function isUpload(req: Request, path: string): boolean {
  return (
    req.method === "POST" &&
    uploadPaths.test(path) &&
    isMultipart(req) &&
    req.headers.get("x-i-inc-upload") === "1"
  );
}

export { sniffImage };

type Refused = { error: string; status: number };

/** A multipart upload's form, refused early when it's bigger than the images it may carry. */
async function readUpload(req: Request): Promise<{ form: FormData } | Refused> {
  if (!isMultipart(req)) return { error: "send images as multipart/form-data", status: 400 };
  const max = imageLimits.count * imageLimits.bytes + 1024 * 1024;
  if (Number(req.headers.get("content-length") ?? 0) > max) {
    return { error: `at most ${imageLimits.count} images of 10 MB each`, status: 413 };
  }
  try {
    return { form: await req.formData() };
  } catch {
    return { error: "couldn't read the upload", status: 400 };
  }
}

/** A form's `image` files, each checked by its bytes. Every path that takes images checks them here. */
async function readImages(form: FormData): Promise<NewAttachment[] | Refused> {
  const files = form.getAll("image");
  if (files.length > imageLimits.count) {
    return { error: `at most ${imageLimits.count} images at a time`, status: 400 };
  }
  const images: NewAttachment[] = [];
  for (const f of files) {
    if (typeof f === "string") return { error: "each image must be a file", status: 400 };
    if (f.size > imageLimits.bytes) return { error: `${f.name || "an image"} is over 10 MB`, status: 400 };
    const data = new Uint8Array(await f.arrayBuffer());
    const mime = sniffImage(data);
    if (!mime) return { error: `${f.name || "an image"} isn't a PNG, JPEG, WebP or GIF`, status: 400 };
    images.push({ name: f.name, mime, data });
  }
  return images;
}

/** A chat message as JSON, or as a `message` JSON field (naming the ticket) and up to six `image` files. */
async function readMessage(
  req: Request,
): Promise<{ text?: string; urgent: boolean; ticket?: Id; images: NewAttachment[] } | Refused> {
  type Body = { text?: unknown; urgent?: unknown; ticket?: unknown };
  let body: Body;
  let images: NewAttachment[] = [];
  if (isMultipart(req)) {
    const upload = await readUpload(req);
    if ("error" in upload) return upload;
    const raw = upload.form.get("message");
    try {
      body = JSON.parse(typeof raw === "string" ? raw : "") as Body;
    } catch {
      return { error: "the message field must be JSON", status: 400 };
    }
    const read = await readImages(upload.form);
    if ("error" in read) return read;
    images = read;
  } else {
    body = (await req.json()) as Body;
  }
  if (typeof body !== "object" || body === null) return { error: "send a JSON object", status: 400 };
  return {
    ...(typeof body.text === "string" ? { text: body.text } : {}),
    urgent: body.urgent === true,
    ...(typeof body.ticket === "string" ? { ticket: body.ticket } : {}),
    images,
  };
}

/** A new ticket as JSON, or as a `ticket` JSON field and up to six `image` files. */
async function readTicket(req: Request): Promise<{ body: NewTicket; images: NewAttachment[] } | Refused> {
  if (!isMultipart(req)) return { body: (await req.json()) as NewTicket, images: [] };
  const upload = await readUpload(req);
  if ("error" in upload) return upload;
  const raw = upload.form.get("ticket");
  if (typeof raw !== "string") return { error: "the upload needs a ticket field", status: 400 };
  let body: NewTicket;
  try {
    body = JSON.parse(raw) as NewTicket;
  } catch {
    return { error: "the ticket field must be JSON", status: 400 };
  }
  const images = await readImages(upload.form);
  if ("error" in images) return images;
  return { body, images };
}

/** A JSON object body (an empty body counts as `{}`), or null when it's anything else. */
async function readObject(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => null);
  if (text === null) return null;
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

/** A body with a field this route doesn't take is a mistake, not something to ignore. */
function shipBodyProblem(body: Record<string, unknown>, allowed: string[]): string | null {
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  if (extra) return `${extra} isn't something this takes (it takes ${allowed.join(", ")})`;
  for (const k of allowed) {
    const v = body[k];
    if (k === "confirmBinary") {
      if (v !== undefined && typeof v !== "boolean") return "confirmBinary must be true or false";
      continue;
    }
    if (k !== "doneWhen" && v !== undefined && typeof v !== "string") return `${k} must be text`;
    if (
      (k === "title" || k === "body" || k === "description") &&
      typeof v === "string" &&
      v.length > (k === "title" ? 200 : 6000)
    ) {
      return `${k} is too long`;
    }
    if (k === "title" && typeof v === "string" && !v.trim()) return "a title can't be empty";
  }
  return null;
}

/** A shipping refusal as the owner sees it: a sentence, a code, and the status that fits. */
function shipFailure(e: unknown): Response {
  if (e instanceof ShipError) return json({ error: e.message, code: e.code, ...e.extra }, e.status);
  throw e;
}

/** A Brain changes feed entry as the API shows it: the same from the list and from a revert. */
function changeView(c: BrainChange, who: (id: string) => { id: string; name: string }) {
  return {
    ...c,
    employee: who(c.employee),
    source: {
      ...c.source,
      url: c.source.kind === "ticket" ? `#/ticket/${c.source.id}` : `#/conversations/${c.source.id}`,
    },
  };
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
