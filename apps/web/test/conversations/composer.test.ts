import { afterEach, describe, expect, it, vi } from "vitest";
import { enterSends, type IncConvComposer } from "../../src/components/conv-composer.ts";
import { must } from "../ahp/fake-host.ts";
import "../../src/components/conv-composer.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted protocol state.
type Any = any;

const key = (o: Partial<KeyboardEventInit> & { keyCode?: number } = {}) => {
  const e = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    composed: true,
    ...o,
  });
  if (o.keyCode !== undefined) Object.defineProperty(e, "keyCode", { value: o.keyCode });
  return e;
};

async function mount(over: Partial<IncConvComposer> = {}, chat: Any = { turns: [] }) {
  const el = document.createElement("inc-conv-composer") as IncConvComposer;
  const send = vi.fn(async () => null as string | null);
  el.conversationId = "c1";
  el.name = "Ada";
  el.chat = chat;
  el.onSend = send;
  Object.assign(el, over);
  document.body.append(el);
  await el.updateComplete;
  const ta = el.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement;
  const type = async (text: string) => {
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;
  };
  return { el, ta, send, type };
}

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("Enter in the composer", () => {
  it("sends on Enter, never on Shift+Enter", async () => {
    const { ta, send, type, el } = await mount();
    await type("hello");
    const shift = key({ shiftKey: true });
    ta.dispatchEvent(shift);
    expect(shift.defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    const enter = key();
    ta.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await el.updateComplete;
    expect(send).toHaveBeenCalledWith({ text: "hello", files: [], intent: "turn" });
  });

  it("does not send while an IME is composing, however the browser reports it", async () => {
    const { ta, send, type } = await mount();
    await type("にほん");
    // 1. the key event says it is part of a composition
    ta.dispatchEvent(key({ isComposing: true }));
    // 2. an older engine reports keyCode 229 for the key that confirms a candidate
    ta.dispatchEvent(key({ keyCode: 229 }));
    // 3. between compositionstart and compositionend
    ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    ta.dispatchEvent(key());
    // 4. Safari fires compositionend *before* the Enter keydown that confirmed it, with isComposing false
    ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    ta.dispatchEvent(key());
    expect(send).not.toHaveBeenCalled();
    // a moment later, a real Enter sends
    await new Promise((r) => setTimeout(r, 90));
    ta.dispatchEvent(key());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the rule, on its own", () => {
    const base = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
    expect(enterSends(base, false, false)).toBe(true);
    expect(enterSends({ ...base, shiftKey: true }, false, false)).toBe(false);
    expect(enterSends({ ...base, isComposing: true }, false, false)).toBe(false);
    expect(enterSends({ ...base, keyCode: 229 }, false, false)).toBe(false);
    expect(enterSends(base, true, false)).toBe(false);
    expect(enterSends(base, false, true)).toBe(false); // a phone: Enter is a new line
    expect(enterSends({ ...base, key: "a" }, false, false)).toBe(false);
  });

  it("keeps the text and says why when the send fails", async () => {
    const { ta, send, type, el } = await mount();
    send.mockResolvedValueOnce("Not connected to the host yet.");
    await type("hello");
    ta.dispatchEvent(key());
    await vi.waitFor(() => expect(el.shadowRoot?.textContent).toContain("Not connected"));
    expect(ta.value).toBe("hello");
  });

  it("refuses an oversized message before sending, with the numbers", async () => {
    const { ta, send, type, el } = await mount();
    await type("x".repeat(256_100));
    expect(el.shadowRoot?.textContent).toContain("100 characters over the limit (256,000)");
    ta.dispatchEvent(key());
    await el.updateComplete;
    expect(send).not.toHaveBeenCalled();
    expect(must<HTMLButtonElement>(el.shadowRoot?.querySelector(".send")).disabled).toBe(true);
  });

  it("puts a refused message back in the box, unless something new was typed", async () => {
    const { el, ta, type } = await mount();
    el.restore("lost words");
    await el.updateComplete;
    expect(ta.value).toBe("lost words");
    await type("newer");
    el.restore("other");
    await el.updateComplete;
    expect(ta.value).toBe("newer");
  });

  it("remembers a draft per conversation", async () => {
    const a = await mount();
    await a.type("half a thought");
    expect(localStorage.getItem("inc.chat.draft.conv:c1")).toBe("half a thought");
    document.body.innerHTML = "";
    const b = await mount();
    expect(b.ta.value).toBe("half a thought");
  });
});

describe("while a turn runs", () => {
  const running = {
    turns: [],
    activeTurn: {
      id: "t",
      startedAt: "2026-10-21T10:00:00Z",
      message: { text: "x", origin: {} },
      responseParts: [],
      usage: undefined,
    },
  };
  it("offers Steer and Queue once there is something typed, and Stop always", async () => {
    const { el, type } = await mount({}, running);
    const labels = () =>
      [...(el.shadowRoot?.querySelectorAll(".row button") ?? [])].map(
        (b) => b.textContent?.trim() || b.getAttribute("aria-label"),
      );
    expect(labels()).toContain("Stop");
    expect(labels()).not.toContain("Steer");
    await type("next please");
    expect(labels()).toEqual(expect.arrayContaining(["Steer", "Queue", "Stop"]));
  });
  it("Enter steers, Alt+Enter queues", async () => {
    const { ta, send, type } = await mount({}, running);
    await type("one");
    ta.dispatchEvent(key());
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ text: "one", files: [], intent: "steer" }));
    await type("two");
    ta.dispatchEvent(key({ altKey: true }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ text: "two", files: [], intent: "queue" }));
  });
  it("lists the queue and lets you remove a message", async () => {
    const chat = {
      ...running,
      steeringMessage: { id: "s", message: { text: "go now" } },
      queuedMessages: [{ id: "q1", message: { text: "later" } }],
    };
    const { el } = await mount({}, chat);
    const items = [...(el.shadowRoot?.querySelectorAll(".queue li") ?? [])];
    expect(items.map((i) => i.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Steering, runs nextgo now",
      "Queuedlater",
    ]);
    const removed: Any[] = [];
    el.addEventListener("conv-unqueue", (e) => removed.push((e as CustomEvent).detail));
    must<HTMLButtonElement>(items[1]?.querySelector("button")).click();
    expect(removed).toEqual([{ kind: "queued", id: "q1" }]);
  });
});

describe("slash commands", () => {
  const session: Any = {
    _meta: { "iinc.commands": [{ name: "compact", description: "Compact the chat" }, { name: "review" }] },
  };
  it("opens a popover on / and picks one with the keyboard", async () => {
    const { el, ta, type, send } = await mount({ session });
    await type("/");
    ta.setSelectionRange(1, 1);
    ta.dispatchEvent(new Event("click"));
    await el.updateComplete;
    const options = () =>
      [...(el.shadowRoot?.querySelectorAll('[role="option"]') ?? [])].map(
        (o) => o.querySelector("b")?.textContent,
      );
    expect(options()).toEqual(["/compact", "/review"]);
    ta.dispatchEvent(key({ key: "ArrowDown" }));
    await el.updateComplete;
    ta.dispatchEvent(key()); // Enter picks, it does not send
    await el.updateComplete;
    expect(send).not.toHaveBeenCalled();
    expect(ta.value).toBe("/review ");
    expect(options()).toEqual([]);
  });
});
