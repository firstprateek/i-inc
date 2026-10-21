import { describe, expect, it } from "vitest";
import { GitHubCi } from "../src/ci.ts";
import { FakeClock, sha } from "./fakes.ts";

const runs = (...r: Array<{ id: number; name?: string; status: string; conclusion: string | null }>) => ({
  check_runs: r.map((x) => ({ name: "check", ...x })),
});

function setup(responses: Array<() => Response>) {
  const clock = new FakeClock();
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const fetchFake = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const make = responses[Math.min(i++, responses.length - 1)];
    if (!make) throw new Error("no response");
    return make();
  }) as unknown as typeof fetch;
  const ci = new GitHubCi({ repo: "firstprateek/i-inc", checkName: "check", clock, fetch: fetchFake });
  return { ci, clock, seen };
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("GitHub CI status", () => {
  it("asks the public API with no credentials", async () => {
    const { ci, seen } = setup([() => json(runs({ id: 1, status: "completed", conclusion: "success" }))]);
    expect(await ci.check(sha(2))).toEqual({ state: "success" });
    expect(seen[0]?.url).toBe(
      `https://api.github.com/repos/firstprateek/i-inc/commits/${sha(2)}/check-runs?per_page=100`,
    );
    expect(Object.keys(seen[0]?.headers ?? {}).join()).not.toMatch(/authorization/i);
  });

  it("is pending until the check run exists and completes", async () => {
    const { ci } = setup([
      () => json({ check_runs: [] }),
      () => json(runs({ id: 1, status: "in_progress", conclusion: null })),
    ]);
    expect((await ci.check(sha(2))).state).toBe("pending");
    expect((await ci.check(sha(2))).state).toBe("pending");
  });

  it("is a failure for any conclusion but success, and uses the latest re-run", async () => {
    const failed = setup([() => json(runs({ id: 1, status: "completed", conclusion: "failure" }))]);
    expect(await failed.ci.check(sha(2))).toMatchObject({ state: "failure" });
    const cancelled = setup([() => json(runs({ id: 1, status: "completed", conclusion: "cancelled" }))]);
    expect((await cancelled.ci.check(sha(2))).state).toBe("failure");
    const rerun = setup([
      () =>
        json(
          runs(
            { id: 1, status: "completed", conclusion: "failure" },
            { id: 9, status: "completed", conclusion: "success" },
          ),
        ),
    ]);
    expect((await rerun.ci.check(sha(2))).state).toBe("success");
    const other = setup([
      () => json(runs({ id: 1, name: "lint", status: "completed", conclusion: "success" })),
    ]);
    expect((await other.ci.check(sha(2))).state).toBe("pending");
  });

  it("sends If-None-Match and reuses the answer on 304", async () => {
    const { ci, seen } = setup([
      () => json(runs({ id: 1, status: "in_progress", conclusion: null }), { etag: 'W/"abc"' }),
      () => new Response(null, { status: 304 }),
    ]);
    expect((await ci.check(sha(2))).state).toBe("pending");
    expect((await ci.check(sha(2))).state).toBe("pending");
    expect(seen[0]?.headers["if-none-match"]).toBeUndefined();
    expect(seen[1]?.headers["if-none-match"]).toBe('W/"abc"');
  });

  it("does not ask again once a commit is known green", async () => {
    const { ci, seen } = setup([
      () => json(runs({ id: 1, status: "completed", conclusion: "success" }), { etag: '"x"' }),
    ]);
    await ci.check(sha(2));
    expect((await ci.check(sha(2))).state).toBe("success");
    expect(seen).toHaveLength(1);
  });

  it("backs off until the rate limit resets on a 403, without asking meanwhile", async () => {
    const { ci, clock, seen } = setup([
      () =>
        json(
          { message: "rate limit" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(clock0() / 1000) + 600) },
          403,
        ),
      () => json(runs({ id: 1, status: "completed", conclusion: "success" })),
    ]);
    function clock0() {
      return 1_700_000_000_000;
    }
    const first = await ci.check(sha(2));
    expect(first).toEqual({ state: "rate-limited", until: (Math.floor(clock0() / 1000) + 600) * 1000 });
    expect((await ci.check(sha(2))).state).toBe("rate-limited");
    expect(seen).toHaveLength(1);
    clock.t += 601_000;
    expect((await ci.check(sha(2))).state).toBe("success");
  });

  it("honours Retry-After on a 429 and backs off exponentially when nothing says when", async () => {
    const retry = setup([() => json({}, { "retry-after": "120" }, 429)]);
    const r = await retry.ci.check(sha(2));
    expect(r).toEqual({ state: "rate-limited", until: retry.clock.now() + 120_000 });

    const blind = setup([() => json({}, {}, 403)]);
    const a = await blind.ci.check(sha(2));
    blind.clock.t += 61_000;
    const b = await blind.ci.check(sha(2));
    if (a.state !== "rate-limited" || b.state !== "rate-limited") throw new Error("expected rate limits");
    expect(a.until - (blind.clock.now() - 61_000)).toBe(60_000);
    expect(b.until - blind.clock.now()).toBe(120_000);
  });

  it("reports an unreachable GitHub or a server error as an error, not a verdict", async () => {
    const down = new GitHubCi({
      repo: "a/b",
      checkName: "check",
      clock: new FakeClock(),
      fetch: (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    expect((await down.check(sha(2))).state).toBe("error");
    const broken = setup([() => json({}, {}, 502)]);
    expect((await broken.ci.check(sha(2))).state).toBe("error");
  });
});
