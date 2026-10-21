// A 1,000-page brain: the copy, the delta after one change, the retrieval of a task's pages, and the
// command's search. The default run checks the results are right and prints nothing; with
// I_INC_BENCH=1 it prints each timing (there are no millisecond assertions anywhere in the suite, because
// they depend on the machine's load):
//
//   I_INC_BENCH=1 pnpm --filter @i-inc/daemon exec vitest run test/brain-bench.test.ts
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brainRig, cleanRigs, page } from "./brain-rig.ts";

afterEach(cleanRigs);

const bench = process.env.I_INC_BENCH === "1";
const time = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  const t = performance.now();
  const out = await fn();
  if (bench) console.log(`bench ${name}: ${(performance.now() - t).toFixed(1)} ms`);
  return out;
};

describe("a thousand pages", () => {
  it("copies, follows a change, retrieves and searches", { timeout: 120_000 }, async () => {
    const r = await brainRig();
    const words =
      "alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega release deploy test build review".split(
        " ",
      );
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      const body = Array.from({ length: 150 }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(" ");
      files[`facts/area${i % 10}/page-${i}.md`] = page(
        `Page ${i} ${words[i % words.length]}`,
        `About ${words[i % 17]} things`,
        `${body} [[page-${(i + 1) % 1000}]] token${i}`,
      );
    }
    r.commit("handbook", files);
    const first = await time("first copy (1,000 pages)", () => r.feed.sync("ada"));
    expect(first).toMatchObject({ ok: true, how: "full" });
    expect(first.sent).toBeGreaterThan(1000);

    r.commit("handbook", {
      "facts/area0/page-0.md": page("Page 0 changed", "About changed things", "changed body token0"),
    });
    const delta = await time("delta after one page changed", () => r.feed.sync("ada"));
    expect(delta).toMatchObject({ ok: true, how: "delta", sent: 2 });
    const same = await time("nothing changed", () => r.feed.sync("ada"));
    expect(same.how).toBe("current");

    const ctx = await time("retrieval for a task", () =>
      r.feed.forTicket({
        employeeId: "ada",
        sessionId: null,
        query: { title: "release deploy review token500", project: "Duet", doneWhen: [] },
      }),
    );
    expect(ctx.pages.length).toBeGreaterThanOrEqual(3);
    expect(ctx.text.split("\n").filter((l) => l.startsWith("- [[")).length).toBeLessThan(200);

    const found = await time("the command's search over the copy", () =>
      spawnSync(
        process.execPath,
        ["--no-warnings", join(r.copy("ada"), ".bin/brain"), "search", "token500"],
        { encoding: "utf8" },
      ),
    );
    expect(found.stdout).toContain("page-500");
  });
});

describe("how big the brief gets", () => {
  const sizes = bench ? [1000, 10_000] : [1000];
  it.each(sizes)(
    "a brief on a brain of %i pages stays within a fixed size",
    { timeout: 300_000 },
    async (n) => {
      const r = await brainRig();
      const files: Record<string, string> = {};
      for (let i = 0; i < n; i++) {
        files[`area${i % 130}/topic${i % 40}/page-${i}.md`] = page(
          `Page ${i}`,
          `A description of page ${i} that is a typical sentence long`,
          `body ${i} token${i}`,
        );
      }
      r.commit("handbook", files);
      const own: Record<string, string> = {};
      for (let i = 0; i < 40; i++)
        own[`tools/own-${i}.md`] = page(`Own ${i}`, `Ada's note number ${i}`, `own ${i}`);
      r.commit("ada", own);
      const ctx = await r.feed.forTicket({
        employeeId: "ada",
        sessionId: null,
        query: { title: "token5 something", project: "Duet", doneWhen: [] },
      });
      const tokens = Math.ceil(ctx.text.length / 4);
      const mapLines = ctx.text.split("\n").filter((l) => /^(- \[\[|## |… )/.test(l)).length;
      if (bench)
        console.log(
          `bench brief at ${n} pages: ${ctx.text.length} chars, about ${tokens} tokens, ${mapLines} map lines`,
        );
      // The maps carry about 150 lines in all and the pages about 3,000 tokens, however big the brain is.
      expect(mapLines).toBeLessThanOrEqual(155);
      expect(tokens).toBeLessThanOrEqual(3000 + 1800);
    },
  );
});
