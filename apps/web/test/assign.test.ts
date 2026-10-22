// Assigning a ticket the owner filed: the "Assign to" choice on the form and on the ticket page, and the
// plain-words reason a ticket is waiting on the board, the ticket page and the inbox (T45).
import type { Employee } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TicketView } from "../src/api.ts";
import { assignees, waitingLine, waitsForAssignee } from "../src/assign.ts";
import "../src/components/board.ts";
import "../src/components/inbox.ts";
import "../src/components/ticket.ts";

const emp = (id: string, name: string, over: Partial<Employee> = {}): Employee =>
  ({
    id,
    name,
    role: "Senior Engineer",
    duties: ["build", "review"],
    engines: { default: "opus", fallbacks: [] },
    switchRules: {},
    ...over,
  }) as Employee;

const ada = emp("ada", "Ada");
const kit = emp("kit", "Kit", { projects: ["Duet"] });
const mo = emp("mo", "Mo", { projects: ["fintrack"], role: "Staff Engineer" });
const quinn = emp("quinn", "Quinn", { role: "QA", duties: ["verify"] });
const team = [ada, kit, mo, quinn];

const view = (over: Partial<TicketView> = {}): TicketView =>
  ({
    id: "12",
    title: "Dark mode for the budget page",
    project: "Duet",
    type: "feat",
    effort: "medium",
    assignee: null,
    column: "todo",
    status: "queued",
    held: false,
    stages: [],
    live: "Queued",
    needsYou: null,
    waiting: "unassigned, and no standing order covers it",
    report: null,
    failure: null,
    outcome: null,
    ...over,
  }) as TicketView;

describe("who can take a ticket", () => {
  it("offers employees who build and work on the project, the project's own people first", () => {
    expect(assignees(team, "Duet", []).map((e) => e.id)).toEqual(["kit", "ada"]);
    expect(assignees(team, "fintrack", []).map((e) => e.id)).toEqual(["mo", "ada"]);
    expect(assignees(team, "listy", []).map((e) => e.id)).toEqual(["ada"]);
  });

  it("puts the one who most recently worked on the project first", () => {
    const both = [kit, emp("zed", "Zed", { projects: ["Duet"] })];
    const done = (id: string, who: Employee) =>
      view({ id, status: "ready", assignee: { id: who.id, name: who.name, tint: 0 } });
    expect(
      assignees(both, "Duet", [done("3", kit), done("7", both[1] as Employee)]).map((e) => e.id),
    ).toEqual(["zed", "kit"]);
    expect(
      assignees(both, "Duet", [done("9", kit), done("7", both[1] as Employee)]).map((e) => e.id),
    ).toEqual(["kit", "zed"]);
  });
});

describe("the reason a ticket waits, in plain words", () => {
  const at = () => "3:40 PM";
  const table: [string, number | undefined, string][] = [
    ["unassigned, and no standing order covers it", undefined, "Waiting: nobody is assigned yet"],
    ["assignee ghost doesn't work here", undefined, "Waiting: ghost doesn't work on this project"],
    ["Ada is busy", undefined, "Waiting: Ada is busy with another ticket"],
    ["Juno is off until 22:00", undefined, "Waiting: Juno starts at 10 PM"],
    ["Juno is off until 7:00", undefined, "Waiting: Juno starts at 7 AM"],
    ["Ada waits for claude-pro to reset", 1, "Waiting for claude-pro usage to reset at 3:40 PM"],
    ["Ada waits for claude-pro to reset", undefined, "Waiting for claude-pro usage to reset"],
    ["Ada reached its usage cap", 1, "Waiting: Ada's usage resets at 3:40 PM"],
    ["Ada reached its usage cap", undefined, "Waiting: Ada reached the usage cap"],
    [
      "waits for a reviewer: Kit is busy",
      undefined,
      "Waiting for a reviewer: Kit is busy with another ticket",
    ],
    ["no one else has the review duty", undefined, "Waiting: no other employee has the review duty"],
    ["coffee break", undefined, "Waiting: coffee break"],
  ];
  it.each(table)("%s", (reason, until, line) => {
    expect(waitingLine(reason, until, at)).toBe(line);
  });

  it("words a reset on another day without 'at Tomorrow'", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(2, 14, 0, 0);
    expect(waitingLine("Ada reached its usage cap", tomorrow.getTime())).toMatch(
      /^Waiting: Ada's usage resets tomorrow at 2:14\s?AM$/i,
    );
    expect(waitingLine("Ada waits for claude-pro to reset", tomorrow.getTime())).toMatch(
      /^Waiting for claude-pro usage to reset tomorrow at 2:14\s?AM$/i,
    );
  });

  it("offers the owner an assignment only when assigning would help", () => {
    expect(waitsForAssignee(view())).toBe(true);
    expect(
      waitsForAssignee(
        view({
          waiting: "assignee ghost doesn't work here",
          assignee: { id: "ghost", name: "ghost", tint: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      waitsForAssignee(view({ waiting: "Ada is busy", assignee: { id: "ada", name: "Ada", tint: 0 } })),
    ).toBe(false);
    // A standing order covers it and its taker is busy: the board says so, and nothing is asked of the owner.
    expect(waitsForAssignee(view({ waiting: "Qwen is busy" }))).toBe(false);
    expect(waitsForAssignee(view({ held: true }))).toBe(false);
    expect(waitsForAssignee(view({ status: "running", waiting: null }))).toBe(false);
  });
});

let calls: { method: string; url: string; body: unknown }[] = [];

function serve(tickets: TicketView[], employees: Employee[] = team) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/board") return reply({ tickets });
    if (url === "/api/employees") return reply({ employees });
    if (url === "/api/projects")
      return reply({ projects: [{ id: "Duet" }, { id: "fintrack" }, { id: "listy" }] });
    if (url === "/api/tickets" && method === "POST") return reply({ ticket: { id: "13" } }, 201);
    if (url === "/api/knowledge/handbook") return reply({ pages: [], history: [], awaiting: [] });
    if (/\/assign$/.test(url)) return reply({ ok: true });
    const m = /^\/api\/tickets\/(\d+)$/.exec(url);
    if (m) {
      const t = tickets.find((x) => x.id === m[1]);
      return t ? reply({ ticket: t, events: [] }) : reply({ error: "no such ticket" }, 404);
    }
    return reply({ ok: true });
  });
}

const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function mount<T extends HTMLElement>(tag: string, props: Record<string, unknown> = {}) {
  const el = document.createElement(tag) as T & { updateComplete: Promise<unknown> };
  Object.assign(el, props);
  document.body.append(el);
  await tick();
  await el.updateComplete;
  return el;
}

const setValue = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  location.hash = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("the new-ticket form's Assign to", () => {
  const open = async () => {
    const board = await mount("inc-board");
    const el = board.shadowRoot?.querySelector("inc-new-ticket") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    (el.shadowRoot as ShadowRoot).querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
    await el.updateComplete;
    await tick();
    return el.shadowRoot as ShadowRoot;
  };
  const options = (r: ShadowRoot) =>
    [...r.querySelectorAll<HTMLOptionElement>("select[name=assignee] option")].map((o) => [
      o.value,
      o.textContent,
    ]);

  it("lists people for the project, with name and role, and an explicit Nobody yet", async () => {
    serve([]);
    const r = await open();
    expect(options(r)).toEqual([
      ["kit", "Kit · Senior Engineer"],
      ["ada", "Ada · Senior Engineer"],
      ["", "Nobody yet — Won't start until someone is assigned"],
    ]);
  });

  it("defaults to the project's usual employee and follows the project", async () => {
    serve([]);
    localStorage.setItem("inc.new-ticket.project", "Duet");
    const r = await open();
    // "Duet" is Kit's; everyone else works on every project.
    const select = () => r.querySelector("select[name=assignee]") as HTMLSelectElement;
    expect(options(r).map(([v]) => v)).toEqual(["kit", "ada", ""]);
    expect(select().value).toBe("kit");
    setValue(r.querySelector("select[name=project]") as HTMLSelectElement, "fintrack");
    await tick();
    expect(select().value).toBe("mo");
    setValue(r.querySelector("select[name=project]") as HTMLSelectElement, "listy");
    await tick();
    expect(select().value).toBe("ada");
  });

  it("sends the chosen assignee, and none for Nobody yet", async () => {
    serve([]);
    const r = await open();
    setValue(r.querySelector("input[name=title]") as HTMLInputElement, "Dark mode");
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();
    const post = () => calls.filter((c) => c.method === "POST" && c.url === "/api/tickets").at(-1)?.body;
    expect(post()).toMatchObject({ project: "Duet", assignee: "kit" });

    setValue(r.querySelector("select[name=assignee]") as HTMLSelectElement, "");
    setValue(r.querySelector("input[name=title]") as HTMLInputElement, "Another");
    (r.querySelector("button[type=submit]") as HTMLButtonElement).click();
    await tick();
    expect(post()).not.toHaveProperty("assignee");
  });

  it("keeps an explicit choice when the project changes and they still fit", async () => {
    serve([]);
    const r = await open();
    setValue(r.querySelector("select[name=assignee]") as HTMLSelectElement, "ada");
    setValue(r.querySelector("select[name=project]") as HTMLSelectElement, "fintrack");
    await tick();
    expect((r.querySelector("select[name=assignee]") as HTMLSelectElement).value).toBe("ada");
  });
});

describe("the ticket page's Who should do this?", () => {
  const page = async (t: TicketView) => {
    serve([t]);
    const el = await mount("inc-ticket", { ticketId: t.id });
    return el.shadowRoot as ShadowRoot;
  };

  it("shows the reason and the card for a ticket that has not started, and posts the chosen employee", async () => {
    const r = await page(view());
    expect(r.querySelector(".waits")?.textContent).toContain("Waiting: nobody is assigned yet");
    const card = r.querySelector("#assign") as HTMLElement;
    expect(card.querySelector("h3")?.textContent).toBe("Who should do this?");
    const select = card.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["kit", "ada"]);
    expect(select.value).toBe("kit");
    expect(select.options[0]?.textContent).toBe("Kit · Senior Engineer");

    setValue(select, "ada");
    (card.querySelector("button.btn") as HTMLButtonElement).click();
    await tick();
    const post = calls.find((c) => c.method === "POST");
    expect(post).toEqual({ method: "POST", url: "/api/tickets/12/assign", body: { to: "ada" } });
  });

  it("posts the default when the owner changes nothing", async () => {
    const r = await page(view());
    (r.querySelector("#assign button.btn") as HTMLButtonElement).click();
    await tick();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ to: "kit" });
  });

  it("shows an error when the daemon refuses", async () => {
    const r = await page(view());
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "Kit doesn't work on Duet" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    (r.querySelector("#assign button.btn") as HTMLButtonElement).click();
    await tick();
    expect(r.querySelector("[role=alert]")?.textContent).toBe("Kit doesn't work on Duet");
  });

  it("is not there once the ticket has started", async () => {
    const r = await page(
      view({
        status: "running",
        column: "in-progress",
        waiting: null,
        assignee: { id: "ada", name: "Ada", tint: 0 },
      }),
    );
    expect(r.querySelector("#assign")).toBeNull();
    expect(r.textContent).not.toContain("Who should do this?");
    expect(calls.some((c) => c.url === "/api/employees")).toBe(false);
  });

  it("says so when nobody works on the project", async () => {
    serve([view()], [emp("mo", "Mo", { projects: ["fintrack"] })]);
    const el = await mount("inc-ticket", { ticketId: "12" });
    const card = el.shadowRoot?.querySelector("#assign");
    expect(card?.querySelector("select")).toBeNull();
    expect(card?.textContent).toContain("Nobody works on Duet yet");
  });
});

describe("saying why a ticket waits", () => {
  it("shows the status line and an Assign… link on a board card, beside the card link", async () => {
    serve([
      view(),
      view({
        id: "13",
        title: "Running one",
        status: "running",
        column: "in-progress",
        waiting: null,
        live: "Build",
        assignee: { id: "ada", name: "Ada", tint: 0 },
      }),
    ]);
    const root = (await mount("inc-board")).shadowRoot as ShadowRoot;
    const card = root.querySelector('a.card.t[href="#/ticket/12"]') as HTMLElement;
    expect(card.querySelector(".waits")?.textContent).toBe("Waiting: nobody is assigned yet");
    const assign = root.querySelector('a.assign[href="#/ticket/12/assign"]') as HTMLElement;
    expect(assign.textContent).toBe("Assign…");
    expect(card.contains(assign)).toBe(false);
    expect(root.querySelectorAll("a.assign")).toHaveLength(1);
    expect(root.querySelector('a.card.t[href="#/ticket/13"] .waits')).toBeNull();
  });

  it("gives no Assign… to a ticket waiting for its busy assignee", async () => {
    serve([view({ waiting: "Ada is busy", assignee: { id: "ada", name: "Ada", tint: 0 } })]);
    const root = (await mount("inc-board")).shadowRoot as ShadowRoot;
    expect(root.querySelector(".waits")?.textContent).toBe("Waiting: Ada is busy with another ticket");
    expect(root.querySelector("a.assign")).toBeNull();
  });

  it("lists an unassigned ticket in the inbox with the reason and Assign…", async () => {
    serve([view()]);
    const root = (await mount("inc-inbox")).shadowRoot as ShadowRoot;
    expect(root.querySelector(".summary")?.textContent).toBe("1 thing needs you");
    expect(root.querySelector(".waits")?.textContent).toContain("Waiting: nobody is assigned yet");
    expect(root.querySelector('a[href="#/ticket/12/assign"]')?.textContent).toBe("Assign…");
    expect(root.textContent).not.toContain("All clear");
  });

  it("opens the ticket at the assign card for #/ticket/12/assign", async () => {
    location.hash = "#/ticket/12/assign";
    serve([view()]);
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    const el = await mount("inc-ticket", { ticketId: "12" });
    await tick();
    expect(scrolled).toHaveBeenCalled();
    expect(el.shadowRoot?.querySelector("#assign select")).toBeTruthy();
  });
});
