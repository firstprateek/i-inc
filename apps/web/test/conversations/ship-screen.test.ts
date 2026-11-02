// The Conversations screen around the ship dialog (T62b): it loads what shipping says about the selected
// conversation, opens the dialog from the header menu and the panel, keeps everything behind it inert, gives
// focus back, and refreshes when the ticket it started changes. Plus the ticket page's link back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import type { IncConversations } from "../../src/components/conversations.ts";
import "../../src/components/conversations.ts";
import "../../src/components/ticket.ts";
import { shipOutcomes } from "../../src/conversations/outcomes.ts";
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
  shipOutcomes.clear();
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

describe("a ship request the owner moves away from", () => {
  const other = {
    ...conv,
    id: "cd34ef56",
    title: "Other work",
    ahpSession: "ahp-session:/o",
    ahpChat: "ahp-chat:/o",
  };
  let asked: { url: string; body: Any; land: (r: Response) => void }[];

  beforeEach(() => {
    listed = [conv, other];
    asked = [];
    const answers = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Promise<Response>((land) => {
          asked.push({ url, body: JSON.parse(String(init.body)), land });
        });
      }
      if (url.startsWith("/api/conversations/cd34ef56/ship")) return Promise.resolve(reply({ ship }));
      return answers(url, init);
    });
  });
  afterEach(() => shipOutcomes.clear());

  /** A dialog with its request sent and not yet answered. */
  async function sending(kind: "ticket" | "pr" = "ticket") {
    const m = await mount();
    await until(() => (m.thread() as Any).ship);
    m.thread().dispatchEvent(
      new CustomEvent("conv-ship", { detail: { kind }, bubbles: true, composed: true }),
    );
    await until(() => m.root().querySelector("inc-conv-ship"));
    const dlg = must(m.root().querySelector("inc-conv-ship")) as Any;
    const main = () => must<HTMLButtonElement>(dlg.shadowRoot.querySelector("[data-main]"));
    await until(() => dlg.shadowRoot.querySelector("#ship-title"));
    await dlg.updateComplete;
    await until(() => !main().disabled);
    main().click();
    await until(() => asked.length);
    await dlg.updateComplete;
    return { ...m, dlg, main };
  }
  const moveOn = async (el: IncConversations, id: string) => {
    el.selectedId = id;
    await el.updateComplete;
  };
  const refused = () => reply({ error: "The working copy changed." }, 409);
  const made = () => reply({ ticket: { id: "12", title: "Greeting" }, created: true });
  const opened = () =>
    reply({ pr: { number: 7, url: "https://github.com/o/r/pull/7", draft: true }, created: true });

  it("keeps the dialog through a move to another conversation, and shows the ticket's link there", async () => {
    const { el, root, dlg } = await sending();
    await moveOn(el, other.id);
    expect(root().querySelector("inc-conv-ship")).toBe(dlg);
    expect(dlg.conv.id).toBe(conv.id);
    expect(root().querySelector(".list-pane")?.hasAttribute("inert")).toBe(true);
    asked[0]?.land(made());
    await until(() => dlg.shadowRoot.querySelector(".finished"));
    expect(dlg.shadowRoot.querySelector(".finished a")?.getAttribute("href")).toBe("#/ticket/12");
    expect(shipOutcomes.list()).toEqual([]);
    must<HTMLElement>(dlg.shadowRoot.querySelector("header .x")).click();
    await until(() => !root().querySelector("inc-conv-ship"));
    expect(root().querySelector(".list-pane")?.hasAttribute("inert")).toBe(false);
    expect(shipOutcomes.list()).toEqual([]);
  });

  describe("while one is open", () => {
    const pressed = (m: { context: () => Element }, kind: "ticket" | "pr") =>
      m
        .context()
        .dispatchEvent(
          new CustomEvent("conv-ship", { detail: { kind, from: "context" }, bubbles: true, composed: true }),
        );

    it("keeps the context panel out of reach, here and on the conversation moved to", async () => {
      const m = await sending();
      expect(m.root().querySelector(".ctx-pane")?.hasAttribute("inert")).toBe(true);
      await moveOn(m.el, other.id);
      expect(m.root().querySelector(".ctx-pane")?.hasAttribute("inert")).toBe(true);
      asked[0]?.land(refused());
      await until(() => !m.dlg.busy);
      must<HTMLElement>(m.dlg.shadowRoot.querySelector("header .x")).click();
      await until(() => !m.root().querySelector("inc-conv-ship"));
      expect(m.root().querySelector(".ctx-pane")?.hasAttribute("inert")).toBe(false);
    });

    it("keeps a tablet's context drawer out of reach", async () => {
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }));
      const m = await sending();
      m.thread().dispatchEvent(new CustomEvent("conv-toggle-context", { bubbles: true, composed: true }));
      await until(() => m.root().querySelector(".drawer"));
      expect(m.root().querySelector(".drawer")?.hasAttribute("inert")).toBe(true);
    });

    it("isn't taken over by another conversation's button", async () => {
      const { el, dlg, main, ...m } = await sending();
      dlg.title = "Title typed for A";
      await moveOn(el, other.id);
      await until(() => m.root().querySelector("inc-conv-context"));
      pressed(m, "ticket");
      await el.updateComplete;
      await dlg.updateComplete;
      expect(dlg.conv.id).toBe(conv.id);
      asked[0]?.land(refused());
      await until(() => !dlg.busy);
      await dlg.updateComplete;
      main().click();
      await until(() => asked.length === 2);
      expect(asked[1]?.url).toBe(`/api/conversations/${conv.id}/ticket`);
      expect(asked[1]?.body.title).toBe("Title typed for A");
    });

    it("isn't turned into a pull request, which would skip i.inc's review", async () => {
      const { el, dlg, main, ...m } = await sending();
      pressed(m, "pr");
      await el.updateComplete;
      await dlg.updateComplete;
      expect(dlg.kind).toBe("ticket");
      asked[0]?.land(refused());
      await until(() => !dlg.busy);
      await dlg.updateComplete;
      main().click();
      await until(() => asked.length === 2);
      expect(asked[1]?.url).toBe(`/api/conversations/${conv.id}/ticket`);
    });

    it("keeps the button focus goes back to", async () => {
      const { el, dlg, root, thread, shipBtn, ...m } = await sending();
      pressed(m, "pr");
      await el.updateComplete;
      asked[0]?.land(refused());
      await until(() => !dlg.busy);
      must<HTMLElement>(dlg.shadowRoot.querySelector("header .x")).click();
      await until(() => !root().querySelector("inc-conv-ship"));
      await until(() => focusedIn(thread().shadowRoot) === shipBtn());
    });
  });

  it("keeps it on going back to the list too, and shows a pull request's link", async () => {
    const { el, root, dlg } = await sending("pr");
    await moveOn(el, "");
    expect(root().querySelector("inc-conv-ship")).toBe(dlg);
    asked[0]?.land(opened());
    await until(() => dlg.shadowRoot.querySelector(".finished"));
    expect(dlg.shadowRoot.querySelector(".finished a")?.getAttribute("href")).toBe(
      "https://github.com/o/r/pull/7",
    );
  });

  it("shows a failure, keeps the words, and sends the next press to the conversation it started in", async () => {
    const { el, dlg, main } = await sending();
    dlg.title = "My own title";
    await moveOn(el, other.id);
    asked[0]?.land(refused());
    await until(() => dlg.shadowRoot.querySelector(".alert")?.textContent === "The working copy changed.");
    await until(() => !dlg.busy);
    await dlg.updateComplete;
    expect(dlg.shadowRoot.querySelector("#ship-title")?.value).toBe("My own title");
    main().click();
    await until(() => asked.length === 2);
    expect(asked.map((a) => a.url)).toEqual([
      `/api/conversations/${conv.id}/ticket`,
      `/api/conversations/${conv.id}/ticket`,
    ]);
    expect(asked[1]?.body.title).toBe("My own title");
  });

  it("stays when the conversation goes while the request is under way", async () => {
    const { el, root, dlg } = await sending();
    (el as Any).leave("It was archived.");
    await el.updateComplete;
    expect(root().querySelector("inc-conv-ship")).toBe(dlg);
    asked[0]?.land(made());
    await until(() => dlg.shadowRoot.querySelector(".finished"));
  });

  it("closes as usual once a request has worked, and the shell keeps its link", async () => {
    const { el, root, dlg } = await sending();
    await moveOn(el, other.id);
    asked[0]?.land(made());
    await until(() => !dlg.busy);
    await moveOn(el, conv.id);
    expect(root().querySelector("inc-conv-ship")).toBeNull();
    expect(shipOutcomes.list()).toMatchObject([{ conversationId: conv.id, done: { ticketId: "12" } }]);
  });

  it("stays with a failure through the next move, with the owner's words, and only the shell's when they leave", async () => {
    const { el, root, dlg } = await sending();
    dlg.title = "My own title";
    await moveOn(el, other.id);
    asked[0]?.land(refused());
    await until(() => !dlg.busy);
    await moveOn(el, "");
    expect(root().querySelector("inc-conv-ship")).toBe(dlg);
    expect(dlg.shadowRoot.querySelector("#ship-title")?.value).toBe("My own title");
    expect(dlg.shadowRoot.querySelector(".alert")?.textContent).toBe("The working copy changed.");
    expect(shipOutcomes.list()).toEqual([]);
    el.remove();
    expect(shipOutcomes.list()).toMatchObject([
      { conversationId: conv.id, kind: "ticket", failure: "The working copy changed." },
    ]);
  });

  it("hands the shell a request that ended just before the screen went", async () => {
    for (const [land, end] of [
      [refused, { failure: "The working copy changed." }],
      [made, { done: { ticketId: "12" } }],
    ] as const) {
      asked.length = 0;
      const { el, dlg } = await sending();
      asked[0]?.land(land());
      await until(() => !dlg.busy);
      el.remove();
      expect(shipOutcomes.list()).toMatchObject([end]);
      shipOutcomes.clear();
      document.body.innerHTML = "";
      resetAhp();
    }
  });

  it("says nothing more once the owner has closed the dialog on how it ended", async () => {
    for (const land of [refused, made]) {
      asked.length = 0;
      const { el, root, dlg } = await sending();
      asked[0]?.land(land());
      await until(() => !dlg.busy);
      must<HTMLElement>(dlg.shadowRoot.querySelector("header .x")).click();
      await until(() => !root().querySelector("inc-conv-ship"));
      el.remove();
      expect(shipOutcomes.list()).toEqual([]);
      document.body.innerHTML = "";
      resetAhp();
    }
  });

  it("tells how the last try ended, and nothing about the one before it", async () => {
    const { el, dlg, main } = await sending();
    asked[0]?.land(refused());
    await until(() => !dlg.busy);
    await dlg.updateComplete;
    main().click();
    await until(() => asked.length === 2);
    el.remove();
    expect(shipOutcomes.list()).toEqual([]);
    asked[1]?.land(made());
    await until(() => shipOutcomes.list().length);
    expect(shipOutcomes.list()).toMatchObject([{ done: { ticketId: "12" } }]);
    expect(shipOutcomes.list()).toHaveLength(1);
  });

  it("says nothing more once the owner has followed the dialog's link", async () => {
    const { el, dlg } = await sending();
    asked[0]?.land(made());
    await until(() => dlg.shadowRoot.querySelector(".finished a"));
    const link = must<HTMLAnchorElement>(dlg.shadowRoot.querySelector(".finished a"));
    link.addEventListener("click", (e) => e.preventDefault());
    link.click();
    el.remove();
    expect(shipOutcomes.list()).toEqual([]);
  });

  it("leaves a refusal of the dialog's own to close with the conversation, with nothing to tell", async () => {
    const m = await mount();
    await until(() => (m.thread() as Any).ship);
    m.thread().dispatchEvent(
      new CustomEvent("conv-ship", { detail: { kind: "ticket" }, bubbles: true, composed: true }),
    );
    await until(() => m.root().querySelector("inc-conv-ship"));
    const dlg = m.root().querySelector("inc-conv-ship") as Any;
    await until(() => dlg.shadowRoot.querySelector("#ship-title"));
    await dlg.updateComplete;
    dlg.title = " ";
    const main = () => dlg.shadowRoot.querySelector("[data-main]") as HTMLButtonElement;
    await until(() => !main().disabled);
    main().click();
    await until(() => dlg.shadowRoot.querySelector(".alert")?.textContent === "Give it a title.");
    await moveOn(m.el, other.id);
    expect(m.root().querySelector("inc-conv-ship")).toBeNull();
    expect(shipOutcomes.list()).toEqual([]);
  });

  it("brings a failure into view, under the fields of a long dialog", async () => {
    const { dlg } = await sending();
    const body = must<HTMLElement>(dlg.shadowRoot.querySelector(".body"));
    Object.defineProperty(body, "scrollHeight", { value: 900 });
    asked[0]?.land(refused());
    await until(() => dlg.shadowRoot.querySelector(".alert"));
    await dlg.updateComplete;
    expect(body.scrollTop).toBe(900);
  });

  it("brings focus back into the dialog with a failure, wherever a route change left it", async () => {
    const { el, dlg } = await sending();
    await moveOn(el, other.id);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    asked[0]?.land(refused());
    await until(() => !dlg.busy);
    await until(() => focusedIn(dlg.shadowRoot) === dlg.shadowRoot.querySelector("#ship-title"));
    expect(dlg.shadowRoot.querySelector("#ship-title").disabled).toBe(false);
  });

  describe("closing a dialog that outlived its conversation", () => {
    const close = async (m: Any) => {
      must<HTMLElement>(m.dlg.shadowRoot.querySelector("header .x")).click();
      await until(() => !m.root().querySelector("inc-conv-ship"));
      await m.el.updateComplete;
    };

    it("gives focus to the panel's button when the conversation showing can't ship", async () => {
      const m = await sending();
      await moveOn(m.el, other.id);
      asked[0]?.land(refused());
      await until(() => !m.dlg.busy);
      const thread = () => m.root().querySelector("inc-conv-thread") as Any;
      await until(() => thread()?.shadowRoot?.querySelector(".context-btn"));
      const button = thread().shadowRoot.querySelector(".ship-btn");
      button?.remove();
      await close(m);
      await until(() => focusedIn(thread().shadowRoot)?.matches(".context-btn"));
    });

    it("gives focus to the list when no conversation is showing", async () => {
      const m = await sending();
      await moveOn(m.el, "");
      asked[0]?.land(refused());
      await until(() => !m.dlg.busy);
      await close(m);
      const list = () => m.root().querySelector("inc-conv-list") as Any;
      await until(() => focusedIn(list()?.shadowRoot)?.matches(".open, .new"));
    });
  });

  it("leaves an idle dialog to close with the conversation, as it did", async () => {
    const m = await mount();
    await until(() => (m.thread() as Any).ship);
    m.thread().dispatchEvent(
      new CustomEvent("conv-ship", { detail: { kind: "ticket" }, bubbles: true, composed: true }),
    );
    await until(() => m.root().querySelector("inc-conv-ship"));
    await moveOn(m.el, other.id);
    expect(m.root().querySelector("inc-conv-ship")).toBeNull();
  });

  describe("with the screen gone", () => {
    it("hands the shell a ticket's link", async () => {
      const { el } = await sending();
      el.remove();
      asked[0]?.land(made());
      await until(() => shipOutcomes.list().length);
      expect(shipOutcomes.list()[0]).toMatchObject({
        conversationId: conv.id,
        title: "Greeting",
        kind: "ticket",
        done: { kind: "ticket", ticketId: "12" },
      });
    });

    it("hands the shell a pull request's link", async () => {
      const { el } = await sending("pr");
      el.remove();
      asked[0]?.land(opened());
      await until(() => shipOutcomes.list().length);
      expect(shipOutcomes.list()[0]?.done?.pr?.number).toBe(7);
    });

    it("hands the shell a failure", async () => {
      const { el } = await sending();
      el.remove();
      asked[0]?.land(refused());
      await until(() => shipOutcomes.list().length);
      expect(shipOutcomes.list()[0]).toMatchObject({
        conversationId: conv.id,
        kind: "ticket",
        failure: "The working copy changed.",
      });
    });

    it("reloads a screen that came back while the request was running", async () => {
      const { el } = await sending();
      el.remove();
      const again = document.createElement("inc-conversations") as IncConversations;
      again.selectedId = conv.id;
      document.body.append(again);
      const thread = () => again.shadowRoot?.querySelector("inc-conv-thread") as Any;
      await until(() => thread()?.ship);
      ship = { ...ship, ticket: { id: "12" } };
      asked[0]?.land(made());
      await until(() => thread().ship.ticket?.id === "12");
    });
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
