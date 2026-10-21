// `#/conversations/<id>?card=<id>` (T65): a notification opens a conversation at one card. The card is brought
// into view, its first button gets focus and it is outlined for a moment; if it was answered already, the
// thread says so instead.
import { chatReducer } from "@microsoft/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import { USER_ORIGIN } from "../../src/ahp/wire.ts";
import type { IncConvThread } from "../../src/components/conv-thread.ts";
import "../../src/components/conv-thread.ts";
import { isPending } from "../../src/conversations/model.ts";
import { OPEN_CARD_EVENT } from "../../src/register-sw.ts";
import { parse } from "../../src/routes.ts";
import {
  CHAT,
  chatState,
  type FakeHost,
  hosts,
  must,
  SESSION,
  sessionState,
  tick,
  until,
} from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted protocol state.
type Any = any;

const micro = (fn: () => void) => {
  queueMicrotask(fn);
  return () => {};
};

const conv: Any = {
  id: "ab12cd34",
  employeeId: "ada",
  project: "Duet",
  branch: "conv/ab12cd34",
  title: "Fix it",
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

const started = {
  type: "chat/turnStarted",
  turnId: "t1",
  startedAt: "2026-10-21T10:00:00.000Z",
  message: { text: "edit it", origin: USER_ORIGIN },
};
const ask = (id: string) => [
  {
    type: "chat/toolCallStart",
    turnId: "t1",
    toolCallId: id,
    toolName: "edit",
    displayName: "Edit src/app.ts",
  },
  {
    type: "chat/toolCallReady",
    turnId: "t1",
    toolCallId: id,
    invocationMessage: "Edit src/app.ts",
    confirmationTitle: "Edit src/app.ts",
    options: [
      { id: "allow-once", label: "Allow once", kind: "approve", group: 0 },
      { id: "reject-once", label: "Deny", kind: "deny", group: 0 },
    ],
  },
];
const answered = (id: string) => ({
  type: "chat/toolCallConfirmed",
  turnId: "t1",
  toolCallId: id,
  approved: true,
  confirmed: "user-action",
  selectedOptionId: "allow-once",
});

/** A chat that is mid-turn with these actions applied, as the host's snapshot would hold it. */
const seeded = (...actions: Any[]) =>
  actions.reduce((st, a) => chatReducer(st, a), chatState({ turns: [], status: 8 }));

async function open(o: { seed?: Any; card?: string } = {}) {
  const h = hosts();
  h.onConnect = (host: FakeHost) => {
    host.states.set(SESSION, sessionState());
    if (o.seed) host.states.set(CHAT, o.seed);
  };
  const c = new AhpConnection({
    connect: h.connect,
    clientId: "me",
    backoff: () => 5,
    schedule: micro,
    pingMs: 0,
  });
  setAhp(c);
  c.start();
  const el = document.createElement("inc-conv-thread") as IncConvThread;
  el.conv = conv;
  el.employee = ada;
  el.card = o.card ?? "";
  document.body.append(el);
  await until(() => c.chat(CHAT) && c.session(SESSION));
  const host = h.made[0] as FakeHost;
  const turn = () => el.shadowRoot?.querySelector("inc-conv-turn[active]")?.shadowRoot;
  const tool = () => turn()?.querySelector("inc-conv-tool") as HTMLElement | null | undefined;
  const note = () => el.shadowRoot?.querySelector(".card-note")?.textContent?.replace(/\s+/g, " ").trim();
  return { c, el, host, tool, note };
}

afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
});

describe("the address", () => {
  it("carries the card in ?card= and nothing else in the route", () => {
    expect(parse("#/conversations/ab12cd34?card=toolu_01AbC")).toEqual({
      view: "conversations",
      id: "ab12cd34",
      card: "toolu_01AbC",
    });
    expect(parse("#/conversations/ab12cd34")).toEqual({ view: "conversations", id: "ab12cd34" });
    // an odd card is dropped, not trusted
    expect(parse("#/conversations/ab12cd34?card=<script>")).toEqual({
      view: "conversations",
      id: "ab12cd34",
    });
    expect(parse(`#/conversations/ab12cd34?card=${"x".repeat(300)}`)).toEqual({
      view: "conversations",
      id: "ab12cd34",
    });
  });
});

describe("a card a notification opened", () => {
  it("is brought into view with its first button focused and outlined for a moment", async () => {
    const t = await open({ seed: seeded(started, ...ask("tc1")), card: "tc1" });
    await until(() => t.tool()?.shadowRoot?.querySelector("button[data-option]"));
    await until(() => t.tool()?.style.outlineStyle);
    expect(t.tool()?.style.outlineStyle).toBe("solid");
    const first = t.tool()?.shadowRoot?.querySelector("button[data-option]");
    expect(t.tool()?.shadowRoot?.activeElement).toBe(first);
    expect(t.note()).toBeUndefined();
  });

  it("picks the card named, not the first one waiting", async () => {
    const t = await open({ seed: seeded(started, ...ask("tc1"), ...ask("tc2")), card: "tc2" });
    await until(
      () =>
        t.el.shadowRoot?.querySelector("inc-conv-turn[active]")?.shadowRoot?.querySelectorAll("inc-conv-tool")
          .length === 2,
    );
    const tools = [
      ...(t.el.shadowRoot
        ?.querySelector("inc-conv-turn[active]")
        ?.shadowRoot?.querySelectorAll("inc-conv-tool") ?? []),
    ] as HTMLElement[];
    await until(() => tools[1]?.style.outlineStyle);
    expect(tools[0]?.style.outlineStyle).toBe("");
    expect(tools[1]?.shadowRoot?.activeElement).toBe(
      tools[1]?.shadowRoot?.querySelector("button[data-option]"),
    );
  });

  it('says "Already answered on another device" when the card is not waiting any more', async () => {
    const t = await open({ seed: seeded(started, ...ask("tc1"), answered("tc1")), card: "tc1" });
    await until(() => t.note());
    expect(t.note()).toContain("Already answered on another device");
    expect(t.el.shadowRoot?.querySelector(".card-note")?.getAttribute("role")).toBe("status");
  });

  it('says "Already answered on another device" for a card of a turn that is over', async () => {
    const t = await open({ seed: chatState({ turns: [] }), card: "tc9" });
    await until(() => t.note());
    expect(t.note()).toContain("Already answered on another device");
  });

  it("says so too when it was answered while the app was open, by another device, and by this one", async () => {
    const t = await open({ seed: seeded(started, ...ask("tc1")) });
    t.host.send(CHAT, answered("tc1"), { clientId: "laptop", clientSeq: 1 });
    await until(() => !isPending(t.c.chat(CHAT), "tc1"));
    t.el.card = "tc1";
    await until(() => t.note());
    expect(t.note()).toContain("Already answered on another device");

    const mine = await open({ seed: seeded(started, ...ask("tc1")) });
    mine.host.send(CHAT, answered("tc1"), { clientId: "me", clientSeq: 1 });
    await until(() => !isPending(mine.c.chat(CHAT), "tc1"));
    mine.el.card = "tc1";
    await until(() => mine.note());
    expect(mine.note()).toContain("You already answered this");
  });

  it("is looked at once: the reader is not scrolled back to it by later updates, but a new tap looks again", async () => {
    const t = await open({ seed: seeded(started, ...ask("tc1")), card: "tc1" });
    await until(() => t.tool()?.style.outlineStyle);
    must<HTMLElement>(t.tool()).style.outlineStyle = "";
    t.host.send(CHAT, { type: "chat/delta", turnId: "t1", partId: "p", content: "more" });
    await tick(60);
    expect(t.tool()?.style.outlineStyle).toBe("");
    window.dispatchEvent(new Event(OPEN_CARD_EVENT));
    await until(() => t.tool()?.style.outlineStyle);
  });

  it("does nothing for a conversation opened without a card, and never reads the card before the chat is loaded", async () => {
    const t = await open({ seed: seeded(started, ...ask("tc1")) });
    await tick(50);
    expect(t.note()).toBeUndefined();
    expect(t.tool()?.style.outlineStyle ?? "").toBe("");
  });
});
