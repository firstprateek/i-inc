import { StartupError } from "@i-inc/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AppleMachines,
  BOOT_FAILURES,
  classifyBootFailure,
  defaultMachineSettings,
  type Exec,
} from "../src/machines.ts";
import { forgetSweepState } from "../src/reaper.ts";

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
      signedIn: { claude: false, antigravity: false, codex: false, github: false },
    });
    expect(calls).toEqual([{ bin: defaultMachineSettings.bin, args: ["machine", "ls"] }]);
  });

  describe("a launcher from before agent notes", () => {
    beforeEach(() => forgetSweepState());
    const listing = [
      "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
      "inc-engineering  2026-09-28 20:46:19  192.168.64.22  6     12G     3.6G  running",
    ].join("\n");
    const probe =
      (output: string): Exec =>
      async (_bin, args) =>
        args[1] === "ls" ? listing : output;
    const size = { cpus: 6, memory: "12G" };

    it("is noticed, logged once per machine, and reported as needing an update", async () => {
      const logs: string[] = [];
      const m = new AppleMachines(noWalls, probe("claude\nnoagentnotes\n"), undefined, undefined, (l) =>
        logs.push(l),
      );
      expect((await m.inspectSandbox("engineering", size)).launcher).toBe("needs-update");
      expect((await m.inspectSandbox("engineering", size)).launcher).toBe("needs-update");
      const said = logs.filter((l) => l.includes("writes no agent notes"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("tools/host/update-machine.sh engineering");
    });

    it("says nothing when the launcher writes notes, or when the probe did not look", async () => {
      const logs: string[] = [];
      const current = new AppleMachines(noWalls, probe("claude\nagentnotes\n"), undefined, undefined, (l) =>
        logs.push(l),
      );
      expect((await current.inspectSandbox("engineering", size)).launcher).toBeUndefined();
      const unknown = new AppleMachines(noWalls, probe("claude\n"));
      expect((await unknown.inspectSandbox("engineering", size)).launcher).toBeUndefined();
      expect(logs.filter((l) => l.includes("agent notes"))).toEqual([]);
      // and an update clears it
      const stale = new AppleMachines(noWalls, probe("noagentnotes\n"));
      expect((await stale.inspectSandbox("engineering", size)).launcher).toBe("needs-update");
      const fixed = new AppleMachines(noWalls, probe("agentnotes\n"));
      expect((await fixed.inspectSandbox("engineering", size)).launcher).toBeUndefined();
    });
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
        return "claude\ncodex\ngithub\n";
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
      signedIn: { claude: true, antigravity: false, codex: true, github: true },
    });

    // the listing, a second look inside the machine's queue (a stopped machine is not probed, never booted), the probe
    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toEqual(["machine", "ls"]);
    expect(calls[1]?.args).toEqual(["machine", "ls"]);
    expect(calls[2]?.args).toEqual([
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
    expect(calls[2]?.input).toContain("~/.claude/.credentials.json");
    expect(calls[2]?.input).toContain("~/.gemini/antigravity-acp/acp_token.json");
    expect(calls[2]?.input).toContain("codex login status >/dev/null 2>&1 && echo codex");
    // Codex is installed under ~/.local/bin, which non-login bash doesn't have on its PATH.
    expect(calls[2]?.input).toMatch(/^export PATH="\$HOME\/\.local\/bin:\$PATH"; /);
    expect(calls[2]?.input).toContain("~/.config/gh/hosts.yml");

    // Check signedInCache was populated
    expect(m.signedInCache.get("inc-engineering")).toEqual({
      claude: true,
      antigravity: false,
      codex: true,
      github: true,
    });
  });

  it("reports stopped sandboxes without booting the machine, using cache if present or default signedIn", async () => {
    const calls: { bin: string; args: string[]; input?: string }[] = [];
    const listing = [
      "NAME             CREATED              IP             CPUS  MEMORY  DISK  STATE    DEFAULT",
      "inc-engineering  2026-09-28 20:46:19  -              6     12G     3.6G  stopped",
    ].join("\n");
    const exec: Exec = async (bin, args, opts) => {
      calls.push({ bin, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
      if (args[1] === "ls") return listing;
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
      signedIn: { claude: false, antigravity: false, codex: false, github: false },
    });

    // Never booted or probed!
    expect(calls).toEqual([{ bin: defaultMachineSettings.bin, args: ["machine", "ls"] }]);

    // If cache is set (e.g. from a prior ensureUp), uses the cached signedIn
    m.signedInCache.set("inc-engineering", { claude: true, antigravity: true, codex: true, github: false });
    calls.length = 0;
    const status2 = await m.inspectSandbox("engineering", { cpus: 6, memory: "12G" });
    expect(status2.signedIn).toEqual({ claude: true, antigravity: true, codex: true, github: false });
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
      signedIn: { claude: false, antigravity: false, codex: false, github: false },
    });
    // Only machine ls was called
    expect(calls).toEqual([{ bin: defaultMachineSettings.bin, args: ["machine", "ls"] }]);
  });
});

describe("boot failure classification & BOOT_FAILURES", () => {
  it("classifies stale-hostname errors", () => {
    const err = new Error(
      'failed to create machine: hostname(s) already exist: ["inc-engineering.machine."]',
    );
    const res = classifyBootFailure(err);
    expect(res.kind).toBe("stale-hostname");
    expect(BOOT_FAILURES[res.kind].fix).toContain("container system stop && container system start");
  });

  it("classifies container-service-down errors", () => {
    const err = new Error("cannot connect to container service: connection refused");
    const res = classifyBootFailure(err);
    expect(res.kind).toBe("container-service-down");
    expect(BOOT_FAILURES[res.kind].fix).toContain("container system start");
  });

  it("classifies unknown errors", () => {
    const err = new Error("something weird happened");
    const res = classifyBootFailure(err);
    expect(res.kind).toBe("unknown");
    expect(BOOT_FAILURES[res.kind].fix).toContain("container machine ls");
  });
});

describe("AppleMachines recovery, exponential backoff, and state change logging", () => {
  it("recovers transient boot failures with machine stop and retry once", async () => {
    const calls: string[] = [];
    let bootAttempts = 0;
    const exec: Exec = async (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "machine" && args[1] === "run") {
        bootAttempts++;
        if (bootAttempts === 1) {
          throw new Error("failed to run: machine state unexpected");
        }
        return "";
      }
      return "";
    };
    const logs: string[] = [];
    const m = new AppleMachines(
      noWalls,
      exec,
      async () => {},
      () => 1000,
      (msg) => logs.push(msg),
    );
    await m.ensureUp("ada");

    expect(calls).toContain("machine stop inc-ada");
    expect(bootAttempts).toBe(2);
    expect(m.sandboxFault("ada")).toBeUndefined();
  });

  it("enters exponential backoff on persistent boot failure and throws StartupError", async () => {
    const calls: string[] = [];
    const exec: Exec = async (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "machine" && args[1] === "run") {
        throw new Error('hostname(s) already exist: ["inc-ada.machine."]');
      }
      return "";
    };
    const logs: string[] = [];
    let currentTime = 1_000_000;
    const m = new AppleMachines(
      noWalls,
      exec,
      async () => {},
      () => currentTime,
      (msg) => logs.push(msg),
    );

    // First attempt: backoff 30s
    await expect(m.ensureUp("ada")).rejects.toBeInstanceOf(StartupError);
    const fault1 = m.sandboxFault("ada");
    expect(fault1).toBeDefined();
    expect(fault1?.kind).toBe("stale-hostname");
    expect(fault1?.attempts).toBe(1);
    expect(fault1?.retryAt).toBe(currentTime + 30_000);
    // the state change, and the stale hostname with the machine's last queue operations (T75)
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("STALE HOSTNAME");
    expect(logs[0]).toContain("queue operations");
    expect(logs[1]).toContain("[sandbox:inc-ada]");

    // Immediate retry while in backoff throws StartupError without calling container CLI again
    calls.length = 0;
    await expect(m.ensureUp("ada")).rejects.toBeInstanceOf(StartupError);
    expect(calls).toHaveLength(0);
    // No duplicate log line for same state
    expect(logs).toHaveLength(2);

    // After 30s, next attempt: backoff 60s
    currentTime += 30_000;
    await expect(m.ensureUp("ada")).rejects.toBeInstanceOf(StartupError);
    const fault2 = m.sandboxFault("ada");
    expect(fault2?.attempts).toBe(2);
    expect(fault2?.retryAt).toBe(currentTime + 60_000);

    // Inspect shows state: error with reason, kind, and retryAt
    const listing =
      "NAME     CREATED  IP  CPUS  MEMORY  DISK  STATE\ninc-ada  -        -   4     6G      3.6G  stopped";
    const execWithLs: Exec = async (_bin, args) => {
      if (args[1] === "ls") return listing;
      return "";
    };
    const mInspect = new AppleMachines(
      noWalls,
      execWithLs,
      async () => {},
      () => currentTime,
      () => {},
    );
    // biome-ignore lint/suspicious/noExplicitAny: test inspecting private faults map
    (mInspect as any).faults.set("inc-ada", fault2);
    const status = await mInspect.inspectSandbox("ada", { cpus: 6, memory: "12G" });
    expect(status.state).toBe("error");
    expect(status.kind).toBe("stale-hostname");
    expect(status.reason).toContain("container-apiserver still holds");
    expect(status.retryAt).toBe(fault2?.retryAt);
  });

  // T63 7.2: a clock stepped back or forward must neither stretch nor skip a boot backoff.
  it("waits out a boot backoff on the monotonic clock, whatever wall time does", async () => {
    const calls: string[] = [];
    const exec: Exec = async (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "machine" && args[1] === "run") {
        throw new Error('hostname(s) already exist: ["inc-ada.machine."]');
      }
      return "";
    };
    let wall = 1_000_000;
    let mono = 5_000;
    const m = new AppleMachines(
      noWalls,
      exec,
      async () => {},
      () => wall,
      () => {},
      () => mono,
    );
    await expect(m.ensureUp("ada")).rejects.toBeInstanceOf(StartupError);
    expect(m.sandboxFault("ada")?.attempts).toBe(1); // backoff: 30 s

    // Wall time jumps 10 hours ahead, but only 1 s really passed: still backing off.
    wall += 10 * 3_600_000;
    mono += 1_000;
    calls.length = 0;
    await expect(m.ensureUp("ada")).rejects.toBeInstanceOf(StartupError);
    expect(calls).toHaveLength(0);
    expect(m.sandboxFault("ada")).toBeDefined();

    // Wall time jumps 10 hours back, and 31 s really passed: the backoff is over and the boot is tried again.
    wall -= 20 * 3_600_000;
    mono += 30_000;
    expect(m.sandboxFault("ada")).toBeUndefined();
    await expect(m.ensureUp("ada")).rejects.toBeInstanceOf(StartupError);
    expect(calls.some((c) => c.startsWith("machine run"))).toBe(true);
    expect(m.sandboxFault("ada")?.attempts).toBe(2);
  });

  it("retrySandbox clears backoff and attempts immediate boot", async () => {
    let failBoot = true;
    const calls: string[] = [];
    const exec: Exec = async (_bin, args) => {
      calls.push(args.join(" "));
      if (args[0] === "machine" && args[1] === "run") {
        if (failBoot) throw new Error('hostname(s) already exist: ["inc-ada.machine."]');
        return "";
      }
      if (args[1] === "ls") {
        return "NAME     CREATED  IP  CPUS  MEMORY  DISK  STATE\ninc-ada  -        -   6     12G     3.6G  running";
      }
      return "";
    };
    const logs: string[] = [];
    const m = new AppleMachines(
      noWalls,
      exec,
      async () => {},
      () => 1000,
      (msg) => logs.push(msg),
    );
    await expect(m.ensureUp("ada")).rejects.toBeInstanceOf(StartupError);
    expect(m.sandboxFault("ada")).toBeDefined();

    // Now owner fixes problem (service restarted) and calls retrySandbox
    failBoot = false;
    const status = await m.retrySandbox("ada", { cpus: 6, memory: "12G" });
    expect(status.state).toBe("running");
    expect(status.reason).toBeUndefined();
    expect(m.sandboxFault("ada")).toBeUndefined();
  });
});
