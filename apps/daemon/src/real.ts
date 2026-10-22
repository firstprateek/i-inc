// Real mode's ports. Each team works in one shared sandbox (inc-<team>), signed in once to its
// subscriptions (decided 2026-10-17): ACP sessions run there, the harness runs each project's recipe
// there, and the workspace makes a branch per ticket there. In direct mode (the default) reviewed work
// goes straight to main; owner-merges projects get a draft PR. The daemon keeps each sandbox signed in
// to GitHub as the bot, so sessions of any length can push. Claude's usage reports land in the
// registry. The helper model and chat use Ollama on the host.
import { type Employee, type Id, isHomeEmployee } from "@i-inc/core";
import { AcpAgent, type Launch } from "./acp.ts";
import type { AgentBackend } from "./ahp/backend.ts";
import { agentsFromRegistry } from "./ahp/conversations.ts";
import { SessionHost } from "./ahp/session-host.ts";
import type { AppOptions } from "./app.ts";
import type { BrainFeed } from "./brain-feed.ts";
import type { BrainHarvest } from "./brain-harvest.ts";
import { type Credentials, credentialsFor } from "./config.ts";
import { EgressWall } from "./egress-wall.ts";
import { commitIdentity, PullRequests, type TokenSource, waitForCi } from "./github.ts";
import { MachineHarness, machineScript, type RunScript } from "./harness.ts";
import {
  AppleMachines,
  convDir,
  defaultMachineSettings,
  type Exec,
  type MachineSettings,
  machineLaunch,
  machineOf,
  workDir,
} from "./machines.ts";
import { OllamaChat, OllamaHelper, type OllamaOptions } from "./ollama.ts";
import { type Reap, reaper, reapMachines } from "./reaper.ts";
import type { Registry } from "./registry.ts";
import { conversationShip, type ShipPort } from "./ship-git.ts";
import type { Tickets } from "./tickets.ts";
import { timeoutsMs } from "./timeouts.ts";
import { GitHubWorkspace, prepareConversationCopy, removeCopyScript } from "./workspace.ts";

export interface RealOptions {
  credentials: Credentials;
  /** The GitHub App (or a stand-in token), and its slug for the bot's commit address. */
  github?: { tokens: TokenSource; slug: string; prs?: PullRequests };
  machine?: MachineSettings;
  log?: (msg: string) => void;
  now?: () => number;
  /** Stand-ins for the `container` CLI, for tests. */
  exec?: Exec;
  launch?: Launch;
  runScript?: RunScript;
  /** Whether a machine is running; default: ask `container machine ls`. For tests. */
  isUp?: (machine: string) => Promise<boolean>;
  ollama?: OllamaOptions;
  /** Stand-ins for GitHub, for tests and the end-to-end run: the bot's commit address, and CI on a pushed commit. */
  identity?: (employee: Employee) => Promise<{ name: string; email: string }>;
  ci?: (repo: string, sha: string, branch: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** What the employee image has (images/employee/Dockerfile), for briefs. */
const machine =
  "Your machine runs Ubuntu 24.04. You're the user employee, with passwordless sudo (except in a personal assistant's sandbox, which has no sudo and no internet). It has Node 24, pnpm 10, git, gh and Docker; install anything else you need. Other agents on your team share it: run servers only on the ports in $I_INC_PORTS.";

/** A ticket's own range of 100 ports, so agents sharing a sandbox don't take each other's. */
export function portsFor(ticketId: Id): string {
  let h = 0;
  for (const ch of ticketId) h = (h * 31 + ch.charCodeAt(0)) % 400;
  const base = 20_000 + h * 100;
  return `${base}-${base + 99}`;
}

/** How often a sandbox's GitHub sign-in is renewed; the bot's tokens last an hour. */
const loginEveryMs = 25 * 60_000;

export function realPorts(o: RealOptions): Pick<
  AppOptions,
  "machines" | "agent" | "harness" | "workspace" | "tokens" | "helper" | "chat" | "ahpBackend" | "ship"
> & {
  /** Renews the GitHub sign-in of every sandbox in use. main.ts calls it on a timer. */
  keepLoginsFresh: () => Promise<void>;
  /**
   * Stops the agents an earlier daemon left running in every sandbox that is up (never starting one),
   * all machines at once. main.ts calls it at startup, before anything launches, and with `all` at shutdown.
   */
  sweepAgents: (o?: { all?: boolean; timeoutMs?: number }) => Promise<number>;
} {
  const base = o.machine ?? defaultMachineSettings;
  // A ticket made from a conversation works in that conversation's copy (conv-<id>); any other in its own (inc-<id>).
  const dirOf = (tickets: Tickets) => (ticketId: Id) => {
    const conversation = tickets.get(ticketId)?.ticket.conversation;
    return conversation ? convDir(conversation, base) : workDir(ticketId, base);
  };
  const now = o.now ?? Date.now;
  const account = credentialsFor(o.credentials);
  const { github } = o;
  let bot: Promise<{ email: string }> | undefined;
  const identity =
    o.identity ??
    (async (employee: Employee) => {
      // Looked up once; a failed lookup is tried again at the next pick-up.
      bot ??= commitIdentity("", github?.slug ?? "").catch((err) => {
        bot = undefined;
        throw err;
      });
      return { name: `${employee.name} (i.inc)`, email: (await bot).email };
    });

  // Machine settings for teams: an employee works in its team's sandbox, sized as the team says.
  let settings: MachineSettings | undefined;
  let registryRef: Registry | undefined;
  const teams = (registry: Registry): MachineSettings => {
    registryRef = registry;
    settings ??= {
      ...base,
      // The egress wall is checked whenever the walls marker is (not in the tests that turn that off).
      ...(base.wallsMarker && !base.wall ? { wall: new EgressWall() } : {}),
      machineFor: (employeeId) => `inc-${registry.teamOf(employeeId).id}`,
      sizeFor: (name) => registry.teams().find((t) => `inc-${t.id}` === name)?.sandbox,
      // A sandbox with a PA in it gets the home wall, whatever its team is called (egress-wall.ts).
      homeMachine: (machine) =>
        registry
          .teams()
          .some(
            (t) =>
              `inc-${t.id}` === machine &&
              registry.employees().some((e) => t.members.includes(e.id) && isHomeEmployee(e)),
          ),
      // Read at each call, so a change in Setup applies at once (timeouts.ts).
      timeouts: () => timeoutsMs(registry.settings().timeouts),
    };
    return settings;
  };
  let runner: RunScript | undefined;
  const run = (registry: Registry): RunScript => {
    runner ??= o.runScript ?? machineScript(teams(registry), o.exec);
    return runner;
  };
  // The brain's copy goes into a sandbox through the same script runner as everything else (a tar
  // stream on stdin of `machine run -i`); the feed adds the brain to briefs only once it has one.
  const withBrain = (registry: Registry, brain: BrainFeed): BrainFeed => {
    brain.deliver ??= run(registry);
    // A copy never starts a stopped machine: `machine ls` says what is running.
    brain.isUp ??=
      o.isUp ??
      (async (name) => (await machines?.listMachines())?.find((m) => m.name === name)?.state === "running");
    return brain;
  };
  let machines: AppleMachines | undefined;
  // Agents a dead daemon left running in a sandbox are stopped before a new one starts for the same
  // work (reaper.ts), and the sandboxes are swept once at startup.
  let reapOnce: Reap | undefined;
  const reap = (registry: Registry): Reap => {
    reapOnce ??= reaper(run(registry), o.log, (employeeId) => machineOf(teams(registry), employeeId));
    return reapOnce;
  };

  // Each sandbox is signed in to GitHub as the bot, for all the App's repos, renewed before it
  // expires. A session's token in its environment would stop working after an hour; this doesn't.
  const signedIn = new Map<string, number>();
  const signIn = async (registry: Registry, employeeId: Id): Promise<void> => {
    if (!github) return;
    const name = machineOf(teams(registry), employeeId);
    if (now() - (signedIn.get(name) ?? 0) < loginEveryMs) return;
    const token = await github.tokens.token("*");
    const r = await run(registry)(
      employeeId,
      'printf %s "$I_INC_GH" | gh auth login --hostname github.com --git-protocol https --with-token && echo @@signed-in',
      { I_INC_GH: token },
    );
    if (!r.output.includes("@@signed-in")) {
      o.log?.(`couldn't sign ${name} in to GitHub: ${r.output.trim().slice(-200)}`);
      return;
    }
    signedIn.set(name, now());
  };

  return {
    machines: (registry) => {
      machines = new AppleMachines(teams(registry), o.exec, undefined, now, o.log);
      return machines;
    },
    agent: (registry, tickets, brain) => {
      withBrain(registry, brain);
      return new AcpAgent({
        launch: o.launch ?? machineLaunch(teams(registry), undefined, o.exec),
        reap: reap(registry),
        // The account's credential if it has one (machines sign in themselves by default), and the
        // ticket's ports. GitHub comes from the sandbox's sign-in.
        credentials: async (engine, ticket, _duty, employeeId) => {
          await signIn(registry, employeeId);
          return { ...account(engine), I_INC_PORTS: portsFor(ticket.id) };
        },
        cwdFor: dirOf(tickets),
        onUsage: (u) => registry.recordUsage(u),
        onRateLimit: (accountId, limit) => registry.setAccountRateLimit(accountId, limit),
        timeouts: () => timeoutsMs(registry.settings().timeouts),
        ...(o.log ? { log: o.log } : {}),
      });
    },
    harness: (registry, tickets) =>
      new MachineHarness(
        {
          recipe: (project) => registry.project(project)?.checks,
          defaultBranch: (project) => registry.project(project)?.defaultBranch,
          worktree: dirOf(tickets),
          machine,
          timeouts: () => timeoutsMs(registry.settings().timeouts),
          policy: (project) => registry.projectPolicy(project),
          ...(github
            ? {
                github: async (ticket) => {
                  const repo = registry.project(ticket.project)?.repo;
                  return repo ? { GH_TOKEN: await github.tokens.token(repo) } : {};
                },
                ci: async (ticket, sha) => {
                  const proj = registry.project(ticket.project);
                  const repo = proj?.repo;
                  const branch = proj?.defaultBranch ?? "main";
                  if (!repo) return { ok: true };
                  return o.ci ? o.ci(repo, sha, branch) : waitForCi(github.tokens, repo, sha, { branch });
                },
              }
            : {}),
        },
        run(registry),
      ),
    ...(github
      ? {
          tokens: github.tokens,
          // Shipping a conversation's work: the git side, and the pull requests it opens and watches.
          ship: (registry: Registry): ShipPort =>
            conversationShip({
              tokens: github.tokens,
              run: run(registry),
              prs: github.prs ?? new PullRequests(github.tokens),
            }),
          workspace: (registry, tickets) =>
            new GitHubWorkspace({
              attachments: (ticketId) => tickets.attachments(ticketId),
              project: (name) => registry.project(name),
              policy: (project) => registry.projectPolicy(project),
              tokens: github.tokens,
              prs: github.prs ?? new PullRequests(github.tokens),
              identity,
              worktree: dirOf(tickets),
              run: run(registry),
              ...(o.log ? { log: o.log } : {}),
            }),
        }
      : {}),
    // Conversations: long-lived agent sessions in the same team sandboxes, behind the AHP host.
    ahpBackend: (registry, _tickets, brain, harvest: BrainHarvest): AgentBackend =>
      new SessionHost({
        brain: withBrain(registry, brain),
        activity: (employeeId) => harvest.beginActivity(employeeId),
        external: (c, why) => harvest.noteExternal({ kind: "conversation", id: c.id }, why),
        // A conversation's brain copy is collected when it goes idle or ends, and on `/remember`.
        harvest: (c, why) =>
          harvest.run({
            employeeId: c.employeeId,
            // A conversation on a project can push to a repository; a PA's home data stays out of it.
            allowHome: c.project === null,
            source: { kind: "conversation", id: c.id },
            trigger: why,
          }),
        launch: o.launch ?? machineLaunch(teams(registry), undefined, o.exec),
        reap: reap(registry),
        agents: () => agentsFromRegistry(registry),
        engine: (id) => registry.engines().find((e) => e.id === id),
        teamOf: (employeeId) => registry.teamOf(employeeId).id,
        workingCopy: async (c) => {
          if (c.project !== null && !github) {
            throw new Error("the GitHub App isn't set up yet, so a conversation can't work on a project");
          }
          return prepareConversationCopy(
            {
              project: (name) => registry.project(name),
              tokens: github?.tokens ?? { token: async () => "" },
              identity,
              run: run(registry),
            },
            { employee: registry.employee(c.employeeId), project: c.project, branch: c.branch, cwd: c.cwd },
          );
        },
        removeCopy: async (c) => {
          await run(registry)(c.employeeId, removeCopyScript({ worktree: c.cwd, branch: c.branch }));
        },
        credentials: async (engine, c) => {
          await signIn(registry, c.employeeId);
          return { ...account(engine), I_INC_PORTS: portsFor(`conv-${c.id}`) };
        },
        employeeKnown: (employeeId) => registry.employees().some((e) => e.id === employeeId),
        effort: (employeeId) => registry.employee(employeeId).effort ?? "medium",
        onUsage: (u) => registry.recordUsage(u),
        onRateLimit: (accountId, limit) => registry.setAccountRateLimit(accountId, limit),
        now,
        ...(o.log ? { log: o.log } : {}),
      }),
    helper: new OllamaHelper(o.ollama),
    chat: new OllamaChat(o.ollama),
    sweepAgents: async (opts) => (machines ? reapMachines(machines, o.log, opts) : 0),
    keepLoginsFresh: async () => {
      if (!machines || !registryRef) return;
      const registry = registryRef;
      for (const employeeId of machines.running()) {
        await signIn(registry, employeeId).catch((err) => o.log?.(`GitHub sign-in renewal failed: ${err}`));
      }
    },
  };
}
