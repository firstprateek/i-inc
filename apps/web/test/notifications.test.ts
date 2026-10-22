// Taking down notifications that are not true any more (T65): the app does it when it is opened or comes back
// into view, because Apple's push service cannot be sent a "resolve" push.
import { describe, expect, it, vi } from "vitest";
import { closeStaleNotifications, conversationOf, type NotificationEnv } from "../src/notifications.ts";

const note = (id: string, card = true) => ({
  tag: `conv-${id}`,
  data: { url: `#/conversations/${id}${card ? "?card=tc1" : ""}` },
  close: vi.fn(),
});

function env(shown: ReturnType<typeof note>[], rows: { id: string; needsYou: boolean }[] | Error) {
  const e: NotificationEnv = {
    registration: async () => ({ getNotifications: async () => shown as never }),
    conversations: async () => {
      if (rows instanceof Error) throw rows;
      return rows as never;
    },
  };
  return e;
}

describe("closeStaleNotifications", () => {
  it("closes a card notification whose conversation is not waiting any more, and keeps one that is", async () => {
    const answered = note("aaaaaaaa");
    const waiting = note("bbbbbbbb");
    const gone = note("cccccccc");
    const closed = await closeStaleNotifications(
      "",
      env(
        [answered, waiting, gone],
        [
          { id: "aaaaaaaa", needsYou: false },
          { id: "bbbbbbbb", needsYou: true },
        ],
      ),
    );
    expect(closed).toBe(2);
    expect(answered.close).toHaveBeenCalled();
    expect(gone.close).toHaveBeenCalled();
    expect(waiting.close).not.toHaveBeenCalled();
  });

  it("keeps a 'finished' notification (no card) until its conversation is opened", async () => {
    const finished = note("aaaaaaaa", false);
    expect(await closeStaleNotifications("", env([finished], [{ id: "aaaaaaaa", needsYou: false }]))).toBe(0);
    expect(await closeStaleNotifications("aaaaaaaa", env([finished], []))).toBe(1);
  });

  it("closes everything of the conversation that is open in front of the owner", async () => {
    const mine = note("aaaaaaaa");
    const other = note("bbbbbbbb");
    const c = await closeStaleNotifications(
      "aaaaaaaa",
      env(
        [mine, other],
        [
          { id: "aaaaaaaa", needsYou: true },
          { id: "bbbbbbbb", needsYou: true },
        ],
      ),
    );
    expect(c).toBe(1);
    expect(mine.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it("closes nothing it cannot be sure of (the daemon unreachable), and ignores other tags and no worker", async () => {
    const n = note("aaaaaaaa");
    expect(await closeStaleNotifications("", env([n], new Error("offline")))).toBe(0);
    expect(n.close).not.toHaveBeenCalled();
    const ticket = { tag: "#/ticket/7", data: { url: "#/ticket/7" }, close: vi.fn() };
    expect(await closeStaleNotifications("", env([ticket as never], []))).toBe(0);
    expect(
      await closeStaleNotifications("", {
        registration: async () => undefined,
        conversations: async () => [],
      }),
    ).toBe(0);
  });

  it("reads the conversation from an address", () => {
    expect(conversationOf("#/conversations/ab12cd34")).toBe("ab12cd34");
    expect(conversationOf("#/conversations/AB12CD34?card=tc1")).toBe("ab12cd34");
    expect(conversationOf("#/conversations")).toBe("");
    expect(conversationOf("#/needs-you")).toBe("");
  });
});
