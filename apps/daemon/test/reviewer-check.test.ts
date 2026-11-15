// The #26 device check, run here with `bash -s` on this machine (`--runtime local`), so the check itself is tested
// on Linux before the owner runs it against an Apple container on the mini.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, type Run, runCheck, stdinRunner } from "../scripts/reviewer-check.ts";

const home = mkdtempSync(join(tmpdir(), "inc-home-"));
process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
const bash = stdinRunner("bash", ["-s"]);

describe("the reviewer check (#26)", () => {
  it("passes every check against the daemon's own scripts", async () => {
    const base = join(mkdtempSync(join(tmpdir(), "inc-rc-")), "check");
    const r = await runCheck({ run: bash, base, images: 3, bytes: 64 * 1024 });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.map((c) => c.name.split(" ")[0])).toEqual([
      "the",
      ...["A1", "A2", "A4", "A5", "A6", "A7", "A8", "A9", "B1", "B2", "B3"],
    ]);
    expect(r.imageMs).toHaveLength(4);
  }, 30_000);

  it("fails when an image arrives damaged", async () => {
    const base = join(mkdtempSync(join(tmpdir(), "inc-rc-")), "check");
    // A transport that drops the last line of every image's base64.
    const lossy: Run = (script) =>
      bash(script.includes("echo @@attached") ? script.replace(/\n[^\n]+\n$/, "\n") : script);
    const r = await runCheck({ run: lossy, base, images: 2, bytes: 4096 });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith("A7"))?.ok).toBe(false);
  }, 30_000);

  it("says the machine can't be reached when nothing answers", async () => {
    const r = runCheck({
      run: async () => ({ code: 1, output: "notFound" }),
      base: "/tmp/x",
      images: 1,
      bytes: 1,
    });
    await expect(r).rejects.toThrow("notFound");
  });

  it("reads the command line", () => {
    expect(parseArgs(["--machine", "inc-engineering"])).toMatchObject({
      runtime: "container",
      images: 6,
      mb: 10,
    });
    expect(parseArgs(["--runtime", "docker"])).toBe("--machine is needed");
    expect(parseArgs(["--runtime", "local", "--images", "0"])).toMatch(/not understood/);
  });
});
