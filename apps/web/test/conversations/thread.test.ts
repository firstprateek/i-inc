import { afterEach, describe, expect, it } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import { USER_ORIGIN } from "../../src/ahp/wire.ts";
import type { IncConvThread } from "../../src/components/conv-thread.ts";
import "../../src/components/conv-thread.ts";
import { CHAT, chatState, hosts, must, SESSION, sessionState, tick, until } from "../ahp/fake-host.ts";

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
const toolStart = {
  type: "chat/toolCallStart",
  turnId: "t1",
  toolCallId: "tc1",
  toolName: "edit",
  displayName: "Edit src/app.ts",
};
const toolReady = {
  type: "chat/toolCallReady",
  turnId: "t1",
  toolCallId: "tc1",
  invocationMessage: "Edit src/app.ts",
  toolInput: JSON.stringify({ path: "src/app.ts" }),
  confirmationTitle: "Edit src/app.ts",
  options: [
    { id: "allow-once", label: "Allow once", kind: "approve", group: 0 },
    { id: "allow-always", label: "Always allow", kind: "approve", group: 1 },
    { id: "reject-once", label: "Deny", kind: "deny", group: 0 },
  ],
};

async function setup() {
  const h = hosts();
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
  document.body.append(el);
  await until(() => c.chat(CHAT) && c.session(SESSION));
  const host = h.made[0] as NonNullable<(typeof h.made)[number]>;
  host.states.set(SESSION, sessionState());
  const sent = () => host.received.filter((m) => m.method === "dispatchAction").map((m) => m.params.action);
  const root = () => el.shadowRoot as ShadowRoot;
  const turn = () => root().querySelector("inc-conv-turn[active]")?.shadowRoot;
  const tool = () => turn()?.querySelector("inc-conv-tool")?.shadowRoot;
  return { c, h, el, host, sent, root, turn, tool };
}

afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
});

describe("the thread", () => {
  it("shows a permission card with the agent's options and answers it with chat/toolCallConfirmed", async () => {
    const { host, sent, tool, el } = await setup();
    host.send(CHAT, started);
    host.send(CHAT, toolStart);
    host.send(CHAT, toolReady);
    await until(() => tool()?.querySelector(".perm"));
    const labels = [...(tool()?.querySelectorAll(".opts button") ?? [])].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Allow once", "Always allow", "Deny"]);
    must<HTMLButtonElement>(tool()?.querySelector('button[data-option="allow-always"]')).click();
    await until(() => sent().length);
    expect(sent()[0]).toEqual({
      type: "chat/toolCallConfirmed",
      turnId: "t1",
      toolCallId: "tc1",
      approved: true,
      confirmed: "user-action",
      selectedOptionId: "allow-always",
    });
    // the buttons wait until the host answers
    await el.updateComplete;
    expect(must<HTMLButtonElement>(tool()?.querySelector(".opts button")).disabled).toBe(true);
    host.send(
      CHAT,
      {
        type: "chat/toolCallConfirmed",
        turnId: "t1",
        toolCallId: "tc1",
        approved: true,
        confirmed: "user-action",
        selectedOptionId: "allow-always",
      },
      { clientId: "me", clientSeq: 1 },
    );
    await until(() => tool()?.querySelector(".outcome"));
    expect(tool()?.querySelector(".outcome")?.textContent).toBe("Always allow");
  });

  it('says "Allowed on another device" when another client answered first, and shows no error', async () => {
    const { host, tool, root } = await setup();
    host.send(CHAT, started);
    host.send(CHAT, toolStart);
    host.send(CHAT, toolReady);
    await until(() => tool()?.querySelector(".perm"));
    host.send(
      CHAT,
      {
        type: "chat/toolCallConfirmed",
        turnId: "t1",
        toolCallId: "tc1",
        approved: true,
        confirmed: "user-action",
        selectedOptionId: "allow-once",
      },
      { clientId: "phone", clientSeq: 3 },
    );
    await until(() => tool()?.querySelector(".outcome"));
    expect(tool()?.querySelector(".outcome")?.textContent).toBe("Allowed on another device");
    expect(tool()?.querySelector(".perm")).toBeNull();
    // our own late answer is refused by the host: still no error
    host.reject(
      CHAT,
      { type: "chat/toolCallConfirmed", turnId: "t1", toolCallId: "tc1", approved: true },
      { clientId: "me", clientSeq: 1 },
      "tool call tc1 is not waiting for an answer (someone answered it already)",
    );
    await tick(30);
    expect(root().querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a refusal inline, and puts a message the host refused back in the box", async () => {
    const { host, root, el } = await setup();
    host.reject(
      CHAT,
      { type: "chat/turnStarted", turnId: "t9", message: { text: "my words", origin: USER_ORIGIN } },
      { clientId: "me", clientSeq: 2 },
      "a message needs text",
    );
    await until(() => root().querySelector(".notice"));
    expect(root().querySelector(".notice")?.textContent).toContain(
      "The host didn't accept that: a message needs text",
    );
    const composer = root().querySelector("inc-conv-composer");
    await el.updateComplete;
    expect(must<HTMLTextAreaElement>(composer?.shadowRoot?.querySelector("textarea")).value).toBe("my words");
  });

  it("queues a message instead when the turn could not start because one is running", async () => {
    const { host, sent } = await setup();
    host.reject(
      CHAT,
      { type: "chat/turnStarted", turnId: "t9", message: { text: "race", origin: USER_ORIGIN } },
      { clientId: "me", clientSeq: 2 },
      "a turn is already running: queue the message instead",
    );
    await until(() => sent().length);
    expect(sent()[0]).toMatchObject({
      type: "chat/pendingMessageSet",
      kind: "queued",
      message: { text: "race" },
    });
  });

  it("sends Stop as chat/turnCancelled for the running turn", async () => {
    const { host, sent, root, el } = await setup();
    host.send(CHAT, started);
    await until(() => root().querySelector("inc-conv-turn[active]"));
    await el.updateComplete;
    const composer = root().querySelector("inc-conv-composer") as HTMLElement;
    await (composer as Any).updateComplete;
    must<HTMLButtonElement>(composer.shadowRoot?.querySelector(".stop")).click();
    await until(() => sent().length);
    expect(sent()[0]).toMatchObject({ type: "chat/turnCancelled", turnId: "t1" });
  });

  it("sends steering and queued messages as chat/pendingMessageSet", async () => {
    const { host, sent, root, el } = await setup();
    host.send(CHAT, started);
    await until(() => root().querySelector("inc-conv-turn[active]"));
    await el.updateComplete;
    const composer = root().querySelector("inc-conv-composer") as Any;
    await composer.updateComplete;
    const ta = composer.shadowRoot.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "steer me";
    ta.dispatchEvent(new Event("input"));
    await composer.updateComplete;
    await composer.submit("steer");
    ta.value = "queue me";
    ta.dispatchEvent(new Event("input"));
    await composer.updateComplete;
    await composer.submit("queue");
    await until(() => sent().length === 2);
    expect(sent().map((a: Any) => [a.type, a.kind, a.message.text])).toEqual([
      ["chat/pendingMessageSet", "steering", "steer me"],
      ["chat/pendingMessageSet", "queued", "queue me"],
    ]);
  });

  it("changes the mode with session/configChanged and remembers it for the employee", async () => {
    const { sent, root } = await setup();
    const composer = root().querySelector("inc-conv-composer") as Any;
    composer.dispatchEvent(
      new CustomEvent("conv-config", {
        detail: { key: "mode", value: "default" },
        bubbles: true,
        composed: true,
      }),
    );
    await until(() => sent().length);
    expect(sent()[0]).toEqual({ type: "session/configChanged", config: { mode: "default" } });
    expect(localStorage.getItem("i-inc-conv-mode:ada")).toBe("default");
  });

  it("announces a turn starting, finishing and a new permission request, but not every delta", async () => {
    const { host, root } = await setup();
    const live = () => root().querySelector('[aria-live="polite"]')?.textContent?.trim();
    host.send(CHAT, started);
    await until(() => live() === "Ada started working");
    host.send(CHAT, {
      type: "chat/responsePart",
      turnId: "t1",
      part: { kind: "markdown", id: "p", content: "" },
    });
    for (let i = 0; i < 20; i++)
      host.send(CHAT, { type: "chat/delta", turnId: "t1", partId: "p", content: "x" });
    await tick(30);
    expect(live()).toBe("Ada started working");
    host.send(CHAT, toolStart);
    host.send(CHAT, toolReady);
    await until(() => live() === "Ada needs your answer");
    host.send(CHAT, { type: "chat/turnComplete", turnId: "t1", duration: 10 });
    await until(() => live() === "Ada finished");
  });

  it("says when the conversation is gone and when the host cannot be reached", async () => {
    const { c, root } = await setup();
    c.stop();
    await tick(10);
    const el = root().host as IncConvThread;
    await el.updateComplete;
    expect(root().querySelector(".banner")?.textContent).toMatch(/Connecting|Reconnecting/);
  });

  it("renders only a window of a long chat, and pages the rest in", async () => {
    const h = hosts();
    const turns = Array.from({ length: 70 }, (_, i) => ({
      id: `t${i}`,
      message: { text: `q${i}`, origin: USER_ORIGIN },
      responseParts: [],
      usage: undefined,
      state: "complete",
    }));
    const c = new AhpConnection({
      connect: h.connect,
      clientId: "me",
      backoff: () => 5,
      schedule: micro,
      pingMs: 0,
    });
    setAhp(c);
    c.start();
    await until(() => c.info.status === "open");
    (h.made[0] as Any).states.set(CHAT, chatState({ turns }));
    const el = document.createElement("inc-conv-thread") as IncConvThread;
    el.conv = conv;
    el.employee = ada;
    document.body.append(el);
    await until(() => c.chat(CHAT));
    await el.updateComplete;
    // the host windows the snapshot to 30 turns; the thread shows what it has
    expect((el.shadowRoot as ShadowRoot).querySelectorAll("inc-conv-turn").length).toBe(30);
    expect(c.chat(CHAT)?.turnsNextCursor).toBeDefined();
  });
});
