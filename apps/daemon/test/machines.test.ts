import { describe, expect, it } from "vitest";
import { AppleMachines, defaultMachineSettings, type Exec } from "../src/machines.ts";

const { wallsMarker: _, ...noWalls } = defaultMachineSettings;

describe("AppleMachines.inspectSandbox", () => {
  it("rejects an invalid team id", async () => {
    const m = new AppleMachines(noWalls);
    await expect(m.inspectSandbox("invalid team!", { cpus: 6, memory: "12G" })).rejects.toThrow(
      "not a team id: invalid team!",
    );
    await expect(m.inspectSandbox("", { cpus: 6, memory: "12G" })).rejects.toThrow("not a team id: ");
    await expect(m.inspectSandbox("Devs_Team", { cpus: 6, memory: "12G" })).rejects.toThrow(
      "not a team id: ",
    );
  });

  it("returns state 'missing' and default signedIn when the machine is not in machine ls", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    const listing = [
      "NAME     CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
      "inc-ada  2026-09-28 20:46:19  192.168.64.22  4     6G      3.6G  running",
    ].join("\n");
    const exec: Exec = async (bin, args) => {
      calls.push({ bin, args });
      if (args[1] === "ls") return listing;
      return "";
    };
    const m = new AppleMachines(noWalls, exec);
    const status = await m.inspectSandbox("engineering", { cpus: 6, memory: "12G" });

    expect(status).toEqual({
      team: "engineering",
      machine: "inc-engineering",
      state: "missing",
      cpus: 6,
      memory: "12G",
      signedIn: { claude: false, antigravity: false, github: false },
    });
    expect(calls).toEqual([{ bin: defaultMachineSettings.bin, args: ["machine", "ls"] }]);
  });

  it("probes credential files inside the machine when running and parses sign-ins accurately", async () => {
    const calls: { bin: string; args: string[]; input?: string }[] = [];
    const listing = [
      "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
      "inc-engineering  2026-09-28 20:46:19  192.168.64.22  6     12G     3.6G  running",
    ].join("\n");
    const exec: Exec = async (bin, args, opts) => {
      calls.push({ bin, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
      if (args[1] === "ls") return listing;
      if (args[1] === "run") {
        // Mock probe output where claude and github are signed in
        return "claude\ngithub\n";
      }
      return "";
    };
    const m = new AppleMachines(noWalls, exec);
    const status = await m.inspectSandbox("engineering", { cpus: 6, memory: "12G" });

    expect(status).toEqual({
      team: "engineering",
      machine: "inc-engineering",
      state: "running",
      cpus: 6,
      memory: "12G",
      signedIn: { claude: true, antigravity: false, github: true },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(["machine", "ls"]);
    expect(calls[1]?.args).toEqual([
      "machine",
      "run",
      "-i",
      "-u",
      "employee",
      "-n",
      "inc-engineering",
      "--",
      "bash",
      "-s",
    ]);
    expect(calls[1]?.input).toContain("~/.claude/.credentials.json");
    expect(calls[1]?.input).toContain("~/.gemini/antigravity-acp/acp_token.json");
    expect(calls[1]?.input).toContain("~/.config/gh/hosts.yml");

    // Check signedInCache was populated
    expect(m.signedInCache.get("inc-engineering")).toEqual({
      claude: true,
      antigravity: false,
      github: true,
    });
  });

  it("probes and re-stops a stopped machine if not yet cached, caching the result", async () => {
    const calls: { bin: string; args: string[]; input?: string }[] = [];
    const listing = [
      "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
      "inc-engineering  2026-09-28 20:46:19  -              6     12G     3.6G  stopped",
    ].join("\n");
    const exec: Exec = async (bin, args, opts) => {
      calls.push({ bin, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
      if (args[1] === "ls") return listing;
      if (args[1] === "run") return "antigravity\n";
      return "";
    };
    const m = new AppleMachines(noWalls, exec);
    const status = await m.inspectSandbox("engineering", { cpus: 6, memory: "12G" });

    expect(status).toEqual({
      team: "engineering",
      machine: "inc-engineering",
      state: "stopped",
      cpus: 6,
      memory: "12G",
      signedIn: { claude: false, antigravity: true, github: false },
    });

    // Probed and stopped
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "machine ls",
      "machine run",
      "machine stop",
    ]);
    expect(calls[2]?.args).toEqual(["machine", "stop", "inc-engineering"]);

    // Subsequent call uses cache and does not probe or stop
    calls.length = 0;
    const status2 = await m.inspectSandbox("engineering", { cpus: 6, memory: "12G" });
    expect(status2.signedIn).toEqual({ claude: false, antigravity: true, github: false });
    expect(calls).toEqual([{ bin: defaultMachineSettings.bin, args: ["machine", "ls"] }]);
  });

  it("does not probe files when walls are down", async () => {
    const calls: { bin: string; args: string[] }[] = [];
    const listing = [
      "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
      "inc-engineering  2026-09-28 20:46:19  192.168.64.22  6     12G     3.6G  running",
    ].join("\n");
    const exec: Exec = async (bin, args) => {
      calls.push({ bin, args });
      if (args[1] === "ls") return listing;
      return "";
    };
    const downWalls = { ...defaultMachineSettings, wallsMarker: "/tmp/nonexistent-marker" };
    const m = new AppleMachines(downWalls, exec);
    const status = await m.inspectSandbox("engineering", { cpus: 6, memory: "12G" });

    expect(status).toEqual({
      team: "engineering",
      machine: "inc-engineering",
      state: "running",
      cpus: 6,
      memory: "12G",
      signedIn: { claude: false, antigravity: false, github: false },
    });
    // Only machine ls was called
    expect(calls).toEqual([{ bin: defaultMachineSettings.bin, args: ["machine", "ls"] }]);
  });
});
