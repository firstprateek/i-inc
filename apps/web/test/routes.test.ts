// The hash router (T61): three areas, each with tabs. Every canonical hash opens its view on a phone and a
// desktop, every hash from before the areas still works (rewritten in place), and each route uses its template.
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncApp, layoutForRoute, parse, routeName } from "../src/components/app.ts";
import { IncLogin } from "../src/login.ts";
import {
  AREAS,
  areaOf,
  COMPANY_TABS,
  hashQuery,
  homeHash,
  legacyTarget,
  redirectFor,
  tabOf,
  WORK_TABS,
} from "../src/routes.ts";

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
  it.each([
    ["#/conversations", { view: "conversations", id: "" }],
    ["#/conversations/ab12cd34", { view: "conversations", id: "ab12cd34" }],
    ["#/conversations/old", { view: "conversations", id: "", old: true }],
    ["#/conversations/new/ada", { view: "conversations", id: "", draft: { employee: "ada", project: "" } }],
    [
      "#/conversations/new/ada/Duet",
      { view: "conversations", id: "", draft: { employee: "ada", project: "Duet" } },
    ],
    [
      "#/conversations/new/ada/my%20repo",
      { view: "conversations", id: "", draft: { employee: "ada", project: "my repo" } },
    ],
    ["#/conversations?new=1", { view: "conversations", id: "", draft: { employee: "", project: "" } }],
    [
      "#/conversations?new=1&project=Duet",
      { view: "conversations", id: "", draft: { employee: "", project: "Duet" } },
    ],
    [
      "#/conversations?new=1&project=my%20repo&employee=kit",
      { view: "conversations", id: "", draft: { employee: "kit", project: "my repo" } },
    ],
    ["#/conversations?x=1", { view: "conversations", id: "" }],
    ["#/conversations/old/ada", { view: "conversations", id: "ada", old: true }],
    // an employee in the old address means the old chat with that employee
    ["#/conversations/ada", { view: "conversations", id: "ada", old: true }],
    ["#/work", { view: "work", tab: "board" }],
    ["#/work/board", { view: "work", tab: "board" }],
    ["#/needs-you", { view: "needs-you" }],
    // Needs you was a Work tab: the old address is the top-level page now
    ["#/work/needs-you", { view: "needs-you" }],
    ["#/work/releases", { view: "work", tab: "releases" }],
    ["#/work/nonsense", { view: "work", tab: "board" }],
    ["#/ticket/12", { view: "ticket", id: "12" }],
    ["#/ticket/12/assign", { view: "ticket", id: "12" }],
    ["#/ticket/12/session/7", { view: "ticket", id: "12", session: "7" }],
    ["#/ticket/12/session/x", { view: "ticket", id: "12" }],
    ["#/company", { view: "team" }],
    ["#/company/team", { view: "team" }],
    ["#/company/team/hiring", { view: "hiring" }],
    ["#/company/team/hiring/ada", { view: "hiring", id: "ada" }],
    ["#/company/brain", { view: "brain", id: "" }],
    ["#/company/brain/ada", { view: "brain", id: "ada" }],
    ["#/company/brain/changes", { view: "brain", id: "", changes: true }],
    ["#/company/projects", { view: "projects" }],
    ["#/company/usage", { view: "usage" }],
    ["#/company/settings", { view: "settings", section: "teams" }],
    ["#/company/settings/engines", { view: "settings", section: "engines" }],
    ["#/company/settings/sandboxes", { view: "settings", section: "sandboxes" }],
    ["#/company/settings/notifications", { view: "settings", section: "notifications" }],
    ["#/company/settings/nonsense", { view: "settings", section: "teams" }],
  ] as const)("%s opens %j on a phone and on a desktop", (hash, route) => {
    for (const onPhone of [true, false]) {
      phone(onPhone);
      expect(parse(hash)).toEqual(route);
    }
  });

  it("opens Conversations on a desktop and Needs you on a phone when there is no hash", () => {
    phone(true);
    expect(parse("")).toEqual({ view: "needs-you" });
    expect(parse("#/")).toEqual({ view: "needs-you" });
    phone(false);
    expect(parse("")).toEqual({ view: "conversations", id: "" });
    expect(parse("#/nothing-here")).toEqual({ view: "conversations", id: "" });
    expect(parse("#/ticket")).toEqual({ view: "conversations", id: "" });
  });
});

describe("old hashes keep working", () => {
  // Every hash from before the three areas, and the canonical hash it lands on.
  const legacy: [string, string][] = [
    ["#/inbox", "#/needs-you"],
    ["#/office", "#/company/team"],
    ["#/board", "#/work/board"],
    ["#/chat", "#/conversations/old"],
    ["#/chat/ada", "#/conversations/old/ada"],
    ["#/desk", "#/company/usage"],
    ["#/handbook", "#/company/brain"],
    ["#/brain/ada", "#/company/brain/ada"],
    ["#/hiring", "#/company/team/hiring"],
    ["#/hiring/ada", "#/company/team/hiring/ada"],
    ["#/setup", "#/company/settings/teams"],
    ["#/setup/teams", "#/company/settings/teams"],
    ["#/setup/projects", "#/company/projects"],
    ["#/setup/engines", "#/company/settings/engines"],
    ["#/setup/sandboxes", "#/company/settings/sandboxes"],
    ["#/setup/notifications", "#/company/settings/notifications"],
    ["#/more", "#/company/team"],
  ];

  it.each(legacy)("%s is %s", (old, canonical) => {
    expect(legacyTarget(old)).toBe(canonical);
    phone(false);
    expect(parse(old)).toEqual(parse(canonical));
  });

  it("leaves new hashes and push-notification links alone", () => {
    for (const h of [
      "#/work/board",
      "#/company/team",
      "#/conversations/ab12cd34",
      "#/ticket/7",
      "#/ticket/7/assign",
      "",
    ])
      expect(legacyTarget(h)).toBeNull();
  });

  it.each(legacy)(
    "the app rewrites %s to %s in place, without a new history entry",
    async (old, canonical) => {
      phone(false);
      vi.stubGlobal("fetch", () => new Promise(() => {}));
      history.replaceState(null, "", "/");
      location.hash = old;
      const before = history.length;
      const app = new IncApp();
      document.body.append(app);
      await app.updateComplete;
      expect(location.hash).toBe(canonical);
      expect(history.length).toBe(before);
      expect(app.route).toEqual(parse(canonical));
      app.remove();
    },
  );

  it("rewrites an old hash that is followed while the app is open, too", async () => {
    phone(false);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    location.hash = "#/work/board";
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    location.hash = "#/chat/ada";
    await new Promise((r) => setTimeout(r, 10));
    await app.updateComplete;
    expect(location.hash).toBe("#/conversations/old/ada");
    expect(app.route).toEqual({ view: "conversations", id: "ada", old: true });
    app.remove();
  });
});

describe("redirectFor: tidying, mistyped and unknown hashes", () => {
  it.each([
    ["#/Inbox", "#/needs-you"],
    ["#/INBOX", "#/needs-you"],
    ["#/inbox?x=1", "#/needs-you"],
    ["#/inbox/", "#/needs-you"],
    ["#/Chat/Ada", "#/conversations/old/Ada"],
    ["#/chat/ada?draft=1", "#/conversations/old/ada"],
    ["#/Setup/Projects", "#/company/projects"],
    ["#/Setup/Engines", "#/company/settings/engines"],
    ["#/Work/Board", "#/work/board"],
    ["#/work/Needs-You", "#/needs-you"],
    ["#/Needs-You", "#/needs-you"],
    ["#/work/needs-you?x=1", "#/needs-you"],
    ["#/work/nonsense", "#/work/board"],
    ["#/Company/Settings/Sandboxes", "#/company/settings/sandboxes"],
    ["#/company/settings/nonsense", "#/company/settings/teams"],
    ["#/company/Team/Hiring/ada", "#/company/team/hiring/ada"],
    ["#/company/brain/Ada?x", "#/company/brain/Ada"],
    ["#/company/Brain/Changes", "#/company/brain/changes"],
    ["#/company/whatever", "#/company/team"],
    ["#/Ticket/12/Assign", "#/ticket/12/assign"],
    ["#/Ticket/12/Session/7", "#/ticket/12/session/7"],
    ["#/ticket/12/session/7?from=push", "#/ticket/12/session/7"],
    ["#/ticket/12/session/nope", "#/ticket/12"],
    ["#/ticket/12?from=push", "#/ticket/12"],
    ["#/Conversations/ada/", "#/conversations/old/ada"],
    ["#/Conversations/AB12CD34", "#/conversations/ab12cd34"],
    ["#/conversations/OLD", "#/conversations/old"],
  ])("%s becomes %s", (hash, to) => {
    expect(redirectFor(hash)).toBe(to);
    phone(false);
    expect(parse(hash)).toEqual(parse(to));
  });

  it("sends a hash the app does not know to the home route: Conversations on a laptop, Needs you on a phone", () => {
    for (const h of ["#/bogus", "#/ticket", "#//", "#/Bogus/thing", "bogus", "#/ticketing/1"]) {
      phone(false);
      expect(redirectFor(h), h).toBe("#/conversations");
      phone(true);
      expect(redirectFor(h), h).toBe("#/needs-you");
    }
  });

  it("leaves canonical hashes and an empty hash alone", () => {
    for (const h of [
      "",
      "#",
      "#/",
      "#/work",
      "#/work/board",
      "#/company",
      "#/company/team/hiring",
      "#/ticket/12/assign",
      "#/conversations/ab12cd34",
      "#/conversations/old/ada",
      "#/conversations/new/ada/Duet",
      "#/conversations?new=1",
      "#/conversations?new=1&project=Duet",
      "#/needs-you",
    ])
      expect(redirectFor(h), h).toBeNull();
  });

  it("the home hash is the phone home on a phone and Conversations on a laptop", () => {
    phone(true);
    expect(homeHash()).toBe("#/needs-you");
    phone(false);
    expect(homeHash()).toBe("#/conversations");
  });

  it("the app rewrites a bogus hash to the home route in place, without a new history entry", async () => {
    for (const [onPhone, home] of [
      [false, "#/conversations"],
      [true, "#/needs-you"],
    ] as const) {
      phone(onPhone);
      vi.stubGlobal("fetch", () => new Promise(() => {}));
      history.replaceState(null, "", "/");
      location.hash = "#/bogus";
      const before = history.length;
      const app = new IncApp();
      document.body.append(app);
      await app.updateComplete;
      expect(location.hash).toBe(home);
      expect(history.length).toBe(before);
      expect(app.route).toEqual(parse(home));
      app.remove();
    }
  });

  it.each(["#/Inbox", "#/inbox?x=1", "#/work/needs-you"])(
    "the app rewrites %s to Needs you",
    async (hash) => {
      phone(false);
      vi.stubGlobal("fetch", () => new Promise(() => {}));
      history.replaceState(null, "", "/");
      location.hash = hash;
      const app = new IncApp();
      document.body.append(app);
      await app.updateComplete;
      expect(location.hash).toBe("#/needs-you");
      app.remove();
    },
  );
});

describe("areas and tabs", () => {
  it("puts every route in one of three areas, and tickets under Work", () => {
    expect(areaOf(parse("#/conversations/ada"))).toBe("conversations");
    expect(areaOf(parse("#/work/releases"))).toBe("work");
    expect(areaOf(parse("#/ticket/3"))).toBe("work");
    // Needs you is a destination of its own, in no area
    expect(areaOf(parse("#/needs-you"))).toBeNull();
    for (const h of [
      "#/company",
      "#/company/team/hiring",
      "#/company/brain/ada",
      "#/company/projects",
      "#/company/usage",
      "#/company/settings/engines",
    ])
      expect(areaOf(parse(h))).toBe("company");
  });

  it("names the tab each route sits under; a ticket and Needs you sit on none", () => {
    expect(tabOf(parse("#/needs-you"))).toBeNull();
    expect(tabOf(parse("#/ticket/3"))).toBeNull();
    expect(tabOf(parse("#/company/team/hiring/ada"))).toBe("team");
    expect(tabOf(parse("#/company/brain/ada"))).toBe("brain");
    expect(tabOf(parse("#/company/brain/changes"))).toBe("brain");
    expect(tabOf(parse("#/company/settings/sandboxes"))).toBe("settings");
    expect(tabOf(parse("#/company/projects"))).toBe("projects");
  });

  it("has the tabs the plan names, in order", () => {
    expect(AREAS.map((a) => a.label)).toEqual(["Conversations", "Work", "Company"]);
    expect(WORK_TABS.map(([, l]) => l)).toEqual(["Board", "Releases"]);
    expect(COMPANY_TABS.map(([, l]) => l)).toEqual(["Team", "Brain", "Projects", "Usage", "Settings"]);
  });
});

describe("the route layout language", () => {
  it.each([
    ["needs-you", "page"],
    ["work/releases", "page"],
    ["ticket/12", "page"],
    ["ticket/12/session/7", "split"],
    ["company/team/hiring", "page"],
    ["company/team/hiring/ada", "page"],
    ["company/projects", "page"],
    ["company/usage", "page"],
    ["work/board", "wide"],
    ["work", "wide"],
    ["company/team", "wide"],
    ["company", "wide"],
    ["conversations/ada", "split"],
    ["conversations", "split"],
    ["company/brain", "split"],
    ["company/brain/ada", "split"],
    ["company/brain/changes", "page"],
    ["company/settings", "split"],
    ["company/settings/engines", "split"],
    ["company/settings/sandboxes", "split"],
    ["company/settings/notifications", "split"],
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
    expect(layoutForRoute(parse("#/work/board"))).toBe("wide");
    expect(layoutForRoute(parse("#/company/settings/engines"))).toBe("split");
    expect(layoutForRoute(parse("#/needs-you"))).toBe("page");
    expect(layoutForRoute(parse("#/board"))).toBe("wide");
    expect(routeName(parse("#/chat/ada")).long).toBe("Conversations");
  });

  it("keeps the selected frame around offline, loading, and error content", async () => {
    phone(false);
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 400 }),
    );
    const app = new IncApp();
    app.route = parse("#/work/board");
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
    app.route = parse("#/work/board");
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
  it("every tab button opens the area it names", async () => {
    phone(true);
    vi.stubGlobal("fetch", () => new Promise(() => {})); // the views just wait for data
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const tabs = [...(app.shadowRoot?.querySelectorAll(".tabs button") ?? [])];
    expect(tabs.map((a) => a.querySelector(".tab-label")?.textContent?.trim())).toEqual([
      "Conversations",
      "Work",
      "Needs you",
      "Company",
    ]);
    const company = tabs[3] as HTMLButtonElement;
    expect(company.getAttribute("role")).toBe("tab");
    company.click();
    await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;
    expect(location.hash).toBe("#/company/team");
    expect(app.shadowRoot?.querySelector("inc-layout")?.innerHTML).toContain("<inc-office");
    app.remove();
  });
});

describe("project addresses and queries (T62)", () => {
  it.each([
    ["#/company/projects", { view: "projects" }],
    ["#/company/projects/add", { view: "projects", flow: "add" }],
    ["#/company/projects/new", { view: "projects", flow: "new" }],
    ["#/company/projects/Duet", { view: "projects", id: "Duet" }],
    ["#/company/projects/New%20API", { view: "projects", id: "New API" }],
    ["#/company/projects/add?repo=acme%2Fduet", { view: "projects", flow: "add" }],
  ])("%s parses to %j", (hash, route) => {
    expect(parse(hash)).toEqual(route);
  });

  it("keeps a project's id in its case, and tidies add and new", () => {
    expect(redirectFor("#/company/projects/Duet")).toBeNull();
    expect(redirectFor("#/Company/Projects/ADD")).toBe("#/company/projects/add");
    expect(redirectFor("#/company/projects/New%20API")).toBeNull();
  });

  it("leaves the query of the pages that read one", () => {
    expect(redirectFor("#/conversations?new=1&project=Duet")).toBeNull();
    expect(redirectFor("#/company/projects/add?repo=acme%2Fduet")).toBeNull();
    expect(parse("#/conversations?new=1&project=Duet")).toEqual({
      view: "conversations",
      id: "",
      draft: { employee: "", project: "Duet" },
    });
    expect(hashQuery("#/conversations?new=1&project=Duet").get("project")).toBe("Duet");
    expect(hashQuery("#/conversations").get("project")).toBeNull();
  });

  it("keeps the query when the address is only tidied (case, trailing slash)", () => {
    expect(redirectFor("#/Conversations?new=1&project=Duet")).toBe("#/conversations?new=1&project=Duet");
    expect(redirectFor("#/conversations/?new=1")).toBe("#/conversations?new=1");
    expect(redirectFor("#/Company/Projects/Add/?repo=a%2Fb")).toBe("#/company/projects/add?repo=a%2Fb");
    expect(parse("#/Conversations?new=1")).toEqual({
      view: "conversations",
      id: "",
      draft: { employee: "", project: "" },
    });
  });

  it("still drops the query elsewhere", () => {
    expect(redirectFor("#/ticket/12?from=push")).toBe("#/ticket/12");
    expect(redirectFor("#/work/board?x=1")).toBe("#/work/board");
  });
});
