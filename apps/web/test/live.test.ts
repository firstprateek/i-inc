// The live event stream: dispatch, debounce, reconnect, and the polling it replaces and falls back to.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RefreshScope, refresh } from "../src/api.ts";
import { Loader } from "../src/components/loader.ts";
import { report } from "../src/connection.ts";
import { Live, startLiveUpdates } from "../src/live.ts";

class FakeEventSource {
  static all: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  // Test controls.
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
  emit(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? [])
      fn(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}
const sources = () => FakeEventSource.all;
const latest = () => FakeEventSource.all[FakeEventSource.all.length - 1] as FakeEventSource;

let refreshes: (RefreshScope | null)[] = [];
const onRefresh = (e: Event) => refreshes.push((e as CustomEvent<RefreshScope | null>).detail);

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
  refreshes = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  refresh.addEventListener("refresh", onRefresh);
  report(true);
});

afterEach(() => {
  refresh.removeEventListener("refresh", onRefresh);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Live", () => {
  it("opens one EventSource on /api/events and dispatches events to subscribers", () => {
    const live = new Live();
    const tickets: unknown[] = [];
    const offices: unknown[] = [];
    live.subscribe("ticket", (d) => tickets.push(d));
    live.subscribe("office", (d) => offices.push(d));
    live.start();
    live.start();
    expect(sources()).toHaveLength(1);
    expect(latest().url).toBe("/api/events");
    latest().open();
    expect(live.connected).toBe(true);
    latest().emit("ticket", { id: "7" });
    latest().emit("office", {});
    expect(tickets).toEqual([{ id: "7" }]);
    expect(offices).toEqual([{}]);
  });

  it("stops delivering after unsubscribe", () => {
    const live = new Live();
    const seen: unknown[] = [];
    const off = live.subscribe("ticket", (d) => seen.push(d));
    live.start();
    off();
    latest().emit("ticket", { id: "1" });
    expect(seen).toEqual([]);
  });

  it("reconnects with a growing backoff and reports the reopen as a reconnect", () => {
    const live = new Live();
    const status: [boolean, boolean][] = [];
    live.onStatus((c, r) => status.push([c, r]));
    live.start();
    latest().open();
    latest().fail();
    expect(live.connected).toBe(false);
    expect(sources()).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sources()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources()).toHaveLength(2);
    latest().fail(); // never opened: next wait is 2 s
    vi.advanceTimersByTime(1999);
    expect(sources()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources()).toHaveLength(3);
    latest().open();
    expect(live.connected).toBe(true);
    expect(status).toEqual([
      [true, false],
      [false, false],
      [true, true],
    ]);
  });

  it("retries at once when the daemon becomes reachable again", () => {
    const live = new Live();
    live.start();
    latest().fail();
    report(false);
    report(true);
    expect(sources()).toHaveLength(2);
  });

  it("does nothing without EventSource", () => {
    vi.stubGlobal("EventSource", undefined);
    const live = new Live();
    live.start();
    expect(live.connected).toBe(false);
  });
});

describe("startLiveUpdates", () => {
  it("collapses a burst of events into one refetch scoped to what changed", () => {
    const stop = startLiveUpdates(new Live());
    latest().open();
    latest().emit("ticket", { id: "1" });
    vi.advanceTimersByTime(100);
    latest().emit("ticket", { id: "2" });
    latest().emit("ticket", { id: "1" });
    latest().emit("office", {});
    vi.advanceTimersByTime(199);
    expect(refreshes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toEqual({ tickets: new Set(["1", "2"]), office: true });
    stop();
  });

  it("refetches everything for a ticket event without an id", () => {
    const stop = startLiveUpdates(new Live());
    latest().open();
    latest().emit("ticket", {});
    vi.advanceTimersByTime(300);
    expect(refreshes).toEqual([null]);
    stop();
  });

  it("does not poll every 5 s while the stream is up, only as a 60 s safety net", () => {
    const stop = startLiveUpdates(new Live());
    latest().open();
    vi.advanceTimersByTime(55_000);
    expect(refreshes).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(refreshes).toHaveLength(1);
    stop();
  });

  it("polls every 5 s while the stream never connects, as before", () => {
    const stop = startLiveUpdates(new Live());
    latest().fail(); // a 404 closes the source without ever opening
    vi.advanceTimersByTime(15_000);
    expect(refreshes.length).toBeGreaterThanOrEqual(3);
    stop();
  });

  it("falls back to polling when there is no EventSource at all", () => {
    vi.stubGlobal("EventSource", undefined);
    const stop = startLiveUpdates(new Live());
    vi.advanceTimersByTime(10_000);
    expect(refreshes).toHaveLength(2);
    stop();
  });

  it("resumes the 5 s poll when the stream drops, and refetches when it comes back", () => {
    const stop = startLiveUpdates(new Live());
    latest().open();
    latest().fail();
    vi.advanceTimersByTime(5000);
    expect(refreshes).toHaveLength(1);
    vi.advanceTimersByTime(0);
    const before = refreshes.length;
    vi.advanceTimersByTime(1000); // backoff over: reconnecting
    latest().open();
    expect(refreshes.length).toBe(before + 1);
    stop();
  });

  it("does not refetch on the first open, the views have just loaded", () => {
    const stop = startLiveUpdates(new Live());
    latest().open();
    expect(refreshes).toHaveLength(0);
    stop();
  });

  it("stops the stream and the timers", () => {
    const stop = startLiveUpdates(new Live());
    const es = latest();
    stop();
    expect(es.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(refreshes).toHaveLength(0);
  });
});

describe("Loader scope", () => {
  class Probe extends Loader<number> {
    loads = 0;
    protected async fetch() {
      return ++this.loads;
    }
  }
  customElements.define("inc-probe", Probe);

  it("a ticket view refetches only for its own ticket; others for any event", async () => {
    const plain = document.createElement("inc-probe") as Probe;
    const one = document.createElement("inc-probe") as Probe;
    one.ticketId = "1";
    document.body.append(plain, one);
    await vi.advanceTimersByTimeAsync(0);
    expect([plain.loads, one.loads]).toEqual([1, 1]);

    const stop = startLiveUpdates(new Live());
    latest().emit("ticket", { id: "2" });
    await vi.advanceTimersByTimeAsync(300);
    expect([plain.loads, one.loads]).toEqual([2, 1]);

    latest().emit("ticket", { id: "1" });
    await vi.advanceTimersByTimeAsync(300);
    expect([plain.loads, one.loads]).toEqual([3, 2]);
    stop();
    plain.remove();
    one.remove();
  });
});
