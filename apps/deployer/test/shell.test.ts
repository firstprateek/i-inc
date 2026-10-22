import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/shell.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-shell-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A grandchild that holds the pipe sleeps for 60 s. A `run` that waited for it would take all of them, so "returns
// promptly" is a single run under a budget that a busy machine cannot reach (the timeouts asked for are 0.3-0.5 s)
// and a hung `run` cannot meet.
const BUDGET_MS = 30_000;

describe("run", () => {
  it("captures the tail of the output and the exit code", async () => {
    const r = await run("sh", ["-c", "echo hi; echo oops >&2; exit 3"]);
    expect(r).toMatchObject({ code: 3, timedOut: false });
    expect(r.output).toContain("hi");
    expect(r.output).toContain("oops");
  });

  it("a timeout returns promptly and kills a grandchild that holds the pipe", {
    timeout: 90_000,
  }, async () => {
    const pidFile = join(dir, "grandchild.pid");
    // The shell starts a background grandchild that inherits stdout/stderr and sleeps for a minute.
    const started = Date.now();
    const r = await run("sh", ["-c", `sleep 60 & echo $! > "${pidFile}"; wait`], { timeoutMs: 500 });
    const took = Date.now() - started;
    expect(r.timedOut).toBe(true);
    expect(took).toBeLessThan(BUDGET_MS);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(pid)).toBe(false);
  });

  it("a grandchild that ignores SIGTERM is killed too, and the call still returns", {
    timeout: 90_000,
  }, async () => {
    const pidFile = join(dir, "stubborn.pid");
    const started = Date.now();
    const r = await run(
      "sh",
      ["-c", `(trap '' TERM; sleep 60) & echo $! > "${pidFile}"; (trap '' TERM; sleep 60); true`],
      { timeoutMs: 300 },
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(BUDGET_MS);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(pid)).toBe(false);
  });

  it("reports a missing command", async () => {
    const r = await run("definitely-not-a-command-i-inc", []);
    expect(r.code).toBe(127);
  });
});
