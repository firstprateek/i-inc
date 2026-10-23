// Accessibility and the layout rule (T63 groups 5 and 6): control edges and placeholders, motion, the skip link,
// one tab stop per board column, the sign-in screen, and the header that never moves.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/board.ts";
import { IncApp } from "../src/components/app.ts";
import { IncLayout } from "../src/components/layout.ts";
import "../src/login.ts";
import { IncLogin } from "../src/login.ts";
import { answer } from "./daemon-board.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");
const sources = (dir: string): string[] =>
  readdirSync(join(web, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : [],
  );

const luminance = (hex: string): number => {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("form controls", () => {
  it("draw their edge with --control-edge (3:1), never the 1.6:1 --line colours", () => {
    const offenders: string[] = [];
    for (const f of sources("src")) {
      const s = read(f);
      for (const m of s.matchAll(/([^{}`;]+)\{([^{}]*)\}/g)) {
        const [, selector = "", body = ""] = m;
        const forControl = /(^|[\s,>])(input|select|textarea)(\b|[[:.])|(input|select|textarea)\[/.test(
          selector.trim(),
        );
        if (!forControl) continue;
        for (const decl of body.matchAll(/(?:^|;|\s)border(?:-color)?\s*:\s*([^;]+)/g)) {
          if (/var\(--line/.test(decl[1] ?? ""))
            offenders.push(`${f}: ${selector.trim().slice(0, 50)}: ${decl[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("have an edge that is 3:1 against the surface in both themes", () => {
    const tokens = read("src/tokens.css");
    const light = (name: string) =>
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(tokens)?.[1] as string;
    expect(ratio(light("control-edge"), light("surface"))).toBeGreaterThanOrEqual(3);
    const dark = tokens.slice(tokens.indexOf('data-theme="dark"'));
    const d = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(dark)?.[1] as string;
    expect(ratio(d("control-edge"), d("surface"))).toBeGreaterThanOrEqual(3);
  });

  it("show placeholders in the secondary ink (4.5:1), not the browser's 4.44:1 default", () => {
    expect(read("src/components/shared.ts")).toMatch(/::placeholder\s*\{\s*color:\s*var\(--ink-2\)/);
    const tokens = read("src/tokens.css");
    const ink2 = /--ink-2:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1] as string;
    const surface = /--surface:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1] as string;
    expect(ratio(ink2, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("are 16px where iOS would zoom the page on focus (the composer's pickers)", () => {
    expect(read("src/components/conv-composer.ts")).toMatch(/\.pickers select \{[^}]*font-size: 16px/);
  });
});

describe("reduced motion", () => {
  it("is honoured everywhere: in every component's base styles and in the page's", () => {
    for (const [f, important] of [
      ["src/components/shared.ts", " !important"],
      ["src/tokens.css", ""],
    ] as const) {
      const css = read(f).replace(/\s+/g, " ");
      expect(css, f).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{/);
      for (const rule of [
        "animation-duration: 0.01ms",
        "animation-iteration-count: 1",
        "transition-duration: 0.01ms",
      ]) {
        expect(css, `${f}: ${rule}`).toContain(`${rule}${important};`);
      }
    }
    // The page's own file needs no !important (and the linter says so): nothing in the light DOM sets motion.
    expect(read("src/tokens.css")).not.toContain("!important");
    // The phone tab bar's press scale is a transform, which a zero duration would not remove.
    expect(read("src/components/app.ts")).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.tabs a:active \{ transform: none; \}/,
    );
  });
});

const phone = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

describe("the shell", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/");
    localStorage.clear();
    document.body.innerHTML = "";
    phone(false);
    vi.stubGlobal(
      "fetch",
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    location.hash = "";
  });

  it("starts with a skip link that moves focus to the page heading without changing the route", async () => {
    location.hash = "#/company/team";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const root = app.shadowRoot as ShadowRoot;
    // It is the first stop in the page, and it lives in the header (the grid's rows stay header, main and bar).
    const first = root.querySelector("button, a, [tabindex='0']") as HTMLElement;
    expect(first.parentElement?.tagName).toBe("HEADER");
    expect(first.classList.contains("skip")).toBe(true);
    expect(first.textContent).toBe("Skip to content");
    first.click();
    expect(root.activeElement?.id).toBe("view-heading");
    expect(location.hash).toBe("#/company/team");
  });

  it("names its two navigations differently, and marks the current page in each", async () => {
    location.hash = "#/work/board";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const navs = [...(app.shadowRoot?.querySelectorAll("nav") ?? [])];
    expect(navs.map((n) => n.getAttribute("aria-label"))).toEqual(["Areas", "Primary"]);
    expect(app.shadowRoot?.querySelector('nav.tabs a[aria-current="page"]')?.getAttribute("href")).toBe(
      "#/work/board",
    );
  });

  it("gives the area tab row aria-selected only, not aria-current as well", async () => {
    location.hash = "#/work/board";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const tabs = [...(app.shadowRoot?.querySelectorAll('.subnav a[role="tab"]') ?? [])];
    expect(tabs.length).toBeGreaterThan(1);
    for (const t of tabs) expect(t.hasAttribute("aria-current")).toBe(false);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
  });

  it("opens a phone's tab-bar link in place, and leaves a modified click to the browser", async () => {
    phone(true);
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const company = app.shadowRoot?.querySelector('nav.tabs a[href="#/company/team"]') as HTMLAnchorElement;
    const meta = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, button: 0 });
    company.dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(false);
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    company.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(location.hash).toBe("#/company/team");
  });
});

describe("tab stops on the board", () => {
  const ticket = (n: number, column: string) => ({
    id: String(n),
    title: `Ticket ${n}`,
    project: "Duet",
    type: "fix",
    effort: "low",
    doneWhen: [],
    assignee: { id: "ada", name: "Ada", tint: 0 },
    column,
    status: column === "done" ? "done" : "running",
    held: false,
    stages: [],
    live: "Build",
    needsYou: null,
    waiting: null,
    report: null,
    failure: null,
    outcome: null,
  });
  beforeEach(() => {
    document.body.innerHTML = "";
    const tickets = [
      ...Array.from({ length: 12 }, (_, i) => ticket(i + 1, "in-progress")),
      ...Array.from({ length: 5 }, (_, i) => ticket(i + 20, "todo")),
    ];
    vi.stubGlobal("fetch", async (url: string) => {
      const body = answer({ tickets }, url) ?? {};
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const mount = async () => {
    const el = document.createElement("inc-board");
    document.body.append(el);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    return el.shadowRoot as ShadowRoot;
  };

  it("is one stop for each column, not one for each card", async () => {
    const root = await mount();
    for (const section of root.querySelectorAll("section")) {
      const cards = [...section.querySelectorAll<HTMLAnchorElement>("a.card.t")];
      if (!cards.length) continue;
      expect(
        cards.filter((c) => c.getAttribute("tabindex") === "0"),
        section.getAttribute("aria-label") ?? "",
      ).toHaveLength(1);
      expect(cards.filter((c) => c.getAttribute("tabindex") === "-1")).toHaveLength(cards.length - 1);
    }
    const stops = root.querySelectorAll('a.card.t[tabindex="0"]').length;
    expect(stops).toBe(2); // To do and In progress
  });

  it("moves between a column's cards with the arrow keys, Home and End, and Tab returns to the last one", async () => {
    const root = await mount();
    const column = [...root.querySelectorAll("section")].find(
      (s) => s.getAttribute("aria-label") === "In progress",
    ) as HTMLElement;
    const cards = () => [...column.querySelectorAll<HTMLAnchorElement>("a.card.t")];
    const key = (el: Element, k: string) =>
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }),
      );
    (cards()[0] as HTMLElement).focus();
    key(cards()[0] as HTMLElement, "ArrowDown");
    expect(root.activeElement).toBe(cards()[1]);
    key(cards()[1] as HTMLElement, "End");
    expect(root.activeElement).toBe(cards().at(-1));
    key(cards().at(-1) as HTMLElement, "ArrowUp");
    expect(root.activeElement).toBe(cards().at(-2));
    key(cards().at(-2) as HTMLElement, "Home");
    expect(root.activeElement).toBe(cards()[0]);
    // The card that was focused last is the column's stop.
    (cards()[3] as HTMLElement).focus();
    await new Promise((r) => setTimeout(r, 0));
    const el = root.host as HTMLElement & { updateComplete: Promise<unknown> };
    await el.updateComplete;
    expect(cards().findIndex((c) => c.getAttribute("tabindex") === "0")).toBe(3);
  });
});

describe("the sign-in screen", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ initialized: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("has a brand mark, and a Show password checkbox that reveals the field and hides it again", async () => {
    const el = new IncLogin();
    document.body.append(el);
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector(".brand")?.textContent).toBe("i.inc");
    const field = root.querySelector('input[name="password"]') as HTMLInputElement;
    expect(field.type).toBe("password");
    const toggle = root.querySelector('label.reveal input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.closest("label")?.textContent?.trim()).toBe("Show password");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await el.updateComplete;
    expect((root.querySelector('input[name="password"]') as HTMLInputElement).type).toBe("text");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await el.updateComplete;
    expect((root.querySelector('input[name="password"]') as HTMLInputElement).type).toBe("password");
  });
});

describe("the header rule (docs/layout.md)", () => {
  const css = IncLayout.styles.map((s) => (typeof s === "string" ? s : s.cssText)).join("\n");

  it("puts the title in a 44px band at the top of the header, whatever the route has beside or under it", () => {
    expect(css).toMatch(/\.heading-copy\s*\{[^}]*justify-content:\s*flex-start/);
    expect(css).toMatch(
      /::slotted\(\[slot="heading"\]\)\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*min-height:\s*44px/,
    );
    // The conversations' short heading uses the same band: only its font is smaller.
    expect(css).toMatch(/:host\(\[dense\]\) ::slotted\(\[slot="heading"\]\)\s*\{\s*font-size:\s*24px/);
    expect(css).not.toMatch(/:host\(\[dense\]\) ::slotted\(\[slot="heading"\]\)[^}]*min-height/);
  });

  it("keeps a phone's Projects header to one action, so its tab row stays where the other tabs' is", async () => {
    history.replaceState(null, "", "/");
    location.hash = "#/company/projects";
    vi.stubGlobal(
      "fetch",
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    phone(false);
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const actions = [...(app.shadowRoot?.querySelectorAll('[slot="actions"]') ?? [])];
    expect(actions.map((a) => a.textContent?.trim())).toEqual(["Add a repo", "New project"]);
    expect(actions[0]?.classList.contains("phone-hide")).toBe(true);
    expect(actions[1]?.classList.contains("phone-hide")).toBe(false);
    const appCss = IncApp.styles.map((s) => (typeof s === "string" ? s : s.cssText)).join("\n");
    expect(appCss).toMatch(
      /@media \(max-width: 600px\)\s*\{\s*\.phone-hide\s*\{\s*display:\s*none !important/,
    );
    // The page offers Add a repo itself, on a phone only.
    expect(read("src/components/setup-projects.ts")).toMatch(/\.only-phone \{ display: none; \}/);
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    location.hash = "";
  });
});

describe("tap targets that were 38px", () => {
  it("hiring's pills are 44px", () => {
    expect(read("src/components/hiring.ts")).toMatch(/\.pill \{[^}]*min-height: 44px/);
    expect(read("src/components/hiring.ts")).not.toContain("min-height: 38px");
  });

  it("the Brain's pointer to Settings → Teams is a 44px link of its own, not a phrase in a sentence", () => {
    const s = read("src/components/knowledge.ts");
    expect(s).toMatch(/\.settings-link \{[^}]*min-height: 44px/);
    expect(s).toContain(
      '<a class="btn ghost settings-link" href="#/company/settings/teams">Open Settings → Teams</a>',
    );
    expect(s).not.toMatch(/<p class="muted">[^<]*<a href="#\/company\/settings\/teams">/);
  });
});
