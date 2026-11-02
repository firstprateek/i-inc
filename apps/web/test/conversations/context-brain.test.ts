// The Conversations context panel lists the brain pages the host says the conversation used
// (`_meta["iinc.brain"]` on the session, contract C19), each with where it lives, whether the agent
// opened it itself, and whether it is untrusted. It also shows the usage, with how full the context is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import "../../src/components/conv-context.ts";
import type { Conversation } from "../../src/api.ts";
import { CHAT, chatState, hosts, SESSION, sessionState, until } from "../ahp/fake-host.ts";

const conv: Conversation = {
  id: "ab12cd34",
  employeeId: "ada",
  project: null,
  branch: null,
  title: "Brain",
  mode: null,
  engineId: "opus",
  createdAt: 0,
  archivedAt: null,
  ahpSession: SESSION,
  ahpChat: CHAT,
  status: 1,
  needsYou: false,
  running: false,
  modifiedAt: 1,
};

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
  vi.unstubAllGlobals();
});

async function panel(meta: unknown, chat?: unknown) {
  const h = hosts();
  h.onConnect = (host) => {
    host.states.set(SESSION, sessionState(meta === undefined ? {} : { _meta: meta }));
    if (chat) host.states.set(CHAT, chatState(chat));
  };
  const c = new AhpConnection({
    connect: h.connect,
    clientId: "me",
    backoff: () => 5,
    pingMs: 0,
    schedule: (fn) => {
      queueMicrotask(fn);
      return () => {};
    },
  });
  setAhp(c);
  c.start();
  c.watch(SESSION);
  c.watch(CHAT);
  await until(() => c.session(SESSION) && c.chat(CHAT));
  const el = document.createElement("inc-conv-context") as HTMLElement & { conv: Conversation };
  el.conv = conv;
  document.body.append(el);
  await until(() => el.shadowRoot?.querySelector("h2"));
  return el.shadowRoot as ShadowRoot;
}

describe("the context panel's brain pages", () => {
  it("lists each page with its scope, links it to where the owner reads it, and marks opened and untrusted ones", async () => {
    const root = await panel({
      "iinc.brain": [
        {
          id: "company:projects/duet",
          title: "Duet",
          scope: "company",
          slug: "projects/duet",
          via: "search",
        },
        {
          id: "brain:ada:tools/vitest",
          title: "Vitest",
          scope: "brain:ada",
          slug: "tools/vitest",
          via: "read",
        },
        { id: "company:facts/web", title: "Web notes", scope: "company", slug: "facts/web", untrusted: true },
      ],
    });
    await until(() => root.querySelector("#h-brain"));
    expect(root.querySelector("#h-brain")?.textContent).toBe("Brain pages used");
    const items = [...root.querySelectorAll<HTMLElement>(".brain li")];
    expect(items.map((li) => li.querySelector("a")?.textContent)).toEqual(["Duet", "Vitest", "Web notes"]);
    expect(items[0]?.querySelector("a")?.getAttribute("href")).toBe("#/company/brain");
    expect(items[1]?.querySelector("a")?.getAttribute("href")).toBe("#/company/brain/ada");
    expect(items[1]?.textContent).toContain("opened");
    expect(items[2]?.textContent).toContain("untrusted");
  });

  it("hides the section when the host reports none", async () => {
    const root = await panel(undefined);
    expect(root.querySelector("#h-brain")).toBeNull();
  });
});

describe("the context panel's usage", () => {
  const reading = { model: "opus", _meta: { contextUsed: 180_000, contextSize: 200_000 } };
  const message = { text: "hi", origin: { kind: "user" } };
  const turn = (id: string, usage: unknown, state = "complete") => ({
    id,
    state,
    message,
    usage,
    responseParts: [],
    duration: 1,
  });
  const running = (usage: unknown) => ({
    id: "2",
    startedAt: "2026-10-21T10:00:00.000Z",
    message,
    usage,
    responseParts: [],
  });
  const rows = (root: ShadowRoot) =>
    [...root.querySelectorAll<HTMLElement>("#h-usage ~ .kv > div")].map((d) => d.textContent?.trim());
  const meter = async (chat: unknown) => {
    const root = await panel(undefined, chat);
    await until(() => root.querySelector("#h-usage"));
    return root;
  };

  it("shows the running turn's context reading on a first turn, and no token use it doesn't have", async () => {
    const root = await meter({ activeTurn: running(reading) });
    const usage = root.querySelector("#h-usage")?.parentElement?.textContent ?? "";
    expect(usage).toContain("180k of 200k tokens");
    expect(usage).toContain("Token use shows here after the first reply.");
    expect(usage).not.toContain("0 in");
    expect(usage).not.toContain("Latest turn");
  });

  it("keeps the last turn's numbers on 'Latest turn' while a turn has only its context reading", async () => {
    const root = await meter({
      turns: [turn("1", { inputTokens: 1000, outputTokens: 20 })],
      activeTurn: running(reading),
    });
    expect(rows(root).some((r) => r?.startsWith("Latest turn") && r.includes("1.0k in"))).toBe(true);
  });

  it("hides 'Latest turn' when the last turn stopped with only its context reading", async () => {
    const root = await meter({
      turns: [turn("1", { inputTokens: 1000, outputTokens: 20 }), turn("2", reading, "cancelled")],
    });
    expect(rows(root).some((r) => r?.startsWith("Latest turn"))).toBe(false);
    expect(rows(root).some((r) => r?.startsWith("This conversation"))).toBe(true);
    expect(root.textContent).toContain("180k of 200k tokens");
  });
});
