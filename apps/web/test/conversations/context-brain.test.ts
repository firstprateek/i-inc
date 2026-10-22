// The Conversations context panel lists the brain pages the host says the conversation used
// (`_meta["iinc.brain"]` on the session, contract C19), each with where it lives, whether the agent
// opened it itself, and whether it is untrusted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import "../../src/components/conv-context.ts";
import type { Conversation } from "../../src/api.ts";
import { CHAT, hosts, SESSION, sessionState, until } from "../ahp/fake-host.ts";

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

async function panel(meta: unknown) {
  const h = hosts();
  h.onConnect = (host) => host.states.set(SESSION, sessionState(meta === undefined ? {} : { _meta: meta }));
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
