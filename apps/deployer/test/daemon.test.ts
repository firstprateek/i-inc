import { describe, expect, it } from "vitest";
import { LaunchdDaemon, probeHealth } from "../src/daemon.ts";
import type { Shell } from "../src/shell.ts";

describe("daemon control", () => {
  it("kickstarts the daemon's own label for this user, never with sudo", async () => {
    const seen: string[][] = [];
    const shell: Shell = async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { code: 0, output: "", timedOut: false };
    };
    await new LaunchdDaemon({
      shell,
      uid: 501,
      label: "inc.i.daemon",
      url: "http://127.0.0.1:7420",
    }).restart();
    expect(seen).toEqual([["launchctl", "kickstart", "-k", "gui/501/inc.i.daemon"]]);
  });

  it("throws with the reason when launchctl fails", async () => {
    const shell: Shell = async () => ({ code: 113, output: "Could not find service", timedOut: false });
    await expect(
      new LaunchdDaemon({ shell, uid: 501, label: "inc.i.daemon", url: "http://x" }).restart(),
    ).rejects.toThrow(/113.*Could not find/);
  });

  it("reads /api/health, and is null for anything unexpected", async () => {
    const ok = (async () =>
      new Response(
        JSON.stringify({ ok: true, version: "abc", busy: true, startedAt: 5 }),
      )) as unknown as typeof fetch;
    expect(await probeHealth("http://x", ok)).toEqual({ ok: true, version: "abc", busy: true, startedAt: 5 });
    const html = (async () => new Response("<html>")) as unknown as typeof fetch;
    expect(await probeHealth("http://x", html)).toBeNull();
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await probeHealth("http://x", down)).toBeNull();
    const old = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await probeHealth("http://x", old)).toBeNull();
  });
});
