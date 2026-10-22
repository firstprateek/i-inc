// T64 PR 2: the board (kanban first, New ticket in the header), what was asked at the top of a ticket, plain
// statuses with times in the owner's zone, and the Brain page without inline approvals.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketEvent, TicketView } from "../src/api.ts";
import { IncApp } from "../src/components/app.ts";
import "../src/components/board.ts";
import "../src/components/inbox.ts";
import type { IncKnowledge } from "../src/components/knowledge.ts";
import "../src/components/knowledge.ts";
import "../src/components/office.ts";
import { stateLabel } from "../src/components/shared.ts";
import "../src/components/conv-turn.ts";
import "../src/components/ticket.ts";
import { liveText } from "../src/assign.ts";
import { atTime } from "../src/time.ts";

const view = (over: Partial<TicketView>): TicketView =>
  ({
    id: "1",
    title: "Refunds are counted as spending",
    project: "Duet",
    type: "fix",
    effort: "medium",
    doneWhen: [],
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

let tickets: TicketView[] = [];
let events: TicketEvent[] = [];
let handbook: unknown = { pages: [], history: [], awaiting: [] };

beforeEach(() => {
  document.body.innerHTML = "";
  tickets = [];
  events = [];
  handbook = { pages: [], history: [], awaiting: [] };
  localStorage.clear();
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/board") return json({ tickets });
    if (url === "/api/projects") return json({ projects: [{ id: "Duet" }] });
    if (url === "/api/knowledge/handbook") return json(handbook);
    const m = /^\/api\/tickets\/(\d+)$/.exec(url);
    if (m) {
      const t = tickets.find((x) => x.id === m[1]);
      return t ? json({ ticket: t, events }) : json({ error: "no such ticket" }, 404);
    }
    return json({ ok: true, proposals: [], threads: [], employees: [], conversations: [], sessions: [] });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  location.hash = "";
});

async function mountApp(hash: string) {
  location.hash = hash;
  const app = new IncApp();
  document.body.append(app);
  await tick();
  return { app, root: app.shadowRoot as ShadowRoot };
}

async function mountTicket(t: TicketView) {
  tickets = [t];
  const el = document.createElement("inc-ticket") as HTMLElement & {
    ticketId: string;
    updateComplete: Promise<unknown>;
  };
  el.ticketId = t.id;
  document.body.append(el);
  await tick();
  await el.updateComplete;
  return el.shadowRoot as ShadowRoot;
}

describe("the board and its header action", () => {
  it("has New ticket as a header button on the board, opening the form in a dialog, and not on Releases", async () => {
    tickets = [view({})];
    const { app, root } = await mountApp("#/work/board");
    const button = root.querySelector('[slot="actions"]') as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent?.trim()).toBe("New ticket");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    const board = root.querySelector("inc-board")?.shadowRoot as ShadowRoot;
    const dialog = board.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.hasAttribute("open")).toBe(false);
    button.click();
    await tick();
    expect(dialog.hasAttribute("open")).toBe(true);
    const form = dialog.querySelector("inc-new-ticket") as HTMLElement & { updateComplete: Promise<unknown> };
    await form.updateComplete;
    expect(form.shadowRoot?.querySelector("input[name=title]")).not.toBeNull();
    // the form's Close closes the dialog
    form.shadowRoot?.querySelector<HTMLButtonElement>("button.ghost")?.click();
    await tick();
    expect(dialog.hasAttribute("open")).toBe(false);
    location.hash = "#/work/releases";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await app.updateComplete;
    expect(root.querySelector('button[slot="actions"]')).toBeNull();
  });

  it("puts the kanban first under the header, across the full width, and drops the form, Proposed and reports from above it", async () => {
    tickets = [
      view({}),
      view({ id: "2", title: "Shipped", column: "done", status: "done", outcome: "merged" }),
    ];
    const { root } = await mountApp("#/work/board");
    const board = root.querySelector("inc-board")?.shadowRoot as ShadowRoot;
    const first = board.firstElementChild as HTMLElement;
    expect(first.classList.contains("cols")).toBe(true);
    expect(board.querySelector(".top")).toBeNull();
    expect(board.querySelector("inc-proposals")).toBeNull();
    expect(board.querySelector(".digest")).toBeNull();
    expect(board.querySelectorAll(".cols > section").length).toBe(4);
    // the form is only ever in the dialog
    expect(board.querySelectorAll("inc-new-ticket").length).toBe(1);
    expect(board.querySelector("dialog inc-new-ticket")).not.toBeNull();
    const css = (customElements.get("inc-board") as unknown as { styles: { cssText: string }[] }).styles
      .map((s) => s.cssText)
      .join("\n");
    expect(css).toMatch(/\.cols \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
    // a phone gets a sheet, with a 44px Dismiss
    expect(css).toMatch(
      /@media \(max-width: 600px\) \{\s*dialog\.new-ticket \{[^}]*border-radius: 22px 22px 0 0/,
    );
  });
});

describe("the protected-paths OK (T68), now only in Needs you", () => {
  it("shows the commit and the change itself, with the rest behind Show all", async () => {
    const long = `diff --git a/apps/x.ts b/apps/x.ts\n${"+let a = 1;\n".repeat(600)}+THE-END\n`;
    tickets = [
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
    ];
    const el = document.createElement("inc-inbox");
    document.body.append(el);
    await tick();
    const root = el.shadowRoot as ShadowRoot;
    expect(root.textContent).toContain("abcdef1");
    expect(root.textContent).toContain("+let a = 1;");
    const shown = [...root.querySelectorAll("pre.diff")].map((p) => p.textContent ?? "");
    expect(shown).toHaveLength(2);
    expect(shown[0]).not.toContain("THE-END");
    expect(shown[1]).toContain("THE-END");
    expect(root.querySelector("details summary")?.textContent).toBe("Show all");
    expect([...root.querySelectorAll("button")].some((b) => b.textContent === "OK it")).toBe(true);
  });
});

describe("the New ticket button in every state of the board", () => {
  const open = async (board: ShadowRoot) => {
    window.dispatchEvent(new Event("i-inc-new-ticket"));
    await tick();
    return board.querySelector("dialog") as HTMLDialogElement;
  };

  it("opens the dialog while the board is still loading", async () => {
    vi.stubGlobal("fetch", (url: string) =>
      url === "/api/board" ? new Promise(() => {}) : Promise.resolve(json({ projects: [], employees: [] })),
    );
    const el = document.createElement("inc-board");
    document.body.append(el);
    await tick();
    const board = el.shadowRoot as ShadowRoot;
    expect(board.textContent).toContain("Loading the board");
    expect((await open(board)).hasAttribute("open")).toBe(true);
    expect(board.querySelector("dialog inc-new-ticket")).not.toBeNull();
  });

  it("opens the dialog when the board failed to load", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/board" ? json({ error: "no board today" }, 500) : json({ projects: [], employees: [] }),
    );
    const el = document.createElement("inc-board");
    document.body.append(el);
    await tick();
    const board = el.shadowRoot as ShadowRoot;
    expect(board.textContent).toContain("Couldn't load the board");
    expect((await open(board)).hasAttribute("open")).toBe(true);
  });
});

describe("what was asked, at the top of a ticket", () => {
  it("shows the done-when list above the current gate, open when it is short", async () => {
    const root = await mountTicket(
      view({
        id: "5",
        status: "needs-you",
        needsYou: { kind: "plan-gate", plan: "Add an alerts table" },
        doneWhen: ["August drops by the refund", "A test covers it"],
      }),
    );
    const asked = root.querySelector("section.asked") as HTMLElement;
    expect(asked.querySelector("h3")?.textContent?.trim()).toBe("What was asked");
    expect([...asked.querySelectorAll("li")].map((l) => l.textContent)).toEqual([
      "August drops by the refund",
      "A test covers it",
    ]);
    expect(asked.querySelector("button")).toBeNull(); // short: nothing to fold
    expect((asked.querySelector("#asked-body") as HTMLElement).hidden).toBe(false);
    const gate = root.querySelector(".ask") as HTMLElement;
    expect(asked.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and below the heading
    const h2 = root.querySelector("h2") as HTMLElement;
    expect(h2.compareDocumentPosition(asked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows why an agent filed a follow-up", async () => {
    const root = await mountTicket(
      view({
        id: "6",
        reason: "The sync gives up on the first timeout.",
        doneWhen: ["A timeout is retried"],
      }),
    );
    expect(root.querySelector(".asked .why")?.textContent).toBe("The sync gives up on the first timeout.");
  });

  it("folds a long one behind a 44px toggle that says how many items, and opens on a tap", async () => {
    const items = Array.from({ length: 6 }, (_, i) => `Done when number ${i + 1}`);
    const root = await mountTicket(view({ id: "7", doneWhen: items }));
    const toggle = root.querySelector("button.asked-toggle") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("6 done-when items");
    expect((root.querySelector("#asked-body") as HTMLElement).hidden).toBe(true);
    toggle.click();
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((root.querySelector("#asked-body") as HTMLElement).hidden).toBe(false);
    expect(root.querySelectorAll("#asked-body li").length).toBe(6);
    const css = (customElements.get("inc-ticket") as unknown as { styles: { cssText: string }[] }).styles
      .map((s) => s.cssText)
      .join("\n");
    expect(css).toMatch(/\.asked-toggle \{[^}]*min-height: 44px/);
  });

  it("is absent when nothing was written down", async () => {
    const root = await mountTicket(view({ id: "8", doneWhen: [] }));
    expect(root.querySelector(".asked")).toBeNull();
  });
});

describe("plain statuses, with times in the owner's zone", () => {
  const resumes = new Date(2026, 9, 22, 2, 14).getTime();

  it("calls an employee who ran out of tokens 'Waiting for tokens', not a coffee break", () => {
    expect(stateLabel["out-of-tokens"]?.[0]).toBe("Waiting for tokens");
    expect(stateLabel.idle?.[0]).toBe("Idle");
    expect(stateLabel.off?.[0]).toBe("Off hours");
  });

  it("words a ticket's resume time in local time on its board card and its page", async () => {
    const t = view({ id: "9", status: "paused", live: "Waiting for tokens", resumesAt: resumes });
    expect(liveText(t)).toMatch(
      /^Waiting for tokens until (tomorrow at |yesterday at |[A-Z][a-z]{2} \d+ at )?2:14\s?AM$/i,
    );
    expect(liveText(t)).toBe(`Waiting for tokens until ${atTime(resumes)}`);
    expect(liveText(t)).not.toMatch(/UTC/);
    tickets = [t];
    const { root } = await mountApp("#/work/board");
    const board = root.querySelector("inc-board")?.shadowRoot as ShadowRoot;
    expect(board.querySelector(".live")?.textContent).toBe(`Waiting for tokens until ${atTime(resumes)}`);
    document.body.innerHTML = "";
    const page = await mountTicket(t);
    expect(page.textContent).toContain(`Waiting for tokens until ${atTime(resumes)}`);
  });

  it("shows the timeline in local friendly time, and the token wait as a plain line", async () => {
    events = [
      { type: "stage-started", at: new Date(2026, 9, 22, 14, 7).getTime(), stage: "build" },
      {
        type: "out-of-tokens",
        at: new Date(2026, 9, 22, 14, 9).getTime(),
        stage: "build",
        engineId: "opus",
        resetsAt: resumes,
      },
    ] as TicketEvent[];
    const root = await mountTicket(view({ id: "10" }));
    const lines = [...root.querySelectorAll("ol li")].map((l) => l.textContent?.replace(/\s+/g, " ").trim());
    expect(lines[0]).toMatch(/^2:07\s?PM\s*build started$/i);
    expect(lines[1]).toContain(`Waiting for tokens until ${atTime(resumes)}`);
    expect(lines.join(" ")).not.toMatch(/coffee|UTC|14:0/i);
  });

  it("shows a failed ticket as Failed, plainly", async () => {
    const root = await mountTicket(
      view({ id: "11", status: "failed", failure: { stage: "checks", reason: "checks red", tried: [] } }),
    );
    expect(root.querySelector(".ask b")?.textContent).toBe("Failed in checks");
  });
});

describe("a usage limit in a conversation", () => {
  it("words the reset in the owner's zone from the host's moment, not from the agent's UTC text", async () => {
    const resetsAt = new Date(2026, 9, 22, 2, 14).getTime();
    const el = document.createElement("inc-conv-turn") as HTMLElement & { updateComplete: Promise<unknown> };
    Object.assign(el, {
      employee: "Ada",
      turn: {
        id: "t1",
        state: "error",
        message: { text: "hi", origin: { kind: "user" } },
        responseParts: [
          {
            kind: "error",
            id: "e1",
            resumable: false,
            error: {
              errorType: "rate_limited",
              message: "You've hit your session limit",
              _meta: { "iinc.resetsAt": resetsAt },
            },
          },
        ],
      },
    });
    document.body.append(el);
    await tick();
    await el.updateComplete;
    const text = el.shadowRoot?.querySelector(".error p")?.textContent ?? "";
    expect(text).toBe(`You've hit your session limit. It resets ${atTime(resetsAt)}.`);
    expect(text).not.toMatch(/UTC/);
  });
});

describe("the Brain page", () => {
  it("shows no approve or decline for a policy proposal: those are Needs you cards", async () => {
    handbook = {
      pages: [{ path: "INDEX.md", text: "# Map\n\nThe handbook." }],
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
    };
    const el = document.createElement("inc-knowledge") as IncKnowledge;
    el.repo = "handbook";
    document.body.append(el);
    await tick();
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    const labels = [...root.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels).not.toContain("Approve");
    expect(labels).not.toContain("Decline");
    expect(root.textContent).not.toContain("Squash-merge every PR.");
    // it says where the proposal is, with a link
    const note = root.querySelector(".awaiting-note") as HTMLElement;
    expect(note.textContent).toContain("1 policy change waits");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("#/needs-you");
    // the map is still there
    expect(root.textContent).toContain("The handbook.");
  });

  it("has no note when nothing waits", async () => {
    const el = document.createElement("inc-knowledge") as IncKnowledge;
    el.repo = "handbook";
    document.body.append(el);
    await tick();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".awaiting-note")).toBeNull();
  });
});
