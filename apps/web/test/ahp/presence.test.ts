// "I am looking at this conversation" (T65): the page tells the host while it is visible and focused, on a
// heartbeat, and the moment it is not; a tap on a notification is followed only to a same-origin address.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { browserPage, HEARTBEAT_MS, IDLE_MS, type PageEnv, startPresence } from "../../src/ahp/presence.ts";
import { notificationTarget } from "../../src/register-sw.ts";
import { hosts, SESSION, tick, until } from "./fake-host.ts";

function fakePage(initial = true) {
  let looking = initial;
  const fns = new Set<() => void>();
  const env: PageEnv = {
    looking: () => looking,
    onChange: (fn) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
  return {
    env,
    set(v: boolean) {
      looking = v;
      for (const fn of [...fns]) fn();
    },
    listeners: () => fns.size,
  };
}

function fakeConn(open = true) {
  const sent: boolean[] = [];
  let info = { status: open ? "open" : "reconnecting" } as AhpConnection["info"];
  const listeners = new Set<(i: AhpConnection["info"]) => void>();
  return {
    sent,
    conn: {
      get info() {
        return info;
      },
      reportPresence: (_session: string, looking: boolean) => {
        sent.push(looking);
      },
      onInfo: (fn: (i: AhpConnection["info"]) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    set(status: AhpConnection["info"]["status"]) {
      info = { ...info, status };
      for (const fn of [...listeners]) fn(info);
    },
  };
}

describe("startPresence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports at once, on the heartbeat while visible and focused, and the moment it is not", () => {
    const page = fakePage(true);
    const c = fakeConn();
    const stop = startPresence(c.conn, SESSION, page.env);
    expect(c.sent).toEqual([true]);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(c.sent).toEqual([true, true, true]);
    page.set(false);
    expect(c.sent.at(-1)).toBe(false);
    const n = c.sent.length;
    // a hidden page stays quiet: the host lets the last report lapse by itself
    vi.advanceTimersByTime(HEARTBEAT_MS * 4);
    expect(c.sent).toHaveLength(n);
    page.set(true);
    expect(c.sent.at(-1)).toBe(true);
    stop();
    expect(c.sent.at(-1)).toBe(false);
    expect(page.listeners()).toBe(0);
    vi.advanceTimersByTime(HEARTBEAT_MS * 4);
    expect(c.sent.at(-1)).toBe(false);
  });

  it("reports again when the connection is back, since the new connection knows nothing", () => {
    const c = fakeConn();
    startPresence(c.conn, SESSION, fakePage(true).env);
    c.set("reconnecting");
    expect(c.sent).toEqual([true]);
    c.set("open");
    expect(c.sent).toEqual([true, true]);
  });

  it("stops reporting once the page is idle, and starts again with the next touch", () => {
    // visible and focused, but nobody there: a laptop left open on the conversation
    vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
    const c = fakeConn();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const stopIdle = startPresence(c.conn, SESSION, browserPage);
    expect(c.sent).toEqual([true]);
    vi.advanceTimersByTime(IDLE_MS - HEARTBEAT_MS);
    expect(c.sent.every(Boolean)).toBe(true);
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(c.sent.at(-1)).toBe(false);
    const quiet = c.sent.length;
    vi.advanceTimersByTime(HEARTBEAT_MS * 6);
    expect(c.sent).toHaveLength(quiet);
    // a touch: reading again
    window.dispatchEvent(new Event("pointerdown"));
    expect(c.sent.at(-1)).toBe(true);
    stopIdle();
    vi.restoreAllMocks();
  });

  it("is a heartbeat well inside the host's 45 seconds", () => {
    expect(HEARTBEAT_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("reportPresence on the connection", () => {
  afterEach(() => vi.useRealTimers());

  it("sends iinc/presence as a notification, only while the socket is open", async () => {
    const h = hosts();
    const c = new AhpConnection({ connect: h.connect, clientId: "me", backoff: () => 5, pingMs: 0 });
    c.reportPresence(SESSION, true);
    c.start();
    await until(() => c.info.status === "open");
    c.reportPresence(SESSION, true);
    c.reportPresence(SESSION, false);
    await tick(20);
    const host = h.made[0];
    const seen = host?.received.filter((m) => m.method === "iinc/presence") ?? [];
    expect(seen.map((m) => m.params)).toEqual([
      { visible: true, focused: true, channel: SESSION },
      { visible: false, focused: false, channel: SESSION },
    ]);
    expect(seen.every((m) => m.id === undefined)).toBe(true);
    c.stop();
  });
});

describe("following a tap on a notification", () => {
  const origin = "https://app.test";
  it("goes to the hash of a same-origin address", () => {
    expect(
      notificationTarget({ type: "i-inc:open", url: `${origin}/#/conversations/ab12cd34?card=tc1` }, origin),
    ).toBe("#/conversations/ab12cd34?card=tc1");
  });
  it("ignores anything else", () => {
    expect(notificationTarget({ type: "other", url: `${origin}/#/x` }, origin)).toBeNull();
    expect(
      notificationTarget({ type: "i-inc:open", url: "https://evil.test/#/conversations/a" }, origin),
    ).toBeNull();
    expect(notificationTarget({ type: "i-inc:open", url: `${origin}/phish` }, origin)).toBeNull();
    expect(notificationTarget({ type: "i-inc:open", url: 5 }, origin)).toBeNull();
    expect(notificationTarget(null, origin)).toBeNull();
    expect(notificationTarget("i-inc:open", origin)).toBeNull();
  });
});
