// Proposed follow-ups (C20) on the board and in the inbox, against a fake API.
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

describe("Proposed on the board", () => {
  it("is hidden when there are none", async () => {
    const root = await mount("inc-board");
    expect(section(root)?.querySelector(".proposed")).toBeNull();
    expect(root.textContent).not.toContain("Proposed");
  });

  it("shows each proposal above the columns, with who proposed it and after which ticket", async () => {
    open = [
      proposal(),
      proposal({ id: 2, title: "Cache the rates", project: "fintrack", sourceTicket: "9" }),
    ];
    const root = await mount("inc-board");
    const s = section(root) as ShadowRoot;
    expect(s.querySelector("h2")?.textContent).toContain("Proposed");
    expect(s.querySelector("h2 .n")?.textContent).toBe("2");
    const cards = [...s.querySelectorAll("li.card")];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector(".title")?.textContent).toBe("Add retry to the sync");
    expect(cards[0]?.querySelector(".proj-badge")?.textContent).toContain("Duet");
    expect(cards[0]?.querySelector(".by")?.textContent?.replace(/\s+/g, " ")).toContain(
      "Proposed by Ada after #12",
    );
    expect(cards[0]?.querySelector<HTMLAnchorElement>(".by a")?.getAttribute("href")).toBe("#/ticket/12");
    // Above the columns in the document.
    const proposed = root.querySelector("inc-proposals") as Element;
    const cols = root.querySelector(".cols") as Element;
    expect(proposed.compareDocumentPosition(cols) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the body and done-when behind an expander", async () => {
    open = [proposal()];
    const s = section(await mount("inc-board")) as ShadowRoot;
    const details = s.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")).not.toBeNull();
    expect(details.textContent).toContain("The sync gives up on the first timeout.");
    expect(details.textContent).toContain("A timeout is retried twice");
  });

  it("has no expander for a recovered proposal with nothing to say, and no ticket link", async () => {
    open = [proposal({ body: "", doneWhen: [], sourceTicket: "" })];
    const s = section(await mount("inc-board")) as ShadowRoot;
    expect(s.querySelector("details")).toBeNull();
    expect(s.querySelector(".by a")).toBeNull();
    expect(s.querySelector(".by")?.textContent).toContain("Proposed by Ada");
  });

  it("Accept posts to the accept route and the proposal leaves the list", async () => {
    open = [proposal(), proposal({ id: 2, title: "Cache the rates" })];
    const root = await mount("inc-board");
    const s = section(root) as ShadowRoot;
    const accept = s.querySelector<HTMLButtonElement>("li.card button:not(.ghost)");
    expect(accept?.textContent).toBe("Accept");
    expect(accept?.getAttribute("aria-label")).toBe("Accept: Add retry to the sync");
    accept?.click();
    await tick();
    expect(calls).toContainEqual({ method: "POST", url: "/api/proposals/1/accept" });
    const after = section(root) as ShadowRoot;
    expect([...after.querySelectorAll(".title")].map((t) => t.textContent)).toEqual(["Cache the rates"]);
  });

  it("Decline posts to the decline route, and the last one hides the section", async () => {
    open = [proposal()];
    const root = await mount("inc-board");
    section(root)?.querySelector<HTMLButtonElement>("button.ghost")?.click();
    await tick();
    expect(calls).toContainEqual({ method: "POST", url: "/api/proposals/1/decline" });
    expect(section(root)?.querySelector(".proposed")).toBeNull();
  });

  it("says so when another window already decided it, and refreshes", async () => {
    open = [proposal()];
    const root = await mount("inc-board");
    failWith = { status: 409, error: "proposal 1 is already accepted" };
    open = [];
    section(root)?.querySelector<HTMLButtonElement>("button:not(.ghost)")?.click();
    await tick();
    // The refresh finds nothing open, so the section is gone rather than showing a stale card.
    expect(section(root)?.querySelector(".proposed")).toBeNull();
  });

  it("shows the error and keeps the card when the call fails for another reason", async () => {
    open = [proposal()];
    const root = await mount("inc-board");
    failWith = { status: 409, error: "Kit doesn't work on Duet" };
    section(root)?.querySelector<HTMLButtonElement>("button:not(.ghost)")?.click();
    await tick();
    const s = section(root) as ShadowRoot;
    expect(s.querySelector("[role=alert]")?.textContent).toContain("Kit doesn't work on Duet");
    expect(s.querySelectorAll("li.card")).toHaveLength(1);
  });

  it("still shows the board when the daemon has no proposals route", async () => {
    proposalsStatus = 404;
    const root = await mount("inc-board");
    expect(root.querySelector(".cols")).not.toBeNull();
    expect(section(root)?.querySelector(".proposed")).toBeNull();
  });

  it("refetches on a live refresh, so a new proposal appears without a reload", async () => {
    const root = await mount("inc-board");
    expect(section(root)?.querySelector(".proposed")).toBeNull();
    open = [proposal()];
    refreshNow();
    await tick();
    expect(section(root)?.querySelectorAll("li.card")).toHaveLength(1);
  });
});

describe("Proposed in the inbox", () => {
  it("counts proposals as things that need you, and lists them", async () => {
    open = [proposal(), proposal({ id: 2, title: "Cache the rates" })];
    const root = await mount("inc-inbox");
    expect(root.querySelector(".summary")?.textContent).toBe("2 things need you");
    expect(root.querySelector(".clear")).toBeNull();
    expect(section(root)?.querySelectorAll("li.card")).toHaveLength(2);
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
    section(root)?.querySelector<HTMLButtonElement>("button:not(.ghost)")?.click();
    await tick();
    expect(calls).toContainEqual({ method: "POST", url: "/api/proposals/1/accept" });
    expect(root.querySelector(".summary")?.textContent).toBe("Nothing needs you");
  });
});
