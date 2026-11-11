// One failed request is not the daemon being away (api.ts, connection.ts). Behind Tailscale serve the
// owner's browser dropped its HTTP/2 connections many times a minute, and each drop flashed the
// "Can't reach i.inc" banner. Now a read is sent once more, a failure that stays is checked with
// health probes, an answer from anywhere calls the check off, a write is never sent twice, and what is
// kept for debugging holds no query string.
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, call, login, netFailures, refresh, send, signup } from "../src/api.ts";
import "../src/components/app.ts";
import "../src/components/offline.ts";
import { LOAD_STATE, Loader, type LoadState, UNANSWERED_RETRIES } from "../src/components/loader.ts";
import {
  connection,
  isDoubted,
  isOffline,
  report,
  suspect,
  timing,
  Unanswered,
  Unreachable,
} from "../src/connection.ts";
import { ghCall } from "../src/github-projects.ts";

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

  // Each of these parses the body itself, so the proxy's text would read as the daemon's (unexplained) refusal.
  for (const [what, path, go] of [
    [
      "a GitHub call (ghCall)",
      "/api/projects/github/repos",
      () => ghCall("GET", "/api/projects/github/repos"),
    ],
    [
      "a ticket with images (upload)",
      "/api/tickets",
      () => api.createTicket({ title: "t" } as never, [new File(["x"], "a.png")]),
    ],
    ["signing in", "/api/login", () => login("me", "pw")],
    ["signing up", "/api/signup", () => signup("me", "pw")],
  ] as const) {
    it(`is "Can't reach i.inc" for ${what}`, async () => {
      serve({ [path]: [gateway], "/api/health": [ok] });
      const p = (go as () => Promise<unknown>)().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(timing.retryMs);
      expect(await p).toBeInstanceOf(Unreachable);
    });
  }
});

class TestThing extends Loader<{ n: number }> {
  protected fetch() {
    return call<{ n: number }>("GET", "/api/thing");
  }
  /** What a view about something else does (another ticket). */
  switchTo() {
    this.resetLoad();
    void this.reload();
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

  it(`runs again by itself at most ${UNANSWERED_RETRIES} times while the daemon answers but the view's request doesn't`, async () => {
    serve({ "/api/thing": [drop], "/api/health": [ok] });
    const el = await mount();
    await vi.advanceTimersByTimeAsync(10_000);
    await el.updateComplete;
    expect(callsTo("/api/thing")).toHaveLength(2 * (1 + UNANSWERED_RETRIES));
    expect(shown(el)).toMatch(/^Couldn't load the thing: Can't reach i\.inc/);
    expect(isOffline()).toBe(false);
  });

  it("waits for the probes again after the owner presses Try again, once it has run out of tries", async () => {
    serve({ "/api/thing": [drop], "/api/health": [ok] });
    const el = await mount();
    await vi.advanceTimersByTimeAsync(10_000);
    await el.updateComplete;
    expect(shown(el)).toMatch(/^Couldn't load the thing/);

    serve({ "/api/thing": [drop, drop, answer(5)], "/api/health": [ok] });
    el.shadowRoot?.querySelector("button")?.click();
    await vi.advanceTimersByTimeAsync(timing.retryMs + 50);
    await el.updateComplete;
    expect(shown(el)).toBe("thing 5");
  });

  for (const [what, between] of [
    ["the view is about something else now", (el: TestThing) => el.switchTo()],
    [
      "the daemon answered meanwhile, even with a refusal",
      async (el: TestThing) => {
        serve({ "/api/thing": [() => new Response('{"error":"busy"}', { status: 500 })] });
        void el.reload();
        await vi.advanceTimersByTimeAsync(10);
      },
    ],
  ] as const) {
    it(`waits for the probes again once ${what}, after running out of tries`, async () => {
      serve({ "/api/thing": [drop], "/api/health": [ok] });
      const el = await mount();
      await vi.advanceTimersByTimeAsync(10_000);
      await between(el);
      serve({ "/api/thing": [drop, drop, answer(6)], "/api/health": [ok] });
      void el.reload();
      await vi.advanceTimersByTimeAsync(timing.retryMs + 50);
      await el.updateComplete;
      expect(shown(el)).toBe("thing 6");
    });
  }
});

describe("a view that isn't a Loader (Unanswered)", () => {
  /** Fails one load with `e` while a doubt runs, and says whether the doubt called off ran it again. */
  function failInDoubt(u: Unanswered, e: unknown, ran: { n: number }): boolean {
    const before = ran.n;
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    suspect();
    u.failed(e);
    report(true);
    return ran.n > before;
  }

  it(`loads again on a doubt called off, ${UNANSWERED_RETRIES} times in a row at most, until answered or asked again`, () => {
    const ran = { n: 0 };
    const u = new Unanswered(() => ran.n++);
    u.connect();
    try {
      expect(failInDoubt(u, new Unreachable(), ran)).toBe(true);
      expect(failInDoubt(u, new Unreachable(), ran)).toBe(true);
      expect(failInDoubt(u, new Unreachable(), ran)).toBe(false); // out of tries
      u.reset(); // the owner pressed Try again
      expect(failInDoubt(u, new Unreachable(), ran)).toBe(true);
      expect(failInDoubt(u, new Unreachable(), ran)).toBe(true);
      expect(failInDoubt(u, new Error("the daemon refused"), ran)).toBe(false); // an answer: the count starts over
      expect(failInDoubt(u, new Unreachable(), ran)).toBe(true);
      // a doubt called off with nothing held runs nothing
      suspect();
      report(true);
      expect(ran.n).toBe(5);
    } finally {
      u.disconnect();
    }
    expect(failInDoubt(u, new Unreachable(), ran)).toBe(false); // gone from the page
  });
});

describe("the offline banner's own retry", () => {
  it("asks /api/health, as the probes do, so a daemon whose health fails doesn't flap back online", async () => {
    serve({ "/api/health": [drop], "/api/auth": [ok] });
    report(false);
    const banner = document.createElement("inc-offline");
    document.body.append(banner);
    await vi.advanceTimersByTimeAsync(3000 + timing.retryMs + 10);
    expect(callsTo("/api/health").length).toBeGreaterThan(0);
    expect(callsTo("/api/auth")).toHaveLength(0);
    expect(isOffline()).toBe(true);

    serve({ "/api/health": [ok] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(isOffline()).toBe(false);
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

  it("refetches every view when the daemon is back from a confirmed outage, at once", async () => {
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
    // A doubt called off is no outage: only the views that failed load again (the loader's own tests).
    suspect();
    await vi.advanceTimersByTimeAsync(500);
    expect(isDoubted()).toBe(true);
    expect(refetchesOnAnswer()).toBe(0);

    // Every probe failed: offline. An answer right after still refetches everything.
    suspect();
    await vi.advanceTimersByTimeAsync(2510);
    expect(isOffline()).toBe(true);
    expect(refetchesOnAnswer()).toBe(1);
  });
});
