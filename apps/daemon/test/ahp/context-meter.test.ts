// The context reading's throttle: the newest reading, at most every few seconds, only on a change, and never left behind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_EVERY_MS, ContextMeter } from "../../src/ahp/context-meter.ts";

describe("the context meter", () => {
  let sent: unknown[];
  let open: boolean;
  const meter = () =>
    new ContextMeter(
      () => {
        if (open) sent.push(m.latest?.contextUsed);
        return open;
      },
      () => Date.now(),
    );
  let m: ContextMeter;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    open = true;
    m = meter();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first reading at once", () => {
    m.note(10, 100);
    expect(sent).toEqual([10]);
  });

  it("sends the newest of a burst when the wait is over, so a quiet agent's last reading gets out", () => {
    m.note(10, 100);
    m.note(11, 100);
    m.note(12, 100);
    expect(sent).toEqual([10]);
    vi.advanceTimersByTime(CONTEXT_EVERY_MS - 1);
    expect(sent).toEqual([10]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([10, 12]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing when the reading didn't change", () => {
    m.note(10, 100);
    vi.advanceTimersByTime(CONTEXT_EVERY_MS * 3);
    m.note(10, 100);
    expect(sent).toEqual([10]);
  });

  it("takes a new context size as a change", () => {
    m.note(10, 100);
    vi.advanceTimersByTime(CONTEXT_EVERY_MS);
    m.note(10, 200);
    expect(sent).toEqual([10, 10]);
  });

  it("says nothing when the reading went back to what was sent", () => {
    m.note(10, 100);
    m.note(11, 100);
    m.note(10, 100);
    vi.advanceTimersByTime(CONTEXT_EVERY_MS);
    expect(sent).toEqual([10]);
  });

  it("flushes what is held back, once", () => {
    m.note(10, 100);
    m.note(11, 100);
    m.flush();
    m.flush();
    expect(sent).toEqual([10, 11]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is quiet once stopped", () => {
    m.note(10, 100);
    m.note(11, 100);
    m.stop();
    vi.advanceTimersByTime(CONTEXT_EVERY_MS * 2);
    expect(sent).toEqual([10]);
  });

  it("a reading that was dropped doesn't count as sent", () => {
    open = false;
    m.note(10, 100);
    open = true;
    m.note(10, 100);
    expect(sent).toEqual([10]);
  });
});
