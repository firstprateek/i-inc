// Real mode's ports: ACP sessions in Apple container machines, and the harness running each
// project's recipe in the builder's machine. Sessions get their account's credentials from the
// host's config, and Claude's usage reports land in the registry. The helper model and chat stay the
// core's fakes until they use Ollama through the relay.
import { FakeChat, FakeHelper } from "@i-inc/core/testing";
import { AcpAgent, type Launch } from "./acp.ts";
import type { AppOptions } from "./app.ts";
import { type Credentials, credentialsFor } from "./config.ts";
import { MachineHarness, machineScript, type RunScript } from "./harness.ts";
import {
  AppleMachines,
  defaultMachineSettings,
  type Exec,
  type MachineSettings,
  machineLaunch,
  workDir,
} from "./machines.ts";

export interface RealOptions {
  credentials: Credentials;
  machine?: MachineSettings;
  log?: (msg: string) => void;
  /** Stand-ins for the `container` CLI, for tests. */
  exec?: Exec;
  launch?: Launch;
  runScript?: RunScript;
}

export function realPorts(
  o: RealOptions,
): Pick<AppOptions, "machines" | "agent" | "harness" | "helper" | "chat"> {
  const s = o.machine ?? defaultMachineSettings;
  return {
    machines: new AppleMachines(s, o.exec),
    agent: (registry) =>
      new AcpAgent({
        launch: o.launch ?? machineLaunch(s),
        credentials: credentialsFor(o.credentials),
        cwdFor: (ticketId) => workDir(ticketId, s),
        onUsage: (u) => registry.recordUsage(u),
        ...(o.log ? { log: o.log } : {}),
      }),
    harness: (registry) =>
      new MachineHarness(
        {
          recipe: (project) => registry.project(project)?.checks,
          worktree: (ticketId) => workDir(ticketId, s),
        },
        o.runScript ?? machineScript(s),
      ),
    helper: new FakeHelper(),
    chat: new FakeChat(),
  };
}
