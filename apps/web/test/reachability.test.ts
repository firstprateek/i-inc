// One failed request is not the daemon being away (api.ts, connection.ts). Behind Tailscale serve the
// owner's browser dropped its HTTP/2 connections many times a minute, and each drop flashed the
// "Can't reach i.inc" banner. Now a read is sent once more, a failure that stays is checked with
// health probes, an answer from anywhere calls the check off, a write is never sent twice, and what is
// kept for debugging holds no query string.
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { call, netFailures, refresh, send } from "../src/api.ts";
import "../src/components/app.ts";
import { LOAD_STATE, Loader, type LoadState, UNANSWERED_RETRIES } from "../src/components/loader.ts";
import { connection, isDoubted, isOffline, report, suspect, timing, Unreachable } from "../src/connection.ts";

const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const answer = (n: number) => () =>
  new Response(JSON.stringify({ n }), { status: 200, headers: { "content-type": "application/json" } });
/** A request that gets no answer until it is called off (the probe's own timeout, or the caller). */
const hang = (init?: RequestInit): Promise<Response> =>
  new Promise((_, reject) =>
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
  );
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

const realTiming = { ...timing };
beforeEach(() => {
  vi.useFakeTimers();
  // Every doubt called off reloads every view at once; the gap between two has a test of its own.
  timing.clearedRefreshGapMs = 0;
  report(true);
  changes = 0;
  connection.addEventListener("change", onChange);
});
afterEach(() => {
  connection.removeEventListener("change", onChange);
  report(true);
  Object.assign(timing, realTiming);
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

describe("the doubt itself", () => {
  it("says it is over with `cleared` when an answer calls it off, and only then", async () => {
    let cleared = 0;
    const onCleared = () => cleared++;
    connection.addEventListener("cleared", onCleared);
    try {
      serve({ "/api/board/summary": [drop], "/api/health": [drop] });
      report(true); // no doubt: nothing to clear
      expect(cleared).toBe(0);
      await sent("/api/board/summary");
      expect(isDoubted()).toBe(true);
      report(true);
      expect(isDoubted()).toBe(false);
      expect(cleared).toBe(1);
      report(true);
      expect(cleared).toBe(1);
    } finally {
      connection.removeEventListener("cleared", onCleared);
    }
  });

  it("is not started by a request its caller called off, which is not sent again", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ path: String(url), method: init?.method ?? "GET" });
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return ok();
    });
    calls = [];
    const stop = new AbortController();
    stop.abort();
    const res = await sent("/api/board/summary", { signal: stop.signal });
    expect((res as Error).name).toBe("AbortError");
    expect(callsTo("/api/board/summary")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(callsTo("/api/health")).toHaveLength(0);
    expect(isDoubted()).toBe(false);
  });

  it("gives up on a probe with no answer, so a hung daemon is found away", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => hang(init));
    suspect();
    await vi.advanceTimersByTimeAsync(timing.probesMs.at(-1) ?? 0);
    expect(isOffline()).toBe(false);
    await vi.advanceTimersByTimeAsync(timing.probeTimeoutMs + 10);
    expect(isOffline()).toBe(true);
  });

  it("ignores probes from a doubt that was called off when they fail later", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => hang(init));
    suspect();
    await vi.advanceTimersByTimeAsync((timing.probesMs.at(-1) ?? 0) + 10); // every probe is out
    report(true); // something else answered
    await vi.advanceTimersByTimeAsync(timing.probeTimeoutMs * 2); // and then they all time out
    expect(isOffline()).toBe(false);
    expect(changes).toBe(0);
  });
});

describe("a call the proxy answered for", () => {
  it("is \"Can't reach i.inc\" after two 502s, not a JSON parse error from the proxy's text", async () => {
    serve({ "/api/board/summary": [gateway], "/api/health": [ok] });
    const p = call("GET", "/api/board/summary").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(timing.retryMs);
    const e = await p;
    expect(e).toBeInstanceOf(Unreachable);
    expect((e as Error).message).toBe("Can't reach i.inc");
  });
});

class TestThing extends Loader<{ n: number }> {
  protected fetch() {
    return call<{ n: number }>("GET", "/api/thing");
  }
  override render() {
    if (this.data) return html`<p>thing ${this.data.n}</p>`;
    return this.error !== null ? this.failure("the thing") : html`<p>Loading</p>`;
  }
}
customElements.define("test-reach-thing", TestThing);

describe("a view whose load got no answer", () => {
  let messages: (string | null)[] = [];
  const onState = (e: Event) => messages.push((e as CustomEvent<LoadState>).detail.message);
  beforeEach(() => {
    messages = [];
    document.addEventListener(LOAD_STATE, onState);
  });
  afterEach(() => document.removeEventListener(LOAD_STATE, onState));

  async function mount(): Promise<TestThing> {
    const el = document.createElement("test-reach-thing") as TestThing;
    document.body.append(el);
    await vi.advanceTimersByTimeAsync(timing.retryMs + 10);
    await el.updateComplete;
    return el;
  }
  const shown = (el: TestThing) => el.shadowRoot?.textContent?.replace(/\s+/g, " ").trim() ?? "";

  for (const [what, fail] of [
    ["dropped twice", drop],
    ["answered 502 twice by the proxy", gateway],
  ] as const) {
    it(`loads again, with no banner, once the daemon answers a probe (${what})`, async () => {
      serve({ "/api/thing": [answer(1)] });
      const el = await mount();
      expect(el.data).toEqual({ n: 1 });

      serve({ "/api/thing": [fail, fail, answer(2)], "/api/health": [ok] });
      void el.reload();
      await vi.advanceTimersByTimeAsync(timing.retryMs + 50);
      await el.updateComplete;
      expect(callsTo("/api/health")).toHaveLength(1);
      expect(el.data).toEqual({ n: 2 });
      expect(callsTo("/api/thing")).toHaveLength(3); // loaded once more, not once for each way of hearing of it
      expect(messages.filter((m) => m !== null)).toEqual([]);
      expect(isOffline()).toBe(false);
    });
  }

  it('loads for the first time once the daemon answers, never showing "Can\'t reach"', async () => {
    serve({ "/api/thing": [drop, drop, answer(3)], "/api/health": [ok] });
    const el = await mount();
    await vi.advanceTimersByTimeAsync(50);
    await el.updateComplete;
    expect(el.error).toBeNull();
    expect(shown(el)).toBe("thing 3");
  });

  it("waits behind the shell's banner when the daemon is away", async () => {
    serve({ "/api/thing": [answer(1)] });
    const kept = await mount();
    serve({ "/api/thing": [drop], "/api/health": [drop] });
    const first = document.createElement("test-reach-thing") as TestThing;
    document.body.append(first);
    void kept.reload();
    await vi.advanceTimersByTimeAsync(timing.retryMs + 10);
    // while the probes decide, neither says anything
    expect(messages.filter((m) => m !== null)).toEqual([]);
    expect(first.error).toBeNull();
    await vi.advanceTimersByTimeAsync((timing.probesMs.at(-1) ?? 0) + 10);
    await first.updateComplete;
    expect(isOffline()).toBe(true);
    // offline: the kept view's failure goes to the shell (its offline banner wins), the new one says why it's empty
    expect(messages.filter((m) => m !== null)).toEqual(["Can't reach i.inc"]);
    expect(shown(first)).toMatch(/^Nothing has loaded yet\. The thing loads when i\.inc answers\./);
  });

  it(`waits at most ${UNANSWERED_RETRIES} times in a row while the daemon answers but the view's request doesn't, and reloads no faster than the gap`, async () => {
    const gap = 3000;
    timing.clearedRefreshGapMs = gap;
    await vi.advanceTimersByTimeAsync(gap); // past the last test's reload
    serve({ "/api/thing": [drop], "/api/health": [ok] });
    const el = await mount();
    // loads at about +0, +0.25 s and +3.25 s (the gap after the first reload): then it says so
    await vi.advanceTimersByTimeAsync(gap + 1000);
    await el.updateComplete;
    expect(callsTo("/api/thing")).toHaveLength(2 * (1 + UNANSWERED_RETRIES));
    expect(shown(el)).toMatch(/^Couldn't load the thing: Can't reach i\.inc/);
    expect(isOffline()).toBe(false);
    // each failure still starts a doubt that the daemon calls off, but every view loads again once a gap at most
    await vi.advanceTimersByTimeAsync(3 * gap);
    expect(callsTo("/api/thing").length).toBeLessThanOrEqual(2 * (1 + UNANSWERED_RETRIES) + 2 * 3);
  });
});

describe("every view loading again for a doubt called off", () => {
  let refreshes = 0;
  const onRefresh = (e: Event) => {
    if ((e as CustomEvent).detail == null) refreshes++; // everything, not some tickets
  };
  beforeEach(() => {
    refreshes = 0;
    refresh.addEventListener("refresh", onRefresh);
  });
  afterEach(() => refresh.removeEventListener("refresh", onRefresh));

  it("happens at once, for a view that is not a Loader too", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => hang(init));
    suspect();
    expect(refreshes).toBe(0);
    report(true);
    expect(refreshes).toBe(1);
    report(true); // no doubt: nothing to load again
    expect(refreshes).toBe(1);
  });

  it("happens once a gap at most, however many doubts are called off, and none is lost", async () => {
    const gap = 3000;
    timing.clearedRefreshGapMs = gap;
    await vi.advanceTimersByTimeAsync(gap); // past the last test's
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => hang(init));
    const doubtCalledOff = () => {
      suspect();
      report(true);
    };
    doubtCalledOff();
    expect(refreshes).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    doubtCalledOff();
    doubtCalledOff();
    expect(refreshes).toBe(1);
    await vi.advanceTimersByTimeAsync(gap - 1000 - 10);
    expect(refreshes).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(refreshes).toBe(2); // the two at +1 s, as one
    await vi.advanceTimersByTimeAsync(gap * 3);
    expect(refreshes).toBe(2);
    doubtCalledOff(); // long after: at once again
    expect(refreshes).toBe(3);
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

  it("refetches every view when a doubt is called off, and when the daemon is back from a confirmed outage, at once", async () => {
    // The shell's own requests never answer here, so only this test says when the daemon comes and goes.
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url) === "/api/health" ? Promise.reject(new TypeError("Failed to fetch")) : hang(init),
    );
    const app = document.createElement("inc-app");
    document.body.append(app);
    await vi.advanceTimersByTimeAsync(50);
    /** The refetches of every view that the daemon answering (`report(true)`) asks for. */
    const refetchesOnAnswer = (): number => {
      let n = 0;
      const onRefresh = (e: Event) => {
        if ((e as CustomEvent).detail == null) n++; // everything, not some tickets
      };
      refresh.addEventListener("refresh", onRefresh);
      report(true);
      refresh.removeEventListener("refresh", onRefresh);
      return n;
    };
    // A doubt called off is no outage, and shows no banner, but it began with a request that got no answer: every
    // view loads again, as the Conversations list (not a Loader) needs.
    suspect();
    await vi.advanceTimersByTimeAsync(500);
    expect(isDoubted()).toBe(true);
    expect(refetchesOnAnswer()).toBe(1);
    expect(isOffline()).toBe(false);

    // Every probe failed: offline. An answer right after still refetches everything.
    suspect();
    await vi.advanceTimersByTimeAsync(2510);
    expect(isOffline()).toBe(true);
    expect(refetchesOnAnswer()).toBe(1);
  });
});
