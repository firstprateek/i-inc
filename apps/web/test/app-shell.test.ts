// The app shell (T40): the document never scrolls, <main> is the one scroll container, a new page starts
// at the top and Back/Forward put a page back where it was, focus goes to the heading, the tab title
// follows the view, and nothing in the app scrolls the window or calls scrollIntoView.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp, parse, type Route, routeName, routeTitle } from "../src/components/app.ts";
import { arrive, entryKey, MAX_REMEMBERED, ScrollMemory, stampEntry } from "../src/scroll-memory.ts";

const phone = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

describe("ScrollMemory", () => {
  it("returns what was saved, and 0 for a page never left", () => {
    const m = new ScrollMemory();
    m.save("a", 420.4);
    expect(m.get("a")).toBe(420);
    expect(m.get("never")).toBe(0);
    m.save("a", -5);
    expect(m.get("a")).toBe(0);
  });

  it("forgets the oldest entries past the cap, and refreshes an entry that is saved again", () => {
    const m = new ScrollMemory();
    for (let i = 0; i < MAX_REMEMBERED; i++) m.save(`k${i}`, i + 1);
    m.save("k0", 999); // now the newest
    m.save("extra", 1);
    expect(m.size).toBe(MAX_REMEMBERED);
    expect(m.has("k1")).toBe(false);
    expect(m.get("k0")).toBe(999);
  });
});

describe("arrive (Back/Forward versus a new page)", () => {
  beforeEach(() => history.replaceState(null, ""));

  it("stamps a fresh entry and starts it at the top", () => {
    const m = new ScrollMemory();
    expect(entryKey()).toBeNull();
    const a = arrive(m);
    expect(a.revisit).toBe(false);
    expect(a.top).toBe(0);
    expect(entryKey()).toBe(a.key);
  });

  it("restores the remembered position for an entry it has stamped before", () => {
    const m = new ScrollMemory();
    const key = stampEntry();
    m.save(key, 640);
    const a = arrive(m);
    expect(a).toEqual({ key, top: 640, revisit: true });
  });

  it("keeps other history state when it stamps", () => {
    history.replaceState({ other: 1 }, "");
    stampEntry();
    expect((history.state as { other: number }).other).toBe(1);
  });
});

describe("routeTitle", () => {
  const t = (hash: string) => routeTitle(parse(hash));
  it("names every view in the tab title", () => {
    phone(false);
    expect(t("#/board")).toBe("Board · i.inc");
    expect(t("#/office")).toBe("Office · i.inc");
    expect(t("#/inbox")).toBe("Inbox · i.inc");
    expect(t("#/desk")).toBe("My desk · i.inc");
    expect(t("#/handbook")).toBe("Company brain · i.inc");
    expect(t("#/brain/ada")).toBe("Company brain · i.inc");
    expect(t("#/hiring")).toBe("Hiring · i.inc");
    expect(t("#/more")).toBe("More · i.inc");
    expect(t("#/chat")).toBe("Chats · i.inc");
    expect(t("#/chat/ada")).toBe("Ada · Chat · i.inc");
    expect(t("#/ticket/12")).toBe("Ticket #12 · i.inc");
    expect(t("#/setup/engines")).toBe("Engines · Setup · i.inc");
    expect(t("#/setup")).toBe("Teams · Setup · i.inc");
    vi.unstubAllGlobals();
  });

  it("falls back to the product name, and has a short form for narrow headers", () => {
    expect(routeTitle({ view: "inbox" } as Route)).toBe("Inbox · i.inc");
    expect(routeName({ view: "ticket", id: "9" }).short).toBe("#9");
    expect(routeName({ view: "desk" }).short).toBe("Desk");
  });
});

describe("the shell", () => {
  let windowScroll: ReturnType<typeof vi.spyOn>;
  let intoView: ReturnType<typeof vi.fn>;
  let app: IncApp;

  beforeEach(() => {
    phone(false);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    intoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = intoView;
    history.replaceState(null, "");
    localStorage.clear();
    location.hash = "#/office";
  });
  afterEach(() => {
    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  async function mount(hash: string) {
    location.hash = hash;
    app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    // happy-dom delivers the `hashchange` for the assignment above a moment later; let it land first.
    await new Promise((r) => setTimeout(r, 10));
    await app.updateComplete;
    const root = app.shadowRoot as ShadowRoot;
    const main = root.querySelector("main") as HTMLElement;
    // happy-dom has no layout: a scroller that clamps to a content height we control.
    const state = { height: 5000, top: 0 };
    Object.defineProperty(main, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(main, "scrollHeight", { configurable: true, get: () => state.height });
    Object.defineProperty(main, "scrollTop", {
      configurable: true,
      get: () => state.top,
      set: (v: number) => {
        state.top = Math.max(0, Math.min(v, state.height - 600));
      },
    });
    return { root, main, state };
  }

  /** Navigates as a browser does: a link click is a fresh history entry (no state); Back/Forward bring
   *  an entry back with the state the shell stamped on it. happy-dom fires `hashchange` by itself. */
  const go = async (hash: string, entry: string | null = null) => {
    location.hash = hash;
    history.replaceState(entry ? { incEntry: entry } : null, "");
    await new Promise((r) => setTimeout(r, 10));
    await app.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;
  };
  const stamp = () => entryKey() as string;

  it("renders the header, the one scrolling <main> and a page heading to focus", async () => {
    const { root } = await mount("#/board");
    expect(root.querySelector("header")).not.toBeNull();
    const main = root.querySelector("main");
    expect(main?.getAttribute("tabindex")).toBe("-1");
    const h1 = main?.querySelector("h1#view-heading");
    expect(h1?.textContent?.trim()).toBe("Board");
    expect(h1?.getAttribute("tabindex")).toBe("-1");
    expect(document.title).toBe("Board · i.inc");
    expect(app.hasAttribute("own-scroll")).toBe(false);
  });

  it("the chat route owns its scrolling: main does not scroll, the panes do", async () => {
    await mount("#/chat/ada");
    expect(app.hasAttribute("own-scroll")).toBe(true);
    await go("#/board");
    expect(app.hasAttribute("own-scroll")).toBe(false);
    expect(document.documentElement.hasAttribute("data-fill")).toBe(false);
  });

  it("a new page starts at the top and takes focus without scrolling", async () => {
    const { root, main, state } = await mount("#/board");
    state.top = 700;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await go("#/desk");
    expect(main.scrollTop).toBe(0);
    expect(document.title).toBe("My desk · i.inc");
    expect(root.querySelector("#view-heading")?.textContent?.trim()).toBe("My desk");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(root.activeElement?.id).toBe("view-heading");
  });

  it("Back puts a page back where it was, and a link click to the same page starts at the top", async () => {
    const { main, state } = await mount("#/board");
    const boardEntry = stamp();
    state.top = 700;
    await go("#/desk");
    const deskEntry = stamp();
    state.top = 300;
    await go("#/board", boardEntry); // Back
    expect(main.scrollTop).toBe(700);
    await go("#/desk", deskEntry); // Forward
    expect(main.scrollTop).toBe(300);
    await go("#/board"); // a link click: a new entry
    expect(main.scrollTop).toBe(0);
  });

  it("remembers positions per history entry, so the same page visited twice keeps both", async () => {
    const { state } = await mount("#/board");
    state.top = 111;
    await go("#/desk");
    state.top = 222;
    await go("#/board");
    state.top = 333;
    await go("#/inbox");
    const memory = (app as unknown as { memory: ScrollMemory }).memory;
    // The board's first visit (111) and second visit (333, saved on leaving) are separate entries.
    expect(memory.size).toBe(3);
    expect(
      [111, 222, 333].every((n) =>
        [...(memory as unknown as { tops: Map<string, number> }).tops.values()].includes(n),
      ),
    ).toBe(true);
  });

  it("does not move focus when switching sections inside the same view from within it", async () => {
    const { root, main } = await mount("#/setup/teams");
    const inner = document.createElement("a");
    inner.href = "#/setup/engines";
    main.append(inner);
    inner.focus();
    Object.defineProperty(root, "activeElement", { configurable: true, get: () => inner });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await go("#/setup/engines");
    expect(focus).not.toHaveBeenCalled();
  });

  it("closes the All views menu on a route change and keeps pins across navigation", async () => {
    const { root } = await mount("#/office");
    (root.querySelector(".all-views-trigger") as HTMLButtonElement).click();
    await app.updateComplete;
    expect(root.querySelector(".all-views-dropdown")).not.toBeNull();
    (root.querySelector('button[aria-label="Unpin Hiring from navigation"]') as HTMLButtonElement).click();
    await app.updateComplete;
    await go("#/board");
    expect(root.querySelector(".all-views-dropdown")).toBeNull();
    await go("#/desk");
    const links = [...root.querySelectorAll("header nav .pinned-links a")].map((a) => a.textContent?.trim());
    expect(links).not.toContain("Hiring");
    expect(JSON.parse(localStorage.getItem("i-inc-nav-pinned") ?? "[]")).not.toContain("hiring");
  });

  it("tapping the tab you are on scrolls main to the top", async () => {
    phone(true);
    const { root, state } = await mount("#/inbox");
    state.top = 500;
    (root.querySelector('.tabs button[aria-selected="true"]') as HTMLButtonElement).click();
    expect(state.top).toBe(0);
  });

  it("never scrolls the window or calls scrollIntoView, through a round of navigation", async () => {
    const { state } = await mount("#/board");
    state.top = 400;
    for (const h of ["#/desk", "#/office", "#/chat/ada", "#/inbox", "#/more", "#/board"]) await go(h);
    expect(windowScroll).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
  });
});

describe("no code scrolls the page", () => {
  const dir = join(import.meta.dirname, "../src");
  const files = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
    );
  it("has no window.scrollTo, scrollIntoView, scrollBy or document scrolling in apps/web/src", () => {
    for (const f of files(dir)) {
      const code = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
        .join("\n");
      expect(code, f).not.toMatch(/window\.scroll(To|By)?\s*\(/);
      expect(code, f).not.toMatch(/\bscrollTo\s*\(/);
      expect(code, f).not.toMatch(/\.scrollIntoView\s*\(/);
      expect(code, f).not.toMatch(/scrollingElement|documentElement\.scrollTop|body\.scrollTop/);
    }
  });
});
