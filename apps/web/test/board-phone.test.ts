// The board on the phone: the new-ticket form, agent-filed badges, the protected-paths OK card
// and the digest of recent reports, against a fake API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketEvent, TicketView } from "../src/api.ts";
import { ago, digestRow } from "../src/components/board.ts";
import "../src/components/board.ts";

const view = (over: Partial<TicketView> & { createdBy?: unknown }): TicketView =>
  ({
    id: "1",
    title: "Refunds are counted as spending",
    project: "Duet",
    type: "fix",
    effort: "medium",
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
  }) as TicketView;

const NOW = 1_800_000_000_000;
const minutesAgo = (m: number) => NOW - m * 60_000;

let calls: { method: string; url: string; body: unknown }[] = [];
let createError: string | null = null;

function serve(tickets: TicketView[], events: Record<string, TicketEvent[]> = {}) {
  calls = [];
  createError = null;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/board") return reply({ tickets });
    if (url === "/api/projects") return reply({ projects: [{ id: "Duet" }, { id: "fintrack" }] });
    if (url === "/api/tickets" && method === "POST") {
      return createError ? reply({ error: createError }, 400) : reply({ ticket: { id: "9" } }, 201);
    }
    const m = /^\/api\/tickets\/(\d+)$/.exec(url);
    if (m) {
      const t = tickets.find((x) => x.id === m[1]);
      return t ? reply({ ticket: t, events: events[t.id] ?? [] }) : reply({ error: "no such ticket" }, 404);
    }
    return reply({ ok: true });
  });
}

const tick = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mount(): Promise<ShadowRoot> {
  const el = document.createElement("inc-board");
  document.body.append(el);
  await tick();
  return el.shadowRoot as ShadowRoot;
}

const form = async (root: ShadowRoot) => {
  const el = root.querySelector("inc-new-ticket") as HTMLElement & { updateComplete: Promise<unknown> };
  (el.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  await el.updateComplete;
  return el;
};

const setValue = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("the new-ticket form", () => {
  it("files a ticket with the title, details, project and effort, and says so", async () => {
    serve([]);
    const el = await form(await mount());
    const r = el.shadowRoot as ShadowRoot;
    setValue(r.querySelector("input[name=title]") as HTMLInputElement, "  Dark mode for the chart ");
    setValue(
      r.querySelector("textarea") as HTMLTextAreaElement,
      "Chart follows the theme\n\nLegend is readable\n",
    );
    setValue(r.querySelector("select[name=project]") as HTMLSelectElement, "fintrack");
    (r.querySelector("input[name=effort][value=high]") as HTMLInputElement).click();
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();

    const post = calls.find((c) => c.method === "POST" && c.url === "/api/tickets");
    expect(post?.body).toEqual({
      title: "Dark mode for the chart",
      project: "fintrack",
      type: "feat",
      effort: "high",
      doneWhen: ["Chart follows the theme", "Legend is readable"],
    });
    expect(r.querySelector("[role=status]")?.textContent).toContain("#9");
    expect((r.querySelector("input[name=title]") as HTMLInputElement).value).toBe("");
  });

  it("defaults to the last project used", async () => {
    localStorage.setItem("inc.new-ticket.project", "fintrack");
    serve([]);
    const el = await form(await mount());
    const select = el.shadowRoot?.querySelector("select[name=project]") as HTMLSelectElement;
    expect(select.value).toBe("fintrack");
  });

  it("remembers the project it filed under for next time", async () => {
    serve([]);
    const el = await form(await mount());
    const r = el.shadowRoot as ShadowRoot;
    setValue(r.querySelector("input[name=title]") as HTMLInputElement, "Something");
    setValue(r.querySelector("select[name=project]") as HTMLSelectElement, "fintrack");
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();
    expect(localStorage.getItem("inc.new-ticket.project")).toBe("fintrack");
  });

  it("asks for a title instead of posting an empty one", async () => {
    serve([]);
    const el = await form(await mount());
    const r = el.shadowRoot as ShadowRoot;
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();
    expect(r.querySelector("[role=alert]")?.textContent).toContain("title");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("shows the daemon's error and keeps what was typed", async () => {
    serve([]);
    const el = await form(await mount());
    const r = el.shadowRoot as ShadowRoot;
    createError = "type must be fix, feat, chore or errand";
    setValue(r.querySelector("input[name=title]") as HTMLInputElement, "Keep me");
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();
    expect(r.querySelector("[role=alert]")?.textContent).toContain("type must be");
    expect((r.querySelector("input[name=title]") as HTMLInputElement).value).toBe("Keep me");
  });
});

describe("agent-filed follow-ups", () => {
  it("badges a ticket an agent filed, and leaves the owner's alone", async () => {
    serve([
      view({ id: "1", title: "Owner ticket" }),
      view({ id: "2", title: "Follow-up", createdBy: { id: "kit", name: "Kit", tint: 1 } }),
    ]);
    const root = await mount();
    const cards = [...root.querySelectorAll("a.card")];
    const byTitle = (t: string) => cards.find((c) => c.querySelector(".title")?.textContent === t);
    expect(byTitle("Follow-up")?.querySelector(".by")?.textContent).toBe("Filed by Kit");
    expect(byTitle("Owner ticket")?.querySelector(".by")).toBeNull();
  });
});

describe("the protected-paths card", () => {
  it("surfaces the ticket at the top with an OK action that uses the approval API", async () => {
    serve([
      view({
        id: "4",
        title: "Add a release workflow",
        status: "needs-you",
        needsYou: { kind: "protected-paths", paths: [".github/workflows/release.yml"] },
      }),
    ]);
    const root = await mount();
    const card = root.querySelector(".ok-card");
    expect(card?.textContent).toContain(".github/workflows/release.yml");
    const ok = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "OK it");
    ok?.click();
    await tick();
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/tickets/4/answer",
      body: { answer: "approve" },
    });
  });

  it("shows the commit and the change itself, with the rest behind Show all (T68)", async () => {
    const long = `diff --git a/apps/x.ts b/apps/x.ts\n${"+let a = 1;\n".repeat(600)}+THE-END\n`;
    serve([
      view({
        id: "5",
        title: "Change the daemon",
        status: "needs-you",
        needsYou: {
          kind: "protected-paths",
          paths: ["apps/x.ts"],
          sha: "abcdef1234567890abcdef1234567890abcdef12",
          patchId: "p".repeat(64),
          diff: long,
          diffTruncated: true,
        },
      }),
    ]);
    const card = (await mount()).querySelector(".ok-card");
    expect(card?.textContent).toContain("abcdef1");
    expect(card?.textContent).toContain("+let a = 1;");
    // A preview first; the end of the diff is behind "Show all".
    const shown = [...(card?.querySelectorAll("pre.diff") ?? [])].map((p) => p.textContent ?? "");
    expect(shown).toHaveLength(2);
    expect(shown[0]).not.toContain("THE-END");
    expect(shown[1]).toContain("THE-END");
    expect(card?.querySelector("details summary")?.textContent).toBe("Show all");
    expect(card?.textContent).toContain("the rest is cut");
  });

  it("shows nothing extra when no ticket waits on protected paths", async () => {
    serve([view({})]);
    expect((await mount()).querySelector(".ok-card")).toBeNull();
  });
});

describe("the digest of recent reports", () => {
  const merged: TicketEvent[] = [
    { type: "pushed", at: minutesAgo(130), sha: "abc" },
    { type: "closed", at: minutesAgo(120), outcome: "merged" },
  ];

  it("lists the last few finished tickets, newest first, each linking to its ticket", async () => {
    serve(
      [
        view({ id: "1", title: "Older merge", column: "done", status: "done", outcome: "merged" }),
        view({ id: "2", title: "Broke the build", column: "review", status: "failed" }),
        view({ id: "3", title: "Still going" }),
      ],
      {
        "1": [
          { type: "pushed", at: minutesAgo(600), sha: "a" },
          { type: "closed", at: minutesAgo(600), outcome: "merged" },
        ],
        "2": [{ type: "failed", at: minutesAgo(30), stage: "checks", reason: "checks red", tried: [] }],
      },
    );
    const rows = [...(await mount()).querySelectorAll(".digest li")];
    expect(rows.map((r) => r.querySelector(".title")?.textContent)).toEqual([
      "Broke the build",
      "Older merge",
    ]);
    expect(rows[0]?.querySelector(".chip")?.textContent).toBe("Failed");
    expect(rows[0]?.querySelector(".note")?.textContent).toBe("failed");
    expect(rows[1]?.querySelector(".chip")?.textContent).toBe("Merged");
    expect(rows[1]?.querySelector(".note")?.textContent).toBe("pushed");
    expect(rows[1]?.querySelector("a")?.getAttribute("href")).toBe("#/ticket/1");
  });

  it("is absent when nothing has finished", async () => {
    serve([view({})]);
    expect((await mount()).querySelector(".digest")).toBeNull();
  });

  it("reads one ticket's events into outcome, push state and time", () => {
    const t = view({ id: "7", title: "T", column: "done", status: "done" });
    expect(digestRow(t, merged)).toEqual({
      id: "7",
      title: "T",
      outcome: "Merged",
      note: "pushed",
      at: minutesAgo(120),
    });
    expect(digestRow(t, [])).toBeNull();
  });

  it("says how long ago", () => {
    expect(ago(NOW, NOW)).toBe("just now");
    expect(ago(minutesAgo(5), NOW)).toBe("5 min ago");
    expect(ago(minutesAgo(180), NOW)).toBe("3 h ago");
    expect(ago(minutesAgo(60 * 24 * 4), NOW)).toBe("4 d ago");
  });
});
