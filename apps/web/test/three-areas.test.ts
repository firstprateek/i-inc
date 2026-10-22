// The three areas (T61): the top bar, each area's tab row, the Needs you count, and the browser title.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketView } from "../src/api.ts";
import { IncApp } from "../src/components/app.ts";
import "../src/components/desk.ts";
import "../src/components/group-brain.ts";
import "../src/components/group-conversations.ts";
import "../src/components/group-projects.ts";
import "../src/components/group-work.ts";
import "../src/components/hiring.ts";
import "../src/components/office.ts";
import "../src/components/setup.ts";
import { needsYouCount } from "../src/needs-you.ts";
import { answer } from "./daemon-board.ts";

const phone = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

const ticket = (over: Partial<TicketView>): TicketView =>
  ({
    id: "1",
    title: "t",
    project: "Duet",
    type: "fix",
    effort: "medium",
    assignee: { id: "ada", name: "Ada", tint: 0 },
    column: "in-progress",
    status: "running",
    held: false,
    stages: [],
    live: "",
    needsYou: null,
    waiting: null,
    report: null,
    failure: null,
    outcome: null,
    ...over,
  }) as TicketView;

const UNASSIGNED = "unassigned, and no standing order covers it";

let openProposals: unknown[] = [];

/** A daemon that answers the board, the handbook and the open proposals, and nothing else. */
function serve(tickets: TicketView[], awaiting: unknown[] = []) {
  vi.stubGlobal("fetch", async (url: string) => {
    const body =
      answer({ tickets, awaiting, proposals: openProposals }, url) ??
      (url === "/api/knowledge/handbook" ? { pages: [], history: [], awaiting } : {});
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

const settle = async (app: IncApp) => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;
  }
};

async function mount(hash: string): Promise<{ app: IncApp; root: ShadowRoot }> {
  location.hash = hash;
  const app = new IncApp();
  document.body.append(app);
  await settle(app);
  return { app, root: app.shadowRoot as ShadowRoot };
}

const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, " ").trim();
const current = (root: ShadowRoot, sel: string) =>
  [...root.querySelectorAll(sel)]
    .filter((a) => a.getAttribute("aria-current") === "page")
    .map((a) => text(a));

beforeEach(() => {
  openProposals = [];
  phone(false);
  history.replaceState(null, "", "/");
  localStorage.clear();
  document.body.innerHTML = "";
  serve([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  location.hash = "";
});

describe("the top bar", () => {
  it("has Conversations, Work and Company, the Needs you badge and the account menu, and no All views menu", async () => {
    const { root } = await mount("#/work/board");
    const areas = [...root.querySelectorAll('header nav[aria-label="Areas"] a')];
    expect(areas.map((a) => [text(a), a.getAttribute("href")])).toEqual([
      ["Conversations", "#/conversations"],
      ["Work", "#/work/board"],
      ["Company", "#/company/team"],
    ]);
    // Needs you is a destination of its own: a link in the top bar, not a button or a Work tab
    const needs = root.querySelector("header a.needs-link");
    expect(needs?.getAttribute("href")).toBe("#/needs-you");
    expect(root.querySelector(".account-trigger")).not.toBeNull();
    expect(root.querySelector(".all-views-trigger")).toBeNull();
    expect(root.querySelector(".pin-btn")).toBeNull();
  });

  it.each([
    ["#/conversations", "Conversations"],
    ["#/conversations/ada", "Conversations"],
    ["#/work/board", "Work"],
    ["#/work/releases", "Work"],
    ["#/needs-you", null],
    ["#/ticket/12", "Work"],
    ["#/ticket/12/assign", "Work"],
    ["#/company/team", "Company"],
    ["#/company/team/hiring", "Company"],
    ["#/company/brain/ada", "Company"],
    ["#/company/projects", "Company"],
    ["#/company/usage", "Company"],
    ["#/company/settings/engines", "Company"],
    ["#/inbox", null],
    ["#/work/needs-you", null],
    ["#/setup/engines", "Company"],
    ["#/chat/ada", "Conversations"],
  ])("%s highlights %s", async (hash, area) => {
    const { root } = await mount(hash);
    // Needs you lights its own link and no area
    expect(current(root, 'header nav[aria-label="Areas"] a')).toEqual(area ? [area] : []);
    expect(current(root, "header .needs-link")).toEqual(area ? [] : [expect.stringContaining("Needs you")]);
  });

  it("opens on Conversations on a laptop and on Needs you on a phone", async () => {
    let { root } = await mount("");
    expect(current(root, 'header nav[aria-label="Areas"] a')).toEqual(["Conversations"]);
    expect(root.querySelector("inc-conversations")).not.toBeNull();
    document.body.innerHTML = "";
    phone(true);
    ({ root } = await mount(""));
    expect(root.querySelector("inc-inbox")).not.toBeNull();
    expect(current(root, ".tabs button")).toEqual(["Needs you"]);
  });
});

describe("the logo", () => {
  it("goes to Conversations on a laptop and to Needs you on a phone", async () => {
    let { root } = await mount("#/company/team");
    expect(root.querySelector("header .mark")?.getAttribute("href")).toBe("#/conversations");
    document.body.innerHTML = "";
    phone(true);
    ({ root } = await mount("#/company/team"));
    expect(root.querySelector("header .mark")?.getAttribute("href")).toBe("#/needs-you");
  });
});

describe("the account menu's Show getting started", () => {
  it("is offered only after the checklist was dismissed, and brings it back in the new conversation screen", async () => {
    const { app, root } = await mount("#/work/board");
    const items = () => [...root.querySelectorAll('.account-menu [role="menuitem"]')].map((i) => text(i));
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await app.updateComplete;
    expect(items()).toEqual(["Switch to dark theme", "Sign out"]);
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await app.updateComplete;

    localStorage.setItem("i-inc-getting-started-dismissed", "1");
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await app.updateComplete;
    expect(items()).toEqual(["Switch to dark theme", "Show getting started", "Sign out"]);
    const show = [...root.querySelectorAll('.account-menu [role="menuitem"]')][1] as HTMLButtonElement;
    show.click();
    await settle(app);
    expect(localStorage.getItem("i-inc-getting-started-dismissed")).toBeNull();
    expect(location.hash).toBe("#/conversations");
    expect(root.querySelector(".account-menu")).toBeNull();
    // it lives in the centre of Conversations, under the composer
    const draft = root.querySelector("inc-conversations")?.shadowRoot?.querySelector("inc-conv-draft");
    expect(draft?.shadowRoot?.querySelector("inc-getting-started")).not.toBeNull();
    expect(root.querySelector(".conv-host > inc-getting-started")).toBeNull();
  });
});

describe("the Needs you count", () => {
  it("counts tickets that need the owner, tickets nobody can start, and policy proposals", () => {
    const tickets = [
      ticket({ id: "1", status: "needs-you", needsYou: { kind: "plan-gate", plan: "x" } }),
      ticket({ id: "2", status: "queued", column: "todo", waiting: UNASSIGNED, assignee: null }),
      ticket({ id: "3", status: "queued", column: "todo", waiting: UNASSIGNED, assignee: null, held: true }),
      ticket({ id: "4", status: "ready", column: "review" }),
      ticket({ id: "5" }),
    ];
    expect(needsYouCount(tickets, [])).toBe(2);
    expect(needsYouCount(tickets, [{ id: "p" } as never])).toBe(3);
    expect(needsYouCount([])).toBe(0);
    // open follow-up proposals count too, so the badge matches the Needs you list
    expect(needsYouCount(tickets, [], [{ id: "a" } as never, { id: "b" } as never])).toBe(4);
  });

  it("shows the count in the top bar link, which opens the Needs you page", async () => {
    serve(
      [
        ticket({ id: "1", status: "needs-you", needsYou: { kind: "plan-gate", plan: "x" } }),
        ticket({ id: "2", status: "needs-you", needsYou: { kind: "plan-gate", plan: "x" } }),
      ],
      [{ id: "p", ticketId: "4", author: "G", at: 0, page: "m", text: "t" }],
    );
    const { app, root } = await mount("#/work/board");
    const badge = root.querySelector("header .needs-link") as HTMLAnchorElement;
    expect(badge.getAttribute("aria-current")).toBe("false");
    expect(badge.getAttribute("href")).toBe("#/needs-you");
    location.hash = badge.getAttribute("href") as string;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle(app);
    expect(badge.getAttribute("aria-current")).toBe("page");
    expect(badge.querySelector(".count")?.textContent).toBe("3");
    expect(badge.getAttribute("aria-label")).toBe("Needs you, 3 waiting");
    // it is no Work tab any more
    expect(root.querySelector('[role="tablist"] a[href="#/needs-you"]')).toBeNull();
  });

  it("includes open follow-up proposals in the badge", async () => {
    openProposals = [{ id: "pr1" }, { id: "pr2" }];
    const { root } = await mount("#/work/board");
    expect(root.querySelector("header .needs-link .count")?.textContent).toBe("2");
  });

  it("shows 0 calmly, and no number until the first answer", async () => {
    const { root } = await mount("#/work/board");
    expect(root.querySelector("header .needs-link .count")?.textContent).toBe("0");
    expect(root.querySelector("header .needs-link .count.some")).toBeNull();
  });

  it("is a destination of its own: current on Needs you with no area highlighted, and not current anywhere else", async () => {
    const { root } = await mount("#/needs-you");
    const link = root.querySelector("header .needs-link") as HTMLAnchorElement;
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(current(root, 'header nav[aria-label="Areas"] a')).toEqual([]);
    // no tab row of its own, and the heading is "Needs you"
    expect(root.querySelector('[role="tablist"].subnav')).toBeNull();
    expect(text(root.querySelector("#view-heading"))).toBe("Needs you");
    expect(root.querySelector("inc-inbox")).not.toBeNull();
    document.body.innerHTML = "";
    const other = (await mount("#/company/team")).root.querySelector("header .needs-link");
    expect(other?.getAttribute("aria-current")).toBe("false");
  });

  it("is the same link on a phone: the bottom tab goes to Needs you and lights up there", async () => {
    phone(true);
    const { app, root } = await mount("#/work/board");
    const tab = [...root.querySelectorAll(".tabs button")].find((b) =>
      text(b)?.startsWith("Needs you"),
    ) as HTMLElement;
    tab.click();
    await settle(app);
    expect(location.hash).toBe("#/needs-you");
    expect(current(root, ".tabs button")).toEqual(["Needs you"]);
  });

  it("updates when the daemon says something changed", async () => {
    const { app, root } = await mount("#/work/board");
    expect(root.querySelector("header .needs-link .count")?.textContent).toBe("0");
    serve([ticket({ id: "1", status: "needs-you", needsYou: { kind: "plan-gate", plan: "x" } })]);
    const { refreshNow } = await import("../src/api.ts");
    refreshNow();
    await settle(app);
    expect(root.querySelector("header .needs-link .count")?.textContent).toBe("1");
  });
});

describe("each area's tab row", () => {
  it("Work has Board and Releases only: Needs you is not a Work tab", async () => {
    const { root } = await mount("#/work/releases");
    const list = root.querySelector('[role="tablist"].subnav') as HTMLElement;
    expect(list.getAttribute("aria-label")).toBe("Work sections");
    const tabs = [...list.querySelectorAll('a[role="tab"]')];
    expect(tabs.map((t) => [text(t), t.getAttribute("href")])).toEqual([
      ["Board", "#/work/board"],
      ["Releases", "#/work/releases"],
    ]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(root.querySelector("inc-desk")?.getAttribute("show")).toBe("releases");
  });

  it("Company has Team, Brain, Projects, Usage and Settings, and each opens its content", async () => {
    const { app, root } = await mount("#/company/team");
    const list = root.querySelector('[role="tablist"].subnav') as HTMLElement;
    expect(list.getAttribute("aria-label")).toBe("Company sections");
    const tabs = [...list.querySelectorAll('a[role="tab"]')];
    expect(tabs.map((t) => text(t))).toEqual(["Team", "Brain", "Projects", "Usage", "Settings"]);
    const opens: [string, string][] = [
      ["#/company/team", "inc-office"],
      ["#/company/brain", "inc-knowledge"],
      ["#/company/projects", "inc-setup-projects"],
      ["#/company/usage", "inc-desk"],
      ["#/company/settings", "inc-setup"],
    ];
    for (const [hash, tag] of opens) {
      location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await settle(app);
      expect(root.querySelector("inc-layout")?.querySelector(tag), hash).not.toBeNull();
      expect(current(root, '[role="tablist"].subnav a'), hash).toEqual([
        text(root.querySelector(`.subnav a[href="${hash}"]`)),
      ]);
    }
  });

  it("Team shows the floor with a Hire someone action, and Usage shows spend with the account meters", async () => {
    const { app, root } = await mount("#/company/team");
    expect(root.querySelector('inc-office[show="floor"]')).not.toBeNull();
    expect(text(root.querySelector('[slot="actions"]'))).toBe("Hire someone");
    expect(root.querySelector('[slot="actions"]')?.getAttribute("href")).toBe("#/company/team/hiring");
    location.hash = "#/company/usage";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle(app);
    expect(root.querySelector('inc-desk[show="usage"]')).not.toBeNull();
    expect(root.querySelector('inc-office[show="meters"]')).not.toBeNull();
  });

  it("a ticket has no tab row, only a way back to Work", async () => {
    const { root } = await mount("#/ticket/12");
    expect(root.querySelector('[role="tablist"].subnav')).toBeNull();
    const back = root.querySelector("a.back") as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("#/work/board");
  });

  it("Conversations has no tab row, and the heading names the area", async () => {
    const { root } = await mount("#/conversations");
    expect(root.querySelector('[role="tablist"].subnav')).toBeNull();
    expect(text(root.querySelector("#view-heading"))).toBe("Conversations");
  });

  it("is one tab stop: only the open tab is tabbable, and the tab row sits in the page header slot", async () => {
    const { root } = await mount("#/company/brain");
    const tabs = [...root.querySelectorAll('.subnav a[role="tab"]')];
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1", "-1"]);
    expect(root.querySelector(".subnav")?.getAttribute("slot")).toBe("tabs");
    // the open panel is labelled by its tab
    expect(root.querySelector("inc-knowledge")?.getAttribute("aria-labelledby")).toBe("tab-brain");
    expect(root.querySelector("inc-knowledge")?.getAttribute("role")).toBe("tabpanel");
    expect(root.getElementById?.("tab-brain") ?? root.querySelector("#tab-brain")).not.toBeNull();
  });

  it("arrow keys, Home and End move between tabs; Space opens one", async () => {
    const { root } = await mount("#/work/board");
    const list = root.querySelector(".subnav") as HTMLElement;
    const tabs = [...list.querySelectorAll<HTMLElement>('a[role="tab"]')];
    const focus = vi.fn();
    for (const t of tabs) t.focus = () => focus(text(t));
    const press = (target: HTMLElement, key: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
    press(tabs[0] as HTMLElement, "ArrowRight");
    press(tabs[1] as HTMLElement, "ArrowRight"); // wraps
    press(tabs[0] as HTMLElement, "ArrowLeft"); // wraps back
    press(tabs[0] as HTMLElement, "End");
    press(tabs[1] as HTMLElement, "Home");
    expect(focus.mock.calls.map((c) => c[0])).toEqual(["Releases", "Board", "Releases", "Releases", "Board"]);
    const click = vi.fn((e: Event) => e.preventDefault());
    (tabs[1] as HTMLElement).addEventListener("click", click);
    press(tabs[1] as HTMLElement, " ");
    expect(click).toHaveBeenCalledOnce();
  });

  it("every tab is at least 44px tall (CSS), and the strip scrolls sideways rather than wrapping", () => {
    const css = (IncApp.styles as unknown as { cssText: string }[]).map((c) => c.cssText).join("\n");
    expect(css).toMatch(/\.subnav a \{[^}]*min-height: 44px/);
    expect(css).toMatch(/\.subnav \{[^}]*overflow-x: auto/);
  });
});

describe("the browser title", () => {
  it("follows the area and the tab", async () => {
    const { app } = await mount("#/work/board");
    expect(document.title).toBe("Board · Work · i.inc");
    for (const [hash, title] of [
      ["#/needs-you", "Needs you · i.inc"],
      ["#/company/usage", "Usage · Company · i.inc"],
      ["#/conversations/old/ada", "Old chat · Conversations · i.inc"],
      ["#/conversations/ab12cd34", "Conversations · i.inc"],
      ["#/ticket/9", "Ticket #9 · Work · i.inc"],
      ["#/company/settings/sandboxes", "Sandboxes · Settings · Company · i.inc"],
    ]) {
      location.hash = hash as string;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await settle(app);
      expect(document.title).toBe(title);
    }
  });
});
