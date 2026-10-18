// The hash router: every view the tab bar and the header link to must open that view, on a phone too,
// where an unknown hash falls back to the inbox. (Office once fell through to that fallback.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncApp, layoutForRoute, parse, routeName } from "../src/components/app.ts";
import { IncLogin } from "../src/login.ts";

const phone = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

afterEach(() => {
  vi.unstubAllGlobals();
  location.hash = "";
});

describe("parse", () => {
  it.each(["office", "board", "desk", "inbox", "handbook", "more", "hiring", "chat"])(
    "#/%s opens that view on a phone and on a desktop",
    (view) => {
      for (const onPhone of [true, false]) {
        phone(onPhone);
        expect(parse(`#/${view}`).view).toBe(view);
      }
    },
  );

  it("starts at the inbox on a phone and the office on a desktop", () => {
    phone(true);
    expect(parse("").view).toBe("inbox");
    phone(false);
    expect(parse("").view).toBe("office");
  });
});

describe("the route layout language", () => {
  it.each([
    ["inbox", "page"],
    ["ticket/12", "page"],
    ["desk", "page"],
    ["hiring", "page"],
    ["hiring/ada", "page"],
    ["more", "page"],
    ["board", "wide"],
    ["office", "wide"],
    ["chat/ada", "split"],
    ["chat", "split"],
    ["handbook", "split"],
    ["brain/ada", "split"],
    ["setup/projects", "split"],
    ["setup/teams", "split"],
    ["setup/engines", "split"],
    ["setup/sandboxes", "split"],
    ["setup/notifications", "split"],
    ["setup", "split"],
  ] as const)("renders #/%s through the %s frame", async (path, kind) => {
    phone(false);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const app = new IncApp();
    app.route = parse(`#/${path}`);
    document.body.append(app);
    await app.updateComplete;
    const frame = app.shadowRoot?.querySelector("inc-layout") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    expect(frame?.getAttribute("kind")).toBe(kind);
    await frame.updateComplete;
    expect(frame.shadowRoot?.querySelector(`[data-layout="${kind}"]`)).not.toBeNull();
    expect(frame.querySelector("#view-heading")?.textContent).toBeTruthy();
    app.remove();
  });

  it("uses the Page frame for sign-in outside the authenticated shell", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const login = new IncLogin();
    document.body.append(login);
    await login.updateComplete;
    const frame = login.shadowRoot?.querySelector("inc-layout");
    expect(frame?.getAttribute("kind")).toBe("page");
    expect(frame?.hasAttribute("compact")).toBe(true);
    expect(frame?.querySelector('[slot="heading"]')?.textContent).toBe("Sign in");
    login.remove();
  });

  it("keeps the layout mapping centralized for route state", () => {
    expect(layoutForRoute(parse("#/board"))).toBe("wide");
    expect(layoutForRoute(parse("#/setup/projects"))).toBe("split");
    expect(layoutForRoute(parse("#/inbox"))).toBe("page");
    expect(routeName(parse("#/chat/ada")).long).toBe("Chats");
  });

  it("keeps the selected frame around offline, loading, and error content", async () => {
    phone(false);
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 400 }),
    );
    const app = new IncApp();
    app.route = parse("#/board");
    app.offline = true;
    document.body.append(app);
    await app.updateComplete;
    let frame = app.shadowRoot?.querySelector("inc-layout") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await frame.updateComplete;
    expect(frame.shadowRoot?.querySelector('[data-layout="wide"]')).not.toBeNull();
    expect(frame.innerHTML).toContain("<inc-offline");

    app.offline = false;
    await app.updateComplete;
    frame = app.shadowRoot?.querySelector("inc-layout") as HTMLElement & { updateComplete: Promise<unknown> };
    await frame.updateComplete;
    const board = frame.querySelector("inc-board") as
      | (HTMLElement & { updateComplete: Promise<unknown> })
      | null;
    expect(board).not.toBeNull();
    expect(frame.shadowRoot?.querySelector('[data-layout="wide"]')).not.toBeNull();
    await board?.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await board?.updateComplete;
    expect(board?.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
    app.remove();
  });

  it("renders the board loading state within its Wide frame", async () => {
    phone(false);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const app = new IncApp();
    app.route = parse("#/board");
    document.body.append(app);
    await app.updateComplete;
    const frame = app.shadowRoot?.querySelector("inc-layout") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await frame.updateComplete;
    const board = frame.querySelector("inc-board") as
      | (HTMLElement & { updateComplete: Promise<unknown> })
      | null;
    await board?.updateComplete;
    expect(frame.shadowRoot?.querySelector('[data-layout="wide"]')).not.toBeNull();
    expect(board?.shadowRoot?.textContent).toContain("Loading the board");
    app.remove();
  });
});

describe("the tab bar", () => {
  it("every tab button opens the view it names", async () => {
    phone(true);
    vi.stubGlobal("fetch", () => new Promise(() => {})); // the views just wait for data
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const tabs = [...(app.shadowRoot?.querySelectorAll(".tabs button") ?? [])];
    expect(tabs.map((a) => a.textContent?.trim())).toEqual(["Inbox", "Office", "Board", "Chats", "More"]);
    const office = tabs[1] as HTMLButtonElement;
    expect(office.getAttribute("role")).toBe("tab");
    office.click();
    await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;
    expect(location.hash).toBe("#/office");
    expect(app.shadowRoot?.querySelector("inc-layout")?.innerHTML).toContain("<inc-office");
    app.remove();
  });
});
