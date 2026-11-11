// The Conversations screen's centre pane: the New conversation draft IS the "nothing selected" view, for an
// owner with no conversations and for one who has some but has not opened one. The list keeps one small line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AhpConnection } from "../../src/ahp/connection.ts";
import { resetAhp, setAhp } from "../../src/ahp/hub.ts";
import { refreshNow } from "../../src/api.ts";
import "../../src/components/conversations.ts";
import type { IncConversations } from "../../src/components/conversations.ts";
import { report, timing } from "../../src/connection.ts";
import { hosts, must, tick, until } from "../ahp/fake-host.ts";

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
/** What `GET /api/conversations/:id` says, when a test cares. */
let byId: (() => Response | Promise<Response>) | undefined;
/** `?archived=all`: what the list holds with Show archived on. */
let allRows: Any[] = [];
/** Set, `GET /api/conversations` fails this way. */
let listFails: (() => Response) | undefined;
/** How many times `GET /api/conversations/:id` was asked. */
let reads = 0;

beforeEach(() => {
  phone = false;
  rows = [];
  posted = [];
  byId = undefined;
  allRows = [];
  listFails = undefined;
  reads = 0;
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
    if (byId && /\/api\/conversations\/[^/?]+$/.test(url)) {
      reads += 1;
      return byId();
    }
    if (listFails && /\/api\/conversations(\?|$)/.test(url)) return listFails();
    if (url.includes("archived=all")) return json({ conversations: allRows });
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

describe("when the open conversation leaves the list", () => {
  const archived = { ...row, archivedAt: 5, status: 1 };
  const reload = async (el: IncConversations) => {
    await (el as Any).loadList();
    await new Promise((r) => setTimeout(r));
    await el.updateComplete;
  };
  const shown = (thread: () => HTMLElement) => ({
    open: !!thread().querySelector("inc-conv-thread"),
    loading: !!thread().querySelector("[aria-busy]"),
    lost: thread().querySelector(".lost")?.textContent ?? "",
  });

  it("says it was archived, and goes on saying so through later reloads", async () => {
    rows = [row];
    const { el, thread } = await mount({ selectedId: row.id });
    rows = [];
    byId = () => json({ conversation: archived });
    await reload(el);
    await reload(el);
    await reload(el);
    expect(shown(thread)).toEqual({ open: false, loading: false, lost: "That conversation was archived." });
  });

  it("says it wasn't found when it was removed", async () => {
    rows = [row];
    const { el, thread } = await mount({ selectedId: row.id });
    rows = [];
    byId = () => json({ error: "no such conversation" }, 404);
    await reload(el);
    await reload(el);
    expect(shown(thread)).toEqual({
      open: false,
      loading: false,
      lost: "That conversation wasn't found. It may have been removed.",
    });
  });

  it("keeps the thread up while it asks, and through an answer that says nothing about the conversation", async () => {
    rows = [row];
    const { el, thread } = await mount({ selectedId: row.id });
    const before = thread().querySelector("inc-conv-thread");
    rows = [];
    byId = () => json({ error: "try later" }, 500);
    await reload(el);
    expect(thread().querySelector("inc-conv-thread")).toBe(before);
    expect(shown(thread).lost).toBe("");
    byId = () => json({ conversation: archived });
    await reload(el);
    expect(shown(thread).lost).toBe("That conversation was archived.");
  });

  it("keeps a conversation open that a link opened already archived, through every reload", async () => {
    byId = () => json({ conversation: archived });
    const { el, thread } = await mount({ selectedId: row.id });
    await until(() => thread().querySelector("inc-conv-thread"));
    await reload(el);
    await reload(el);
    expect(shown(thread)).toEqual({ open: true, loading: false, lost: "" });
  });

  it("takes down what was open over it, so the screen behind can be used", async () => {
    phone = true;
    rows = [row];
    const { el, root, thread } = await mount({ selectedId: row.id });
    (el as Any).sheet = true;
    (el as Any).dialog = { kind: "ticket" };
    await el.updateComplete;
    expect(thread().hasAttribute("inert")).toBe(true);
    rows = [];
    byId = () => json({ conversation: archived });
    await reload(el);
    expect((el as Any).sheet).toBe(false);
    expect((el as Any).dialog).toBeNull();
    expect(thread().hasAttribute("inert")).toBe(false);
    expect(root().querySelector(".list-pane")?.hasAttribute("inert")).toBe(false);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it("takes the ship dialog down on going back to the list, so the list can be used", async () => {
    rows = [row];
    const { el, root, list, thread } = await mount({ selectedId: row.id });
    (el as Any).dialog = { kind: "ticket" };
    await el.updateComplete;
    expect(root().querySelector("inc-conv-ship")).not.toBeNull();
    expect(list().hasAttribute("inert")).toBe(true);
    el.selectedId = "";
    await el.updateComplete;
    expect((el as Any).dialog).toBeNull();
    expect(root().querySelector("inc-conv-ship")).toBeNull();
    expect(list().hasAttribute("inert")).toBe(false);
    expect(thread().hasAttribute("inert")).toBe(false);
  });

  it("doesn't carry the ship dialog to the next conversation, with the first one's text in it", async () => {
    const other = { ...row, id: "cd34ef56", title: "Other work" };
    rows = [row, other];
    const { el, root } = await mount({ selectedId: row.id });
    (el as Any).dialog = { kind: "ticket" };
    (el as Any).opener = document.body;
    await el.updateComplete;
    expect(root().querySelector("inc-conv-ship")).not.toBeNull();
    el.selectedId = other.id;
    await el.updateComplete;
    expect(root().querySelector("inc-conv-ship")).toBeNull();
    expect((el as Any).opener).toBeNull();
    expect(root().querySelector(".list-pane")?.hasAttribute("inert")).toBe(false);
  });

  it("doesn't open the next conversation with the phone's sheet up, or hold on to Tab", async () => {
    phone = true;
    const other = { ...row, id: "cd34ef56", title: "Other work" };
    rows = [row, other];
    const { el, root } = await mount({ selectedId: row.id });
    (el as Any).sheet = true;
    await el.updateComplete;
    expect(root().querySelector(".sheet")).not.toBeNull();
    el.selectedId = "";
    await el.updateComplete;
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    el.selectedId = other.id;
    await el.updateComplete;
    expect(root().querySelector(".sheet")).toBeNull();
    expect((el as Any).sheet).toBe(false);
  });

  it("brings the thread back and drops the message when Show archived holds it again", async () => {
    rows = [row];
    const { el, thread } = await mount({ selectedId: row.id });
    rows = [];
    byId = () => json({ conversation: archived });
    await reload(el);
    expect(shown(thread).lost).toBe("That conversation was archived.");
    allRows = [archived];
    (el as Any).showArchived = true;
    await reload(el);
    expect(shown(thread)).toEqual({ open: true, loading: false, lost: "" });
  });

  it("drops the message on leaving, and asks again on coming back", async () => {
    byId = () => json({ error: "no such conversation" }, 404);
    const { el, thread } = await mount({ selectedId: row.id });
    await until(() => shown(thread).lost);
    el.selectedId = "";
    await el.updateComplete;
    expect(shown(thread).lost).toBe("");
    byId = () => json({ conversation: row });
    el.selectedId = row.id;
    await until(() => thread().querySelector("inc-conv-thread"));
    expect(shown(thread)).toEqual({ open: true, loading: false, lost: "" });
  });

  it("ignores an answer that comes after the owner has moved on", async () => {
    rows = [row];
    const { el, thread } = await mount({ selectedId: row.id });
    rows = [];
    let answer: (r: Response) => void = () => {};
    byId = () =>
      new Promise<Response>((r) => {
        answer = r;
      });
    await (el as Any).loadList();
    el.selectedId = "";
    await el.updateComplete;
    answer(json({ conversation: archived }));
    await new Promise((r) => setTimeout(r));
    await el.updateComplete;
    expect(shown(thread).lost).toBe("");
  });
});

describe("a link to a conversation the list doesn't hold", () => {
  const archived = { ...row, archivedAt: 5, status: 1 };
  const settle = async (el: IncConversations) => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r));
      await el.updateComplete;
    }
  };
  const reload = async (el: IncConversations) => {
    await (el as Any).loadList();
    await settle(el);
  };
  const failed = (thread: () => HTMLElement) => thread().querySelector("[role='alert']")?.textContent ?? "";
  const retry = (thread: () => HTMLElement) =>
    must<HTMLButtonElement>(thread().querySelector(".none button"));

  it("says a failed read couldn't load it, not that it has gone, and a good reload opens it", async () => {
    byId = () => json({ error: "try later" }, 500);
    const { el, thread } = await mount({ selectedId: row.id });
    await until(() => failed(thread));
    expect(failed(thread)).toBe("Couldn't load this conversation (try later).");
    expect(thread().querySelector(".lost")).toBeNull();
    expect(thread().querySelector("[aria-busy]")).toBeNull();
    expect(thread().querySelector("inc-conv-draft")).toBeNull();
    byId = () => json({ conversation: archived });
    await reload(el);
    expect(thread().querySelector("inc-conv-thread")).not.toBeNull();
    expect(failed(thread)).toBe("");
  });

  it("says it couldn't reach i.inc when the network drops, and opens after reconnecting", async () => {
    byId = () => {
      throw new TypeError("Failed to fetch");
    };
    const { el, thread } = await mount({ selectedId: row.id });
    await until(() => failed(thread));
    expect(failed(thread)).toBe("Couldn't load this conversation (Can't reach i.inc).");
    byId = () => json({ conversation: archived });
    await reload(el);
    expect(thread().querySelector("inc-conv-thread")).not.toBeNull();
  });

  it("says it wasn't found when a later read says so", async () => {
    byId = () => json({ error: "try later" }, 500);
    const { el, thread } = await mount({ selectedId: row.id });
    await until(() => failed(thread));
    byId = () => json({ error: "no such conversation" }, 404);
    await reload(el);
    expect(thread().querySelector(".lost")?.textContent).toBe(
      "That conversation wasn't found. It may have been removed.",
    );
    expect(thread().querySelector(".none button")).toBeNull();
  });

  it("forgets a failed read on moving to another conversation", async () => {
    byId = () => json({ error: "try later" }, 500);
    const { el, thread } = await mount({ selectedId: row.id });
    await until(() => failed(thread));
    let answer: (r: Response) => void = () => {};
    byId = () =>
      new Promise<Response>((r) => {
        answer = r;
      });
    el.selectedId = "cd34ef56";
    await el.updateComplete;
    expect(failed(thread)).toBe("");
    expect(thread().querySelector("[aria-busy]")).not.toBeNull();
    answer(json({ conversation: { ...row, id: "cd34ef56" } }));
    await until(() => thread().querySelector("inc-conv-thread"));
  });

  it("asks once for each list, and not again by itself, while the read goes on failing", async () => {
    byId = () => json({ error: "try later" }, 500);
    const { el, thread } = await mount({ selectedId: row.id });
    await until(() => failed(thread));
    await settle(el);
    expect(reads).toBe(1);
    await reload(el);
    expect(reads).toBe(2);
    await settle(el);
    expect(reads).toBe(2);
  });

  describe("while the list request fails", () => {
    beforeEach(() => {
      listFails = () => json({ error: "the list broke" }, 500);
    });

    it("still reads the conversation, and doesn't sit on Loading", async () => {
      byId = () => json({ conversation: archived });
      const { thread } = await mount({ selectedId: row.id });
      await until(() => thread().querySelector("inc-conv-thread"));
      expect(thread().querySelector("[aria-busy]")).toBeNull();
    });

    it("says so when the read fails too, and stops asking", async () => {
      byId = () => json({ error: "try later" }, 500);
      const { el, thread } = await mount({ selectedId: row.id });
      await until(() => failed(thread));
      expect(failed(thread)).toBe("Couldn't load this conversation (try later).");
      await settle(el);
      await reload(el);
      expect(reads).toBe(1);
    });

    it("opens when the list comes back", async () => {
      byId = () => json({ error: "try later" }, 500);
      const { el, thread } = await mount({ selectedId: row.id });
      await until(() => failed(thread));
      listFails = undefined;
      rows = [row];
      await reload(el);
      expect(thread().querySelector("inc-conv-thread")).not.toBeNull();
      expect(failed(thread)).toBe("");
    });

    it("says it wasn't found on a 404, whatever the list says", async () => {
      byId = () => json({ error: "no such conversation" }, 404);
      const { thread } = await mount({ selectedId: row.id });
      await until(() => thread().querySelector(".lost"));
      expect(thread().querySelector("[aria-busy]")).toBeNull();
    });
  });

  describe("Try again", () => {
    it("keeps the button and focus while it asks, and again when it fails", async () => {
      byId = () => json({ error: "try later" }, 500);
      const { el, root, thread } = await mount({ selectedId: row.id });
      await until(() => failed(thread));
      retry(thread).focus();
      let answer: (r: Response) => void = () => {};
      byId = () =>
        new Promise<Response>((r) => {
          answer = r;
        });
      retry(thread).click();
      await el.updateComplete;
      expect(failed(thread)).toBe("Loading…");
      expect(retry(thread).getAttribute("aria-disabled")).toBe("true");
      expect(thread().querySelector("[aria-busy]")).not.toBeNull();
      // A second press while it asks is nothing.
      retry(thread).click();
      await settle(el);
      expect(reads).toBe(2);
      expect(failed(thread)).toBe("Loading…");
      answer(json({ error: "still broken" }, 500));
      await until(() => failed(thread).startsWith("Couldn't"));
      expect(failed(thread)).toBe("Couldn't load this conversation (still broken).");
      expect(retry(thread).getAttribute("aria-disabled")).toBe("false");
      expect(root().activeElement).toBe(retry(thread));
    });

    it("gives focus to the thread's header when it works, not to nothing", async () => {
      byId = () => json({ error: "try later" }, 500);
      const { el, thread } = await mount({ selectedId: row.id });
      await until(() => failed(thread));
      retry(thread).focus();
      byId = () => json({ conversation: archived });
      retry(thread).click();
      await until(() => thread().querySelector("inc-conv-thread"));
      await settle(el);
      const shown = must<HTMLElement>(thread().querySelector("inc-conv-thread"));
      expect(shown.shadowRoot?.activeElement).toBe(shown.shadowRoot?.querySelector(".context-btn"));
    });
  });
});

// A blip used to heal at once on main: the failed request turned the app offline, the next answer back online,
// and that refreshed every view. Now a doubt called off refreshes nothing globally, so the list must load again
// by itself (connection.ts's Unanswered), and stop after a couple of tries while its own request keeps failing.
describe("a list request that got no answer", () => {
  const saved = { ...timing, probesMs: [...timing.probesMs] };
  beforeEach(() => {
    timing.retryMs = 1;
    timing.probesMs = [0, 20, 40];
  });
  afterEach(() => {
    Object.assign(timing, saved);
    report(true);
  });
  const drop = (): Response => {
    throw new TypeError("Failed to fetch");
  };
  const listed = () => calls.filter((u) => /\/api\/conversations(\?|$)/.test(u)).length;
  let calls: string[] = [];
  beforeEach(() => {
    calls = [];
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push(String(url));
      return inner(url, init);
    });
  });

  it('loads again once the daemon answers a health probe, so the owner never sees "Can\'t reach i.inc" stay', async () => {
    rows = [row];
    const { el } = await mount();
    await until(() => (el as Any).list.length === 1);
    let drops = 2;
    rows = [row, { ...row, id: "ef56ab78", title: "Later work" }];
    listFails = () => {
      if (drops-- > 0) return drop();
      listFails = undefined;
      return json({ conversations: rows });
    };
    refreshNow();
    await until(() => (el as Any).list.length === 2);
    expect((el as Any).listError).toBe("");
  });

  it("stops after two more tries while its own request keeps failing and the daemon answers", async () => {
    rows = [row];
    const { el } = await mount();
    await until(() => (el as Any).list.length === 1);
    listFails = drop;
    const before = listed();
    refreshNow();
    await until(() => listed() - before >= 6);
    await tick(300);
    expect(listed() - before).toBe(6); // three loads, each tried twice
    expect((el as Any).listError).toBe("Can't reach i.inc");
  });
});
