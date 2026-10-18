import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";

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

  it("renders buttons with role='tab' and type='button', not link elements", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const nav = app.shadowRoot?.querySelector(".tabs");
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute("role")).toBe("tablist");
    expect(nav?.getAttribute("aria-label")).toBe("Views");

    const links = nav?.querySelectorAll("a");
    expect(links?.length).toBe(0);

    const buttons = [...(nav?.querySelectorAll("button") ?? [])];
    expect(buttons.length).toBe(5);

    for (const btn of buttons) {
      expect(btn.tagName.toLowerCase()).toBe("button");
      expect(btn.getAttribute("type")).toBe("button");
      expect(btn.getAttribute("role")).toBe("tab");
    }

    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Inbox", "Office", "Board", "Chats", "More"]);
  });

  it("sets aria-current='page' and aria-selected='true' on the active tab, and 'false' on inactive tabs", async () => {
    // Phone default is inbox
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const buttons = [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".tabs button") ?? [])];
    const [inbox, office, board, chat, more] = buttons;
    if (!inbox || !office || !board || !chat || !more) throw new Error("Missing tabs");

    // Inbox is active
    expect(inbox.getAttribute("aria-current")).toBe("page");
    expect(inbox.getAttribute("aria-selected")).toBe("true");

    // Inactive tabs
    for (const inactive of [office, board, chat, more]) {
      expect(inactive.getAttribute("aria-current")).toBe("false");
      expect(inactive.getAttribute("aria-selected")).toBe("false");
    }
  });

  it("clicking a tab navigates via location.hash and activates the tab", async () => {
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const buttons = [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".tabs button") ?? [])];
    const [inbox, office, board, chat, more] = buttons;
    if (!inbox || !office || !board || !chat || !more) throw new Error("Missing tabs");

    // Click Office
    office.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/office");
    expect(office.getAttribute("aria-current")).toBe("page");
    expect(office.getAttribute("aria-selected")).toBe("true");
    expect(inbox.getAttribute("aria-current")).toBe("false");
    expect(inbox.getAttribute("aria-selected")).toBe("false");

    // Click Board
    board.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/board");
    expect(board.getAttribute("aria-current")).toBe("page");
    expect(board.getAttribute("aria-selected")).toBe("true");
    expect(office.getAttribute("aria-current")).toBe("false");
    expect(office.getAttribute("aria-selected")).toBe("false");

    // Click Chats
    chat.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/chat");
    expect(chat.getAttribute("aria-current")).toBe("page");
    expect(chat.getAttribute("aria-selected")).toBe("true");

    // Click More
    more.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/more");
    expect(more.getAttribute("aria-current")).toBe("page");
    expect(more.getAttribute("aria-selected")).toBe("true");

    // Click back to Inbox
    inbox.click();
    await app.updateComplete;
    expect(location.hash).toBe("#/inbox");
    expect(inbox.getAttribute("aria-current")).toBe("page");
    expect(inbox.getAttribute("aria-selected")).toBe("true");
  });

  it("activates tabs on nested routes (ticket -> Board, brain -> More)", async () => {
    location.hash = "#/ticket/42";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;

    const buttons = [...(app.shadowRoot?.querySelectorAll<HTMLButtonElement>(".tabs button") ?? [])];
    const board = buttons[2];
    const more = buttons[4];
    if (!board || !more) throw new Error("Missing tabs");

    expect(board.getAttribute("aria-current")).toBe("page");
    expect(board.getAttribute("aria-selected")).toBe("true");

    location.hash = "#/setup/teams";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await app.updateComplete;

    expect(more.getAttribute("aria-current")).toBe("page");
    expect(more.getAttribute("aria-selected")).toBe("true");
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
  });
});
