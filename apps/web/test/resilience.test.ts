// T63 group 2: a failed request never takes a view away. The data and anything typed stay; the shell shows
// a banner with a retry; answers that arrive out of order are dropped; a button press can't be sent twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketView } from "../src/api.ts";
import "../src/components/app.ts";
import "../src/components/board.ts";
import "../src/components/inbox.ts";
import "../src/components/knowledge.ts";
import "../src/components/ticket.ts";
import { report } from "../src/connection.ts";
import { parse } from "../src/routes.ts";

const view = (over: Partial<TicketView>): TicketView => ({
  id: "1",
  title: "Refunds are counted as spending",
  project: "Duet",
  type: "fix",
  effort: "medium",
  doneWhen: [],
  assignee: { id: "ada", name: "Ada", tint: 0 },
  column: "in-progress",
  status: "running",
  held: false,
  stages: [{ id: "build", state: "current" }],
  live: "Build",
  needsYou: null,
  waiting: null,
  report: null,
  failure: null,
  outcome: null,
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function settle(el: Element) {
  await tick();
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
}

/** Waits (up to 2 s) for a condition that depends on a chain of promises and renders: robust on a busy machine. */
async function until(f: () => unknown) {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
}

async function mount<T extends HTMLElement>(tag: string, props: Record<string, unknown> = {}) {
  const el = document.createElement(tag) as T;
  Object.assign(el, props);
  document.body.append(el);
  await settle(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  location.hash = "";
  report(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  report(true);
});

describe("a daemon that goes away and comes back", () => {
  it("keeps the view mounted with what was typed, shows a banner, and loads again by itself", async () => {
    let up = true;
    let boardCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (!up) throw new TypeError("Failed to fetch");
      if (url === "/api/board") {
        boardCalls++;
        return json({ tickets: [view({})] });
      }
      if (url === "/api/projects") return json({ projects: [{ id: "Duet" }] });
      return json({ proposals: [], employees: [], pages: [], history: [], awaiting: [], conversations: [] });
    });
    location.hash = "#/work/board";
    const app = await mount<HTMLElement>("inc-app");
    const board = app.shadowRoot?.querySelector("inc-board") as HTMLElement;
    expect(board).toBeTruthy();
    const form = board.shadowRoot?.querySelector("inc-new-ticket") as HTMLElement & {
      shadowRoot: ShadowRoot;
      updateComplete: Promise<unknown>;
    };
    form.shadowRoot.querySelector<HTMLButtonElement>("button.btn")?.click();
    await form.updateComplete;
    const title = form.shadowRoot.querySelector<HTMLInputElement>('input[name="title"]') as HTMLInputElement;
    title.value = "Half-written ticket";
    title.dispatchEvent(new InputEvent("input"));
    await form.updateComplete;

    // the daemon goes away for a while: any request fails (here, the refresh a live event asks for)
    up = false;
    const { refreshNow } = await import("../src/api.ts");
    refreshNow();
    await until(() => app.shadowRoot?.querySelector("inc-offline"));
    await settle(app);

    expect(app.shadowRoot?.querySelector("inc-offline")).toBeTruthy();
    // the same view, the same form, the same text: nothing was unmounted
    expect(app.shadowRoot?.querySelector("inc-board")).toBe(board);
    expect(board.shadowRoot?.querySelector("inc-new-ticket")).toBe(form);
    expect(form.shadowRoot.querySelector<HTMLInputElement>('input[name="title"]')).toBe(title);
    expect(title.value).toBe("Half-written ticket");
    expect(board.shadowRoot?.textContent).toContain("Refunds are counted as spending");

    // it comes back: the banner goes and the views fetch again
    const before = boardCalls;
    up = true;
    const { send } = await import("../src/api.ts");
    await send("/api/auth");
    await until(() => !app.shadowRoot?.querySelector("inc-offline") && boardCalls > before);
    expect(app.shadowRoot?.querySelector("inc-offline")).toBeNull();
    expect(boardCalls).toBeGreaterThan(before);
    expect(title.value).toBe("Half-written ticket");
    expect(app.shadowRoot?.querySelector("inc-board")).toBe(board);
  });

  it("puts the offline banner in the frame's notice slot, above the view", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    location.hash = "#/work/board";
    const app = await mount<HTMLElement>("inc-app");
    const banner = app.shadowRoot?.querySelector("inc-offline");
    expect(banner?.getAttribute("slot")).toBe("notice");
    // and the view is mounted, saying nothing has loaded yet, with a retry
    const board = app.shadowRoot?.querySelector("inc-board") as HTMLElement;
    expect(board.shadowRoot?.textContent).toContain("Nothing has loaded yet");
    expect(board.shadowRoot?.querySelector("button")?.textContent).toBe("Try again");
  });
});

describe("a refresh that fails with an answer from the daemon", () => {
  it("keeps the data, and the shell says so with a retry", async () => {
    let fail = false;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/board")
        return fail ? json({ error: "the daemon had a bad day" }, 500) : json({ tickets: [view({})] });
      return json({ proposals: [], conversations: [], employees: [], projects: [] });
    });
    location.hash = "#/work/board";
    const app = await mount<HTMLElement>("inc-app");
    const board = app.shadowRoot?.querySelector("inc-board") as HTMLElement & { reload(): Promise<void> };
    expect(board.shadowRoot?.textContent).toContain("Refunds are counted as spending");
    fail = true;
    await board.reload();
    await until(() => app.shadowRoot?.querySelector('[slot="notice"]'));
    await settle(app);
    // still the board, still the ticket
    expect(app.shadowRoot?.querySelector("inc-board")).toBe(board);
    expect(board.shadowRoot?.textContent).toContain("Refunds are counted as spending");
    const notice = app.shadowRoot?.querySelector('[slot="notice"]');
    expect(notice?.textContent).toContain("the daemon had a bad day");
    expect(notice?.querySelector("button")?.textContent).toBe("Try again");
    // retry works, and the banner goes
    fail = false;
    notice?.querySelector("button")?.click();
    await until(() => !app.shadowRoot?.querySelector('[slot="notice"]'));
    expect(app.shadowRoot?.querySelector('[slot="notice"]')).toBeNull();
  });
});

describe("the loader", () => {
  it("drops an answer that arrives after a newer request's", async () => {
    const pending: ((r: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      (url: string) =>
        new Promise<Response>((resolve) => {
          if (url === "/api/board") pending.push(resolve);
          else resolve(json({ proposals: [], conversations: [], employees: [] }));
        }),
    );
    const board = await mount<HTMLElement & { reload(): Promise<void> }>("inc-board");
    void board.reload();
    await tick();
    expect(pending.length).toBe(2); // the first load, and the refresh
    // the refresh (newer) is answered first, with both tickets; the first load's old answer comes last
    pending[1]?.(json({ tickets: [view({ id: "1" }), view({ id: "2", title: "Second ticket" })] }));
    await settle(board);
    pending[0]?.(json({ tickets: [view({ id: "1" })] }));
    await settle(board);
    expect(board.shadowRoot?.textContent).toContain("Second ticket");
  });

  it("shows the first load's failure with a retry instead of a dead end", async () => {
    let up = false;
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/board" && !up
        ? json({ error: "no board today" }, 500)
        : json({ tickets: [view({})], proposals: [] }),
    );
    const board = await mount<HTMLElement>("inc-board");
    expect(board.shadowRoot?.textContent).toContain("Couldn't load the board: no board today");
    up = true;
    board.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
    await settle(board);
    expect(board.shadowRoot?.textContent).toContain("Refunds are counted as spending");
  });
});

describe("a failed button press", () => {
  const needsYou = view({
    id: "3",
    status: "needs-you",
    needsYou: { kind: "plan-gate", plan: "Add an alerts table" },
    title: "Budget alerts",
  });

  it("keeps the list and says what went wrong above it", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ error: "ticket 3 is not waiting" }, 409);
      if (url === "/api/board")
        return json({ tickets: [needsYou, view({ id: "1", status: "ready", column: "review" })] });
      return json({ pages: [], history: [], awaiting: [], proposals: [], conversations: [] });
    });
    const inbox = await mount<HTMLElement>("inc-inbox");
    const root = inbox.shadowRoot as ShadowRoot;
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Approve plan")?.click();
    await settle(inbox);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("ticket 3 is not waiting");
    // the list is still there
    expect(root.querySelector(".summary")?.textContent).toBe("1 thing needs you");
    expect(root.textContent).toContain("The plan for “Budget alerts” waits at the gate.");
    expect(root.textContent).toContain("Refunds are counted as spending");
  });

  it("sends once however many times it is tapped, and disables the buttons meanwhile", async () => {
    const posts: string[] = [];
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(url);
        await new Promise<void>((r) => {
          release = r;
        });
        return json({ ok: true });
      }
      if (url === "/api/board") return json({ tickets: [needsYou] });
      return json({ pages: [], history: [], awaiting: [], proposals: [], conversations: [] });
    });
    const inbox = await mount<HTMLElement>("inc-inbox");
    const root = inbox.shadowRoot as ShadowRoot;
    const approve = [...root.querySelectorAll("button")].find((b) => b.textContent === "Approve plan");
    approve?.click();
    approve?.click();
    await settle(inbox);
    approve?.click();
    expect(posts).toEqual(["/api/tickets/3/answer"]);
    expect(approve?.disabled).toBe(true);
    release?.();
    await settle(inbox);
  });

  it("asks before it reverts a brain change", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/knowledge/handbook")
        return json({
          pages: [{ path: "INDEX.md", text: "# Handbook" }],
          history: [
            {
              commit: "abc123",
              subject: "edit merging",
              at: 1,
              author: "ada",
              authorName: "Ada",
              reverted: false,
            },
          ],
          awaiting: [],
        });
      return json({ ok: true, teams: [], employees: [] });
    });
    const el = await mount<HTMLElement>("inc-knowledge", { repo: "handbook" });
    const root = el.shadowRoot as ShadowRoot;
    const revert = () => [...root.querySelectorAll("button")].find((b) => b.textContent === "Revert");
    revert()?.click();
    await settle(el);
    expect(calls.some((c) => c.startsWith("POST"))).toBe(false);
    // "Keep it" backs out
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Keep it")?.click();
    await settle(el);
    expect(revert()).toBeTruthy();
    revert()?.click();
    await settle(el);
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Yes, revert")?.click();
    await settle(el);
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });
});

describe("another ticket's page", () => {
  it("drops the last ticket's body at once, and for good when the new one doesn't exist", async () => {
    let release: ((r: Response) => void) | undefined;
    vi.stubGlobal("fetch", (url: string) => {
      if (url === "/api/tickets/1")
        return Promise.resolve(json({ ticket: view({ id: "1", title: "First ticket" }), events: [] }));
      if (url === "/api/tickets/4")
        return new Promise<Response>((r) => {
          release = r;
        });
      if (url === "/api/tickets/999") return Promise.resolve(json({ error: "no such ticket" }, 404));
      return Promise.resolve(json({ employees: [], tickets: [] }));
    });
    const el = await mount<HTMLElement & { ticketId: string }>("inc-ticket", { ticketId: "1" });
    expect(el.shadowRoot?.textContent).toContain("First ticket");
    el.ticketId = "4";
    await tick(2);
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    // while #4 loads, #1's body is gone
    expect(el.shadowRoot?.textContent).not.toContain("First ticket");
    release?.(json({ ticket: view({ id: "4", title: "Fourth ticket" }), events: [] }));
    await settle(el);
    expect(el.shadowRoot?.textContent).toContain("Fourth ticket");
    // a ticket that doesn't exist: no body at all
    el.ticketId = "999";
    await settle(el);
    expect(el.shadowRoot?.textContent).not.toContain("Fourth ticket");
    // #97's not-found page, not the daemon's raw sentence
    expect(el.shadowRoot?.textContent).toContain("There is no ticket #999");
    expect(el.shadowRoot?.textContent).not.toContain("no such ticket");
  });

  it("does not let #1's late answer land on #4", async () => {
    let release1: ((r: Response) => void) | undefined;
    vi.stubGlobal("fetch", (url: string) => {
      if (url === "/api/tickets/1")
        return new Promise<Response>((r) => {
          release1 = r;
        });
      if (url === "/api/tickets/4")
        return Promise.resolve(json({ ticket: view({ id: "4", title: "Fourth ticket" }), events: [] }));
      return Promise.resolve(json({ employees: [], tickets: [] }));
    });
    const el = await mount<HTMLElement & { ticketId: string }>("inc-ticket", { ticketId: "1" });
    el.ticketId = "4";
    await settle(el);
    release1?.(json({ ticket: view({ id: "1", title: "First ticket" }), events: [] }));
    await settle(el);
    expect(el.shadowRoot?.textContent).toContain("Fourth ticket");
    expect(el.shadowRoot?.textContent).not.toContain("First ticket");
  });
});

describe("a malformed address", () => {
  it("opens, rather than blanking the app", () => {
    expect(() => parse("#/conversations/new/%E0%A4%A")).not.toThrow();
    expect(() => parse("#/conversations/new/ada/%")).not.toThrow();
    expect(parse("#/conversations/new/ada/%")).toMatchObject({
      view: "conversations",
      draft: { employee: "ada" },
    });
  });

  it("mounts the app on one", async () => {
    location.hash = "#/conversations/new/%E0%A4%A";
    vi.stubGlobal("fetch", async () => json({}));
    const app = await mount<HTMLElement>("inc-app");
    expect(app.shadowRoot?.querySelector("main")).toBeTruthy();
  });
});

describe("a half-written ticket", () => {
  it("comes back after a reload, and is gone once filed", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/projects") return json({ projects: [{ id: "Duet" }] });
      if (init?.method === "POST") return json({ ticket: view({ id: "9" }) }, 201);
      return json({ tickets: [], employees: [] });
    });
    const open = async () => {
      document.body.innerHTML = "";
      const el = await mount<HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> }>(
        "inc-new-ticket",
        { startOpen: true },
      );
      return el;
    };
    let el = await open();
    const title = el.shadowRoot.querySelector<HTMLInputElement>('input[name="title"]') as HTMLInputElement;
    title.value = "Fix the thing";
    title.dispatchEvent(new InputEvent("input"));
    const details = el.shadowRoot.querySelector<HTMLTextAreaElement>("textarea") as HTMLTextAreaElement;
    details.value = "it is broken";
    details.dispatchEvent(new InputEvent("input"));
    el = await open(); // a reload
    expect(el.shadowRoot.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("Fix the thing");
    expect(el.shadowRoot.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("it is broken");
    el.shadowRoot.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(el);
    el = await open();
    expect(el.shadowRoot.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("");
  });
});

describe("a 404 on a loader view", () => {
  it("says it isn't there in words, never the daemon's raw sentence", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/board" ? json({ error: "no such board" }, 404) : json({ proposals: [], tickets: [] }),
    );
    const board = await mount<HTMLElement>("inc-board");
    expect(board.shadowRoot?.textContent).toContain("The board isn't there. It may have been removed.");
    expect(board.shadowRoot?.textContent).not.toContain("no such board");
  });
});

describe("the conversations list while the daemon can't be reached", () => {
  it("leaves the explaining to the shell's banner: no second 'Can't reach i.inc' and no empty-state lie", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    location.hash = "#/conversations";
    const app = await mount<HTMLElement>("inc-app");
    await until(() => app.shadowRoot?.querySelector("inc-offline"));
    await settle(app);
    const reach = (root: Document | ShadowRoot | Element): number => {
      let n = 0;
      const walk = (r: ParentNode) => {
        for (const e of r.querySelectorAll("*")) {
          if (e.shadowRoot) walk(e.shadowRoot);
          if (e.children.length === 0 && /Can't reach i\.inc/.test(e.textContent ?? "")) n++;
        }
      };
      walk(root as ParentNode);
      return n;
    };
    // one banner heading, nowhere else
    expect(reach(document)).toBe(1);
    const text = (function all(r: ParentNode): string {
      let t = "";
      for (const e of r.querySelectorAll("*")) if (e.shadowRoot) t += all(e.shadowRoot);
      return t + ((r as Element).textContent ?? "");
    })(document);
    expect(text).not.toContain("Reconnecting");
    expect(text).not.toContain("No conversations yet");
  });
});
