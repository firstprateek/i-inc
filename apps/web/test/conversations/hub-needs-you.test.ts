import { afterEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { ahpUrl, resetAhp, STOP_AFTER_MS, setAhp, useAhp } from "../../src/ahp/hub.ts";
import { needsYouCount } from "../../src/needs-you.ts";
import { hosts } from "../ahp/fake-host.ts";

afterEach(() => {
  vi.useRealTimers();
  resetAhp();
});

describe("the shared connection", () => {
  it("is the page's own origin, with wss on https", () => {
    expect(ahpUrl({ protocol: "http:", host: "127.0.0.1:7420" })).toBe("ws://127.0.0.1:7420/ahp");
    expect(ahpUrl({ protocol: "https:", host: "iinc.example.ts.net" })).toBe("wss://iinc.example.ts.net/ahp");
  });

  it("opens with the first lease and closes a few seconds after the last, leaving nothing behind", async () => {
    vi.useFakeTimers();
    const h = hosts();
    const c = new AhpConnection({ connect: h.connect, pingMs: 0, backoff: () => 5 });
    setAhp(c);
    const a = useAhp();
    const b = useAhp();
    await vi.advanceTimersByTimeAsync(50);
    expect(c.info.status).toBe("open");
    a();
    a(); // releasing twice is harmless
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS + 100);
    expect(c.info.status).toBe("open"); // b still holds it
    b();
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS - 100);
    expect(c.info.status).toBe("open"); // a grace period, so a route change does not thrash the socket
    const again = useAhp(); // coming back in time keeps the same socket
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS + 100);
    expect(c.info.status).toBe("open");
    again();
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS + 100);
    expect(c.info.status).toBe("stopped");
    expect(h.made).toHaveLength(1);
  });
});

describe("the Needs you count", () => {
  it("counts conversations waiting for a permission or an answer", () => {
    expect(needsYouCount([], [], [], [{ needsYou: true }, { needsYou: false }, { needsYou: true }])).toBe(2);
    expect(needsYouCount([], [], [])).toBe(0);
  });
});
