// The Conversations screen's centre pane: the New conversation draft IS the "nothing selected" view, for an
// owner with no conversations and for one who has some but has not opened one. The list keeps one small line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import "../../src/components/conversations.ts";
import type { IncConversations } from "../../src/components/conversations.ts";
import { hosts, must, until } from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted rows.
type Any = any;

const row = {
  id: "ab12cd34",
  employeeId: "ada",
  project: null,
  branch: null,
  title: "Earlier work",
  mode: null,
  engineId: "opus",
  createdAt: 0,
  archivedAt: null,
  ahpSession: "ahp-session://s1",
  ahpChat: "ahp-chat://c1",
  status: 1,
  needsYou: false,
  running: false,
  modifiedAt: 1,
};

let phone = false;
let rows: Any[] = [];
let posted: Any[] = [];

beforeEach(() => {
  phone = false;
  rows = [];
  posted = [];
  localStorage.clear();
  location.hash = "";
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: phone && /max-width: 767px/.test(q),
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/conversations" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return json({ conversation: { ...row, id: "99887766", employeeId: posted.at(-1).employeeId } }, 201);
    }
    const body = url.includes("/api/conversations")
      ? { conversations: rows }
      : url.includes("/api/employees")
        ? {
            employees: [
              { id: "ada", name: "Ada", role: "Engineer", tint: 0 },
              { id: "kit", name: "Kit", role: "Engineer", tint: 1 },
            ],
          }
        : url.includes("/api/projects")
          ? { projects: [{ id: "Duet" }] }
          : url.includes("/api/engines")
            ? { engines: [] }
            : {};
    return json(body);
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  resetAhp();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function mount(props: Partial<IncConversations> = {}) {
  const h = hosts();
  setAhp(
    new AhpConnection({
      connect: h.connect,
      clientId: "me",
      backoff: () => 5,
      pingMs: 0,
      schedule: (fn) => {
        queueMicrotask(fn);
        return () => {};
      },
    }),
  );
  const el = document.createElement("inc-conversations") as IncConversations;
  Object.assign(el, props);
  document.body.append(el);
  const root = () => el.shadowRoot as ShadowRoot;
  await until(() => !(el as Any).loading && (el as Any).ready);
  await el.updateComplete;
  const list = () => must<HTMLElement>(root().querySelector("inc-conv-list"));
  const thread = () => must<HTMLElement>(root().querySelector("section.thread-pane"));
  return { el, root, list, thread };
}

describe("with no conversations", () => {
  it("shows one centred empty state with the composer, and only a small muted line in the list", async () => {
    const { root, list, thread } = await mount();
    expect(thread().querySelector("inc-conv-draft")).not.toBeNull();
    // the centre pane is the only empty state: exactly one "Start a conversation" heading on the screen
    expect(root().querySelectorAll("inc-conv-draft").length).toBe(1);
    const draft = must(thread().querySelector("inc-conv-draft"));
    expect(draft.shadowRoot?.querySelector("inc-conv-composer")).not.toBeNull();
    expect(draft.shadowRoot?.querySelector("h2")?.textContent).toBe("Start a conversation");
    expect(thread().textContent).not.toContain("Pick a conversation");
    const l = list().shadowRoot as ShadowRoot;
    expect(l.querySelector("p.none")?.textContent).toBe("No conversations yet.");
    expect(l.querySelector(".groups h2")).toBeNull();
    // and no form in the left column
    expect(l.querySelector("form.create")).toBeNull();
  });

  it("a phone shows it instead of an empty list", async () => {
    phone = true;
    const { list, thread } = await mount();
    expect(list().hasAttribute("hidden")).toBe(true);
    expect(thread().hasAttribute("hidden")).toBe(false);
    expect(thread().querySelector("inc-conv-draft")).not.toBeNull();
  });
});

describe("with conversations but none selected", () => {
  beforeEach(() => {
    rows = [row];
  });

  it("the centre pane is the same composer, not a second kind of empty state", async () => {
    const { thread, list } = await mount();
    expect(thread().querySelector("inc-conv-draft")).not.toBeNull();
    expect(thread().textContent).not.toContain("Pick a conversation");
    expect(list().shadowRoot?.querySelector("p.none")).toBeNull();
    expect(list().shadowRoot?.querySelectorAll("li.row").length).toBe(1);
  });

  it("a phone shows the list, and the draft once New conversation is asked for", async () => {
    phone = true;
    const { el, list, thread } = await mount();
    expect(list().hasAttribute("hidden")).toBe(false);
    expect(thread().hasAttribute("hidden")).toBe(true);
    el.draft = { employee: "", project: "" };
    await el.updateComplete;
    expect(list().hasAttribute("hidden")).toBe(true);
    expect(thread().hasAttribute("hidden")).toBe(false);
    // with a way back to the list
    const draft = must(thread().querySelector("inc-conv-draft"));
    expect(draft.shadowRoot?.querySelector("button.back")).not.toBeNull();
  });

  it("the New conversation button goes to the draft on a phone and stays put on a laptop", async () => {
    const { list } = await mount();
    must<HTMLButtonElement>(list().shadowRoot?.querySelector("button.new")).click();
    expect(location.hash).toBe(""); // nothing selected: the centre pane already is the draft
    phone = true;
    document.body.innerHTML = "";
    const m = await mount();
    must<HTMLButtonElement>(m.list().shadowRoot?.querySelector("button.new")).click();
    expect(location.hash).toBe("#/conversations?new=1");
  });

  it("an open conversation shows its thread, not the draft", async () => {
    const { thread } = await mount({ selectedId: "ab12cd34" });
    expect(thread().querySelector("inc-conv-draft")).toBeNull();
    expect(thread().querySelector("inc-conv-thread")).not.toBeNull();
  });
});

describe("the first message", () => {
  it("creates the conversation on send, with the pickers' employee, and nothing before", async () => {
    const { thread, el } = await mount({ draft: { employee: "kit", project: "" } });
    expect(posted).toEqual([]);
    const draft = must<Any>(thread().querySelector("inc-conv-draft"));
    const composer = must<Any>(draft.shadowRoot?.querySelector("inc-conv-composer"));
    composer.text = "hi there";
    await composer.updateComplete;
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    await composer.submit("turn");
    expect(posted).toEqual([{ employeeId: "kit" }]);
    expect(replace).toHaveBeenCalledWith("#/conversations/99887766");
    expect((el as Any).first).toMatchObject({ id: "99887766", text: "hi there" });
  });
});
