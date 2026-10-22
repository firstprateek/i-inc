// Proposed follow-ups (C20) in Needs you (they left the board in T64), against a fake API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalView } from "../src/api.ts";
import { refreshNow } from "../src/api.ts";
import "../src/components/board.ts";
import "../src/components/inbox.ts";

const proposal = (over: Partial<ProposalView> = {}): ProposalView => ({
  id: 1,
  project: "Duet",
  title: "Add retry to the sync",
  body: "The sync gives up on the first timeout.",
  doneWhen: ["A timeout is retried twice"],
  type: "fix",
  effort: "low",
  proposedBy: "ada",
  proposer: { id: "ada", name: "Ada", tint: 0, role: "Senior Engineer" },
  sourceTicket: "12",
  createdAt: 1_800_000_000_000,
  status: "open",
  decidedAt: null,
  ticketId: null,
  ...over,
});

let open: ProposalView[] = [];
let calls: { method: string; url: string }[] = [];
let failWith: { status: number; error: string } | null = null;
let proposalsStatus = 200;

function serve() {
  calls = [];
  failWith = null;
  proposalsStatus = 200;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/board") return reply({ tickets: [] });
    if (url === "/api/projects") return reply({ projects: [{ id: "Duet" }] });
    if (url === "/api/knowledge/handbook") return reply({ pages: [], history: [], awaiting: [] });
    if (url === "/api/proposals?status=open") {
      return proposalsStatus === 200 ? reply({ proposals: open }) : reply({ error: "not found" }, 404);
    }
    const m = /^\/api\/proposals\/(\d+)\/(accept|decline)$/.exec(url);
    if (m && method === "POST") {
      if (failWith) return reply({ error: failWith.error }, failWith.status);
      open = open.filter((p) => p.id !== Number(m[1]));
      return reply({ proposal: proposal({ id: Number(m[1]) }), ticket: { id: "30" } }, 201);
    }
    return reply({ ok: true });
  });
}

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mount(tag: "inc-board" | "inc-inbox"): Promise<ShadowRoot> {
  const el = document.createElement(tag);
  document.body.append(el);
  await tick();
  return el.shadowRoot as ShadowRoot;
}

/** The proposals component inside a view. */
const section = (root: ShadowRoot) => root.querySelector("inc-proposals")?.shadowRoot ?? null;

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  open = [];
  serve();
});
afterEach(() => vi.unstubAllGlobals());

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => proposal({ id: i + 1, title: `Follow-up number ${i + 1}` }));
const rows = (s: ShadowRoot) => [...s.querySelectorAll<HTMLElement>("li.row")];
const head = (s: ShadowRoot) => s.querySelector<HTMLButtonElement>("button.head") as HTMLButtonElement;
const listOf = (s: ShadowRoot) => s.querySelector<HTMLElement>("#proposed-list") as HTMLElement;

describe("Proposed in Needs you", () => {
  it("is hidden when there are none", async () => {
    const root = await mount("inc-inbox");
    expect(section(root)?.querySelector(".proposed")).toBeFalsy();
    expect(root.querySelector("inc-proposals")).toBeNull();
  });

  it("shows a one-line header and a dense row for each, in the Needs you list", async () => {
    open = [
      proposal(),
      proposal({ id: 2, title: "Cache the rates", project: "fintrack", sourceTicket: "9" }),
    ];
    const root = await mount("inc-inbox");
    const s = section(root) as ShadowRoot;
    expect(head(s).textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Proposed (2) — follow-ups waiting for you",
    );
    expect(head(s).getAttribute("aria-expanded")).toBe("true");
    const r = rows(s);
    expect(r).toHaveLength(2);
    expect(r[0]?.querySelector(".title")?.textContent).toBe("Add retry to the sync");
    expect(r[0]?.querySelector(".proj-badge")?.textContent).toContain("Duet");
    expect(r[0]?.querySelector(".meta")?.textContent?.replace(/\s+/g, " ")).toContain("by Ada after #12");
    expect(r[0]?.querySelector<HTMLAnchorElement>(".meta a")?.getAttribute("href")).toBe("#/ticket/12");
  });

  it("starts collapsed above three proposals, and the header opens and closes it", async () => {
    open = many(4);
    const s = section(await mount("inc-inbox")) as ShadowRoot;
    expect(head(s).getAttribute("aria-expanded")).toBe("false");
    expect(listOf(s).hidden).toBe(true);
    expect(head(s).textContent).toContain("Proposed (4)");
    head(s).click();
    await tick();
    expect(head(s).getAttribute("aria-expanded")).toBe("true");
    expect(listOf(s).hidden).toBe(false);
    head(s).click();
    await tick();
    expect(listOf(s).hidden).toBe(true);
  });

  it("stays open for three or fewer", async () => {
    open = many(3);
    const s = section(await mount("inc-inbox")) as ShadowRoot;
    expect(head(s).getAttribute("aria-expanded")).toBe("true");
  });

  it("shows five at most, with Show all for the rest", async () => {
    open = many(8);
    const s = section(await mount("inc-inbox")) as ShadowRoot;
    head(s).click();
    await tick();
    expect(rows(s)).toHaveLength(5);
    const more = s.querySelector<HTMLButtonElement>(".foot .more");
    expect(more?.textContent).toBe("Show all (8)");
    more?.click();
    await tick();
    expect(rows(s)).toHaveLength(8);
    expect(s.querySelector(".foot .more")?.textContent).toBe("Show fewer");
  });

  it("has no Show all for five or fewer", async () => {
    open = many(5);
    const s = section(await mount("inc-inbox")) as ShadowRoot;
    head(s).click();
    await tick();
    expect(s.querySelector(".foot")).toBeNull();
  });

  it("keeps the body and done-when behind a Why toggle on the row", async () => {
    open = [proposal()];
    const s = section(await mount("inc-inbox")) as ShadowRoot;
    const body = s.querySelector<HTMLElement>("#body-1") as HTMLElement;
    expect(body.hidden).toBe(true);
    expect(body.textContent).toContain("The sync gives up on the first timeout.");
    expect(body.textContent).toContain("A timeout is retried twice");
    const why = s.querySelector<HTMLButtonElement>("button.more") as HTMLButtonElement;
    expect(why.getAttribute("aria-expanded")).toBe("false");
    why.click();
    await tick();
    expect(why.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
  });

  it("has no Why toggle for a recovered proposal with nothing to say, and no ticket link", async () => {
    open = [proposal({ body: "", doneWhen: [], sourceTicket: "" })];
    const s = section(await mount("inc-inbox")) as ShadowRoot;
    expect(s.querySelector("button.more")).toBeNull();
    expect(s.querySelector(".meta a")).toBeNull();
    expect(s.querySelector(".meta")?.textContent).toContain("by Ada");
  });

  it("Accept posts to the accept route and the proposal leaves the list", async () => {
    open = [proposal(), proposal({ id: 2, title: "Cache the rates" })];
    const root = await mount("inc-inbox");
    const s = section(root) as ShadowRoot;
    const accept = s.querySelector<HTMLButtonElement>("li.row button.btn:not(.ghost)");
    expect(accept?.textContent).toBe("Accept");
    expect(accept?.getAttribute("aria-label")).toBe("Accept: Add retry to the sync");
    accept?.click();
    await tick();
    expect(calls).toContainEqual({ method: "POST", url: "/api/proposals/1/accept" });
    expect([...(section(root) as ShadowRoot).querySelectorAll(".title")].map((t) => t.textContent)).toEqual([
      "Cache the rates",
    ]);
  });

  it("Decline posts to the decline route, and the last one hides the section", async () => {
    open = [proposal()];
    const root = await mount("inc-inbox");
    section(root)?.querySelector<HTMLButtonElement>("button.ghost")?.click();
    await tick();
    expect(calls).toContainEqual({ method: "POST", url: "/api/proposals/1/decline" });
    expect(section(root)?.querySelector(".proposed")).toBeFalsy();
  });

  it("says so when another window already decided it, and refreshes", async () => {
    open = [proposal()];
    const root = await mount("inc-inbox");
    failWith = { status: 409, error: "proposal 1 is already accepted" };
    open = [];
    section(root)?.querySelector<HTMLButtonElement>("button.btn:not(.ghost)")?.click();
    await tick();
    expect(section(root)?.querySelector(".proposed")).toBeFalsy();
  });

  it("shows the error and keeps the row when the call fails for another reason", async () => {
    open = [proposal()];
    const root = await mount("inc-inbox");
    failWith = { status: 409, error: "Kit doesn't work on Duet" };
    section(root)?.querySelector<HTMLButtonElement>("button.btn:not(.ghost)")?.click();
    await tick();
    const s = section(root) as ShadowRoot;
    expect(s.querySelector("[role=alert]")?.textContent).toContain("Kit doesn't work on Duet");
    expect(rows(s)).toHaveLength(1);
  });

  it("moves keyboard focus to the next row after a decision", async () => {
    open = many(3);
    const root = await mount("inc-inbox");
    const s = section(root) as ShadowRoot;
    const first = s.querySelector<HTMLButtonElement>(
      '[data-row="1"] button.btn:not(.ghost)',
    ) as HTMLButtonElement;
    first.focus();
    first.click();
    await tick();
    const after = section(root) as ShadowRoot;
    expect(after.querySelector('[data-row="1"]')).toBeNull();
    const focused = after.activeElement as HTMLElement | null;
    expect(focused?.closest("[data-row]")?.getAttribute("data-row")).toBe("2");
  });

  it("moves focus to a short note after the last one is decided", async () => {
    open = [proposal()];
    const root = await mount("inc-inbox");
    const s = section(root) as ShadowRoot;
    const decline = s.querySelector<HTMLButtonElement>("button.ghost") as HTMLButtonElement;
    decline.focus();
    decline.click();
    await tick();
    const after = section(root) as ShadowRoot;
    expect(after.querySelector(".proposed")).toBeNull();
    expect(after.querySelector(".all-done")?.textContent).toContain("All decided");
    expect(after.activeElement?.classList.contains("all-done")).toBe(true);
  });

  it("still shows the list when the daemon has no proposals route", async () => {
    proposalsStatus = 404;
    const root = await mount("inc-inbox");
    expect(root.querySelector(".summary")).not.toBeNull();
    expect(section(root)?.querySelector(".proposed")).toBeFalsy();
  });

  it("refetches on a live refresh, so a new proposal appears without a reload", async () => {
    const root = await mount("inc-inbox");
    expect(section(root)?.querySelector(".proposed")).toBeFalsy();
    open = [proposal()];
    refreshNow();
    await tick();
    expect(rows(section(root) as ShadowRoot)).toHaveLength(1);
  });
});

describe("the board has no Proposed band (T64)", () => {
  it("leaves proposals to Needs you: the kanban is the first thing, with or without proposals", async () => {
    open = [proposal(), proposal({ id: 2, title: "Cache the rates" })];
    const root = await mount("inc-board");
    expect(root.querySelector("inc-proposals")).toBeNull();
    expect(root.textContent).not.toContain("Proposed");
    expect(root.firstElementChild?.classList.contains("cols")).toBe(true);
    // and the board does not even ask for them
    expect(calls.some((c) => c.url.startsWith("/api/proposals"))).toBe(false);
  });
});

describe("Proposed in the inbox", () => {
  it("counts proposals as things that need you, and lists them", async () => {
    open = [proposal(), proposal({ id: 2, title: "Cache the rates" })];
    const root = await mount("inc-inbox");
    expect(root.querySelector(".summary")?.textContent).toBe("2 things need you");
    expect(root.querySelector(".clear")).toBeNull();
    expect(section(root)?.querySelectorAll("li.row")).toHaveLength(2);
  });

  it("says nothing needs you, and shows no Proposed section, when there are none", async () => {
    const root = await mount("inc-inbox");
    expect(root.querySelector(".summary")?.textContent).toBe("Nothing needs you");
    expect(root.querySelector("inc-proposals")).toBeNull();
    expect(root.querySelector(".clear")).not.toBeNull();
  });

  it("Accept works there too", async () => {
    open = [proposal()];
    const root = await mount("inc-inbox");
    section(root)?.querySelector<HTMLButtonElement>("button.btn:not(.ghost)")?.click();
    await tick();
    expect(calls).toContainEqual({ method: "POST", url: "/api/proposals/1/accept" });
    expect(root.querySelector(".summary")?.textContent).toBe("Nothing needs you");
  });
});
