// Shipping a conversation's work, on screen (T62b): the confirm dialog (what is committed, where it goes,
// what the owner still does, the editable title and done-when), the header menu, the context panel's section
// and the held conversation. The daemon is a scripted fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import type { IncConvContext } from "../../src/components/conv-context.ts";
import type { IncConvShip } from "../../src/components/conv-ship.ts";
import type { IncConvThread } from "../../src/components/conv-thread.ts";
import "../../src/components/conv-context.ts";
import "../../src/components/conv-ship.ts";
import "../../src/components/conv-thread.ts";
import { CHAT, hosts, must, SESSION, sessionState, until } from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted JSON.
type Any = any;

const conv: Any = {
  id: "ab12cd34",
  employeeId: "ada",
  project: "Duet",
  branch: "conv/ab12cd34",
  title: "Add a greeting",
  mode: null,
  engineId: "opus",
  createdAt: 0,
  archivedAt: null,
  ahpSession: SESSION,
  ahpChat: CHAT,
  status: 1,
  needsYou: false,
  running: false,
  modifiedAt: 0,
};
const ada: Any = { id: "ada", name: "Ada", role: "Engineer", tint: 0 };

const preview = (over: Any = {}): Any => ({
  project: "Duet",
  mode: "owner-merges",
  canTicket: true,
  canPr: true,
  ticket: null,
  pr: null,
  copy: {
    branch: "conv/ab12cd34",
    files: [
      { path: "src/greeting.ts", added: 12, removed: 3 },
      { path: ".github/workflows/ci.yml", added: 1, removed: 0 },
      { path: "logo.png", added: 0, removed: 0, binary: true },
    ],
    uncommitted: 2,
    ahead: 0,
    protectedPaths: [".github/workflows/ci.yml"],
    pushed: false,
    blockers: [],
  },
  suggestion: {
    title: "Add a greeting",
    doneWhen: ["Does what the conversation asked: add a greeting", "The project's checks pass"],
    description: "Made from a conversation",
  },
  ...over,
});

let posts: { url: string; body: Any }[] = [];
let answers: Record<string, () => Response>;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  answers = {};
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return (answers[url] ?? (() => reply({ ticket: { id: "7", title: "x" }, created: true }, 201)))();
    }
    return (answers[url] ?? (() => reply({})))();
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
  vi.unstubAllGlobals();
});

async function dialog(kind: "ticket" | "pr", view: Any = preview()) {
  answers["/api/conversations/ab12cd34/ship?preview=1"] = () => reply({ ship: view });
  const el = document.createElement("inc-conv-ship") as IncConvShip;
  el.conv = conv;
  el.employee = ada;
  el.kind = kind;
  const events: string[] = [];
  const done: Any[] = [];
  el.addEventListener("conv-ship-close", () => events.push("close"));
  el.addEventListener("conv-ship-done", (e) => done.push((e as CustomEvent).detail));
  document.body.append(el);
  await until(() => !el.loading);
  await el.updateComplete;
  const root = el.shadowRoot as ShadowRoot;
  const text = () => root.textContent?.replace(/\s+/g, " ") ?? "";
  const button = (label: RegExp) =>
    must<HTMLButtonElement>(
      [...root.querySelectorAll("button")].find((b) => label.test(b.textContent ?? "")),
    );
  return { el, root, text, button, events, done };
}

describe("the ship dialog: make this a ticket", () => {
  it("says what is committed (files with plus and minus), where it goes and what you still do, in an owner-merges project", async () => {
    const d = await dialog("ticket");
    expect(d.root.querySelector("h2")?.textContent).toBe("Make this a ticket");
    expect(d.text()).toContain("What gets committed");
    expect(d.text()).toContain("Ada's 2 unsaved changes become a commit on conv/ab12cd34");
    expect(d.text()).toContain("3 files differ from the project's main: +13 −3");
    const rows = [...d.root.querySelectorAll("ul.files li")].map((li) =>
      li.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows[0]).toBe(".github/workflows/ci.yml protected +1−0");
    expect(rows[1]).toBe("src/greeting.ts +12−3");
    expect(rows[2]).toBe("logo.png binary");
    expect(d.text()).toContain("Where it goes");
    expect(d.text()).toContain("A pull request opens on GitHub from conv/ab12cd34");
    expect(d.text()).toContain("What you still do");
    expect(d.text()).toContain("merge it when you're happy: only you can merge");
    expect(d.text()).toContain("Ada is paused on this conversation's files until the ticket is done");
    expect(d.text()).toContain("touches protected paths (.github/workflows/ci.yml)");
  });

  it("says straight to main after a review in a direct project, and that protected paths wait for the owner", async () => {
    const d = await dialog("ticket", preview({ mode: "direct", canPr: false }));
    expect(d.text()).toContain(
      "Straight to main on GitHub, after i.inc runs the project's checks and another employee reviews it",
    );
    expect(d.text()).toContain(
      "This change touches protected paths (.github/workflows/ci.yml): i.inc waits for your OK before anything goes to main",
    );
    expect(d.text()).not.toContain("merge it");
  });

  it("starts from the conversation's words, and lets the owner edit the title and the done-when items", async () => {
    const d = await dialog("ticket");
    const title = must<HTMLInputElement>(d.root.querySelector("#ship-title"));
    expect(title.value).toBe("Add a greeting");
    const items = () => [...d.root.querySelectorAll<HTMLInputElement>(".item input")].map((i) => i.value);
    expect(items()).toEqual([
      "Does what the conversation asked: add a greeting",
      "The project's checks pass",
    ]);
    title.value = "Greet users";
    title.dispatchEvent(new Event("input"));
    const first = must<HTMLInputElement>(d.root.querySelector(".item input"));
    first.value = "The home page says hello";
    first.dispatchEvent(new Event("input"));
    must<HTMLButtonElement>(d.root.querySelector('button[aria-label="Remove item 2"]')).click();
    await d.el.updateComplete;
    expect(items()).toEqual(["The home page says hello"]);
    // The last one can't be removed: a ticket needs a done-when.
    expect(must<HTMLButtonElement>(d.root.querySelector('button[aria-label="Remove item 1"]')).disabled).toBe(
      true,
    );
    d.button(/Add an item/).click();
    await d.el.updateComplete;
    const added = [...d.root.querySelectorAll<HTMLInputElement>(".item input")].at(-1) as HTMLInputElement;
    added.value = "It is tested";
    added.dispatchEvent(new Event("input"));

    d.button(/Make the ticket/).click();
    await until(() => posts.length);
    expect(posts).toEqual([
      {
        url: "/api/conversations/ab12cd34/ticket",
        body: { title: "Greet users", doneWhen: ["The home page says hello", "It is tested"] },
      },
    ]);
  });

  it("makes one ticket from a double click, then says so and links to it", async () => {
    const d = await dialog("ticket");
    const go = d.button(/Make the ticket/);
    go.click();
    go.click();
    await until(() => d.done.length);
    expect(posts).toHaveLength(1);
    expect(d.done).toEqual([{ kind: "ticket", ticketId: "7" }]);
    await d.el.updateComplete;
    expect(d.text()).toContain("This work is now ticket #7");
    expect(must<HTMLAnchorElement>(d.root.querySelector('a[href="#/ticket/7"]')).textContent).toContain(
      "Open ticket #7",
    );
    d.button(/^Close$/).click();
    expect(d.events).toEqual(["close"]);
  });

  it("shows the daemon's sentence when it refuses, keeps the dialog open and lets the owner try again", async () => {
    const d = await dialog("ticket");
    answers["/api/conversations/ab12cd34/ticket"] = () =>
      reply(
        {
          error:
            "Ada is still working in this conversation. Stop the turn (or wait for it to end), then make it a ticket.",
          code: "busy",
        },
        409,
      );
    d.button(/Make the ticket/).click();
    await until(() => d.root.querySelector(".body .alert"));
    expect(d.root.querySelector(".body .alert")?.textContent).toContain("Stop the turn");
    expect(d.root.querySelector("h2")?.textContent).toBe("Make this a ticket");
    expect(d.done).toEqual([]);
    await d.el.updateComplete;
    expect(d.button(/Make the ticket/).disabled).toBe(false);
  });

  it("checks the title and the done-when before sending anything", async () => {
    const d = await dialog("ticket");
    const title = must<HTMLInputElement>(d.root.querySelector("#ship-title"));
    title.value = "   ";
    title.dispatchEvent(new Event("input"));
    d.button(/Make the ticket/).click();
    await d.el.updateComplete;
    expect(d.root.querySelector(".body .alert")?.textContent).toBe("Give it a title.");
    title.value = "Fine";
    title.dispatchEvent(new Event("input"));
    for (const i of d.root.querySelectorAll<HTMLInputElement>(".item input")) {
      i.value = " ";
      i.dispatchEvent(new Event("input"));
    }
    d.button(/Make the ticket/).click();
    await d.el.updateComplete;
    expect(d.root.querySelector(".body .alert")?.textContent).toMatch(/at least one done-when/);
    expect(posts).toEqual([]);
  });

  it("stops at a credential: names the file, offers no way forward, and cannot be confirmed", async () => {
    const view = preview({
      copy: { ...preview().copy, blockers: ["config.ts looks like it holds a credential"] },
    });
    const d = await dialog("ticket", view);
    expect(d.text()).toContain("Can't ship yet: config.ts looks like it holds a credential.");
    expect(d.root.querySelector("#ship-title")).toBeNull();
    expect(d.button(/Make the ticket/).disabled).toBe(true);
  });

  it("says why a conversation can't be shipped, and when there is nothing to ship", async () => {
    const held = await dialog(
      "ticket",
      preview({
        canTicket: false,
        canPr: false,
        reason: "This work is now ticket #4.",
        ticket: { id: "4", held: true },
      }),
    );
    expect(held.text()).toContain("This work is now ticket #4.");
    expect(held.button(/Make the ticket/).disabled).toBe(true);
    document.body.innerHTML = "";
    const none = await dialog(
      "ticket",
      preview({ copy: { ...preview().copy, files: [], blockers: ["nothing has changed yet"] } }),
    );
    expect(none.text()).toContain("Can't ship yet: nothing has changed yet.");
    expect(none.button(/Make the ticket/).disabled).toBe(true);
  });

  it("says plainly when the working copy couldn't be read, and can look again", async () => {
    const d = await dialog("ticket", {
      ...preview(),
      copy: undefined,
      problem: "Couldn't wake Ada's machine: boom",
    });
    expect(d.root.querySelector(".alert")?.textContent).toBe("Couldn't wake Ada's machine: boom");
    expect(d.button(/Make the ticket/).disabled).toBe(true);
    answers["/api/conversations/ab12cd34/ship?preview=1"] = () => reply({ ship: preview() });
    d.button(/Look again/).click();
    await until(() => d.root.querySelector("ul.files"));
  });

  it("shows a failed preview as the daemon's sentence, with Try again", async () => {
    answers["/api/conversations/ab12cd34/ship?preview=1"] = () =>
      reply({ error: "GitHub isn't set up yet." }, 409);
    const el = document.createElement("inc-conv-ship") as IncConvShip;
    el.conv = conv;
    el.kind = "ticket";
    document.body.append(el);
    await until(() => el.shadowRoot?.querySelector(".alert"));
    expect(el.shadowRoot?.querySelector(".alert")?.textContent).toBe("GitHub isn't set up yet.");
    expect(el.shadowRoot?.textContent).toContain("Try again");
  });

  it("is a modal dialog: labelled, Escape closes it, and Tab stays inside it", async () => {
    const d = await dialog("ticket");
    const panel = must(d.root.querySelector('[role="dialog"]'));
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).toBe("ship-h");
    expect(d.root.querySelector("#ship-h")?.textContent).toBe("Make this a ticket");
    // The title field has focus first.
    expect(d.root.activeElement?.id).toBe("ship-title");
    const tab = (shift = false) =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true }),
      );
    const inside = () => d.root.activeElement as HTMLElement | null;
    const stops = d.root.querySelectorAll("button:not([disabled]), a[href], input:not([disabled])").length;
    for (let i = 0; i < stops + 2; i++) {
      tab();
      expect(inside()).not.toBeNull();
    }
    tab(true);
    expect(inside()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(d.events).toEqual(["close"]);
  });
});

describe("the ship dialog: open a PR", () => {
  it("says it is a draft without i.inc's review, and posts the title", async () => {
    const d = await dialog("pr");
    expect(d.root.querySelector("h2")?.textContent).toBe("Open a pull request");
    expect(d.text()).toContain("a draft pull request");
    expect(d.text()).toContain("It hasn't been through i.inc's checks and review");
    expect(d.root.querySelector(".item")).toBeNull();
    answers["/api/conversations/ab12cd34/pr"] = () =>
      reply(
        { pr: { number: 12, url: "https://github.com/acme/duet/pull/12", draft: true }, created: true },
        201,
      );
    d.button(/Open the pull request/).click();
    await until(() => d.done.length);
    expect(posts).toEqual([{ url: "/api/conversations/ab12cd34/pr", body: { title: "Add a greeting" } }]);
    expect(d.done[0]).toEqual({
      kind: "pr",
      pr: { number: 12, url: "https://github.com/acme/duet/pull/12" },
    });
    await d.el.updateComplete;
    const link = must<HTMLAnchorElement>(
      d.root.querySelector('a[href="https://github.com/acme/duet/pull/12"]'),
    );
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });
});

// ───────────────────────────── header menu, banner, context panel ─────────────────────────────

async function thread(ship?: Any, c: Any = conv) {
  const h = hosts();
  const connection = new AhpConnection({
    connect: h.connect,
    clientId: "me",
    backoff: () => 5,
    schedule: (fn) => {
      queueMicrotask(fn);
      return () => {};
    },
    pingMs: 0,
  });
  setAhp(connection);
  connection.start();
  const el = document.createElement("inc-conv-thread") as IncConvThread;
  el.conv = c;
  el.employee = ada;
  el.ship = ship;
  document.body.append(el);
  await until(() => connection.chat(CHAT) && connection.session(SESSION));
  (h.made[0] as Any).states.set(SESSION, sessionState());
  const root = el.shadowRoot as ShadowRoot;
  const shipEvents: Any[] = [];
  el.addEventListener("conv-ship", (e) => shipEvents.push((e as CustomEvent).detail));
  const open = async () => {
    must<HTMLButtonElement>(root.querySelector(".ship-btn")).click();
    await el.updateComplete;
  };
  return { el, root, open, shipEvents };
}

describe("the header menu", () => {
  it("offers both ways in an owner-merges project, and asks the screen to open the dialog", async () => {
    const t = await thread(preview());
    const btn = must<HTMLButtonElement>(t.root.querySelector(".ship-btn"));
    expect(btn.getAttribute("aria-label")).toBe("Ship this work");
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    await t.open();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const items = [...t.root.querySelectorAll('[role="menuitem"]')].map((i) =>
      i.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(items).toEqual([
      "Make this a ticket Checks and a review, then a PR for you",
      "Open a PR A draft, without i.inc's review",
    ]);
    must<HTMLElement>([...t.root.querySelectorAll<HTMLElement>('[role="menuitem"]')][1]).click();
    expect(t.shipEvents).toEqual([{ kind: "pr" }]);
    await t.el.updateComplete;
    expect(t.root.querySelector(".ship-menu")).toBeNull();
  });

  it("has no Open a PR in a direct project, and says why", async () => {
    const t = await thread(
      preview({
        mode: "direct",
        canPr: false,
        reason: "This project pushes straight to main after a review, so its way there is a ticket.",
      }),
    );
    await t.open();
    const items = [...t.root.querySelectorAll('[role="menuitem"]')].map((i) =>
      i.textContent?.trim().split("\n")[0]?.trim(),
    );
    expect(items).toEqual(["Make this a ticket"]);
    expect(t.root.querySelector(".ship-menu .why")?.textContent).toContain("straight to main");
  });

  it("keeps the buttons off a held conversation, and links the ticket and the PR", async () => {
    const t = await thread(
      preview({
        canTicket: false,
        canPr: false,
        reason: "This work is now ticket #4.",
        ticket: {
          id: "4",
          title: "Greeting",
          status: "running",
          stage: "checks",
          live: "Checks · running",
          held: true,
          outcome: null,
        },
        pr: {
          number: 9,
          url: "https://github.com/acme/duet/pull/9",
          state: "open",
          draft: true,
          checks: null,
        },
      }),
    );
    await t.open();
    const ticketItem = must<HTMLElement>([...t.root.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]);
    expect(ticketItem.getAttribute("aria-disabled")).toBe("true");
    ticketItem.click();
    expect(t.shipEvents).toEqual([]);
    expect(must<HTMLAnchorElement>(t.root.querySelector('a[href="#/ticket/4"]')).textContent).toContain(
      "Open ticket #4",
    );
    expect(
      must<HTMLAnchorElement>(t.root.querySelector('a[href="https://github.com/acme/duet/pull/9"]')).rel,
    ).toContain("noopener");
    // The conversation says whose the files are, and the composer says it can't be used.
    expect(t.root.querySelector(".held")?.textContent).toContain(
      "This work is now ticket #4: Checks · running. Ada is paused until it is done.",
    );
    await until(() => t.root.querySelector("inc-conv-composer"));
    const composer = t.root.querySelector("inc-conv-composer") as Any;
    expect(composer.blocked).toContain("This work is now ticket #4");
  });

  it("knows a held conversation from its row alone, before the ship call has answered", async () => {
    const t = await thread(undefined, { ...conv, ship: { ticket: { id: "4", held: true }, pr: null } });
    expect(t.root.querySelector(".held")?.textContent).toContain("This work is now ticket #4");
  });

  it("closes on Escape and gives focus back to the button", async () => {
    const t = await thread(preview());
    await t.open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await t.el.updateComplete;
    expect(t.root.querySelector(".ship-menu")).toBeNull();
    expect(t.root.activeElement?.classList.contains("ship-btn")).toBe(true);
  });

  it("is not there for a conversation with no project", async () => {
    const t = await thread(undefined, { ...conv, project: null, branch: null });
    expect(t.root.querySelector(".ship-btn")).toBeNull();
    expect(t.root.querySelector(".tool-btn")).not.toBeNull();
  });
});

async function context(ship?: Any, c: Any = conv) {
  const h = hosts();
  const connection = new AhpConnection({
    connect: h.connect,
    clientId: "me",
    backoff: () => 5,
    schedule: (fn) => {
      queueMicrotask(fn);
      return () => {};
    },
    pingMs: 0,
  });
  setAhp(connection);
  connection.start();
  const el = document.createElement("inc-conv-context") as IncConvContext;
  el.conv = c;
  el.employee = ada;
  el.ship = ship;
  document.body.append(el);
  await el.updateComplete;
  const root = el.shadowRoot as ShadowRoot;
  const section = () => root.querySelector('section[aria-labelledby="h-ship"]');
  const events: Any[] = [];
  el.addEventListener("conv-ship", (e) => events.push((e as CustomEvent).detail));
  return { el, root, section, events };
}

describe("the context panel's Ship this work", () => {
  it("shows the ticket's stage and status, and the PR's link and checks", async () => {
    const c = await context(
      preview({
        canTicket: false,
        ticket: {
          id: "4",
          title: "Greeting",
          status: "running",
          stage: "review",
          live: "Review · round 1",
          held: true,
          outcome: null,
        },
        pr: {
          number: 9,
          url: "https://github.com/acme/duet/pull/9",
          state: "open",
          draft: true,
          checks: { state: "pending", total: 3, passed: 1, failed: 0, pending: 2 },
        },
      }),
    );
    const text = c.section()?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("Ticket #4: Greeting");
    expect(text).toContain("Running · Review");
    expect(text).toContain("Review · round 1");
    expect(text).toContain("It has this conversation's files; the conversation is paused until it is done.");
    expect(text).toContain("Pull request #9 on GitHub");
    expect(text).toContain("Draft");
    expect(text).toContain("Checks: 1 of 3 passed, 2 running");
    expect(must<HTMLAnchorElement>(c.section()?.querySelector('a[href="#/ticket/4"]')).textContent).toContain(
      "Ticket #4",
    );
    const buttons = [...(c.section()?.querySelectorAll("button") ?? [])];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Make this a ticket", "Update the PR"]);
    expect(buttons[0]?.disabled).toBe(true);
  });

  it("words the checks and the ticket's end", async () => {
    const done = await context(
      preview({
        ticket: {
          id: "4",
          title: "G",
          status: "done",
          stage: null,
          live: "",
          held: false,
          outcome: "merged",
        },
        pr: {
          number: 9,
          url: "https://github.com/acme/duet/pull/9",
          state: "merged",
          draft: false,
          checks: { state: "success", total: 2, passed: 2, failed: 0, pending: 0 },
        },
      }),
    );
    const text = done.section()?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("Merged");
    expect(text).toContain("Checks: all 2 passed");
    expect(text).not.toContain("paused");
    document.body.innerHTML = "";
    const failed = await context(
      preview({
        pr: {
          number: 9,
          url: "https://github.com/acme/duet/pull/9",
          state: "open",
          draft: false,
          checks: { state: "failure", total: 4, passed: 2, failed: 1, pending: 1 },
        },
      }),
    );
    expect(failed.section()?.textContent).toContain("Checks: 1 of 4 failed");
    document.body.innerHTML = "";
    const down = await context(
      preview({
        pr: {
          number: 9,
          url: "https://github.com/acme/duet/pull/9",
          state: "unknown",
          draft: true,
          checks: null,
          problem: "Couldn't ask GitHub about the pull request.",
        },
      }),
    );
    expect(down.section()?.textContent).toContain("Couldn't ask GitHub about the pull request.");
  });

  it("offers the two buttons, which ask the screen for the dialog", async () => {
    const c = await context(preview());
    const [ticket, pr] = [...(c.section()?.querySelectorAll("button") ?? [])];
    expect(ticket?.disabled).toBe(false);
    ticket?.click();
    pr?.click();
    expect(c.events).toEqual([
      { kind: "ticket", from: "context" },
      { kind: "pr", from: "context" },
    ]);
  });

  it("offers only the ticket in a direct project, and says why", async () => {
    const c = await context(
      preview({
        mode: "direct",
        canPr: false,
        reason: "This project pushes straight to main after a review, so its way there is a ticket.",
      }),
    );
    expect([...(c.section()?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim())).toEqual([
      "Make this a ticket",
    ]);
    expect(c.section()?.textContent).toContain("straight to main after a review");
  });

  it("is not there with no project", async () => {
    const c = await context(undefined, { ...conv, project: null, branch: null });
    expect(c.section()).toBeNull();
  });
});

describe("binary files, many files, and taking the work back", () => {
  it("lists the protected files first and says how many more, never hiding a protected one", async () => {
    const files = [
      ...Array.from({ length: 60 }, (_, i) => ({ path: `src/f${i}.ts`, added: 1, removed: 0 })),
      { path: ".github/workflows/ci.yml", added: 1, removed: 0 },
    ];
    const d = await dialog(
      "ticket",
      preview({ copy: { ...preview().copy, files, protectedPaths: [".github/workflows/ci.yml"] } }),
    );
    const rows = [...d.root.querySelectorAll("ul.files li")].map((li) =>
      li.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(rows[0]).toContain(".github/workflows/ci.yml protected");
    expect(rows).toHaveLength(41);
    expect(rows.at(-1)).toBe("and 21 more");
    expect(d.text()).toContain("61 files differ from the project's main");
  });

  it("names binary files as not scanned, and waits for the owner to say they looked before sending confirmBinary", async () => {
    const d = await dialog(
      "ticket",
      preview({ copy: { ...preview().copy, binaries: [{ path: "logo.bin", size: 20480 }] } }),
    );
    expect(d.text()).toContain("Binary, not scanned");
    expect(d.text()).toMatch(/logo\.bin\s*20 KB/);
    expect(d.button(/Make the ticket/).disabled).toBe(true);
    const box = must<HTMLInputElement>(d.root.querySelector('input[type="checkbox"]'));
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await d.el.updateComplete;
    expect(d.button(/Make the ticket/).disabled).toBe(false);
    d.button(/Make the ticket/).click();
    await until(() => posts.length);
    expect(posts[0]?.body.confirmBinary).toBe(true);
  });

  it("takes the work back after a confirm dialog that says what happens", async () => {
    answers["/api/conversations/ab12cd34/take-back"] = () =>
      reply({ ok: true, released: true, pr: "closed" });
    const el = document.createElement("inc-conv-ship") as IncConvShip;
    el.conv = conv;
    el.employee = ada;
    el.kind = "takeback";
    el.ship = preview({
      ticket: {
        id: "4",
        title: "G",
        status: "ready",
        stage: null,
        live: "",
        held: true,
        outcome: null,
        canTakeBack: true,
      },
    });
    const done: Any[] = [];
    el.addEventListener("conv-ship-done", (e) => done.push((e as CustomEvent).detail));
    document.body.append(el);
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector("h2")?.textContent).toBe("Take the work back");
    expect(root.textContent).toContain("Ticket #4 ends as rejected");
    expect(root.textContent).toContain("Its pull request on GitHub, if it has one, is closed too");
    must<HTMLButtonElement>(
      [...root.querySelectorAll("button")].find((b) => /Take it back/.test(b.textContent ?? "")),
    ).click();
    await until(() => done.length);
    expect(posts).toEqual([{ url: "/api/conversations/ab12cd34/take-back", body: {} }]);
    expect(done).toEqual([{ kind: "takeback", prState: "closed" }]);
    await el.updateComplete;
    expect(root.textContent).toContain("Its pull request on GitHub is closed. You can reopen it there.");
  });

  it("offers it in the panel and the menu only for a ticket that waits for the owner", async () => {
    const waiting = preview({
      canTicket: false,
      canPr: false,
      ticket: {
        id: "4",
        title: "G",
        status: "ready",
        stage: null,
        live: "",
        held: true,
        outcome: null,
        canTakeBack: true,
      },
    });
    const c = await context(waiting);
    const labels = [...(c.section()?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim());
    expect(labels).toContain("Take the work back");
    [...(c.section()?.querySelectorAll("button") ?? [])]
      .find((b) => /Take the work back/.test(b.textContent ?? ""))
      ?.click();
    expect(c.events).toEqual([{ kind: "takeback", from: "context" }]);
    document.body.innerHTML = "";
    const running = await context(
      preview({
        ticket: {
          id: "4",
          title: "G",
          status: "running",
          stage: "review",
          live: "",
          held: true,
          outcome: null,
        },
      }),
    );
    expect(
      [...(running.section()?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim()),
    ).not.toContain("Take the work back");
    document.body.innerHTML = "";
    const t = await thread(waiting);
    await t.open();
    expect(t.root.querySelector(".ship-menu")?.textContent).toContain("Take the work back");
    must<HTMLElement>(
      [...t.root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) =>
        /Take the work back/.test(i.textContent ?? ""),
      ),
    ).click();
    expect(t.shipEvents).toEqual([{ kind: "takeback" }]);
  });
});
