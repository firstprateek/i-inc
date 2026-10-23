// The app shell (T40): the document never scrolls, <main> is the one scroll container, a new page starts
// at the top and Back/Forward put a page back where it was, focus goes to the heading, the tab title
// follows the view, and nothing in the app scrolls the window or calls scrollIntoView.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp, parse, routeName, routeTitle } from "../src/components/app.ts";
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
  it("names the tab, then the area, in the tab title", () => {
    phone(false);
    expect(t("#/conversations")).toBe("Conversations · i.inc");
    expect(t("#/conversations/ab12cd34")).toBe("Conversations · i.inc");
    expect(t("#/conversations/old/ada")).toBe("Old chat · Conversations · i.inc");
    expect(t("#/work/board")).toBe("Board · Work · i.inc");
    expect(t("#/needs-you")).toBe("Needs you · i.inc");
    expect(t("#/work/releases")).toBe("Releases · Work · i.inc");
    expect(t("#/ticket/12")).toBe("Ticket #12 · Work · i.inc");
    expect(t("#/company/team")).toBe("Team · Company · i.inc");
    expect(t("#/company/team/hiring")).toBe("Hiring · Company · i.inc");
    expect(t("#/company/brain")).toBe("Brain · Company · i.inc");
    expect(t("#/company/brain/ada")).toBe("Ada’s brain · Company · i.inc");
    expect(t("#/company/projects")).toBe("Projects · Company · i.inc");
    expect(t("#/company/usage")).toBe("Usage · Company · i.inc");
    expect(t("#/company/settings/engines")).toBe("Engines and accounts · Settings · Company · i.inc");
    expect(t("#/company/settings")).toBe("Teams · Settings · Company · i.inc");
    // an old hash is titled as the page it redirects to
    expect(t("#/inbox")).toBe("Needs you · i.inc");
    vi.unstubAllGlobals();
  });

  it("names the area in the page heading, with a short form for narrow headers", () => {
    expect(routeName({ view: "work", tab: "board" }).long).toBe("Work");
    expect(routeName({ view: "usage" }).long).toBe("Company");
    expect(routeName({ view: "ticket", id: "9" }).short).toBe("#9");
    expect(routeTitle({ view: "needs-you" })).toBe("Needs you · i.inc");
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
    location.hash = "#/company/team";
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
    const { root } = await mount("#/work/board");
    expect(root.querySelector("header")).not.toBeNull();
    const main = root.querySelector("main");
    expect(main?.getAttribute("tabindex")).toBe("-1");
    const h1 = main?.querySelector("h1#view-heading");
    expect(h1?.textContent?.trim()).toBe("Work");
    expect(h1?.getAttribute("tabindex")).toBe("-1");
    expect(document.title).toBe("Board · Work · i.inc");
    expect(app.hasAttribute("own-scroll")).toBe(false);
  });

  it("the conversations route owns its scrolling: main does not scroll, the panes do", async () => {
    await mount("#/conversations/ada");
    expect(app.hasAttribute("own-scroll")).toBe(true);
    await go("#/work/board");
    expect(app.hasAttribute("own-scroll")).toBe(false);
    expect(document.documentElement.hasAttribute("data-fill")).toBe(false);
  });

  it("a new page starts at the top and takes focus without scrolling", async () => {
    const { root, main, state } = await mount("#/work/board");
    state.top = 700;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await go("#/company/usage");
    expect(main.scrollTop).toBe(0);
    expect(document.title).toBe("Usage · Company · i.inc");
    expect(root.querySelector("#view-heading")?.textContent?.trim()).toBe("Company");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(root.activeElement?.id).toBe("view-heading");
  });

  it("Back puts a page back where it was, and a link click to the same page starts at the top", async () => {
    const { main, state } = await mount("#/work/board");
    const boardEntry = stamp();
    state.top = 700;
    await go("#/company/usage");
    const deskEntry = stamp();
    state.top = 300;
    await go("#/work/board", boardEntry); // Back
    expect(main.scrollTop).toBe(700);
    await go("#/company/usage", deskEntry); // Forward
    expect(main.scrollTop).toBe(300);
    await go("#/work/board"); // a link click: a new entry
    expect(main.scrollTop).toBe(0);
  });

  it("remembers positions per history entry, so the same page visited twice keeps both", async () => {
    const { state } = await mount("#/work/board");
    state.top = 111;
    await go("#/company/usage");
    state.top = 222;
    await go("#/work/board");
    state.top = 333;
    await go("#/needs-you");
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
    const { root, main } = await mount("#/company/settings/teams");
    const inner = document.createElement("a");
    inner.href = "#/company/settings/engines";
    main.append(inner);
    inner.focus();
    Object.defineProperty(root, "activeElement", { configurable: true, get: () => inner });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await go("#/company/settings/engines");
    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps focus on the tab row while moving along an area's tabs", async () => {
    const { root } = await mount("#/company/team");
    const tab = root.querySelector('[role="tablist"] a[href="#/company/brain"]') as HTMLElement;
    Object.defineProperty(root, "activeElement", { configurable: true, get: () => tab });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await go("#/company/brain");
    expect(focus).not.toHaveBeenCalledWith({ preventScroll: true });
  });

  it("opens the account menu with theme and sign out, and closes it on a route change", async () => {
    const { root } = await mount("#/company/team");
    const trigger = root.querySelector(".account-trigger") as HTMLButtonElement;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".account-menu")).toBeNull();
    trigger.click();
    await app.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = [...root.querySelectorAll('.account-menu [role="menuitem"]')].map((i) =>
      i.textContent?.trim(),
    );
    expect(items).toEqual(["Switch to dark theme", "Sign out"]);
    await go("#/work/board");
    expect(root.querySelector(".account-menu")).toBeNull();
  });

  it("switches the theme from the account menu and remembers it", async () => {
    const { root } = await mount("#/work/board");
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await app.updateComplete;
    (root.querySelector('.account-menu [role="menuitem"]') as HTMLButtonElement).click();
    await app.updateComplete;
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("i-inc-theme")).toBe("dark");
    expect(root.querySelector(".account-menu")).toBeNull();
    (root.querySelector(".account-trigger") as HTMLButtonElement).click();
    await app.updateComplete;
    expect(root.querySelector('.account-menu [role="menuitem"]')?.textContent?.trim()).toBe(
      "Switch to light theme",
    );
    delete document.documentElement.dataset.theme;
  });

  it("closes the account menu on Escape, and on a click outside it", async () => {
    const { root } = await mount("#/work/board");
    const trigger = root.querySelector(".account-trigger") as HTMLButtonElement;
    trigger.click();
    await app.updateComplete;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.updateComplete;
    expect(root.querySelector(".account-menu")).toBeNull();
    trigger.click();
    await app.updateComplete;
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await app.updateComplete;
    expect(root.querySelector(".account-menu")).toBeNull();
  });

  it("forgets the customizable menu's pins from before the three areas", async () => {
    localStorage.setItem("i-inc-nav-pinned", '["office","board"]');
    await mount("#/work/board");
    expect(localStorage.getItem("i-inc-nav-pinned")).toBeNull();
  });

  it("tapping the tab you are on scrolls main to the top", async () => {
    phone(true);
    const { root, state } = await mount("#/needs-you");
    state.top = 500;
    (root.querySelector('.tabs a[aria-current="page"]') as HTMLButtonElement).click();
    expect(state.top).toBe(0);
  });

  it("never scrolls the window or calls scrollIntoView, through a round of navigation", async () => {
    const { state } = await mount("#/work/board");
    state.top = 400;
    for (const h of [
      "#/company/usage",
      "#/company/team",
      "#/conversations/ada",
      "#/needs-you",
      "#/company/settings/engines",
      "#/work/board",
    ])
      await go(h);
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

// Guards for the headline fix: if any of these rules is removed the page goes back to scrolling as a
// document and the header scrolls away. happy-dom has no layout, so these read the rules themselves.
describe("the shell's layout rules", () => {
  const tokens = readFileSync(join(import.meta.dirname, "../src/tokens.css"), "utf8");
  const appCss = (IncApp.styles as unknown as { cssText: string }[]).map((c) => c.cssText).join("\n");

  /** The bodies of every rule whose selector is exactly `selector` (rules without nested braces). */
  const bodies = (css: string, selector: string): string[] => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...css.matchAll(new RegExp(`(?:^|[};\\n])\\s*${esc}\\s*\\{([^{}]*)\\}`, "g"))].map(
      (m) => m[1] ?? "",
    );
  };
  const has = (css: string, selector: string, ...decls: RegExp[]) => {
    const found = bodies(css, selector);
    expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
    for (const d of decls)
      expect(
        found.some((b) => d.test(b)),
        `${selector} lacks ${d}`,
      ).toBe(true);
  };

  it("html and body never scroll the document", () => {
    has(tokens, "html", /overflow:\s*hidden/, /height:\s*100%/, /overscroll-behavior:\s*none/);
    has(tokens, "body", /overflow:\s*hidden/, /height:\s*100%/, /overscroll-behavior:\s*none/);
  });

  it("the host is a viewport-height grid of header, main (and the tab bar on phones)", () => {
    has(
      appCss,
      ":host",
      /display:\s*grid/,
      /grid-template-rows:\s*auto minmax\(0, 1fr\)\s*;/,
      /height:\s*100dvh/,
      /overflow:\s*hidden/,
    );
    has(appCss, ":host", /grid-template-areas:\s*"header" "main" "tabs"/);
    expect(appCss).toMatch(/grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  });

  it("the header and the tab bar are grid rows, never sticky or fixed", () => {
    has(appCss, "header", /grid-area:\s*header/, /z-index:\s*20/);
    has(appCss, ".tabs", /grid-area:\s*tabs/);
    expect(appCss).not.toMatch(/position:\s*(sticky|fixed)/);
  });

  it("a phone keeps the account menu in the header and moves the areas to the tab bar", () => {
    const phoneRules = appCss.slice(appCss.indexOf("@media (max-width: 900px)"));
    expect(phoneRules).toMatch(/header nav\.areas, header \.needs-link\s*\{\s*display:\s*none;/);
    expect(appCss).toMatch(/repeat\(4, 1fr\)/);
  });

  it("a route that owns its scrolling has the same top padding as every other route, so headings do not move", () => {
    const own = bodies(appCss, ":host([own-scroll]) main").join(" ");
    const plain = bodies(appCss, "main").join(" ");
    const top = (b: string) => /padding(?:-top)?:\s*(\d+)px/.exec(b)?.[1];
    expect(own).toMatch(/padding-top:\s*20px/);
    expect(top(plain)).toBe("20");
  });

  it("main is the one scroller, and a route that owns its scrolling clips it", () => {
    has(
      appCss,
      "main",
      /grid-area:\s*main/,
      /min-height:\s*0/,
      /overflow-y:\s*auto/,
      /overscroll-behavior:\s*contain/,
      /scrollbar-gutter:\s*stable/,
    );
    has(appCss, ":host([own-scroll]) main", /overflow:\s*hidden/);
  });

  it("a route that owns its scrolling keeps the notch's side insets on a phone", () => {
    has(
      appCss,
      ":host([own-scroll]) main",
      /padding:\s*0 env\(safe-area-inset-right\) 0 env\(safe-area-inset-left\)/,
    );
  });

  it("the scrollbar thumb is at least 3:1 on the ground and the surface, in light and dark", () => {
    const hex = (block: string, name: string) =>
      new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1] as string;
    const lum = (h: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const light = tokens.slice(
      tokens.indexOf(":root {"),
      tokens.indexOf("@media (prefers-color-scheme: dark)"),
    );
    const dark = tokens.slice(tokens.indexOf(':root[data-theme="dark"]'));
    const darkMedia = tokens.slice(
      tokens.indexOf("@media (prefers-color-scheme: dark)"),
      tokens.indexOf(':root[data-theme="dark"]'),
    );
    for (const block of [light, dark, darkMedia]) {
      for (const bg of ["--ground", "--surface"]) {
        expect(ratio(hex(block, "--scroll-thumb"), hex(block, bg))).toBeGreaterThanOrEqual(3);
        expect(ratio(hex(block, "--scroll-thumb-hover"), hex(block, bg))).toBeGreaterThanOrEqual(3);
      }
    }
    expect(tokens).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\)/);
  });
});

describe("the shell's structure and header links", () => {
  beforeEach(() => {
    phone(false);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    history.replaceState(null, "");
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("has header, main and the tab bar as the grid's direct children, in that order", async () => {
    location.hash = "#/work/board";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const kids = [...(app.shadowRoot as ShadowRoot).children]
      .filter((e) => e.tagName !== "STYLE")
      .map((e) => e.tagName);
    expect(kids).toEqual(["HEADER", "MAIN", "NAV"]);
  });

  it("clicking the link to the page you are on scrolls main to the top", async () => {
    location.hash = "#/work/board";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    await new Promise((r) => setTimeout(r, 10));
    const main = (app.shadowRoot as ShadowRoot).querySelector("main") as HTMLElement;
    let top = 480;
    Object.defineProperty(main, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => (top = v),
    });
    const link = (app.shadowRoot as ShadowRoot).querySelector(
      'header nav a[href="#/work/board"]',
    ) as HTMLAnchorElement;
    link.click();
    expect(top).toBe(0);
    // A link to another page leaves the position to the navigation logic.
    top = 480;
    (app.shadowRoot as ShadowRoot)
      .querySelector('header nav a[href="#/company/team"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(top).toBe(480);
  });
});
