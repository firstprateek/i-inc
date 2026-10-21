// The Conversations screen around the ship dialog (T62b): it loads what shipping says about the selected
// conversation, opens the dialog from the header menu and the panel, keeps everything behind it inert, gives
// focus back, and refreshes when the ticket it started changes. Plus the ticket page's link back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import type { IncConversations } from "../../src/components/conversations.ts";
import "../../src/components/conversations.ts";
import "../../src/components/ticket.ts";
import { live } from "../../src/live.ts";
import { CHAT, hosts, must, SESSION, until } from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted JSON.
type Any = any;

const conv: Any = {
  id: "ab12cd34",
  employeeId: "ada",
  project: "Duet",
  branch: "conv/ab12cd34",
  title: "Greeting",
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

/** The focused element in a shadow root; happy-dom throws while focus is on an element that was just removed. */
const focusedIn = (root: ShadowRoot | null | undefined) => {
  try {
    return root?.activeElement;
  } catch {
    return undefined;
  }
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let ship: Any;
let shipCalls = 0;
let listed: Any[];

beforeEach(() => {
  shipCalls = 0;
  listed = [conv];
  ship = {
    project: "Duet",
    mode: "owner-merges",
    canTicket: true,
    canPr: true,
    ticket: null,
    pr: null,
  };
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: /min-width: 1200px/.test(q),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("/api/conversations/ab12cd34/ship")) {
      if (url.includes("preview")) {
        return reply({
          ship: {
            ...ship,
            copy: {
              branch: "conv/ab12cd34",
              files: [{ path: "a.ts", added: 1, removed: 0 }],
              uncommitted: 1,
              ahead: 0,
              protectedPaths: [],
              pushed: false,
              blockers: [],
            },
            suggestion: { title: "Greeting", doneWhen: ["It works"], description: "" },
          },
        });
      }
      shipCalls++;
      return reply({ ship });
    }
    if (url.includes("/api/conversations")) return reply({ conversations: listed });
    if (url.includes("/api/employees"))
      return reply({ employees: [{ id: "ada", name: "Ada", role: "Engineer", tint: 0 }] });
    if (url.includes("/api/projects")) return reply({ projects: [{ id: "Duet" }] });
    if (url.includes("/api/engines")) return reply({ engines: [] });
    return reply({});
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  const context = () => must(root().querySelector("inc-conv-context"));
  const shipBtn = () => must<HTMLButtonElement>(thread().shadowRoot?.querySelector(".ship-btn"));
  return { el, root, thread, context, shipBtn, c };
}

describe("the screen's shipping", () => {
  it("loads what shipping says for a project conversation, and gives it to the thread and the panel", async () => {
    const m = await mount();
    await until(() => shipCalls > 0);
    await until(() => (m.thread() as Any).ship?.mode === "owner-merges");
    expect((m.context() as Any).ship?.mode).toBe("owner-merges");
  });

  it("opens the dialog from the header menu, keeps the panes inert behind it, and gives focus back on close", async () => {
    const m = await mount();
    await until(() => (m.thread() as Any).ship);
    m.shipBtn().click();
    await until(() => m.thread().shadowRoot?.querySelector(".ship-menu"));
    must<HTMLElement>(m.thread().shadowRoot?.querySelector('[role="menuitem"]')).click();
    await until(() => m.root().querySelector("inc-conv-ship"));
    const dlg = must(m.root().querySelector("inc-conv-ship"));
    expect(m.root().querySelector(".thread-pane")?.hasAttribute("inert")).toBe(true);
    expect(m.root().querySelector(".list-pane")?.hasAttribute("inert")).toBe(true);
    await until(() => dlg.shadowRoot?.querySelector("#ship-title"));
    expect(dlg.shadowRoot?.querySelector("h2")?.textContent).toBe("Make this a ticket");
    must<HTMLButtonElement>(dlg.shadowRoot?.querySelector("footer .cbtn")).click(); // Cancel
    await until(() => !m.root().querySelector("inc-conv-ship"));
    expect(m.root().querySelector(".thread-pane")?.hasAttribute("inert")).toBe(false);
    await until(() => focusedIn(m.thread().shadowRoot) === m.shipBtn());
  });

  it("opens the dialog from the panel's button, and goes back to that button", async () => {
    const m = await mount();
    await until(() => (m.context() as Any).ship);
    await (m.context() as Any).updateComplete;
    const open = must<HTMLButtonElement>(
      [...(m.context().shadowRoot?.querySelectorAll("button") ?? [])].find((b) =>
        /Open a PR/.test(b.textContent ?? ""),
      ),
    );
    open.click();
    await until(() => m.root().querySelector("inc-conv-ship"));
    expect(m.root().querySelector("inc-conv-ship")?.shadowRoot?.querySelector("h2")?.textContent).toBe(
      "Open a pull request",
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !m.root().querySelector("inc-conv-ship"));
    await until(() => focusedIn(m.context().shadowRoot) === open);
  });

  it("asks again when a ticket event arrives, once the conversation has a ticket", async () => {
    ship = {
      ...ship,
      ticket: {
        id: "4",
        title: "Greeting",
        status: "running",
        stage: "checks",
        live: "Checks",
        held: true,
        outcome: null,
      },
    };
    const m = await mount();
    await until(() => (m.thread() as Any).ship?.ticket);
    const before = shipCalls;
    ship = { ...ship, ticket: { ...ship.ticket, stage: "review", live: "Review" } };
    for (const fn of (live as Any).handlers.get("ticket") ?? []) fn({ id: "4" });
    await until(() => shipCalls > before, 3000);
    await until(() => (m.thread() as Any).ship?.ticket?.stage === "review", 3000);
  });

  it("asks nothing about shipping for a conversation with no project", async () => {
    listed = [{ ...conv, project: null, branch: null }];
    const m = await mount();
    await new Promise((r) => setTimeout(r, 50));
    expect(shipCalls).toBe(0);
    expect(m.thread().shadowRoot?.querySelector(".ship-btn")).toBeNull();
  });
});

describe("the ticket page", () => {
  const ticket = (over: Any = {}) => ({
    id: "9",
    title: "Greeting",
    project: "Duet",
    type: "feat",
    effort: "medium",
    assignee: { id: "ada", name: "Ada", tint: 1 },
    column: "doing",
    status: "running",
    held: false,
    stages: [],
    live: "Checks",
    needsYou: null,
    waiting: null,
    report: null,
    failure: null,
    outcome: null,
    ...over,
  });
  async function page(t: Any) {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/tickets/9" ? reply({ ticket: t, events: [] }) : reply({ sessions: [] }),
    );
    const el = document.createElement("inc-ticket") as Any;
    el.ticketId = "9";
    document.body.append(el);
    await until(() => el.shadowRoot?.querySelector("h2"));
    return el.shadowRoot as ShadowRoot;
  }

  it("says which conversation it came from, with a link", async () => {
    const r = await page(ticket({ fromConversation: { id: "ab12cd34", title: "Greeting" } }));
    const link = must<HTMLAnchorElement>(r.querySelector(".from a"));
    expect(r.querySelector(".from")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "From conversation Greeting",
    );
    expect(link.getAttribute("href")).toBe("#/conversations/ab12cd34");
  });

  it("says so when that conversation is gone, and has no line for an ordinary ticket", async () => {
    const gone = await page(ticket({ fromConversation: { id: "ab12cd34", title: null } }));
    expect(gone.querySelector(".from")?.textContent).toContain("no longer there");
    expect(gone.querySelector(".from a")).toBeNull();
    document.body.innerHTML = "";
    const plain = await page(ticket());
    expect(plain.querySelector(".from")).toBeNull();
  });
});
