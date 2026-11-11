// Needs you's order and its count (WP1, N5): ready reports first, then what needs an answer, then what nobody has
// started, then what is running, and the agents' follow-up proposals folded last. The count is decisions only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalView, TicketView } from "../src/api.ts";
import "../src/components/inbox.ts";
import { answer, UNASSIGNED } from "./daemon-board.ts";

const view = (over: Partial<TicketView>): TicketView => ({
  id: "1",
  title: "A ticket",
  project: "Duet",
  type: "fix",
  effort: "medium",
  doneWhen: [],
  assignee: { id: "kit", name: "Kit", tint: 0 },
  column: "in-progress",
  status: "running",
  held: false,
  stages: [],
  live: "Build · Kit on Claude Sonnet",
  needsYou: null,
  waiting: null,
  report: null,
  failure: null,
  outcome: null,
  ...over,
});

const report = {
  title: "[fix] Refunds are counted as spending · Duet",
  byline: "Kit (Claude Sonnet), reviewed by Ada, 1 round",
  engines: null,
  checks: "checks green",
  minutes: 38,
  judgment: "Refunds are subtracted from spending.",
  pr: null,
};

const proposal = (id: number): ProposalView =>
  ({
    id,
    project: "Duet",
    title: `Follow-up ${id}`,
    body: "",
    doneWhen: [],
    type: "fix",
    effort: "low",
    proposedBy: "ada",
    proposer: { id: "ada", name: "Ada", tint: 0, role: "Senior Engineer" },
    sourceTicket: "",
    createdAt: 0,
    status: "open",
    decidedAt: null,
    ticketId: null,
  }) as ProposalView;

const TICKETS = [
  view({ id: "2", title: "Refunds are counted as spending", status: "ready", column: "review", report }),
  view({ id: "3", title: "Budget alerts", status: "needs-you", needsYou: { kind: "plan-gate", plan: "x" } }),
  view({ id: "7", title: "Export video" }),
  view({ id: "8", title: "Sync retries", status: "paused", live: "Waiting for tokens" }),
  view({
    id: "9",
    title: "Dark mode",
    status: "queued",
    column: "todo",
    waiting: UNASSIGNED,
    assignee: null,
  }),
  view({ id: "10", title: "Shipped", status: "done", column: "done" }),
];
const POLICY = {
  id: "4:9:p0",
  ticketId: "4",
  author: "Grace",
  at: 0,
  page: "merging",
  text: "Squash-merge every PR.",
};
const CONVERSATION = { id: "ab12cd34", employeeId: "ada", title: "Why are dates US format?", needsYou: true };

function serve(world: {
  tickets?: TicketView[];
  awaiting?: unknown[];
  proposals?: ProposalView[];
  conversations?: unknown[];
}) {
  vi.stubGlobal("fetch", async (url: string) => {
    const body =
      answer({ tickets: [], ...world }, url) ??
      (url === "/api/employees" ? { employees: [{ id: "ada", name: "Ada" }] } : {});
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
}

async function mount(): Promise<ShadowRoot> {
  const el = document.createElement("inc-inbox");
  document.body.append(el);
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  return el.shadowRoot as ShadowRoot;
}

const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, " ").trim();
/** The page's section headings in order, the folded Proposed band's included. */
const headings = (root: ShadowRoot) => [
  ...[...root.querySelectorAll(".sections > h2")].map((h) => text(h)),
  ...[...(root.querySelector("inc-proposals")?.shadowRoot?.querySelectorAll("h2") ?? [])].map((h) =>
    text(h)?.replace(/ \(\d+\).*/, ""),
  ),
];

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Needs you's order", () => {
  it("is Ready for you, Needs your answer, Not started, Running, then Proposed, folded, last", async () => {
    serve({
      tickets: TICKETS,
      awaiting: [POLICY],
      proposals: [proposal(1), proposal(2)],
      conversations: [CONVERSATION],
    });
    const root = await mount();
    expect(headings(root)).toEqual([
      "Ready for you",
      "Needs your answer",
      "Not started",
      "Running",
      "Proposed",
    ]);
    const last = [...root.children].filter((e) => e.tagName !== "STYLE").at(-1);
    expect(last?.tagName).toBe("INC-PROPOSALS");
    const band = root.querySelector("inc-proposals")?.shadowRoot;
    expect(band?.querySelector("button.head")?.getAttribute("aria-expanded")).toBe("false");
    // the conversation, the plan gate and the policy are the answers, in that order
    const answers = [...root.querySelectorAll(".sections > h2 + .list")][1];
    expect([...(answers?.querySelectorAll(".q") ?? [])].map((q) => text(q))).toEqual([
      "Why are dates US format?",
      "The plan for “Budget alerts” waits at the gate.",
      "Squash-merge every PR.",
    ]);
  });

  it("draws no empty sections, and keeps All clear with the Running strip under it", async () => {
    serve({ tickets: [view({ id: "7", title: "Export video" })] });
    const root = await mount();
    expect(headings(root)).toEqual(["Running"]);
    const clear = root.querySelector(".clear");
    expect(text(clear?.querySelector("h2"))).toBe("All clear");
    const running = root.querySelector("ul.rows") as Element;
    expect(clear?.compareDocumentPosition(running) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("puts the report first on a ready card: Read the report, then Approve, with the byline", async () => {
    serve({ tickets: TICKETS });
    const root = await mount();
    const card = root.querySelector(".sections > h2 + .list .item") as Element;
    expect(text(card.querySelector(".byline"))).toBe(
      "Kit (Claude Sonnet), reviewed by Ada, 1 round · 38 min",
    );
    const actions = [...card.querySelectorAll(".actions > .btn")];
    expect(actions.map((a) => [text(a), a.classList.contains("ghost")])).toEqual([
      ["Read the report", false],
      ["Approve", true],
    ]);
    expect(actions[0]?.getAttribute("href")).toBe("#/ticket/2");
  });

  it("lists a ticket nobody is assigned to as one row with Assign…, not an amber card", async () => {
    serve({ tickets: TICKETS });
    const root = await mount();
    const rows = [...root.querySelectorAll("ul.rows")];
    const notStarted = rows[0] as Element;
    expect(notStarted.querySelectorAll("li")).toHaveLength(1);
    expect(text(notStarted.querySelector("li a"))).toBe("#9 Dark mode");
    expect(text(notStarted.querySelector('a.btn[href="#/ticket/9/assign"]'))).toBe("Assign…");
    expect(root.querySelectorAll(".item.waiting")).toHaveLength(1); // the plan gate alone
  });

  it("shows what is running, one line each with who is on it and the live line, and nothing done or asking", async () => {
    serve({ tickets: TICKETS });
    const root = await mount();
    const running = [...root.querySelectorAll("ul.rows")][1] as Element;
    expect([...running.querySelectorAll("li")].map((li) => text(li))).toEqual([
      "#7 Export videoDuet Kit · Build · Kit on Claude Sonnet",
      "#8 Sync retriesDuet Kit · Waiting for tokens",
    ]);
    expect(running.querySelector("a")?.getAttribute("href")).toBe("#/ticket/7");
  });
});

describe("Needs you's count (N5)", () => {
  it("counts decisions only, and says separately how many are not started", async () => {
    serve({
      tickets: TICKETS,
      awaiting: [POLICY],
      proposals: [proposal(1), proposal(2)],
      conversations: [CONVERSATION],
    });
    const root = await mount();
    // the report, the plan gate, the conversation and the policy; not the two proposals, nor the unassigned ticket
    expect(text(root.querySelector(".summary"))).toBe("4 for you to decide");
    expect(text(root.querySelector(".summary + .sub"))).toBe("1 not started: nobody is assigned");
  });

  it("says nothing is for you to decide when only suggestions and unassigned tickets wait", async () => {
    serve({ tickets: TICKETS.filter((t) => t.id === "9"), proposals: [proposal(1)] });
    const root = await mount();
    expect(text(root.querySelector(".summary"))).toBe("Nothing for you to decide");
    expect(headings(root)).toEqual(["Not started", "Proposed"]);
  });

  it("is the number the daemon sends for the badge", async () => {
    const body = answer(
      { tickets: TICKETS, awaiting: [POLICY], proposals: [proposal(1)], conversations: [CONVERSATION] },
      "/api/needs-you",
    ) as { count: number };
    expect(body.count).toBe(4);
  });
});
