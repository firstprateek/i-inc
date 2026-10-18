// The chat's message list is the only thing that scrolls. These tests cover the scroll rules: near-bottom
// detection, following new messages, the "New messages" button, and never scrolling the page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasNewFromOthers, isNearBottom, NEAR_BOTTOM_PX } from "../src/chat-scroll.ts";
import { type Entry, IncChat, type Thread } from "../src/components/chat.ts";

describe("isNearBottom", () => {
  it("is true at the bottom and within the threshold, false beyond it", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600 - NEAR_BOTTOM_PX, clientHeight: 400 })).toBe(
      true,
    );
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600 - NEAR_BOTTOM_PX - 1, clientHeight: 400 })).toBe(
      false,
    );
    expect(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});

describe("hasNewFromOthers", () => {
  const owner: Entry = { from: "owner", at: 1, text: "hi" };
  const reply: Entry = { from: "employee", at: 2, text: "hello" };
  it("counts a new reply or draft, not the owner's own message or an unchanged re-fetch", () => {
    expect(hasNewFromOthers([owner], [owner, reply])).toBe(true);
    expect(hasNewFromOthers([owner, reply], [owner, reply])).toBe(false);
    expect(hasNewFromOthers([reply], [reply, { from: "owner", at: 3, text: "more" }])).toBe(false);
    const sentReply: Entry = { ...reply, status: "sent" };
    expect(hasNewFromOthers([owner], [owner, sentReply])).toBe(true);
    const draft: Entry = {
      from: "employee",
      at: 5,
      kind: "draft",
      ticketId: "7",
      title: "t",
      confirmed: false,
    };
    const confirmed: Entry = { ...draft, confirmed: true };
    expect(hasNewFromOthers([draft], [confirmed])).toBe(false);
  });
});

const threads: Thread[] = [
  { id: "ada", name: "Ada", tint: 0, role: "Lead", last: null },
  { id: "kit", name: "Kit", tint: 1, role: "Design", last: null },
];
const thread = (n: number, base = 1000): Entry[] =>
  Array.from(
    { length: n },
    (_, i) => ({ from: i % 2 ? "employee" : "owner", at: base + i, text: `m${i}` }) as Entry,
  );

let served: Entry[] = [];
beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  served = thread(30);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (url === "/api/chat") return json({ threads });
    if ((init?.method ?? "GET") === "POST") return json({ entries: served });
    return json({ entries: served });
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** happy-dom has no layout, so give the list a fixed viewport (400px) and a content height we control. */
function fakeLayout(msgs: HTMLElement, state: { height: number; top: number }) {
  Object.defineProperty(msgs, "clientHeight", { configurable: true, get: () => 400 });
  Object.defineProperty(msgs, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(msgs, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = Math.min(v, state.height - 400);
    },
  });
}

async function settle(el: IncChat) {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
}

async function mount() {
  if (!customElements.get("inc-chat")) customElements.define("inc-chat", IncChat);
  const el = document.createElement("inc-chat") as IncChat;
  const state = { height: 400, top: 0 };
  el.employeeId = "ada";
  // Lay the list out before the thread's entries arrive, as the browser does.
  document.body.append(el);
  await el.updateComplete;
  const root = el.shadowRoot as ShadowRoot;
  const msgs = root.querySelector(".msgs") as HTMLElement;
  fakeLayout(msgs, state);
  state.height = 3000;
  await settle(el);
  return { el, root, msgs, state };
}

const scrollTo = (msgs: HTMLElement, state: { top: number }, top: number) => {
  state.top = top;
  msgs.dispatchEvent(new Event("scroll"));
};

describe("chat scrolling", () => {
  let windowScroll: ReturnType<typeof vi.spyOn>;
  let intoView: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    intoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = intoView;
  });
  afterEach(() => {
    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("opens a thread at its newest message by scrolling the list, never the page", async () => {
    const { state } = await mount();
    expect(state.top).toBe(3000 - 400);
    expect(windowScroll).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });

  it("scrolls the list region itself: it is a focusable log with its own scrolling", async () => {
    const { msgs } = await mount();
    expect(msgs.getAttribute("role")).toBe("log");
    expect(msgs.getAttribute("tabindex")).toBe("0");
  });

  it("follows a new reply when the reader is near the bottom, and shows no button", async () => {
    const { el, root, msgs, state } = await mount();
    scrollTo(msgs, state, 2600 - 60); // 60px from the bottom
    state.height = 3200;
    served = [...served, { from: "employee", at: 9999, text: "new reply" }];
    el.entries = served;
    await settle(el);
    expect(state.top).toBe(3200 - 400);
    expect(root.querySelector(".jump")).toBeNull();
    expect(windowScroll).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });

  it("holds the position and offers a New messages button when the reader has scrolled up", async () => {
    const { el, root, msgs, state } = await mount();
    scrollTo(msgs, state, 1200);
    state.height = 3200;
    served = [...served, { from: "employee", at: 9999, text: "new reply" }];
    el.entries = served;
    await settle(el);
    expect(state.top).toBe(1200);
    const jump = root.querySelector(".jump") as HTMLButtonElement;
    expect(jump).not.toBeNull();
    expect(jump.textContent).toContain("New messages");

    jump.click();
    await settle(el);
    expect(state.top).toBe(3200 - 400);
    expect(root.querySelector(".jump")).toBeNull();
    expect(windowScroll).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });

  it("does not show the button for a re-fetch with nothing new, and dismisses it when the reader reaches the bottom", async () => {
    const { el, root, msgs, state } = await mount();
    scrollTo(msgs, state, 1200);
    el.entries = served.map((e) => ({ ...e }));
    await settle(el);
    expect(state.top).toBe(1200);
    expect(root.querySelector(".jump")).toBeNull();

    el.entries = [...served, { from: "employee", at: 9999, text: "late" }];
    await settle(el);
    expect(root.querySelector(".jump")).not.toBeNull();
    scrollTo(msgs, state, 2600);
    await settle(el);
    expect(root.querySelector(".jump")).toBeNull();
  });

  it("sending always scrolls to the bottom, even from far up, and the sending bubble sits in the list", async () => {
    const { el, root, msgs, state } = await mount();
    scrollTo(msgs, state, 500);
    const box = root.querySelector("textarea") as HTMLTextAreaElement;
    box.value = "my question";
    box.dispatchEvent(new Event("input"));
    await el.updateComplete;
    state.height = 3300;
    void el.send();
    await el.updateComplete;
    expect(state.top).toBe(3300 - 400);
    const mine = [...msgs.querySelectorAll(".me")].pop();
    expect(mine?.textContent).toContain("my question");
    expect(windowScroll).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
    await settle(el);
  });

  it("switching employee jumps to the new thread's bottom", async () => {
    const { el, msgs, state } = await mount();
    scrollTo(msgs, state, 300);
    served = thread(20, 5000);
    state.height = 2000;
    el.employeeId = "kit";
    await settle(el);
    expect(state.top).toBe(2000 - 400);
    expect(windowScroll).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });
});
