// A machine made from an image older than the launcher is updated by the daemon (T70), not by hand:
// when a sweep or the sign-in probe reports `@@launcher old`, the release's acp-env.sh, launchers and Claude
// settings are copied in as root, checked, and logged once. Walls first; a stopped machine is never started.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AppleMachines,
  defaultMachineSettings,
  type Exec,
  type MachineSettings,
  releaseImageDir,
} from "../src/machines.ts";
import { forgetSweepState, launcherNeedsUpdate, noteLauncher, reaper, reapMachines } from "../src/reaper.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;
const image = resolve(import.meta.dirname, "../../../images/employee");

const listing = (state: string) =>
  [
    "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
    `inc-engineering  2026-09-28 20:46:19  192.168.64.22  6     12G     3.6G  ${state}`,
  ].join("\n");

interface Rig {
  calls: { args: string[]; input?: string | undefined }[];
  logs: string[];
  state: { machine: string; root: string; probe: string };
  machines: AppleMachines;
  clock: { t: number };
}
function rig(settings: MachineSettings = noWalls): Rig {
  const calls: Rig["calls"] = [];
  const logs: string[] = [];
  const state = { machine: "running", root: "@@launcher-updated\n", probe: "claude\nnoagentnotes\n" };
  const clock = { t: 0 };
  const exec: Exec = async (_bin, args, opts) => {
    calls.push({ args, input: opts?.input });
    if (args[1] === "ls") return listing(state.machine);
    if (args[1] === "run" && args[args.indexOf("-u") + 1] === "root") return state.root;
    return state.probe;
  };
  const machines = new AppleMachines(
    settings,
    exec,
    undefined,
    () => clock.t,
    (l) => logs.push(l),
    () => clock.t,
  );
  return { calls, logs, state, machines, clock };
}
const rootRuns = (r: Rig) => r.calls.filter((c) => c.args.includes("root"));

beforeEach(() => forgetSweepState());

describe("AppleMachines.updateLauncher", () => {
  it("copies the release's launcher files into a running machine as root, and logs it once", async () => {
    const r = rig();
    noteLauncher("inc-engineering", false);
    expect(launcherNeedsUpdate("inc-engineering")).toBe(true);
    expect(await r.machines.updateLauncher("inc-engineering")).toBe("updated");

    const runs = rootRuns(r);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args).toEqual([
      "machine",
      "run",
      "-i",
      "-u",
      "root",
      "-n",
      "inc-engineering",
      "--",
      "bash",
      "-s",
    ]);
    const script = runs[0]?.input ?? "";
    // the same files and modes as tools/host/update-machine.sh
    const want: [string, string, string][] = [
      ["root", "644", "/usr/local/lib/i-inc/acp-env.sh"],
      ["root", "755", "/usr/local/bin/acp-antigravity"],
      ["root", "755", "/usr/local/bin/acp-claude"],
      ["root", "755", "/usr/local/bin/acp-codex"],
      ["root", "755", "/usr/local/bin/acp-opencode"],
      ["employee", "644", "/home/employee/.claude/settings.json"],
    ];
    const sources = [
      "acp-env.sh",
      "launchers/acp-antigravity",
      "launchers/acp-claude",
      "launchers/acp-codex",
      "launchers/acp-opencode",
      "claude-settings.json",
    ];
    want.forEach(([who, mode, path], i) => {
      const m = new RegExp(`^put ${who} ${mode} ${path} '([A-Za-z0-9+/=]*)'$`, "m").exec(script);
      expect(m, path).not.toBeNull();
      expect(Buffer.from(m?.[1] ?? "", "base64").equals(readFileSync(`${image}/${sources[i]}`)), path).toBe(
        true,
      );
      expect(script, path).toMatch(new RegExp(`^chk [0-9a-f]{64} ${path} ${mode}$`, "m"));
    });
    expect(script).toContain("grep -q inc-agents /usr/local/lib/i-inc/acp-env.sh");
    expect(spawnSync("bash", ["-n"], { input: script }).status).toBe(0);

    expect(launcherNeedsUpdate("inc-engineering")).toBe(false);
    expect(r.logs.filter((l) => l.includes("launcher was older"))).toHaveLength(1);
    // the release's folder is the one beside the code
    expect(releaseImageDir.replace(/\/$/, "")).toBe(image);
  });

  it("never starts a stopped machine, and does it once the machine is up (the next boot)", async () => {
    const r = rig();
    r.state.machine = "stopped";
    expect(await r.machines.updateLauncher("inc-engineering")).toBe("skipped");
    expect(r.calls.filter((c) => c.args[1] === "run")).toEqual([]);
    expect(r.logs).toEqual([]);
    r.state.machine = "running";
    expect(await r.machines.updateLauncher("inc-engineering")).toBe("updated");
  });

  it("respects the walls: no marker, no root command, no log", async () => {
    const r = rig({ ...noWalls, wallsMarker: "/nonexistent/i-inc-walls.ok" });
    expect(await r.machines.updateLauncher("inc-engineering")).toBe("skipped");
    expect(r.calls).toEqual([]);
    expect(r.logs).toEqual([]);
    // and a home machine with no wall set up is refused by assertRunnable too
    const home = rig();
    expect(await home.machines.updateLauncher("inc-home-ada")).toBe("skipped");
    expect(rootRuns(home)).toEqual([]);
  });

  it("is not tried again at once when the copy does not check out, and says so once", async () => {
    const r = rig();
    r.state.root = "@@launcher-update-failed\n";
    expect(await r.machines.updateLauncher("inc-engineering")).toBe("failed");
    expect(await r.machines.updateLauncher("inc-engineering")).toBe("skipped");
    expect(rootRuns(r)).toHaveLength(1);
    expect(r.logs.filter((l) => l.includes("couldn't update its launcher"))).toHaveLength(1);
    r.clock.t += 11 * 60_000;
    r.state.root = "@@launcher-updated\n";
    expect(await r.machines.updateLauncher("inc-engineering")).toBe("updated");
    expect(rootRuns(r)).toHaveLength(2);
  });

  it("runs one update at a time for a machine", async () => {
    const r = rig();
    const [a, b] = await Promise.all([
      r.machines.updateLauncher("inc-engineering"),
      r.machines.updateLauncher("inc-engineering"),
    ]);
    expect([a, b].sort()).toEqual(["skipped", "updated"]);
    expect(rootRuns(r)).toHaveLength(1);
  });

  it("is refused for anything but a machine name, and never throws on a missing release folder", async () => {
    const r = rig();
    expect(await r.machines.updateLauncher("engineering; reboot")).toBe("skipped");
    const gone = rig({ ...noWalls, imageDir: "/nonexistent/images/employee" });
    expect(await gone.machines.updateLauncher("inc-engineering")).toBe("failed");
    expect(rootRuns(gone)).toEqual([]);
  });
});

describe("the daemon notices an old launcher", () => {
  it("in the sign-in probe: Setup's refresh updates the machine in the background", async () => {
    const r = rig();
    const status = await r.machines.inspectSandbox("engineering", { cpus: 6, memory: "12G" });
    expect(status.launcher).toBe("needs-update");
    await expect.poll(() => rootRuns(r).length).toBe(1);
    await expect.poll(() => launcherNeedsUpdate("inc-engineering")).toBe(false);
    expect(r.logs.filter((l) => l.includes("writes no agent notes"))).toHaveLength(1);
    expect(r.logs.filter((l) => l.includes("launcher was older"))).toHaveLength(1);
    // the next probe finds it current and does nothing more
    r.state.probe = "claude\nagentnotes\n";
    expect(
      (await r.machines.inspectSandbox("engineering", { cpus: 6, memory: "12G" })).launcher,
    ).toBeUndefined();
    expect(rootRuns(r)).toHaveLength(1);
  });

  it("in the startup sweep: only a running machine is touched", async () => {
    const r = rig();
    const swept = await reapMachines(r.machines, (l) => r.logs.push(l), {});
    expect(swept).toBe(0);
    // reapMachines ran the sweep script as the employee (it printed the probe text, not @@launcher): nothing old
    r.state.probe = "@@launcher old\n";
    await reapMachines(r.machines, (l) => r.logs.push(l), {});
    expect(rootRuns(r)).toHaveLength(1);
    r.state.machine = "stopped";
    r.state.probe = "@@launcher old\n";
    forgetSweepState();
    const before = r.calls.length;
    await reapMachines(r.machines, (l) => r.logs.push(l), {});
    expect(r.calls.slice(before).filter((c) => c.args[1] === "run")).toEqual([]);
  });

  it("in the sweep before a launch: the machine is updated before the sweep returns", async () => {
    const order: string[] = [];
    const reap = reaper(
      async () => {
        order.push("sweep");
        return { code: 0, output: "@@launcher old\n" };
      },
      undefined,
      () => "inc-engineering",
      async (machine) => {
        order.push(`update ${machine}`);
      },
    );
    await reap("ada");
    expect(order).toEqual(["sweep", "update inc-engineering"]);
    // a current launcher is not updated
    forgetSweepState();
    const quiet = reaper(
      async () => ({ code: 0, output: "@@launcher current\n" }),
      undefined,
      () => "inc-engineering",
      async () => {
        order.push("unexpected");
      },
    );
    await quiet("ada");
    expect(order).not.toContain("unexpected");
  });
});
