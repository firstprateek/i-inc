import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import { answer } from "./daemon-board.ts";

const phone = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

describe("mobile app tab bar (T25)", () => {
  beforeEach(() => {
    phone(true);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    location.hash = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    location.hash = "";
    document.body.innerHTML = "";
  });

  it("renders the four areas as links in a navigation landmark, not a tablist of buttons", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const nav = app.shadowRoot?.querySelector(".tabs");
    expect(nav).not.toBeNull();
    expect(nav?.tagName.toLowerCase()).toBe("nav");
    expect(nav?.getAttribute("role")).toBeNull();
    // Not the same name as the header's "Areas" navigation.
    expect(nav?.getAttribute("aria-label")).toBe("Primary");
    expect(app.shadowRoot?.querySelector("header nav")?.getAttribute("aria-label")).toBe("Areas");

    expect(nav?.querySelectorAll("button").length).toBe(0);
    const buttons = [...(nav?.querySelectorAll("a") ?? [])];
    expect(buttons.length).toBe(4);

    for (const link of buttons) {
      expect(link.getAttribute("role")).toBeNull();
      expect(link.getAttribute("aria-selected")).toBeNull();
      expect(link.getAttribute("href")).toMatch(/^#\//);
    }

    expect(buttons.map((b) => b.querySelector(".tab-label")?.textContent?.trim())).toEqual([
      "Conversations",
      "Work",
      "Needs you",
      "Company",
    ]);
  });

  it("marks the active tab aria-current='page' and the others 'false', with no aria-selected", async () => {
    // The phone's home is Work → Needs you.
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const buttons = [...(app.shadowRoot?.querySelectorAll<HTMLAnchorElement>(".tabs a") ?? [])];
    const [conversations, work, needs, company] = buttons;
    if (!conversations || !work || !needs || !company) throw new Error("Missing tabs");

    expect(needs.getAttribute("aria-current")).toBe("page");
    for (const inactive of [conversations, work, company]) {
      expect(inactive.getAttribute("aria-current")).toBe("false");
    }
    // One signal, not two: a link is "current", only a tab is "selected".
    for (const t of buttons) expect(t.getAttribute("aria-selected")).toBeNull();
  });

  it("clicking a tab navigates via location.hash and activates the tab", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const buttons = [...(app.shadowRoot?.querySelectorAll<HTMLAnchorElement>(".tabs a") ?? [])];
    const [conversations, work, needs, company] = buttons;
    if (!conversations || !work || !needs || !company) throw new Error("Missing tabs");
    const selected = () => buttons.filter((b) => b.getAttribute("aria-current") === "page");

    work.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/work/board");
    expect(selected()).toEqual([work]);
    expect(work.getAttribute("aria-current")).toBe("page");

    company.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/company/team");
    expect(selected()).toEqual([company]);

    conversations.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/conversations");
    expect(selected()).toEqual([conversations]);

    needs.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/needs-you");
    expect(selected()).toEqual([needs]);
  });

  it("lights Work for the board, releases and tickets, and Needs you only for its own tab", async () => {
    location.hash = "#/ticket/42";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const buttons = [...(app.shadowRoot?.querySelectorAll<HTMLAnchorElement>(".tabs a") ?? [])];
    const [, work, needs, company] = buttons;
    if (!work || !needs || !company) throw new Error("Missing tabs");
    const go = async (hash: string) => {
      location.hash = hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await app.updateComplete;
    };

    expect(work.getAttribute("aria-current")).toBe("page");
    expect(needs.getAttribute("aria-current")).toBe("false");

    await go("#/work/releases");
    expect(work.getAttribute("aria-current")).toBe("page");
    await go("#/needs-you");
    expect(needs.getAttribute("aria-current")).toBe("page");
    expect(work.getAttribute("aria-current")).toBe("false");

    for (const h of [
      "#/company/settings/teams",
      "#/company/brain/ada",
      "#/company/team/hiring",
      "#/company/usage",
    ]) {
      await go(h);
      expect(company.getAttribute("aria-current")).toBe("page");
    }
  });

  it("contains touch callout, tap highlight, user-select, 44px min target, and no underline in CSS", () => {
    const allCss = IncApp.styles.map((s) => (typeof s === "string" ? s : s.cssText)).join("\n");

    // Must prevent touch callout menu
    expect(allCss).toContain("-webkit-touch-callout: none");

    // Must remove tap highlight
    expect(allCss).toContain("-webkit-tap-highlight-color: transparent");

    // Must prevent text selection
    expect(allCss).toContain("user-select: none");
    expect(allCss).toContain("-webkit-user-select: none");

    // Target sizes at least 44px
    expect(allCss).toContain("min-height: 44px");
    expect(allCss).toContain("min-width: 44px");

    // Haptic active press state
    expect(allCss).toContain("scale(0.92)");
    expect(allCss).toContain("opacity: 0.7");

    // No underline anywhere in the styles
    expect(allCss).not.toContain("text-decoration: underline");
    expect(allCss).toContain("text-decoration: none");

    // Frosted glass blur backdrop and solid fallback
    expect(allCss).toContain("backdrop-filter: blur(20px)");
    expect(allCss).toContain("-webkit-backdrop-filter: blur(20px)");
    expect(allCss).toContain("@supports");

    // Header safe-area-inset-top on mobile
    expect(allCss).toContain("calc(10px + env(safe-area-inset-top))");

    // Active pill uses var(--ink) and var(--on-ink) for high contrast
    expect(allCss).toContain("background: var(--ink)");
    expect(allCss).toContain("color: var(--on-ink)");
  });

  it("renders an icon and pill container inside each tab button", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const buttons = [...(app.shadowRoot?.querySelectorAll<HTMLAnchorElement>(".tabs a") ?? [])];
    expect(buttons.length).toBe(4);

    for (const btn of buttons) {
      const pill = btn.querySelector(".tab-pill");
      expect(pill).not.toBeNull();
      const svg = pill?.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");

      const label = btn.querySelector(".tab-label");
      expect(label).not.toBeNull();
      expect(label?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });

  it("puts the account menu, not the areas, in the phone header", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const header = app.shadowRoot?.querySelector("header");
    expect(header?.querySelector(".account-trigger")).not.toBeNull();
    expect(header?.querySelector(".mark")?.textContent).toBe("i.inc");
    // The areas nav and the badge are in the DOM for the laptop; CSS hides them on a phone.
    const css = IncApp.styles.map((s) => (typeof s === "string" ? s : s.cssText)).join("\n");
    expect(css).toMatch(/header nav\.areas, header \.needs-link\s*\{\s*display:\s*none/);
  });

  it("shows how many things need you on the Needs you tab, and says it in its name", async () => {
    vi.stubGlobal(
      "fetch",
      async (url: string) =>
        new Response(
          JSON.stringify(
            answer(
              {
                tickets: [
                  { id: "1", title: "a", status: "needs-you", column: "in-progress", stages: [] },
                  { id: "2", title: "b", status: "needs-you", column: "in-progress", stages: [] },
                ],
              },
              url,
            ) ?? { awaiting: [] },
          ),
        ),
    );
    const app = new IncApp();
    document.body.append(app);
    await new Promise((r) => setTimeout(r, 20));
    await app.updateComplete;
    const needs = app.shadowRoot?.querySelectorAll<HTMLAnchorElement>(".tabs a")[2];
    expect(needs?.querySelector(".tab-badge")?.textContent).toBe("2");
    expect(needs?.getAttribute("aria-label")).toBe("Needs you, 2 waiting");
  });
});
