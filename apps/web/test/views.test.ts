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

async function mount(tag: string, props: Record<string, string> = {}): Promise<ShadowRoot> {
  const el = document.createElement(tag);
  Object.assign(el, props);
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
    expect(root.textContent).toContain("Waiting: Juno starts at 22:00");
    expect(root.querySelectorAll(".strip i.cur")).toHaveLength(1);
  });

  it("shows a dashed placeholder in empty columns only", async () => {
    serve([view({ id: "1" })]);
    const root = await mount("inc-board");
    const placeholders = [...root.querySelectorAll("section")].map((s) => ({
      name: s.getAttribute("aria-label"),
      placeholder: s.querySelector(".empty")?.textContent?.trim() ?? null,
    }));
    expect(placeholders).toEqual([
      { name: "To do", placeholder: "No tickets waiting. Add one with the form above." },
      { name: "In progress", placeholder: null },
      { name: "Review", placeholder: "Nothing to review. Finished work waits here for your OK." },
      { name: "Done", placeholder: "Nothing shipped yet. Approved tickets land here." },
    ]);
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
    expect(root.querySelector(".summary")?.textContent).toBe("1 thing needs you");
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

  it("offers Keep going on a stuck ticket, and sends the continue answer", async () => {
    serve([
      view({
        id: "5",
        status: "needs-you",
        needsYou: { kind: "stuck", reason: "3 failed check runs" },
        title: "Alerts",
      }),
    ]);
    const root = await mount("inc-inbox");
    expect(root.textContent).toContain("3 failed check runs");
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Keep going")?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/tickets/5/answer",
      body: { answer: "continue" },
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
    expect(root.querySelector(".summary")?.textContent).toBe("1 thing needs you");
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
    expect(root.querySelector(".summary")?.textContent).toBe("Nothing needs you");
  });

  it("shows a calm all-clear card, saying what to do next, when nothing needs you and nothing is ready", async () => {
    serve([view({})]);
    const root = await mount("inc-inbox");
    const card = root.querySelector(".clear");
    expect(card).not.toBeNull();
    expect(card?.querySelector("h2")?.textContent).toBe("All clear");
    expect(card?.querySelector("svg")).not.toBeNull();
    expect(card?.textContent).toContain("Nothing needs your answer. Tickets that do will show up here.");
    const links = [...(card?.querySelectorAll("a.btn") ?? [])] as HTMLAnchorElement[];
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute("href")])).toEqual([
      ["Go to the board", "#/work/board"],
      ["Start a conversation", "#/conversations"],
    ]);
  });

  it("leaves the all-clear card out when something needs the owner or is ready", async () => {
    serve([view({ id: "3", status: "needs-you", needsYou: { kind: "plan-gate", plan: "x" } })]);
    expect((await mount("inc-inbox")).querySelector(".clear")).toBeNull();
    document.body.innerHTML = "";
    serve([view({ id: "1", status: "ready", column: "review" })]);
    expect((await mount("inc-inbox")).querySelector(".clear")).toBeNull();
    document.body.innerHTML = "";
    serve([], {
      pages: [],
      history: [],
      awaiting: [{ id: "p", ticketId: "4", author: "G", at: 0, page: "m", text: "t" }],
    });
    expect((await mount("inc-inbox")).querySelector(".clear")).toBeNull();
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
    // Sign out lives in the account menu.
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Sign out")).toBe(
      false,
    );
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
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
  it("has Conversations, Work, Needs you and Company, and Company holds the old More screens as tabs", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } }),
    );
    location.hash = "#/more";
    const root = await mount("inc-app");
    expect(location.hash).toBe("#/company/team");
    const tabs = [...(root.querySelectorAll(".tabs button") as NodeListOf<HTMLButtonElement>)];
    expect(tabs.map((a) => a.querySelector(".tab-label")?.textContent?.trim())).toEqual([
      "Conversations",
      "Work",
      "Needs you",
      "Company",
    ]);
    expect(tabs[3]?.getAttribute("aria-current")).toBe("page");
    expect(tabs[3]?.getAttribute("aria-selected")).toBe("true");
    const rowTabs = [...(root.querySelectorAll('[role="tablist"] a') as NodeListOf<HTMLAnchorElement>)];
    expect(rowTabs.map((a) => a.getAttribute("href"))).toEqual([
      "#/company/team",
      "#/company/brain",
      "#/company/projects",
      "#/company/usage",
      "#/company/settings",
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

    const floor = await mount("inc-office");
    expect(floor.textContent).toContain("The floor");
    expect(floor.textContent).toContain("Ada");
    expect(floor.textContent).not.toContain("Accounts & quotas");
    expect(floor.textContent).not.toContain("Needs you");
    document.body.innerHTML = "";
    const root = await mount("inc-office", { show: "meters" });
    expect(root.textContent).not.toContain("The floor");
    expect(root.textContent).toContain("Accounts & quotas");
    expect(root.textContent).toContain("Claude Pro");
    expect(root.textContent).toContain("Cap: $100");
    expect(root.textContent).toContain("45%");
    expect(root.textContent).toContain("80%");
    expect(root.textContent).toContain("allowed");
  });

  it("renders accounts without percentage bars with model badges, activity meters, and status", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/office") {
        return new Response(
          JSON.stringify({
            employees: [],
            accounts: [
              {
                id: "google-ai-pro",
                name: "Google AI Pro",
                models: ["gemini-2.5-pro"],
                harnesses: ["antigravity"],
                fiveHourSessions: 3,
                fiveHourMinutes: 12,
                sevenDaySessions: 15,
                sevenDayMinutes: 65,
              },
              {
                id: "local",
                name: "Local Ollama",
                models: ["qwen3:8b"],
                harnesses: ["opencode"],
                fiveHourSessions: 0,
                fiveHourMinutes: 0,
                sevenDaySessions: 2,
                sevenDayMinutes: 8,
              },
            ],
            rateLimits: {
              "google-ai-pro": {
                status: "allowed",
                updatedAt: 1000,
              },
              local: {
                // Expired rejection: resetsAt in the past
                status: "rejected",
                resetsAt: Date.now() - 60_000,
                updatedAt: 1000,
              },
              claude: {
                // Out of range utilization: clamp text and bar
                status: "rejected",
                resetsAt: Date.now() + 3_600_000,
                fiveHourUtilization: 1.5,
                sevenDayUtilization: null as unknown as number,
                updatedAt: 1000,
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ tickets: [] }), {
        headers: { "content-type": "application/json" },
      });
    });

    const root = await mount("inc-office", { show: "meters" });
    expect(root.textContent).toContain("Google AI Pro");
    expect(root.textContent).toContain("gemini-2.5-pro");
    expect(root.textContent).toContain("3 sessions · 12m active");
    expect(root.textContent).toContain("15 sessions · 65m active");
    expect(root.textContent).toContain("Local Ollama");
    expect(root.textContent).toContain("qwen3:8b");
    expect(root.textContent).toContain("2 sessions · 8m active");

    // Expired rejection on local: alarm chip is NOT shown
    expect(root.querySelector(".account-item:nth-child(2) .chip.alarm")).toBeNull();

    // Verify role="meter" tracks exist and have valid ARIA attributes
    const meters = root.querySelectorAll('.quota-bar-track[role="meter"]');
    expect(meters.length).toBeGreaterThan(0);
    for (const meter of meters) {
      expect(meter.getAttribute("aria-valuemin")).toBe("0");
      expect(meter.getAttribute("aria-valuemax")).toBe("100");
      const val = Number(meter.getAttribute("aria-valuenow"));
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(100);
    }
  });
});

describe("Work → Releases", () => {
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

    const root = await mount("inc-desk", { show: "releases" });
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

describe("empty states say what to do next", () => {
  const empty = () =>
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            employees: [],
            accounts: [],
            tickets: [],
            projects: [],
            releases: [],
            pendingReleases: [],
            waits: [],
            spend: { lines: [], total: 0, perMergedPR: null },
            bottleneck: null,
            merged: 0,
            changes: [],
          }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
    );

  it("the team floor links to hiring", async () => {
    empty();
    const root = await mount("inc-office");
    expect(root.querySelector(".empty-note a")?.getAttribute("href")).toBe("#/company/team/hiring");
  });

  it("the account meters link to Settings", async () => {
    empty();
    const root = await mount("inc-office", { show: "meters" });
    expect(root.querySelector(".empty-card a")?.getAttribute("href")).toBe("#/company/settings/engines");
  });

  it("releases link to Company → Projects when there are no projects", async () => {
    empty();
    const root = await mount("inc-desk", { show: "releases" });
    expect(root.querySelector(".releases a")?.getAttribute("href")).toBe("#/company/projects");
    expect(root.textContent).toContain("Nothing released yet.");
  });
});
