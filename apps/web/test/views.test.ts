// The views against a fake API: what they render, and what the owner's taps send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketView } from "../src/api.ts";
import "../src/components/board.ts";
import "../src/components/inbox.ts";

const view = (over: Partial<TicketView>): TicketView => ({
  id: "1",
  title: "Refunds are counted as spending",
  project: "Duet",
  type: "fix",
  effort: "medium",
  assignee: { id: "ada", name: "Ada" },
  column: "in-progress",
  status: "running",
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

function serve(tickets: TicketView[]) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body = url === "/api/board" ? { tickets } : { ok: true };
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

  it("says so when nothing needs the owner", async () => {
    serve([view({})]);
    const root = await mount("inc-inbox");
    expect(root.querySelector("h1")?.textContent).toBe("Nothing needs you");
  });
});
