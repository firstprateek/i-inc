// Real mode's ports: ACP sessions in Apple container machines, the harness running each project's
// recipe in the builder's machine, and, once the GitHub App is set up, a branch and draft PR per
// code ticket. Sessions get their account's credentials from the host's config, plus a token for
// the ticket's repo, and Claude's usage reports land in the registry. The helper model and chat stay
// the core's fakes until they use Ollama through the relay.
import type { Employee } from "@i-inc/core";
import { FakeChat, FakeHelper } from "@i-inc/core/testing";
import { AcpAgent, type Launch } from "./acp.ts";
import type { AppOptions } from "./app.ts";
import { type Credentials, credentialsFor } from "./config.ts";
import { commitIdentity, PullRequests, type TokenSource, waitForCi } from "./github.ts";
import { MachineHarness, machineScript, type RunScript } from "./harness.ts";
import {
  AppleMachines,
  defaultMachineSettings,
  type Exec,
  type MachineSettings,
  machineLaunch,
  workDir,
} from "./machines.ts";
import { GitHubWorkspace } from "./workspace.ts";

export interface RealOptions {
  credentials: Credentials;
  /** The GitHub App (or a stand-in token), and its slug for the bot's commit address. */
  github?: { tokens: TokenSource; slug: string; prs?: PullRequests };
  machine?: MachineSettings;
  log?: (msg: string) => void;
  /** Stand-ins for the `container` CLI, for tests. */
  exec?: Exec;
  launch?: Launch;
  runScript?: RunScript;
}

/** What the employee image has (images/employee/Dockerfile), for briefs. */
const machine =
  "Your machine runs Ubuntu 24.04. You're the user employee, with passwordless sudo. It has Node 24, pnpm 10, git, gh and Docker; install anything else you need.";

export function realPorts(
  o: RealOptions,
): Pick<AppOptions, "machines" | "agent" | "harness" | "workspace" | "helper" | "chat"> {
  const s = o.machine ?? defaultMachineSettings;
  const account = credentialsFor(o.credentials);
  const { github } = o;
  let bot: Promise<{ email: string }> | undefined;
  const identity = async (employee: Employee) => {
    // Looked up once; a failed lookup is tried again at the next pick-up.
    bot ??= commitIdentity("", github?.slug ?? "").catch((err) => {
      bot = undefined;
      throw err;
    });
    return { name: `${employee.name} (i.inc)`, email: (await bot).email };
  };
  const run = o.runScript ?? machineScript(s);
  return {
    machines: new AppleMachines(s, o.exec),
    agent: (registry) =>
      new AcpAgent({
        launch: o.launch ?? machineLaunch(s),
        // The account's credential, and a token for the ticket's repo so the builder can push.
        credentials: async (engine, ticket) => {
          const repo = registry.project(ticket.project)?.repo;
          return {
            ...account(engine),
            ...(github && repo ? { GH_TOKEN: await github.tokens.token(repo) } : {}),
          };
        },
        cwdFor: (ticketId) => workDir(ticketId, s),
        onUsage: (u) => registry.recordUsage(u),
        ...(o.log ? { log: o.log } : {}),
      }),
    harness: (registry) =>
      new MachineHarness(
        {
          recipe: (project) => registry.project(project)?.checks,
          worktree: (ticketId) => workDir(ticketId, s),
          machine,
          ...(github
            ? {
                github: async (ticket) => {
                  const repo = registry.project(ticket.project)?.repo;
                  return repo ? { GH_TOKEN: await github.tokens.token(repo) } : {};
                },
                ci: async (ticket, sha) => {
                  const repo = registry.project(ticket.project)?.repo;
                  return repo ? waitForCi(github.tokens, repo, sha) : { ok: true };
                },
              }
            : {}),
        },
        run,
      ),
    ...(github
      ? {
          workspace: (registry) =>
            new GitHubWorkspace({
              project: (name) => registry.project(name),
              tokens: github.tokens,
              prs: github.prs ?? new PullRequests(github.tokens),
              identity,
              worktree: (ticketId) => workDir(ticketId, s),
              run,
            }),
        }
      : {}),
    helper: new FakeHelper(),
    chat: new FakeChat(),
  };
}
