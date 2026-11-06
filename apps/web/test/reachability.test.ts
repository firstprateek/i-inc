// One failed request is not the daemon being away (api.ts, connection.ts). Behind Tailscale serve the
// owner's browser dropped its HTTP/2 connections many times a minute, and each drop flashed the
// "Can't reach i.inc" banner. Now a read is sent once more, a failure that stays is checked with
// health probes, an answer from anywhere calls the check off, a write is never sent twice, and what is
// kept for debugging holds no query string.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { netFailures, refresh, send } from "../src/api.ts";
import "../src/components/app.ts";
import { connection, isOffline, report, timing } from "../src/connection.ts";

const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const gateway = () => new Response("Bad gateway", { status: 502 });
const drop = (): Response => {
  throw new TypeError("Failed to fetch");
};

let calls: { path: string; method: string; cache?: RequestCache | undefined }[] = [];
/** Answers each path from its script, in order; the last answer repeats. Anything else answers {}. */
function serve(routes: Record<string, (() => Response)[]>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push({ path, method: init?.method ?? "GET", cache: init?.cache });
    const script = routes[path.split(/[?#]/)[0] ?? ""] ?? [ok];
    const next = (script.length > 1 ? script.shift() : script[0]) ?? ok;
    return next();
  });
}
const callsTo = (path: string) => calls.filter((c) => c.path.split(/[?#]/)[0] === path);

/** Sends a request and lets its retry run; resolves with the response, or the error it threw. */
async function sent(path: string, init?: RequestInit): Promise<Response | Error> {
  const p = send(path, init).catch((e: Error) => e);
  await vi.advanceTimersByTimeAsync(timing.retryMs);
  return p;
}

let changes = 0;
const onChange = () => changes++;

beforeEach(() => {
  vi.useFakeTimers();
  report(true);
  changes = 0;
  connection.addEventListener("change", onChange);
});
afterEach(() => {
  connection.removeEventListener("change", onChange);
  report(true);
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a read that fails once", () => {
  for (const [what, first] of [
    ["a dropped connection", drop],
    ["a 502 from the proxy", gateway],
  ] as const) {
    it(`is sent again after ${what}, and nothing changes when that answers`, async () => {
      serve({ "/api/tickets/9/sessions": [first, ok] });
      const res = await sent("/api/tickets/9/sessions");
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).status).toBe(200);
      expect(callsTo("/api/tickets/9/sessions")).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(5000);
      expect(callsTo("/api/health")).toHaveLength(0);
      expect(changes).toBe(0);
      expect(isOffline()).toBe(false);
    });
  }
});

describe("a failure that stays", () => {
  it("asks /api/health, past any cache, and stays online when it answers", async () => {
    serve({ "/api/board/summary": [drop], "/api/health": [ok] });
    const res = await sent("/api/board/summary");
    expect((res as Error).message).toBe("Can't reach i.inc");
    await vi.advanceTimersByTimeAsync(5000);
    // the first probe answered: no more are sent
    expect(callsTo("/api/health")).toEqual([{ path: "/api/health", method: "GET", cache: "no-store" }]);
    expect(changes).toBe(0);
    expect(isOffline()).toBe(false);
  });

  it("is the daemon being away only once every probe has failed", async () => {
    serve({ "/api/board/summary": [gateway], "/api/health": [drop, gateway, drop] });
    expect(((await sent("/api/board/summary")) as Response).status).toBe(502);
    // probes at about +0, +1 s and +2.5 s
    await vi.advanceTimersByTimeAsync(10);
    expect(callsTo("/api/health")).toHaveLength(1);
    expect(isOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callsTo("/api/health")).toHaveLength(2);
    expect(isOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(callsTo("/api/health")).toHaveLength(3);
    expect(isOffline()).toBe(true);
    expect(changes).toBe(1);
    // offline, a failure doesn't start another check (the banner keeps asking by itself)
    await sent("/api/board/summary");
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo("/api/health")).toHaveLength(3);
  });

  it("is called off by any answer from the daemon meanwhile", async () => {
    serve({ "/api/board/summary": [drop], "/api/health": [drop] });
    await sent("/api/board/summary");
    await vi.advanceTimersByTimeAsync(500);
    expect(callsTo("/api/health")).toHaveLength(1);
    report(true); // another request was answered, or the event stream opened
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo("/api/health")).toHaveLength(1);
    expect(isOffline()).toBe(false);
    expect(changes).toBe(0);
  });

  it("is offline at once when the device says it is", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      serve({ "/api/board/summary": [drop] });
      await sent("/api/board/summary");
      expect(isOffline()).toBe(true);
      expect(changes).toBe(1);
      expect(callsTo("/api/health")).toHaveLength(0);
    } finally {
      delete (navigator as unknown as Record<string, unknown>).onLine;
    }
  });
});

describe("a write that fails", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`is never sent twice (${method})`, async () => {
      serve({ "/api/tickets/7": [drop, ok], "/api/health": [ok] });
      const res = await sent("/api/tickets/7", { method, body: "{}" });
      expect((res as Error).message).toBe("Can't reach i.inc");
      await vi.advanceTimersByTimeAsync(5000);
      expect(callsTo("/api/tickets/7")).toHaveLength(1);
      expect(isOffline()).toBe(false);
    });
  }

  it("is not sent twice after a 502 either", async () => {
    serve({ "/api/tickets": [gateway, ok], "/api/health": [ok] });
    expect(((await sent("/api/tickets", { method: "POST", body: "{}" })) as Response).status).toBe(502);
    expect(callsTo("/api/tickets")).toHaveLength(1);
  });
});

describe("the failures kept for debugging", () => {
  it("are the last 20, by method and path, with no query string, also on window.__incNet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    serve({ "/api/search": [drop], "/api/health": [ok] });
    for (let i = 0; i < 12; i++) await sent(`/api/search?q=my+secret+plan+${i}#frag`);
    const kept = netFailures();
    expect(kept).toHaveLength(20);
    for (const f of kept) {
      expect(f).toMatchObject({ method: "GET", path: "/api/search", failure: "TypeError" });
      expect(f.ms).toBeGreaterThanOrEqual(0);
      expect(f.at).toBeGreaterThan(0);
    }
    const net = (globalThis as unknown as { __incNet: unknown }).__incNet;
    expect(net).toEqual(kept);
    expect(JSON.stringify(net)).not.toMatch(/secret|q=|frag/);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|q=|frag/);
    // a copy: changing it changes nothing kept
    (kept[0] as { path: string }).path = "changed";
    expect(netFailures()[0]?.path).toBe("/api/search");
  });
});

// These mount the whole shell, whose own requests can outlive a test: they go last.
describe("the shell", () => {
  it("shows no banner for a read that failed once", async () => {
    serve({});
    const app = document.createElement("inc-app");
    document.body.append(app);
    await vi.advanceTimersByTimeAsync(50);
    serve({ "/api/tickets/9/sessions": [drop, ok] });
    expect(((await sent("/api/tickets/9/sessions")) as Response).status).toBe(200);
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes).toBe(0);
    expect(app.shadowRoot?.querySelector("inc-offline")).toBeNull();
  });

  it("refetches every view after an outage of a couple of seconds, but not after a blip", async () => {
    // The shell's own requests never answer here, so only this test says when the daemon comes and goes.
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const app = document.createElement("inc-app");
    document.body.append(app);
    await vi.advanceTimersByTimeAsync(50);
    /** The refetches of every view that coming back (`report(true)`) asks for. */
    const refetchesOnReturn = (): number => {
      let n = 0;
      const onRefresh = (e: Event) => {
        if ((e as CustomEvent).detail == null) n++; // everything, not some tickets
      };
      refresh.addEventListener("refresh", onRefresh);
      report(true);
      refresh.removeEventListener("refresh", onRefresh);
      return n;
    };
    report(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(refetchesOnReturn()).toBe(0);

    report(false);
    await vi.advanceTimersByTimeAsync(timing.refreshAfterMs);
    expect(refetchesOnReturn()).toBe(1);
  });
});
