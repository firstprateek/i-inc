// The deployer's command line, run with bun against temp directories (skipped where bun is absent).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const main = resolve(import.meta.dirname, "../src/main.ts");
const hasBun = spawnSync("bun", ["--version"]).status === 0;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-inc-deployer-main-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync("bun", [main, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      I_INC_CHECKOUT: join(dir, "checkout"),
      I_INC_RELEASES: join(dir, "releases"),
      I_INC_HOME: join(dir, "inc"),
    },
  });

describe.skipIf(!hasBun)("deployer command line", () => {
  it("--status is read-only and prints the state", () => {
    const r = run(["--status"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ current: null, releases: [], state: { bad: {} } });
    expect(existsSync(join(dir, "releases"))).toBe(false);
    expect(existsSync(join(dir, "inc"))).toBe(false);
  });

  it("exits non-zero at once when another deployer holds the lock, for the service and for one-off commands", () => {
    const releases = join(dir, "releases");
    spawnSync("mkdir", ["-p", releases]);
    writeFileSync(join(releases, "deployer.lock"), `${process.pid}\n`);
    const loop = run([]);
    expect(loop.status).toBe(1); // non-zero, so launchd keeps trying
    expect(loop.stdout).toContain("another deployer holds the lock");
    expect(run(["--once"]).status).toBe(1);
    expect(run(["--rollback"]).status).toBe(1);
  });

  it("--once says what to do when there is no current release", () => {
    const r = run(["--once"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("install-deployer.sh");
    expect(existsSync(join(dir, "inc", "deploys.jsonl"))).toBe(false);
  });
});
