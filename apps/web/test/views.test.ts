// The views against a fake API: what they render, and what the owner's taps send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketView } from "../src/api.ts";
import "../src/components/app.ts";
import "../src/components/board.ts";
import "../src/components/desk.ts";
import "../src/components/inbox.ts";
import "../src/components/office.ts";
import "../src/components/ticket.ts";

const view = (over: Partial<TicketView>): TicketView => ({
  id: "1",
  title: "Refunds are counted as spending",
  project: "Duet",
  type: "fix",
  effort: "medium",
  assignee: { id: "ada", name: "Ada", tint: 0 },
  column: "in-progress",
  status: "running",
  held: false,
  stages: [
    { id: "pickup", state: "done" },
    { id: "build", state: "current" },
    { id: "checks", state: "todo" },
  ],
  live: "Build · Ada on Claude Opus",
  needsYou: null,
  waiting: null,
  report: null,
  failure: null,
  outcome: null,
  ...over,
});

let calls: { method: string; url: string; body: unknown }[] = [];

function serve(tickets: TicketView[], handbook: unknown = { pages: [], history: [], awaiting: [] }) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body =
      url === "/api/board" ? { tickets } : url === "/api/knowledge/handbook" ? handbook : { ok: true };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

async function mount(tag: string): Promise<ShadowRoot> {
  const el = document.createElement(tag);
  document.body.append(el);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el.shadowRoot as ShadowRoot;
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("the board", () => {
  it("puts each ticket in its column, with the stage strip and live line", async () => {
    serve([
      view({ id: "1" }),
      view({
        id: "2",
        title: "Pricing page copy",
        column: "todo",
        status: "queued",
        waiting: "Juno is off until 22:00",
      }),
      view({
        id: "3",
        title: "CSV import",
        column: "review",
        status: "ready",
        live: "Report ready",
        stages: [
          { id: "pickup", state: "done" },
          { id: "build", state: "done" },
          { id: "checks", state: "done" },
        ],
      }),
    ]);
    const root = await mount("inc-board");
    const cols = [...root.querySelectorAll("section")].map((s) => ({
      name: s.getAttribute("aria-label"),
      titles: [...s.querySelectorAll(".title")].map((t) => t.textContent),
    }));
    expect(cols).toEqual([
      { name: "To do", titles: ["Pricing page copy"] },
      { name: "In progress", titles: ["Refunds are counted as spending"] },
      { name: "Review", titles: ["CSV import"] },
      { name: "Done", titles: [] },
    ]);
    expect(root.textContent).toContain("Juno is off until 22:00");
    expect(root.querySelectorAll(".strip i.cur")).toHaveLength(1);
  });
});

describe("the inbox", () => {
  it("asks the owner in one tap, and sends the answer", async () => {
    serve([
      view({
        id: "3",
        status: "needs-you",
        needsYou: { kind: "plan-gate", plan: "Add an alerts table" },
        title: "Budget alerts",
      }),
      view({ id: "1", status: "ready", column: "review" }),
    ]);
    const root = await mount("inc-inbox");
    expect(root.querySelector("h1")?.textContent).toBe("1 thing needs you");
    expect(root.textContent).toContain("The plan for “Budget alerts” waits at the gate.");

    const approve = [...root.querySelectorAll("button")].find((b) => b.textContent === "Approve plan");
    approve?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/tickets/3/answer",
      body: { answer: "approve" },
    });

    const merge = [...root.querySelectorAll("button")].find((b) => b.textContent === "Approve");
    merge?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/tickets/1/decide",
      body: { decision: "approve" },
    });
  });

  it("puts a proposed handbook policy with the rest, and approves it in one tap", async () => {
    serve([view({})], {
      pages: [],
      history: [],
      awaiting: [
        {
          id: "4:9:p0",
          ticketId: "4",
          author: "Grace",
          at: 0,
          page: "merging",
          text: "Squash-merge every PR.",
        },
      ],
    });
    const root = await mount("inc-inbox");
    expect(root.querySelector("h1")?.textContent).toBe("1 thing needs you");
    expect(root.textContent).toContain("Squash-merge every PR.");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Approve")?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/knowledge/policies/4%3A9%3Ap0",
      body: { approved: true },
    });
  });

  it("says so when nothing needs the owner", async () => {
    serve([view({})]);
    const root = await mount("inc-inbox");
    expect(root.querySelector("h1")?.textContent).toBe("Nothing needs you");
  });
});

describe("the ticket drawer", () => {
  it("renders a retry button when failed and sends retry request", async () => {
    const failedTicket = view({
      id: "7",
      status: "failed",
      failure: { stage: "build", reason: "syntax error", tried: ["rebuild"] },
    });
    calls = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/tickets/7") {
        return new Response(JSON.stringify({ ticket: failedTicket, events: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const el = document.createElement("inc-ticket") as HTMLElement & {
      ticketId: string;
      updateComplete: Promise<unknown>;
    };
    el.ticketId = "7";
    document.body.append(el);
    let changedDispatched = false;
    el.addEventListener("changed", () => {
      changedDispatched = true;
    });

    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;

    const root = el.shadowRoot as ShadowRoot;
    const retryBtn = [...root.querySelectorAll("button")].find((b) => b.textContent === "Retry ticket");
    expect(retryBtn).toBeTruthy();

    retryBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/tickets/7/retry",
      body: {},
    });
    expect(changedDispatched).toBe(true);
  });
});

describe("the shell", () => {
  it("renders a Sign out button and triggers logout on click", async () => {
    calls = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/logout") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/office") {
        return new Response(JSON.stringify({ employees: [], accounts: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/board") {
        return new Response(JSON.stringify({ tickets: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      });
    });

    const root = await mount("inc-app");
    const signOutBtn = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sign out");
    expect(signOutBtn).toBeTruthy();

    signOutBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/logout",
      body: {},
    });
  });
});

describe("the phone tab bar", () => {
  it("reaches My desk, the handbook, hiring and Setup through More", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } }),
    );
    location.hash = "#/more";
    const root = await mount("inc-app");
    const tabs = [...(root.querySelectorAll(".tabs a") as NodeListOf<HTMLAnchorElement>)];
    expect(tabs.map((a) => a.textContent?.trim())).toEqual(["Inbox", "Office", "Board", "Chats", "More"]);
    expect(tabs[4]?.getAttribute("aria-current")).toBe("page");
    const more = [...(root.querySelectorAll(".more a") as NodeListOf<HTMLAnchorElement>)];
    expect(more.map((a) => a.getAttribute("href"))).toEqual([
      "#/desk",
      "#/handbook",
      "#/hiring",
      "#/setup/teams",
    ]);
    location.hash = "";
  });
});

describe("the office", () => {
  it("renders the floor and Accounts & quotas section", async () => {
    calls = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/office") {
        return new Response(
          JSON.stringify({
            employees: [
              {
                id: "ada",
                name: "Ada",
                tint: 0,
                role: "Core Engineer",
                engine: "Claude Sonnet",
                state: "idle",
                ticket: null,
              },
            ],
            accounts: [
              {
                id: "claude-pro",
                name: "Claude Pro",
                monthlyCap: 100,
              },
            ],
            rateLimits: {
              "claude-pro": {
                status: "allowed",
                fiveHourUtilization: 0.45,
                sevenDayUtilization: 0.8,
                updatedAt: 1000,
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/board") {
        return new Response(JSON.stringify({ tickets: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      });
    });

    const root = await mount("inc-office");
    expect(root.textContent).toContain("The floor");
    expect(root.textContent).toContain("Ada");
    expect(root.textContent).toContain("Accounts & quotas");
    expect(root.textContent).toContain("Claude Pro");
    expect(root.textContent).toContain("Cap: $100");
    expect(root.textContent).toContain("45%");
    expect(root.textContent).toContain("80%");
    expect(root.textContent).toContain("allowed");
  });
});

describe("My desk releases", () => {
  it("renders pending releases with Cut release button and recent releases", async () => {
    calls = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url === "/api/desk") {
        return new Response(
          JSON.stringify({
            spend: { lines: [], total: 0, perMergedPR: null },
            waits: [],
            bottleneck: null,
            merged: 1,
            releases: [
              {
                project: "Duet",
                tag: "v2026-10-17.1",
                at: 1000,
                ticketIds: ["1"],
                commits: ["sha1"],
              },
            ],
            pendingReleases: [
              {
                project: "Duet",
                id: "Duet",
                repo: "firstprateek/duet",
                pendingTickets: [{ id: "2", title: "Add feature", pushed: "sha222" }],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/knowledge/recent") {
        return new Response(JSON.stringify({ changes: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/projects/Duet/release") {
        return new Response(
          JSON.stringify({
            release: {
              project: "Duet",
              tag: "v2026-10-17.2",
              at: 2000,
              ticketIds: ["2"],
              commits: ["sha222"],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const root = await mount("inc-desk");
    expect(root.textContent).toContain("Releases");
    expect(root.textContent).toContain("1 unreleased ticket");
    expect(root.textContent).toContain("Add feature");
    expect(root.textContent).toContain("v2026-10-17.1");

    const cutBtn = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cut release");
    expect(cutBtn).toBeTruthy();
    cutBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/projects/Duet/release",
      body: {},
    });
  });
});
