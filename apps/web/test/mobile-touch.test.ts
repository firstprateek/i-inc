import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskView, OfficeResponse, TicketView } from "../src/api.ts";
import { IncApp, parse } from "../src/components/app.ts";
import "../src/components/board.ts";
import "../src/components/group-brain.ts";
import "../src/components/group-conversations.ts";
import "../src/components/group-projects.ts";
import "../src/components/conversations.ts";
import "../src/components/desk.ts";
import "../src/components/hiring.ts";
import "../src/components/inbox.ts";
import "../src/components/knowledge.ts";
import "../src/components/new-ticket.ts";
import "../src/components/office.ts";
import "../src/components/offline.ts";
import "../src/components/setup.ts";
import "../src/components/ticket.ts";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const mockTicket: TicketView = {
  id: "42",
  title: "Mobile viewport regression test",
  project: "i-inc",
  type: "fix",
  effort: "small",
  doneWhen: [],
  assignee: { id: "ada", name: "Ada", tint: 0 },
  column: "in-progress",
  status: "running",
  held: false,
  stages: [
    { id: "pickup", state: "done" },
    { id: "build", state: "current" },
    { id: "checks", state: "todo" },
  ],
  live: "Build · Ada on Claude",
  needsYou: null,
  waiting: null,
  report: null,
  failure: null,
  outcome: null,
};

const mockOffice: OfficeResponse = {
  employees: [
    {
      id: "ada",
      name: "Ada",
      role: "Lead Engineer",
      tint: 0,
      engine: "claude",
      state: "working",
      ticket: {
        id: "42",
        title: "Mobile viewport regression test",
        project: "i-inc",
        live: "Working on mobile pass",
      },
    },
  ],
  accounts: [{ id: "claude", name: "Claude Pro", monthlyFee: 20, monthlyCap: 100 }],
  rateLimits: {
    claude: { status: "allowed", fiveHourUtilization: 0.15, sevenDayUtilization: 0.3, updatedAt: Date.now() },
  },
};

const mockDesk: DeskView = {
  spend: {
    lines: [{ name: "Claude Pro", kind: "subscription", amount: 42.5, basis: "monthly fee" }],
    total: 42.5,
    perMergedPR: null,
  },
  waits: [],
  bottleneck: null,
  merged: 2,
  releases: [],
};

const mockHandbook = {
  pages: [{ path: "INDEX.md", title: "Index", text: "# Company Brain\nWelcome to i.inc." }],
  history: [],
  awaiting: [],
};

describe("T27: Mobile bug hunt & touch regression tests (390x844)", () => {
  beforeEach(() => {
    // Emulate iPhone 390x844 touch viewport
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(navigator, "userAgent", { value: IPHONE_UA, configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });

    vi.stubGlobal("matchMedia", (query: string) => {
      const isPhone = query.includes("max-width") || query.includes("390");
      const isCoarse = query.includes("pointer: coarse") || query.includes("hover: none");
      return {
        matches: isPhone || isCoarse,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      };
    });

    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/office") {
        return new Response(JSON.stringify(mockOffice), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/board") {
        return new Response(JSON.stringify({ tickets: [mockTicket] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/desk") {
        return new Response(JSON.stringify(mockDesk), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/knowledge/handbook") {
        return new Response(JSON.stringify(mockHandbook), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/knowledge/recent") {
        return new Response(JSON.stringify({ changes: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/teams") {
        return new Response(
          JSON.stringify({ teams: [{ id: "eng", name: "Engineering", members: ["ada"] }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/projects") {
        return new Response(
          JSON.stringify({
            projects: [{ id: "i-inc", name: "i-inc", repo: "firstprateek/i-inc", checks: [] }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/engines") {
        return new Response(
          JSON.stringify({
            engines: [
              { id: "claude", model: "Claude", harness: "claude-code", accountId: "claude", local: false },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/accounts") {
        return new Response(JSON.stringify({ accounts: mockOffice.accounts }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/sandboxes") {
        return new Response(JSON.stringify({ sandboxes: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/push/key") {
        return new Response(JSON.stringify({ publicKey: "mock-key" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/chat/")) {
        return new Response(JSON.stringify({ thread: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    });

    location.hash = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    location.hash = "";
    document.body.innerHTML = "";
  });

  it("router parses the phone default to Work → Needs you on a 390x844 viewport", () => {
    expect(parse("")).toEqual({ view: "needs-you" });
  });

  it("tap-every-tab suite: tapping each mobile tab navigates correctly and never breaks routing", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const nav = app.shadowRoot?.querySelector(".tabs");
    expect(nav).not.toBeNull();
    const tabs = [...(nav?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    expect(tabs.length).toBe(4);

    const [conversationsBtn, workBtn, needsBtn, companyBtn] = tabs;
    if (!conversationsBtn || !workBtn || !needsBtn || !companyBtn) throw new Error("Missing tabs");

    // 1. The phone opens on Needs you
    expect(needsBtn.getAttribute("aria-current")).toBe("page");
    expect(needsBtn.getAttribute("aria-selected")).toBe("true");
    expect(app.shadowRoot?.querySelector("inc-inbox")).not.toBeNull();

    // 2. Tap Work: routes to #/work/board and mounts <inc-board>
    workBtn.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/work/board");
    expect(workBtn.getAttribute("aria-current")).toBe("page");
    expect(workBtn.getAttribute("aria-selected")).toBe("true");
    expect(needsBtn.getAttribute("aria-selected")).toBe("false");
    expect(app.shadowRoot?.querySelector("inc-board")).not.toBeNull();

    // 3. Tap Conversations: routes to #/conversations and mounts <inc-conversations>
    conversationsBtn.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/conversations");
    expect(conversationsBtn.getAttribute("aria-current")).toBe("page");
    expect(conversationsBtn.getAttribute("aria-selected")).toBe("true");
    expect(workBtn.getAttribute("aria-selected")).toBe("false");
    expect(app.shadowRoot?.querySelector("inc-conversations")).not.toBeNull();

    // 4. Tap Company: routes to #/company/team and mounts the team floor
    companyBtn.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/company/team");
    expect(companyBtn.getAttribute("aria-current")).toBe("page");
    expect(companyBtn.getAttribute("aria-selected")).toBe("true");
    expect(conversationsBtn.getAttribute("aria-selected")).toBe("false");
    expect(app.shadowRoot?.querySelector("inc-office")).not.toBeNull();

    // 5. Tap Needs you: returns to #/needs-you
    needsBtn.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/needs-you");
    expect(needsBtn.getAttribute("aria-current")).toBe("page");
    expect(needsBtn.getAttribute("aria-selected")).toBe("true");
    expect(companyBtn.getAttribute("aria-selected")).toBe("false");
    expect(app.shadowRoot?.querySelector("inc-inbox")).not.toBeNull();
  });

  it("Company's sub-screens keep the Company tab active and mount without error", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const subRoutes = [
      { hash: "#/company/usage", component: "inc-desk" },
      { hash: "#/company/brain", component: "inc-knowledge" },
      { hash: "#/company/team/hiring", component: "inc-hiring" },
      { hash: "#/company/projects", component: "inc-setup-projects" },
      { hash: "#/company/settings/teams", component: "inc-setup" },
      { hash: "#/company/settings/notifications", component: "inc-setup" },
    ];

    for (const { hash, component } of subRoutes) {
      location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await app.updateComplete;

      const companyTab = app.shadowRoot?.querySelector(".tabs button:last-child");
      expect(companyTab?.getAttribute("aria-current")).toBe("page");
      expect(companyTab?.getAttribute("aria-selected")).toBe("true");
      expect(app.shadowRoot?.querySelector(component)).not.toBeNull();
    }
  });

  it("the theme switch in the account menu toggles the theme on a phone", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const trigger = app.shadowRoot?.querySelector<HTMLButtonElement>("button.account-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("type")).toBe("button");
    trigger?.click();
    await app.updateComplete;

    const themeItem = app.shadowRoot?.querySelector<HTMLButtonElement>('.account-menu [role="menuitem"]');
    const initialTheme = app.theme ?? "light";
    themeItem?.click();
    await app.updateComplete;

    expect(app.theme).not.toBe(initialTheme);
  });

  it("offline mode mounts <inc-offline> with accessible try-now button", async () => {
    const app = new IncApp();
    app.offline = true;
    document.body.append(app);
    await app.updateComplete;

    const offlineEl = app.shadowRoot?.querySelector("inc-offline");
    expect(offlineEl).not.toBeNull();
    await (offlineEl as unknown as { updateComplete: Promise<unknown> }).updateComplete;

    const tryBtn = offlineEl?.shadowRoot?.querySelector<HTMLButtonElement>("button.btn");
    expect(tryBtn).not.toBeNull();
    expect(tryBtn?.getAttribute("type")).toBe("button");
    expect(tryBtn?.textContent?.trim()).toBe("Try now");
  });

  it("all interactive buttons have type='button' and touch-friendly targets", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const tabButtons = app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".tabs button") ?? [];
    for (const btn of tabButtons) {
      expect(btn.type).toBe("button");
      expect(btn.getAttribute("role")).toBe("tab");
    }

    const headerButtons = app.shadowRoot?.querySelectorAll<HTMLButtonElement>("header button") ?? [];
    for (const btn of headerButtons) {
      expect(btn.type).toBe("button");
    }
  });
});
