// The views load on demand (T63): the shell does not carry code for screens nobody has opened.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import { isReady, loadViews, needFor } from "../src/components/views.ts";
import { parse, type Route } from "../src/routes.ts";

// The hiring screen's file is "gone" (a newer build replaced it).
vi.mock("../src/components/hiring.ts", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

// Deliberately no import of a view: nothing here defines inc-board or inc-ticket until the app asks for them.
const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, "..", p), "utf8");

beforeEach(() => {
  history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  location.hash = "";
});

describe("what the shell imports", () => {
  it("is not any screen: they are loaded by views.ts when their route opens", () => {
    const app = read("src/components/app.ts");
    const eager = [...app.matchAll(/^import ["']\.\/([\w-]+)\.ts["'];?$/gm)].map((m) => m[1]);
    expect(eager).toEqual(["offline"]);
    // Nor does it pull in the AHP client; the Needs you count follows the roster once that has loaded.
    expect(app).not.toMatch(/from ["']\.\.\/ahp\//);
    expect(app).toMatch(/import\(["']\.\.\/ahp\/hub\.ts["']\)/);
  });

  it("splits every screen into a dynamic import", () => {
    const views = read("src/components/views.ts");
    for (const file of [
      "group-conversations",
      "chat",
      "group-work",
      "desk",
      "office",
      "hiring",
      "group-brain",
      "group-projects",
      "setup",
    ]) {
      expect(views, file).toContain(`import("./${file}.ts")`);
    }
  });
});

describe("needFor", () => {
  const routes: Route[] = [
    parse("#/conversations"),
    parse("#/conversations/old/ada"),
    parse("#/work/board"),
    parse("#/needs-you"),
    parse("#/work/releases"),
    parse("#/ticket/4"),
    parse("#/ticket/4/session/12"),
    parse("#/company/team"),
    parse("#/company/team/hiring"),
    parse("#/company/brain"),
    parse("#/company/brain/changes"),
    parse("#/company/projects"),
    parse("#/company/projects/add"),
    parse("#/company/projects/duet"),
    parse("#/company/usage"),
    parse("#/company/settings/engines"),
  ];

  it("names the group and elements of every route the app can show", () => {
    const seen = new Set(routes.map((r) => r.view));
    for (const view of [
      "conversations",
      "work",
      "ticket",
      "team",
      "hiring",
      "brain",
      "projects",
      "usage",
      "settings",
    ]) {
      expect(seen.has(view as Route["view"]), view).toBe(true);
    }
    for (const r of routes) {
      const need = needFor(r);
      expect(need.groups.length, JSON.stringify(r)).toBeGreaterThan(0);
      expect(
        need.tags.every((t) => t.startsWith("inc-")),
        JSON.stringify(r),
      ).toBe(true);
    }
  });

  it("asks only for the elements the route renders", () => {
    expect(needFor(parse("#/work/board")).tags).toEqual(["inc-board"]);
    expect(needFor(parse("#/ticket/4")).tags).toEqual(["inc-ticket"]);
    expect(needFor(parse("#/ticket/4/session/12")).tags).toEqual(["inc-ticket-session"]);
    expect(needFor(parse("#/work/releases")).tags).toEqual(["inc-desk"]);
    expect(needFor(parse("#/company/usage")).tags).toEqual(["inc-desk", "inc-office"]);
  });
});

describe("opening a screen", () => {
  it("shows a loading line, then the screen once its code has arrived", async () => {
    location.hash = "#/work/board";
    expect(customElements.get("inc-board")).toBeUndefined();
    const app = new IncApp();
    document.body.append(app);
    await app.updateComplete;
    const root = app.shadowRoot as ShadowRoot;
    expect(root.querySelector("inc-board")).toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain("Loading");
    // The heading is already in place: the frame does not wait for the code.
    expect(root.querySelector("#view-heading")?.textContent?.trim()).not.toBe("");

    await loadViews(needFor((app as unknown as { route: Route }).route));
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await app.updateComplete;
    }
    expect(customElements.get("inc-board")).toBeDefined();
    expect(root.querySelector("inc-board")).not.toBeNull();
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it("is ready at once when the elements are already defined", async () => {
    await import("../src/components/office.ts");
    expect(isReady(needFor(parse("#/company/team")))).toBe(true);
    await expect(loadViews(needFor(parse("#/company/team")))).resolves.toBeUndefined();
  });

  it("says so, with a way to reload, when the code cannot be fetched", async () => {
    // A tab left open across a deploy asks for a file the new build no longer has.
    location.hash = "#/company/team/hiring";
    const app = new IncApp();
    document.body.append(app);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await app.updateComplete;
    }
    const alert = (app.shadowRoot as ShadowRoot).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("couldn't load");
    expect(alert?.querySelector("button")?.textContent).toBe("Reload");
    expect((app.shadowRoot as ShadowRoot).querySelector('[role="status"]')).toBeNull();
  });
});
