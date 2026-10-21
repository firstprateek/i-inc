import { describe, expect, it } from "vitest";
import { ProcessSmoke, type SmokeChild, type SmokeProcess } from "../src/smoke.ts";
import { FakeClock, sha } from "./fakes.ts";

const S = sha(7);

function setup(
  routes: Record<string, () => { status: number; body: string } | undefined>,
  opts: { exitAfter?: number } = {},
) {
  const clock = new FakeClock();
  const started: SmokeProcess[] = [];
  const state = { stopped: 0, removed: [] as string[] };
  const child: SmokeChild = {
    exitCode: () => (opts.exitAfter !== undefined && clock.slept >= opts.exitAfter ? 1 : null),
    output: () => "Error: Cannot find module 'x'\n  at main.ts:1",
    stop: async () => {
      state.stopped++;
    },
  };
  const fetchFake = (async (url: string) => {
    const path = new URL(url).pathname;
    const r = routes[path]?.();
    if (!r) throw new Error("ECONNREFUSED");
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  const smoke = new ProcessSmoke({
    clock,
    releaseDir: (s) => `/releases/${s}`,
    bun: "/usr/local/bin/bun",
    timeoutMs: 10_000,
    fetch: fetchFake,
    start: (p) => {
      started.push(p);
      return child;
    },
    freePort: async () => 54321,
    makeHome: () => "/tmp/smoke-home",
    removeHome: (d) => state.removed.push(d),
  });
  return { smoke, started, state, clock };
}

const good = {
  "/api/health": () => ({
    status: 200,
    body: JSON.stringify({ ok: true, version: S, busy: false, startedAt: 1 }),
  }),
  "/api/auth": () => ({ status: 200, body: '{"initialized":false}' }),
  "/": () => ({
    status: 200,
    body: '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  }),
  "/assets/index-abc.js": () => ({ status: 200, body: "console.log(1)" }),
};

describe("smoke test", () => {
  it("starts the new daemon on a spare port in demo mode with a throwaway home, probes it, stops it", async () => {
    const { smoke, started, state } = setup(good);
    expect(await smoke.run(S)).toEqual({ ok: true });
    const p = started[0];
    expect(p?.cmd).toBe("/usr/local/bin/bun");
    expect(p?.args).toEqual([`/releases/${S}/apps/daemon/src/main.ts`]);
    expect(p?.env).toMatchObject({
      I_INC_DEMO: "1",
      PORT: "54321",
      HOST: "127.0.0.1",
      I_INC_HOME: "/tmp/smoke-home",
      HOME: "/tmp/smoke-home",
    });
    expect(p?.env.PORT).not.toBe("7420");
    expect(state.stopped).toBe(1);
    expect(state.removed).toEqual(["/tmp/smoke-home"]);
  });

  it("waits for the daemon to come up", async () => {
    let calls = 0;
    const { smoke } = setup({
      ...good,
      "/api/health": () => (++calls < 4 ? undefined : good["/api/health"]()),
    });
    expect(await smoke.run(S)).toEqual({ ok: true });
    expect(calls).toBe(4);
  });

  it("fails when the daemon never answers, and still stops it", async () => {
    const { smoke, state } = setup({});
    const r = await smoke.run(S);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain("did not answer");
    expect(state.stopped).toBe(1);
  });

  it("fails fast, with the output, when the daemon exits", async () => {
    const { smoke, clock } = setup({}, { exitAfter: 1000 });
    const r = await smoke.run(S);
    expect(!r.ok && r.reason).toContain("exited with 1");
    expect(!r.ok && r.reason).toContain("Cannot find module");
    expect(clock.slept).toBeLessThan(5000);
  });

  it("fails when the daemon reports another version", async () => {
    const { smoke } = setup({
      ...good,
      "/api/health": () => ({
        status: 200,
        body: JSON.stringify({ ok: true, version: sha(1), busy: false }),
      }),
    });
    const r = await smoke.run(S);
    expect(!r.ok && r.reason).toContain("version");
  });

  it("fails when the web app is not served or its asset is missing", async () => {
    const noRoot = setup({ ...good, "/": () => ({ status: 404, body: "" }) });
    expect((await noRoot.smoke.run(S)).ok).toBe(false);
    const noAsset = setup({ ...good, "/": () => ({ status: 200, body: "<html>nothing built</html>" }) });
    const r = await noAsset.smoke.run(S);
    expect(!r.ok && r.reason).toContain("built asset");
    const gone = setup({ ...good, "/assets/index-abc.js": () => ({ status: 404, body: "" }) });
    expect((await gone.smoke.run(S)).ok).toBe(false);
  });
});
