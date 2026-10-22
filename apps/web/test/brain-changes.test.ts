// Company → Brain → Changes (T58): the feed of what agents wrote to the brain, with filters and a one-click undo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/brain-changes.ts";
import type { IncBrainChanges } from "../src/components/brain-changes.ts";
import { redirectFor } from "../src/routes.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted API data.
type Any = any;

const change = (over: Any = {}): Any => ({
  id: 3,
  harvest: "h2",
  at: Date.UTC(2026, 9, 21, 10, 30),
  status: "committed",
  reverted: false,
  revertedAt: null,
  scope: "company",
  slug: "facts/gh",
  path: "company/facts/gh.md",
  op: "update",
  employee: { id: "ada", name: "Ada" },
  source: { kind: "ticket", id: "14", url: "#/ticket/14" },
  code: null,
  reason: null,
  commit: "a".repeat(40),
  diff: " title: GitHub CLI\n-Use gh pr checks.\n+Use gh pr checks --watch.",
  notes: [],
  untrusted: false,
  policy: false,
  conflict: false,
  revertible: true,
  ...over,
});

const facets = {
  scopes: ["brain:ada", "company"],
  employees: [
    { id: "ada", name: "Ada" },
    { id: "kit", name: "Kit" },
  ],
};

interface Call {
  method: string;
  url: string;
}

function api(pages: Any[] = [{ changes: [change()], next: null, facets }]) {
  const calls: Call[] = [];
  let n = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && /\/revert$/.test(url)) {
      return json({
        change: change({ id: Number(/changes\/(\d+)\//.exec(url)?.[1]), reverted: true, revertible: false }),
      });
    }
    if (url.startsWith("/api/brain/changes")) return json(pages[Math.min(n++, pages.length - 1)]);
    return json({});
  });
  return calls;
}

async function mount(): Promise<{ el: IncBrainChanges; root: ShadowRoot }> {
  const el = document.createElement("inc-brain-changes") as IncBrainChanges;
  document.body.append(el);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return { el, root: el.shadowRoot as ShadowRoot };
}
const settle = async (el: IncBrainChanges) => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
};

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("the Brain changes view", () => {
  it("shows the page, scope, who, the ticket they came from and a short diff, newest first", async () => {
    const calls = api([
      { changes: [change({ id: 4, slug: "facts/new", op: "create" }), change()], next: null, facets },
    ]);
    const { root } = await mount();
    const entries = [...root.querySelectorAll("ol > li")];
    expect(entries).toHaveLength(2);
    const first = entries[0] as HTMLElement;
    expect(first.querySelector(".verb")?.textContent).toBe("Added");
    expect(first.querySelector(".page")?.textContent).toBe("facts/new");
    expect(first.querySelector(".tag")?.textContent).toBe("Company");
    expect(first.querySelector(".who")?.textContent).toContain("Ada");
    expect(first.querySelector(".who a")?.getAttribute("href")).toBe("#/ticket/14");
    expect(first.querySelector(".who a")?.textContent).toBe("ticket #14");
    const lines = [...first.querySelectorAll("pre.diff span")].map((s) => [s.className, s.textContent]);
    expect(lines).toContainEqual(["del", "-Use gh pr checks."]);
    expect(lines).toContainEqual(["add", "+Use gh pr checks --watch."]);
    expect(calls[0]?.url).toBe("/api/brain/changes");
  });

  it("flags untrusted pages, policy changes and conflicts, and names a conversation as the source", async () => {
    api([
      {
        changes: [
          change({
            id: 5,
            policy: true,
            untrusted: true,
            conflict: true,
            source: { kind: "conversation", id: "3f2a9c01", url: "#/conversations/3f2a9c01" },
          }),
        ],
        next: null,
        facets,
      },
    ]);
    const { root } = await mount();
    const tags = [...root.querySelectorAll(".tags .tag")].map((t) => t.textContent);
    expect(tags).toEqual(expect.arrayContaining(["policy", "untrusted", "conflict"]));
    expect(root.querySelector(".who a")?.textContent).toBe("conversation");
    expect(root.querySelector(".who a")?.getAttribute("href")).toBe("#/conversations/3f2a9c01");
  });

  it("shows why a change was refused, with no Revert button", async () => {
    api([
      {
        changes: [
          change({
            id: 6,
            status: "rejected",
            code: "duplicate",
            reason: "it has the same title as [[facts/gh]]: update that page instead",
            commit: null,
            revertible: false,
            op: "create",
            slug: "facts/github-cli",
          }),
        ],
        next: null,
        facets,
      },
    ]);
    const { root } = await mount();
    const entry = root.querySelector("ol > li") as HTMLElement;
    expect(entry.classList.contains("refused")).toBe(true);
    expect(entry.querySelector(".verb")?.textContent).toBe("Refused added");
    expect(entry.querySelector(".reason")?.textContent).toContain("update that page instead");
    expect(entry.querySelector("button")).toBeNull();
  });

  it("reverts with one click and updates the entry in place, keeping the older pages already loaded", async () => {
    const calls = api([
      { changes: [change({ id: 9 })], next: 9, facets },
      { changes: [change({ id: 8, slug: "facts/older" })], next: null, facets },
    ]);
    const { el, root } = await mount();
    const more = [...root.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("older"),
    ) as HTMLButtonElement;
    more.click();
    await settle(el);
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
    (root.querySelector("ol li button") as HTMLButtonElement).click();
    await settle(el);
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
      "/api/brain/changes/9/revert",
    ]);
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
    expect(root.querySelector(".tags")?.textContent).toContain("reverted by owner");
    expect(root.querySelectorAll("ol li button")).toHaveLength(1);
  });

  it("shows the reason when a revert can't be done", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body =
        init?.method === "POST"
          ? { error: "later edits to the same page overlap this change, so it can't be undone in one step" }
          : { changes: [change()], next: null, facets };
      return new Response(JSON.stringify(body), {
        status: init?.method === "POST" ? 409 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { el, root } = await mount();
    (root.querySelector("ol li button") as HTMLButtonElement).click();
    await settle(el);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("overlap");
  });

  it("filters by scope, employee and what, offering only what has entries", async () => {
    const calls = api();
    const { el, root } = await mount();
    const [scope, who, what] = [...root.querySelectorAll("select")] as [
      HTMLSelectElement,
      HTMLSelectElement,
      HTMLSelectElement,
    ];
    expect([...scope.options].map((o) => o.textContent)).toEqual(["All scopes", "Ada’s brain", "Company"]);
    expect([...who.options].map((o) => o.textContent)).toEqual(["Everyone", "Ada", "Kit"]);
    for (const [select, value] of [
      [scope, "company"],
      [who, "kit"],
      [what, "rejected"],
    ] as const) {
      select.value = value;
      select.dispatchEvent(new Event("change"));
      await settle(el);
    }
    expect(calls.map((c) => c.url).slice(1)).toEqual([
      "/api/brain/changes?scope=company",
      "/api/brain/changes?scope=company&employee=kit",
      "/api/brain/changes?scope=company&employee=kit&status=rejected",
    ]);
  });

  it("loads older changes on request, and says so when there are none", async () => {
    const calls = api([
      { changes: [change({ id: 9 })], next: 9, facets },
      { changes: [change({ id: 8, slug: "facts/older" })], next: null, facets },
    ]);
    const { el, root } = await mount();
    const more = [...root.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("older"),
    ) as HTMLButtonElement;
    more.click();
    await settle(el);
    expect(calls.at(-1)?.url).toBe("/api/brain/changes?before=9");
    expect(root.querySelectorAll("ol > li")).toHaveLength(2);
    expect([...root.querySelectorAll("button")].some((b) => b.textContent?.includes("older"))).toBe(false);

    document.body.innerHTML = "";
    api([{ changes: [], next: null, facets: { scopes: [], employees: [] } }]);
    const empty = await mount();
    expect(empty.root.querySelector(".empty")?.textContent).toContain("Nothing has been written yet");
  });

  it("has an address that survives tidying", () => {
    expect(redirectFor("#/company/brain/changes")).toBeNull();
  });
});
