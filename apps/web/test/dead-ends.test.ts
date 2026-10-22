// T63 group 3: dead ends and silent mistakes: a brain page is in the address, not-found says so in words,
// the first message replaces the draft's address, and an unsaved project edit comes back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/app.ts";
import "../src/components/chat.ts";
import "../src/components/conversations.ts";
import "../src/components/knowledge.ts";
import "../src/components/project-page.ts";
import "../src/components/ticket.ts";
import { STARTED_KEY } from "../src/first-run.ts";
import { brainHash, parse, redirectFor } from "../src/routes.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
async function mount<T extends HTMLElement>(tag: string, props: Record<string, unknown> = {}) {
  const el = document.createElement(tag) as T;
  Object.assign(el, props);
  document.body.append(el);
  await tick();
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  location.hash = "";
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a brain page is in the address", () => {
  const handbook = {
    pages: [
      {
        path: "INDEX.md",
        text: "# Handbook\n\nRead [the merging policy](policies/merging.md) before you ship, or see [GitHub](https://github.com/acme) and [bad](javascript:alert(1)).\n\n- [Facts](facts/duet.md)",
      },
      {
        path: "policies/merging.md",
        text: "# Merging\n\nBack to the [map](../INDEX.md) or the [fact](../facts/duet.md).",
      },
      { path: "facts/duet.md", text: "# Duet\n\nA money app." },
    ],
    history: [],
    awaiting: [],
  };
  const serve = () =>
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/knowledge/handbook" ? json(handbook) : json({ teams: [], employees: [] }),
    );

  it("parses ?page= and builds the same address back, and ignores a path that isn't a plain page", () => {
    expect(parse("#/company/brain?page=policies%2Fmerging.md")).toEqual({
      view: "brain",
      id: "",
      page: "policies/merging.md",
    });
    expect(parse("#/company/brain/ada?page=facts%2Fduet.md")).toEqual({
      view: "brain",
      id: "ada",
      page: "facts/duet.md",
    });
    expect(parse("#/company/brain/ada")).toEqual({ view: "brain", id: "ada" });
    expect(parse("#/company/brain?page=..%2Fsecret.md")).toEqual({ view: "brain", id: "" });
    expect(parse("#/company/brain?page=http%3A%2F%2Fx.md")).toEqual({ view: "brain", id: "" });
    expect(brainHash("handbook", "policies/merging.md")).toBe("#/company/brain?page=policies%2Fmerging.md");
    expect(brainHash("ada", "facts/duet.md")).toBe("#/company/brain/ada?page=facts%2Fduet.md");
    expect(brainHash("ada", "INDEX.md")).toBe("#/company/brain/ada");
    // an address that names a page is already canonical; any other query is dropped
    expect(redirectFor("#/company/brain/ada?page=facts%2Fduet.md")).toBeNull();
    expect(redirectFor("#/company/brain/Ada?x=1")).toBe("#/company/brain/Ada");
  });

  it("opens the page the address names, and a click on a page changes the address", async () => {
    serve();
    const el = await mount<HTMLElement & { page: string }>("inc-knowledge", {
      repo: "handbook",
      page: "policies/merging.md",
    });
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector("article")?.textContent).toContain("Merging");
    const facts = [...root.querySelectorAll("nav button")].find(
      (b) => b.textContent?.trim() === "Duet",
    ) as HTMLButtonElement;
    facts.click();
    await tick();
    expect(location.hash).toBe("#/company/brain?page=facts%2Fduet.md");
    expect(root.querySelector("article")?.textContent).toContain("A money app");
  });

  it("links inside a sentence, relative to the page they are on, and only to real pages and safe URLs", async () => {
    serve();
    const el = await mount<HTMLElement>("inc-knowledge", { repo: "handbook" });
    const root = el.shadowRoot as ShadowRoot;
    const links = [...root.querySelectorAll("article a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual(["the merging policy", "GitHub", "Facts"]);
    expect(links[0]?.getAttribute("href")).toBe("#/company/brain?page=policies%2Fmerging.md");
    expect(links[1]?.getAttribute("href")).toBe("https://github.com/acme");
    expect(links[1]?.getAttribute("rel")).toContain("noopener");
    expect(root.querySelector("article")?.textContent).toContain("[bad](javascript:alert(1))");
    links[0]?.click();
    await tick();
    expect(location.hash).toBe("#/company/brain?page=policies%2Fmerging.md");
    // on that page, ../INDEX.md is the map
    const back = [...root.querySelectorAll("article a")].find(
      (a) => a.textContent === "map",
    ) as HTMLAnchorElement;
    expect(back.getAttribute("href")).toBe("#/company/brain");
  });

  it("follows Back: the address decides the page", async () => {
    serve();
    location.hash = "#/company/brain?page=facts%2Fduet.md";
    const app = await mount<HTMLElement>("inc-app");
    await tick();
    const brain = app.shadowRoot?.querySelector("inc-knowledge") as HTMLElement;
    expect(brain.shadowRoot?.querySelector("article")?.textContent).toContain("A money app");
    location.hash = "#/company/brain";
    await tick();
    await (brain as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    const again = app.shadowRoot?.querySelector("inc-knowledge") as HTMLElement;
    expect(again.shadowRoot?.querySelector("article")?.textContent).toContain("Handbook");
  });
});

describe("not found says so", () => {
  it("a ticket that doesn't exist", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "no such ticket" }, 404));
    const el = await mount<HTMLElement>("inc-ticket", { ticketId: "999" });
    const text = el.shadowRoot?.textContent ?? "";
    expect(text).toContain("There is no ticket #999");
    expect(text).not.toContain("no such ticket");
    expect(el.shadowRoot?.querySelector("a")?.getAttribute("href")).toBe("#/work/board");
  });

  it("a brain whose employee isn't here", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "no such employee" }, 404));
    const el = await mount<HTMLElement>("inc-knowledge", { repo: "zed" });
    expect(el.shadowRoot?.textContent).toContain("There is no brain for zed");
    expect(el.shadowRoot?.textContent).not.toContain("no such employee");
  });

  it("an old chat address that names nobody", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/chat" ? json({ threads: [] }) : json({ error: "no such employee" }, 404),
    );
    const el = await mount<HTMLElement>("inc-chat", { employeeId: "zzzzzzzz" });
    expect(el.shadowRoot?.textContent).toContain("There is no employee called zzzzzzzz");
    expect(el.shadowRoot?.textContent).not.toContain("no such employee");
  });
});

describe("the first message of a new conversation", () => {
  it("replaces the draft's address, so Back can't return to a draft that would make a second conversation", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/conversations" && init?.method === "POST")
        return json({ conversation: { id: "ab12cd34", employeeId: "ada", title: "New" } }, 201);
      return json({ conversations: [], employees: [], projects: [], threads: [], proposals: [] });
    });
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    const el = await mount<HTMLElement & { draft?: unknown }>("inc-conversations");
    const create = el as unknown as {
      createFromDraft(d: { text: string; files: File[]; intent: string }): Promise<string | null>;
    };
    (el as { draft?: unknown }).draft = { employee: "ada", project: "" };
    expect(await create.createFromDraft({ text: "hello", files: [], intent: "turn" })).toBeNull();
    expect(replace).toHaveBeenCalledWith("#/conversations/ab12cd34");
    expect(location.hash).not.toBe("#/conversations/ab12cd34"); // no new history entry
    // and it counts as the first-run checklist's last step
    expect(localStorage.getItem(STARTED_KEY)).toBe("1");
  });
});

describe("unsaved project edits", () => {
  const detail = {
    project: { id: "Duet", repo: "acme/duet", checks: ["pnpm test"] },
    policy: { mode: "owner-merges", protectedPaths: [".github/"], followUpsPerDay: 2, autoRelease: false },
    tickets: [],
    releases: [],
    repoUrl: "https://github.com/acme/duet",
    id: "Duet",
    repo: "acme/duet",
    mode: "owner-merges",
    checks: ["pnpm test"],
    lastTicket: null,
    openTickets: 0,
    openPrs: [],
  };
  const serve = () =>
    vi.stubGlobal("fetch", async (url: string) =>
      url.startsWith("/api/projects/Duet")
        ? json(detail)
        : json({ projects: [], employees: [], tickets: [] }),
    );

  it("comes back after leaving the page, can be discarded, and is gone once saved", async () => {
    serve();
    let el = await mount<HTMLElement>("inc-project-page", { projectId: "Duet" });
    const input = () => el.shadowRoot?.querySelector('input[aria-label^="command"]') as HTMLInputElement;
    input().value = "pnpm test && pnpm lint";
    input().dispatchEvent(new InputEvent("input"));
    await tick();
    expect(el.shadowRoot?.textContent).toContain("Unsaved changes");
    // go to another page and come back
    document.body.innerHTML = "";
    el = await mount<HTMLElement>("inc-project-page", { projectId: "Duet" });
    expect(input().value).toBe("pnpm test && pnpm lint");
    expect(el.shadowRoot?.textContent).toContain("Unsaved changes");
    // discard
    [...(el.shadowRoot?.querySelectorAll("button") ?? [])]
      .find((b) => b.textContent?.trim() === "Discard changes")
      ?.click();
    await tick();
    expect(input().value).toBe("pnpm test");
    document.body.innerHTML = "";
    el = await mount<HTMLElement>("inc-project-page", { projectId: "Duet" });
    expect(input().value).toBe("pnpm test");
    expect(el.shadowRoot?.textContent).not.toContain("Unsaved changes");
  });
});

describe("the next free engine id", () => {
  it("adds a suffix, and for a slug at the 40-character limit shortens the base instead of looping", async () => {
    const { freeEngineId } = await import("../src/components/hiring.ts");
    expect(freeEngineId("opus", new Set())).toBe("opus");
    expect(freeEngineId("opus", new Set(["opus"]))).toBe("opus-2");
    expect(freeEngineId("opus", new Set(["opus", "opus-2", "opus-3"]))).toBe("opus-4");
    const forty = "a".repeat(40);
    const taken = new Set([forty]);
    const next = freeEngineId(forty, taken);
    expect(next).toBe(`${"a".repeat(38)}-2`);
    expect(next.length).toBe(40);
    taken.add(next);
    expect(freeEngineId(forty, taken)).toBe(`${"a".repeat(38)}-3`);
    // 39 characters, and a base cut so its end would be a dash
    const thirtyNine = `${"b".repeat(37)}-cd`;
    const t2 = new Set([thirtyNine, `${"b".repeat(37)}-2`.slice(0, 39)]);
    const id = freeEngineId(thirtyNine, t2);
    expect(t2.has(id)).toBe(false);
    expect(id.length).toBeLessThanOrEqual(40);
    // many collisions at the limit still end, with ids that are all different
    const many = new Set([forty]);
    for (let i = 0; i < 120; i++) many.add(freeEngineId(forty, many));
    expect(many.size).toBe(121);
    for (const id of many) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});
