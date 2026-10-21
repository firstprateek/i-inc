import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import "../../src/components/conversations.ts";
import type { IncConversations } from "../../src/components/conversations.ts";
import { CHAT, hosts, must, SESSION, until } from "../ahp/fake-host.ts";

const conv = {
  id: "ab12cd34",
  employeeId: "ada",
  project: null,
  branch: null,
  title: "Sheet",
  mode: null,
  engineId: "opus",
  createdAt: 0,
  archivedAt: null,
  ahpSession: SESSION,
  ahpChat: CHAT,
  status: 1,
  needsYou: false,
  running: false,
  modifiedAt: 1,
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: /max-width: 767px/.test(q),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async (url: string) => {
    const body = url.includes("/api/conversations")
      ? { conversations: [conv] }
      : url.includes("/api/employees")
        ? { employees: [{ id: "ada", name: "Ada", role: "Engineer", tint: 0 }] }
        : url.includes("/api/projects")
          ? { projects: [] }
          : url.includes("/api/engines")
            ? { engines: [] }
            : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
  vi.unstubAllGlobals();
});

async function mount() {
  const h = hosts();
  const c = new AhpConnection({
    connect: h.connect,
    clientId: "me",
    backoff: () => 5,
    pingMs: 0,
    schedule: (fn) => {
      queueMicrotask(fn);
      return () => {};
    },
  });
  setAhp(c);
  const el = document.createElement("inc-conversations") as IncConversations;
  el.selectedId = conv.id;
  document.body.append(el);
  const root = () => el.shadowRoot as ShadowRoot;
  await until(() => root().querySelector("inc-conv-thread") && c.chat(CHAT));
  const thread = () => must(root().querySelector("inc-conv-thread"));
  const toggle = () => must<HTMLButtonElement>(thread().shadowRoot?.querySelector(".tool-btn"));
  const sheet = () => root().querySelector(".sheet");
  const context = () => must(sheet()?.querySelector("inc-conv-context"));
  const activeInContext = () => {
    let a: Element | null = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const tab = (shift = false) => {
    const e = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    (activeInContext() ?? document.body).dispatchEvent(e);
    return e;
  };
  return { el, root, thread, toggle, sheet, context, activeInContext, tab };
}

describe("the phone's context sheet", () => {
  it("opens as a modal: the panes behind it are inert, and the close button takes focus", async () => {
    const m = await mount();
    expect(m.sheet()).toBeNull();
    m.toggle().click();
    await until(() => m.sheet());
    expect(m.sheet()?.getAttribute("aria-modal")).toBe("true");
    expect(m.root().querySelector(".thread-pane")?.hasAttribute("inert")).toBe(true);
    expect(m.root().querySelector(".list-pane")?.hasAttribute("inert")).toBe(true);
    await until(() => m.activeInContext()?.classList.contains("x"));
  });

  it("keeps Tab and Shift+Tab inside it, even when focus has strayed outside", async () => {
    const m = await mount();
    m.toggle().click();
    await until(() => m.sheet());
    await until(() => m.activeInContext()?.classList.contains("x"));
    const inside = () => m.context().shadowRoot?.contains(m.activeInContext() as Node);
    for (const shift of [false, true, false]) {
      const e = m.tab(shift);
      expect(e.defaultPrevented).toBe(true); // we steer focus; the browser never picks the next stop
      expect(inside()).toBe(true);
    }
    // focus has strayed out (to the page behind): the next Tab pulls it back in
    (document.activeElement as HTMLElement | null)?.blur();
    (m.thread().shadowRoot?.querySelector("textarea, .back, .tool-btn") as HTMLElement | null)?.focus();
    const e = m.tab();
    expect(e.defaultPrevented).toBe(true);
    expect(inside()).toBe(true);
  });

  it("closes on Escape from anywhere, frees the panes, and gives focus back to the button that opened it", async () => {
    const m = await mount();
    m.toggle().click();
    await until(() => m.sheet());
    // Escape while focus is outside the sheet still closes it
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await until(() => !m.sheet());
    expect(m.root().querySelector(".thread-pane")?.hasAttribute("inert")).toBe(false);
    await until(() => m.thread().shadowRoot?.activeElement === m.toggle());
    // and the Tab trap is gone with the sheet: Tab is no longer intercepted
    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, composed: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("lets go of the document listener when the screen goes away", async () => {
    const m = await mount();
    m.toggle().click();
    await until(() => m.sheet());
    m.el.remove();
    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, composed: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
