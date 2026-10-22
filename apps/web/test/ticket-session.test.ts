// "Open the session" (T69): the ticket page links each stage to a read-only view of it in the Conversations thread,
// which shows a live stage as it happens and a finished one as it was, and has no composer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../src/ahp/hub.ts";
import { USER_ORIGIN } from "../src/ahp/wire.ts";
import type { TicketSession } from "../src/api.ts";
import "../src/components/ticket-session.ts";
import "../src/components/transcript.ts";
import { hosts, must, until } from "./ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted protocol state.
type Any = any;

const SESSION = "ahp-session:/ticket:12";
const CHAT = "ahp-chat:/stage:7";

const micro = (fn: () => void) => {
  queueMicrotask(fn);
  return () => {};
};

const roChat = (over: Any = {}): Any => ({
  resource: CHAT,
  title: "#12 Fix the refunds · build",
  status: 1,
  modifiedAt: "2026-10-22T10:00:00.000Z",
  turns: [],
  interactivity: "read-only",
  _meta: { readOnly: true, "iinc.ticket": "12", "iinc.stage": "build" },
  ...over,
});
const roSession = (): Any => ({
  provider: "opus",
  title: "#12 Fix the refunds · build",
  status: 1,
  lifecycle: "ready",
  activeClients: [],
  chats: [],
  _meta: { readOnly: true, "iinc.ticket": "12" },
});

const started = {
  type: "chat/turnStarted",
  turnId: "stage-7",
  startedAt: "2026-10-22T10:00:00.000Z",
  message: { text: "Ticket #12 [fix] Fix the refunds\nStage: build", origin: USER_ORIGIN },
};
const plan = [
  {
    type: "chat/toolCallStart",
    turnId: "stage-7",
    toolCallId: "p",
    toolName: "x-iinc-plan",
    displayName: "Plan",
  },
  {
    type: "chat/toolCallReady",
    turnId: "stage-7",
    toolCallId: "p",
    invocationMessage: "Plan",
    confirmed: "not-needed",
  },
  {
    type: "chat/toolCallContentChanged",
    turnId: "stage-7",
    toolCallId: "p",
    content: [{ type: "text", text: "- [x] Find it\n- [ ] Fix it" }],
    _meta: {
      "iinc.plan": [
        { content: "Find it", status: "completed", priority: "high" },
        { content: "Fix it", status: "in_progress", priority: "high" },
      ],
    },
  },
];
const edit = [
  {
    type: "chat/toolCallStart",
    turnId: "stage-7",
    toolCallId: "e",
    toolName: "edit",
    displayName: "Edit src/sort.ts",
  },
  {
    type: "chat/toolCallReady",
    turnId: "stage-7",
    toolCallId: "e",
    invocationMessage: "Edit src/sort.ts",
    confirmed: "not-needed",
  },
  {
    type: "chat/toolCallComplete",
    turnId: "stage-7",
    toolCallId: "e",
    result: {
      success: true,
      pastTenseMessage: "Edited src/sort.ts",
      content: [
        {
          type: "fileEdit",
          after: { uri: "file:///work/src/sort.ts", content: { uri: "ahp-content:/aa", sizeHint: 3 } },
          diff: { added: 3, removed: 1 },
        },
      ],
    },
  },
];
const text = (content: string) => ({
  type: "chat/responsePart",
  turnId: "stage-7",
  part: { kind: "markdown", id: "stage-7:md1", content },
});
const usage = {
  type: "chat/usage",
  turnId: "stage-7",
  usage: { inputTokens: 900, outputTokens: 120, model: "Claude Opus" },
};

const stage = (over: Partial<TicketSession> = {}): TicketSession => ({
  id: 7,
  channel: { session: SESSION, chat: CHAT },
  stage: "build",
  employeeId: "ada",
  engineId: "opus",
  startedAt: Date.UTC(2026, 9, 22, 10, 0),
  endedAt: null,
  items: [{ kind: "text", text: "Working.", at: Date.UTC(2026, 9, 22, 10, 1) }],
  ...over,
});

let sessions: TicketSession[];
let calls: string[];

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessions = [stage()];
  calls = [];
  location.hash = "#/ticket/12/session/7";
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: /min-width: 1200px/.test(q),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.startsWith("/api/tickets/12/sessions")) return reply({ sessions });
    if (url.startsWith("/api/tickets/12"))
      return reply({
        ticket: { id: "12", title: "Fix the refunds", project: "Duet", status: "running" },
        events: [],
      });
    if (url.includes("/api/employees"))
      return reply({ employees: [{ id: "ada", name: "Ada", role: "Engineer", tint: 0 }] });
    return reply({}, 404);
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
  vi.unstubAllGlobals();
});

async function mount() {
  const h = hosts();
  const c = new AhpConnection({
    connect: h.connect,
    clientId: "me",
    backoff: () => 5,
    schedule: micro,
    pingMs: 0,
  });
  h.onConnect = (host) => {
    host.states.set(SESSION, roSession());
    host.states.set(CHAT, roChat());
  };
  setAhp(c);
  const el = document.createElement("inc-ticket-session") as Any;
  el.ticketId = "12";
  el.sessionId = "7";
  document.body.append(el);
  await until(() => c.chat(CHAT) && c.session(SESSION));
  await until(() => el.shadowRoot?.querySelector("inc-conv-thread"));
  const host = h.made[0] as NonNullable<(typeof h.made)[number]>;
  const thread = () => el.shadowRoot.querySelector("inc-conv-thread") as Any;
  const root = () => thread().shadowRoot as ShadowRoot;
  const turn = () =>
    root().querySelector("inc-conv-turn[active]")?.shadowRoot ??
    root().querySelector("inc-conv-turn")?.shadowRoot;
  return { c, h, host, el, thread, root, turn };
}

describe("the ticket page", () => {
  it("links each stage with a session to its view, and says when only the transcript is left", async () => {
    sessions = [
      stage({ id: 6, stage: "plan", endedAt: 1 }),
      stage(),
      stage({ id: 5, stage: "pickup", channel: null, endedAt: 1 }),
    ];
    vi.stubGlobal("fetch", async () => reply({ sessions }));
    const el = document.createElement("inc-transcript") as Any;
    el.ticketId = "12";
    document.body.append(el);
    await until(() => el.shadowRoot?.querySelector("li"));
    const links = [...el.shadowRoot.querySelectorAll("a.open-session")] as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#/ticket/12/session/6",
      "#/ticket/12/session/7",
    ]);
    expect(links.map((a) => a.textContent?.trim())).toEqual(["Open the session", "Open the session"]);
    // the one still running says so to the eye only (the dot is decoration)
    expect(links[1]?.querySelector(".live-dot")).not.toBeNull();
    expect(links[0]?.querySelector(".live-dot")).toBeNull();
    expect(links[1]?.getAttribute("aria-label")).toBe("Open the session: build by ada");
    expect(el.shadowRoot.querySelector(".gone")?.textContent).toContain("Only the transcript is kept");
  });

  it("shows no link for a daemon that does not know sessions' views", async () => {
    vi.stubGlobal("fetch", async () =>
      reply({
        sessions: [
          { stage: "plan", employeeId: "ada", engineId: "opus", startedAt: 1, endedAt: 2, items: [] },
        ],
      }),
    );
    const el = document.createElement("inc-transcript") as Any;
    el.ticketId = "12";
    document.body.append(el);
    await until(() => el.shadowRoot?.querySelector("li"));
    expect(el.shadowRoot.querySelector("a.open-session")).toBeNull();
    expect(el.shadowRoot.querySelector(".gone")).toBeNull();
  });
});

describe("the session view", () => {
  it("is the conversation thread, read-only: a 'Watching' header, a live mark, no composer, no shipping", async () => {
    const { host, root, thread } = await mount();
    host.send(CHAT, started);
    await until(() => root().querySelector("inc-conv-turn"));
    const head = root().querySelector(".head") as HTMLElement;
    expect(head.querySelector(".title")?.textContent).toBe("Watching #12 · build");
    expect(head.querySelector(".status")?.textContent?.trim()).toBe("Live");
    expect(head.querySelector(".status")?.getAttribute("role")).toBe("status");
    // nothing that sends, ships or remembers
    expect(root().querySelector("inc-conv-composer")).toBeNull();
    expect(head.querySelector(".ship-btn")).toBeNull();
    expect(head.querySelector('[aria-label="Remember this"]')).toBeNull();
    expect(root().querySelector(".ro-note")?.textContent).toContain("Read-only");
    expect(root().querySelector(".ro-note a")?.getAttribute("href")).toBe("#/ticket/12");
    // the brief is the first turn, folded
    const t = root().querySelector("inc-conv-turn")?.shadowRoot;
    expect(t?.querySelector("details.brief summary")?.textContent).toContain("The brief");
    expect(t?.querySelector(".user")).toBeNull();
    expect(thread().watch).toEqual({ ticket: "12", stage: "build", back: "#/ticket/12" });
  });

  it("updates as the stage works, and calls it finished when the turn completes", async () => {
    const { host, root } = await mount();
    host.send(CHAT, started);
    for (const a of plan) host.send(CHAT, a);
    host.send(CHAT, text("Looking at the sorter."));
    await until(() =>
      root()
        .querySelector("inc-conv-turn[active]")
        ?.shadowRoot?.textContent?.includes("Looking at the sorter."),
    );
    expect(root().querySelector(".status")?.textContent?.trim()).toBe("Live");
    host.send(CHAT, { type: "chat/delta", turnId: "stage-7", partId: "stage-7:md1", content: " Found it." });
    await until(() =>
      root().querySelector("inc-conv-turn[active]")?.shadowRoot?.textContent?.includes("Found it."),
    );
    for (const a of edit) host.send(CHAT, a);
    host.send(CHAT, usage);
    host.send(CHAT, { type: "chat/turnComplete", turnId: "stage-7", duration: 5000 });
    await until(() => root().querySelector(".status")?.textContent?.trim() === "Finished");
    expect(root().querySelector(".status.live")).toBeNull();
    // a finished stage has no "working" footer and no retry
    const done = root().querySelector("inc-conv-turn")?.shadowRoot;
    expect(done?.querySelector(".working")).toBeNull();
    expect([...(done?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim())).not.toContain(
      "Retry",
    );
  });

  it("shows a stage that failed with its reason and no Retry", async () => {
    const { host, root } = await mount();
    host.send(CHAT, started);
    host.send(CHAT, {
      type: "chat/error",
      turnId: "stage-7",
      duration: 10,
      part: {
        kind: "error",
        resumable: false,
        error: { errorType: "stuck", message: "the agent said nothing" },
      },
    });
    await until(() => root().querySelector(".status")?.textContent?.trim() === "Failed");
    const t = root().querySelector("inc-conv-turn")?.shadowRoot;
    expect(t?.querySelector(".error")?.textContent).toContain("the agent said nothing");
    expect([...(t?.querySelectorAll("button") ?? [])].map((b) => b.textContent?.trim())).not.toContain(
      "Retry",
    );
  });

  it("replays a finished stage from the host's store, as it was", async () => {
    const h = hosts();
    h.onConnect = (host) => {
      host.states.set(SESSION, roSession());
      host.states.set(
        CHAT,
        roChat({
          status: 1,
          turns: [
            {
              id: "stage-7",
              startedAt: "2026-10-22T10:00:00.000Z",
              duration: 4000,
              message: started.message,
              responseParts: [
                { kind: "markdown", id: "stage-7:md1", content: "All done: the sorter is fixed." },
              ],
              usage: { inputTokens: 900, outputTokens: 120, model: "Claude Opus" },
              state: "complete",
            },
          ],
        }),
      );
    };
    sessions = [stage({ endedAt: Date.UTC(2026, 9, 22, 10, 5) })];
    const c = new AhpConnection({
      connect: h.connect,
      clientId: "me",
      backoff: () => 5,
      schedule: micro,
      pingMs: 0,
    });
    setAhp(c);
    const el = document.createElement("inc-ticket-session") as Any;
    el.ticketId = "12";
    el.sessionId = "7";
    document.body.append(el);
    await until(() =>
      el.shadowRoot?.querySelector("inc-conv-thread")?.shadowRoot?.querySelector("inc-conv-turn"),
    );
    const root = el.shadowRoot.querySelector("inc-conv-thread").shadowRoot as ShadowRoot;
    expect(root.querySelector(".status")?.textContent?.trim()).toBe("Finished");
    expect(root.querySelector("inc-conv-turn")?.shadowRoot?.textContent).toContain(
      "All done: the sorter is fixed.",
    );
    expect(root.querySelector("inc-conv-composer")).toBeNull();
  });

  it("takes nothing from the keyboard or the page: there is nothing to dispatch", async () => {
    const { host, root } = await mount();
    host.send(CHAT, started);
    await until(() => root().querySelector("inc-conv-turn"));
    // the thread's own handlers are the only way an action leaves; none is reachable without a composer or a card
    expect(host.received.filter((m) => m.method === "dispatchAction")).toEqual([]);
    // and it does not tell the host that it is "looking" (that is for conversations' notifications)
    expect(host.received.filter((m) => m.method === "iinc/presence")).toEqual([]);
  });

  it("the context panel shows the plan, the files changed and the usage", async () => {
    const { host, el, root } = await mount();
    host.send(CHAT, started);
    for (const a of plan) host.send(CHAT, a);
    for (const a of edit) host.send(CHAT, a);
    host.send(CHAT, usage);
    host.send(CHAT, { type: "chat/turnComplete", turnId: "stage-7", duration: 5000 });
    await until(() => root().querySelector(".status")?.textContent?.trim() === "Finished");
    // a laptop window of 1200 or more has the panel open beside the thread
    await until(() => el.shadowRoot.querySelector("aside inc-conv-context"));
    const ctx = el.shadowRoot.querySelector("inc-conv-context").shadowRoot as ShadowRoot;
    await until(() => ctx.querySelector(".plan"));
    expect(ctx.querySelector("#h-where")?.textContent).toBe("This session");
    expect(ctx.textContent).toContain("Ticket");
    expect(ctx.textContent).toContain("build");
    expect(ctx.querySelector("#h-plan")?.textContent).toContain("1 of 2 done");
    expect(ctx.querySelector("#h-files")?.textContent).toContain("Files changed · 1");
    expect(ctx.querySelector("#h-usage")).not.toBeNull();
    expect(ctx.textContent).toContain("900 in");
    // no shipping section: it is not a conversation
    expect(ctx.querySelector("#h-ship")).toBeNull();
    expect(ctx.textContent).not.toContain("Make this a ticket");
  });

  it("Back goes to the ticket", async () => {
    const { root } = await mount();
    must<HTMLButtonElement>(root().querySelector(".back")).click();
    expect(location.hash).toBe("#/ticket/12");
    expect(must(root().querySelector(".back")).getAttribute("aria-label")).toBe("Back to ticket #12");
  });

  it("works in one column on a phone: Back is there, the panel is a sheet", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: /max-width: 767px/.test(q),
      addEventListener() {},
      removeEventListener() {},
    }));
    const { el, root } = await mount();
    await until(() => root().querySelector(".back"));
    expect(el.shadowRoot.querySelector("aside")).toBeNull();
    must<HTMLButtonElement>(root().querySelector('[aria-label="Context panel"]')).click();
    await until(() => el.shadowRoot.querySelector(".sheet"));
    expect(el.shadowRoot.querySelector(".sheet")?.getAttribute("role")).toBe("dialog");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => !el.shadowRoot.querySelector(".sheet"));
  });

  it("says so when the live view was let go of, when the session is not on the ticket and when the ticket is gone", async () => {
    sessions = [stage({ channel: null, endedAt: 1 })];
    const h = hosts();
    setAhp(
      new AhpConnection({ connect: h.connect, clientId: "me", backoff: () => 5, schedule: micro, pingMs: 0 }),
    );
    const el = document.createElement("inc-ticket-session") as Any;
    el.ticketId = "12";
    el.sessionId = "7";
    document.body.append(el);
    await until(() => el.shadowRoot?.querySelector(".none h2"));
    expect(el.shadowRoot.querySelector(".none h2")?.textContent).toContain(
      "live view of this session is gone",
    );
    expect(el.shadowRoot.querySelector(".none a")?.getAttribute("href")).toBe("#/ticket/12");

    sessions = [];
    el.sessionId = "99";
    await until(() => el.shadowRoot.querySelector(".none h2")?.textContent === "No such session");
    el.ticketId = "404";
    await until(() => el.shadowRoot.querySelector(".none h2")?.textContent === "No such ticket");
  });
});
