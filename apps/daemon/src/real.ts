// Real mode's ports. Each team works in one shared sandbox (inc-<team>), signed in once to its
// subscriptions (decided 2026-10-17): ACP sessions run there, the harness runs each project's recipe
// there, and the workspace makes a branch per ticket there. In direct mode (the default) reviewed work
// goes straight to main; owner-merges projects get a draft PR. The daemon keeps each sandbox signed in
// to GitHub as the bot with a READ-ONLY token for the repos its sessions work on (T68): a sandbox never
// holds a credential that can write. Every push is made on the host, from a bundle the sandbox hands over
// (host-push.ts). Claude's usage reports land in the registry. The helper model and chat use Ollama on the host.
import { type Employee, type Id, isHomeEmployee, offlineNotes } from "@i-inc/core";
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
import { type HostPush, HostPusher } from "./host-push.ts";
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
  /**
   * Where pushes are made (T68): a stand-in for tests, or the host's mirrors and ledger (main.ts:
   * `~/.i-inc/push-mirrors` and `~/.i-inc/pushed-main.jsonl`). With GitHub but neither, nothing can be pushed.
   */
  hostPush?: HostPush | { mirrors: string; ledger?: string };
  /**
   * The repo ("owner/name") the deployer deploys onto the host. Anything a push to it changes that the host could
   * run needs the owner's OK (paths.ts), whatever the project's protected paths say. The deployer's `I_INC_REPO`.
   */
  deployRepo?: string;
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
   * At startup: signs every running sandbox out of GitHub (`gh auth logout`, so a write token an older daemon left
   * there is gone). The first session that needs GitHub signs in again, read-only, for its own repo. Returns how many
   * sandboxes it did.
   */
  resignAll: () => Promise<number>;
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
  const host: HostPush | undefined =
    o.hostPush && "push" in o.hostPush
      ? o.hostPush
      : github && o.hostPush
        ? new HostPusher({
            tokens: github.tokens,
            mirrors: o.hostPush.mirrors,
            ...(o.hostPush.ledger ? { ledger: o.hostPush.ledger } : {}),
            ...(o.log ? { log: o.log } : {}),
          })
        : undefined;
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
    reapOnce ??= reaper(
      run(registry),
      o.log,
      (employeeId) => machineOf(teams(registry), employeeId),
      // A machine whose launcher is older than the release's is updated before the launch (machines.ts).
      (machine) => machines?.updateLauncher(machine) ?? Promise.resolve(),
    );
    return reapOnce;
  };

  // Each sandbox is signed in to GitHub as the bot with a read-only token for the repos its sessions work on,
  // renewed before it expires. A session's token in its environment would stop working after an hour; this
  // doesn't. A sandbox shared by tickets of several projects is signed in for all of them (the sign-in is
  // the machine's, not the session's), and a session that needs no GitHub adds nothing. Never a write token.
  const signedIn = new Map<string, number>();
  const loginRepos = new Map<string, Set<string>>();
  const ghLogin = "gh auth login --hostname github.com --git-protocol https --with-token && echo @@signed-in";
  const loginScript = `printf %s "$I_INC_GH" | ${ghLogin}`;
  const signIn = async (registry: Registry, employeeId: Id, repo?: string | null): Promise<void> => {
    if (!github) return;
    const name = machineOf(teams(registry), employeeId);
    const known = loginRepos.get(name);
    const wanted = new Set(known);
    if (repo) wanted.add(repo);
    if (wanted.size === 0) return; // no session here has needed GitHub: it gets none
    const widened = wanted.size !== (known?.size ?? 0);
    if (!widened && now() - (signedIn.get(name) ?? 0) < loginEveryMs) return;
    let token: string;
    try {
      token = await github.tokens.readToken([...wanted]);
    } catch (err) {
      o.log?.(`couldn't mint a read-only GitHub token for ${name}: ${String(err)}`);
      return;
    }
    const r = await run(registry)(employeeId, loginScript, { I_INC_GH: token });
    if (!r.output.includes("@@signed-in")) {
      o.log?.(`couldn't sign ${name} in to GitHub: ${r.output.trim().slice(-200)}`);
      return;
    }
    signedIn.set(name, now());
    loginRepos.set(name, wanted);
  };
  /** The repo ("owner/name") of a project, for a session's sign-in. */
  const repoOf = (registry: Registry, project: string | null | undefined): string | null =>
    (project ? registry.project(project)?.repo : undefined) ?? null;

  return {
    machines: (registry) => {
      machines = new AppleMachines(
        teams(registry),
        o.exec,
        undefined,
        now,
        o.log,
        // An injected `now` (a test's) drives the backoff too; the real one waits on a clock that never steps.
        o.now ? now : () => performance.now(),
      );
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
          await signIn(registry, employeeId, repoOf(registry, ticket.project));
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
                ...(host ? { host } : {}),
                hostExecuted: (project) =>
                  o.deployRepo !== undefined &&
                  registry.project(project)?.repo.toLowerCase() === o.deployRepo.toLowerCase(),
                repo: (project) => registry.project(project)?.repo,
                author: async (ticket) => {
                  const who = await identity(registry.employee(ticket.assignee));
                  return who;
                },
                github: async (ticket) => {
                  const repo = registry.project(ticket.project)?.repo;
                  // Reading only: the fetch and the ls-remote. Pushes are the host's (host-push.ts).
                  return repo ? { GH_TOKEN: await github.tokens.readToken([repo]) } : {};
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
              ...(host ? { host } : {}),
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
              ...(host ? { host } : {}),
              ...(o.log ? { log: o.log } : {}),
            }),
        }
      : {}),
    // Conversations: long-lived agent sessions in the same team sandboxes, behind the AHP host.
    ahpBackend: (registry, _tickets, brain, harvest: BrainHarvest): AgentBackend =>
      new SessionHost({
        brain: withBrain(registry, brain),
        homeNotes: (employeeId) =>
          registry.employees().some((e) => e.id === employeeId && isHomeEmployee(e))
            ? offlineNotes(employeeId, brain.toolsOf(employeeId))
            : "",
        sandboxLabel: (employeeId) => {
          const e = registry.employees().find((x) => x.id === employeeId);
          return e && isHomeEmployee(e)
            ? `${e.name}'s sandbox`
            : `the ${registry.teamOf(employeeId).id} sandbox`;
        },
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
              tokens: github?.tokens ?? { token: async () => "", readToken: async () => "" },
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
          await signIn(registry, c.employeeId, repoOf(registry, c.project));
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
    resignAll: async () => {
      if (!github || !machines) return 0;
      const m = machines;
      const up = (await m.listMachines().catch(() => [])).filter(
        (row) => row.name.startsWith("inc-") && row.state === "running",
      );
      // Signed out, and nothing more: the first session that needs GitHub signs its machine in again, with a
      // read-only token for its own repo and no other. (A token for every project would reach further than
      // the work needs.)
      const script = [
        "gh auth logout --hostname github.com >/dev/null 2>&1 || true",
        'rm -f "$HOME/.config/gh/hosts.yml"',
        "echo @@signed-out",
      ].join("\n");
      let n = 0;
      await Promise.all(
        up.map(async (row) => {
          try {
            await m.runIn(row.name, script, 60_000);
            n++;
          } catch (err) {
            o.log?.(`couldn't sign ${row.name} out of GitHub: ${String(err)}`);
          }
        }),
      );
      return n;
    },
    keepLoginsFresh: async () => {
      if (!machines || !registryRef) return;
      const registry = registryRef;
      for (const employeeId of machines.running()) {
        await signIn(registry, employeeId).catch((err) => o.log?.(`GitHub sign-in renewal failed: ${err}`));
      }
    },
  };
}
