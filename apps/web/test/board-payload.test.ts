// What opening the board and one live event cost with a thousand tickets (T63): before, 16 requests and 2.6 MB
// to open, and 9 requests and 1.3 MB for each ticket event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../src/ahp/hub.ts";
import { refreshNow, type TicketView } from "../src/api.ts";
import { IncApp } from "../src/components/app.ts";
import "../src/components/board.ts";
import "../src/components/inbox.ts";
import { hosts } from "./ahp/fake-host.ts";
import { answer } from "./daemon-board.ts";

const COLUMNS = ["todo", "in-progress", "review", "done"] as const;

const ticket = (n: number): TicketView =>
  ({
    id: String(n),
    title: `Ticket number ${n} with a title of ordinary length`,
    project: "Duet",
    type: "fix",
    effort: "medium",
    doneWhen: ["the first thing it must do", "the second thing it must do"],
    assignee: { id: "ada", name: "Ada", tint: 0 },
    column: COLUMNS[n % 4],
    status: n % 4 === 3 ? "done" : "running",
    held: false,
    stages: [{ id: "build", state: "current" }],
    live: "Build",
    needsYou: null,
    waiting: null,
    report: null,
    failure: null,
    outcome: null,
  }) as unknown as TicketView;

let tickets: TicketView[] = [];
let log: { url: string; bytes: number }[] = [];

beforeEach(() => {
  tickets = Array.from({ length: 1000 }, (_, i) => ticket(i + 1));
  log = [];
  history.replaceState(null, "", "/");
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async (url: string) => {
    const body = JSON.stringify(
      answer({ tickets }, url) ?? (url === "/api/board" ? { tickets } : { employees: [], projects: [] }),
    );
    log.push({ url, bytes: body.length });
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  location.hash = "";
});

const settle = async (app: IncApp) => {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;
  }
};

async function open(): Promise<{ app: IncApp; board: HTMLElement; root: ShadowRoot }> {
  location.hash = "#/work/board";
  const app = new IncApp();
  document.body.append(app);
  await settle(app);
  const board = app.shadowRoot?.querySelector("inc-board") as HTMLElement;
  return { app, board, root: board.shadowRoot as ShadowRoot };
}

const paths = () => log.map((l) => l.url.replace(/\?.*/, ""));
const total = () => log.reduce((n, l) => n + l.bytes, 0);

describe("opening the board with 1,000 tickets", () => {
  it("is a handful of small requests, not one per ticket or per source", async () => {
    await open();
    const p = paths();
    expect(p.filter((x) => x === "/api/board/summary")).toHaveLength(1);
    expect(p.filter((x) => x === "/api/needs-you")).toHaveLength(1);
    for (const never of ["/api/board", "/api/knowledge/handbook", "/api/proposals", "/api/conversations"]) {
      expect(p, never).not.toContain(never);
    }
    expect(p.filter((x) => /^\/api\/tickets\//.test(x))).toEqual([]);
    expect(log.length).toBeLessThanOrEqual(5);
    // It was 2.6 MB.
    expect(total()).toBeLessThan(150_000);
  });

  it("shows each column's total, the first cards, and Show more for the rest", async () => {
    const { root } = await open();
    const sections = [...root.querySelectorAll("section")];
    const cards = (s: Element) => s.querySelectorAll("a.card").length;
    const done = sections[3] as Element;
    expect(done.querySelector("h2")?.textContent).toContain("250");
    expect(cards(done)).toBe(15);
    expect(done.querySelector("button.more")?.textContent).toContain("Show 25 more");
    expect(done.querySelector("button.more")?.getAttribute("aria-label")).toContain("235 not shown");
    // Done is newest first, and its cards carry no request for a report: the page already has them.
    expect(done.querySelector("a.card .title")?.textContent).toContain("Ticket number 999");
  });

  it("loads the next page of one column on Show more, and only that", async () => {
    const { root, app } = await open();
    log = [];
    const more = root.querySelectorAll("section")[3]?.querySelector<HTMLButtonElement>("button.more");
    more?.click();
    await settle(app);
    expect(log.map((l) => l.url)).toEqual(["/api/board/column?column=done&offset=15&limit=25"]);
    expect(root.querySelectorAll("section")[3]?.querySelectorAll("a.card")).toHaveLength(40);
  });
});

describe("a live event for one ticket", () => {
  it("fetches that ticket's card and the count, and updates the one card", async () => {
    const { root, app } = await open();
    const before = root.querySelectorAll("a.card").length;
    log = [];
    tickets[3] = { ...(tickets[3] as TicketView), live: "Checks passed", title: "Renamed by the event" };
    refreshNow({ tickets: new Set(["4"]), office: false });
    await settle(app);
    const p = log.map((l) => l.url);
    expect(p).toEqual(expect.arrayContaining(["/api/board/cards?ids=4", "/api/needs-you"]));
    expect(p).toHaveLength(2);
    expect(total()).toBeLessThan(5_000); // it was 1.3 MB
    expect(root.textContent).toContain("Renamed by the event");
    expect(root.querySelectorAll("a.card").length).toBe(before);
  });

  it("moves the card between columns and keeps the totals", async () => {
    const { root, app } = await open();
    // Ticket 8 is in To do; it starts running.
    expect((tickets.find((x) => x.id === "8") as TicketView).column).toBe("todo");
    tickets = tickets.map((x) => (x.id === "8" ? ({ ...x, column: "in-progress" } as TicketView) : x));
    log = [];
    refreshNow({ tickets: new Set(["8"]), office: false });
    await settle(app);
    const totals = [...root.querySelectorAll("section h2")].map((h) => h.textContent?.replace(/\D+/g, ""));
    expect(totals).toEqual(["249", "251", "250", "250"]); // To do -1, In progress +1
    // It moved by itself: one card fetched, no summary.
    expect(paths()).not.toContain("/api/board/summary");
  });

  it("does nothing on the board for an employee-only event", async () => {
    const { app } = await open();
    log = [];
    refreshNow({ tickets: new Set(), office: true });
    await settle(app);
    expect(paths().filter((p) => p.startsWith("/api/board"))).toEqual([]);
  });

  it("reloads the summary for an event with no ticket named (everything may have changed)", async () => {
    const { app } = await open();
    log = [];
    refreshNow();
    await settle(app);
    expect(paths().filter((p) => p === "/api/board/summary")).toHaveLength(1);
    expect(paths().filter((p) => p === "/api/needs-you")).toHaveLength(1);
  });
});

describe("the Needs you page and the badge", () => {
  it("share one request for each refresh", async () => {
    location.hash = "#/needs-you";
    const app = new IncApp();
    document.body.append(app);
    await settle(app);
    log = [];
    refreshNow();
    await settle(app);
    expect(paths().filter((p) => p === "/api/needs-you")).toHaveLength(1);
    expect(paths().filter((p) => p === "/api/board")).toEqual([]);
  });
});

describe("the Needs you count and the AHP connection's opening roster", () => {
  it("is not counted again for the snapshot every connection sends, but is for a real change", async () => {
    vi.useFakeTimers();
    try {
      const h = hosts();
      setAhp(new AhpConnection({ connect: h.connect, pingMs: 0, backoff: () => 5 }));
      location.hash = "#/work/board";
      const app = new IncApp();
      document.body.append(app);
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.made.length).toBeGreaterThan(0);
      // The page opened with one count (the connection's snapshot did not ask for another).
      expect(paths().filter((p) => p === "/api/needs-you")).toHaveLength(1);
      log = [];
      (h.made[0] as NonNullable<(typeof h.made)[number]>).notify("root/sessionAdded", {
        channel: "ahp-root:/",
        session: "ahp-session:/chat/ab12cd34",
        summary: { resource: "ahp-session:/chat/ab12cd34", status: 24 },
      });
      // The roster is debounced (600 ms); the 5 s fallback poll (no event stream here) is not reached.
      await vi.advanceTimersByTimeAsync(1000);
      expect(paths()).toEqual(["/api/needs-you"]);
    } finally {
      resetAhp();
      vi.useRealTimers();
    }
  });
});
