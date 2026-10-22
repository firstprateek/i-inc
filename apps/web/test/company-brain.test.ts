// Tests for Company brain discoverability, team sections, and handbook links (T26).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncApp } from "../src/components/app.ts";
import "../src/components/group-brain.ts";
import type { IncKnowledge } from "../src/components/knowledge.ts";

async function mountKnowledge(repo = "handbook"): Promise<{ el: IncKnowledge; root: ShadowRoot }> {
  const el = document.createElement("inc-knowledge") as IncKnowledge;
  el.repo = repo;
  document.body.append(el);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return { el, root: el.shadowRoot as ShadowRoot };
}

async function mountApp(): Promise<{ app: IncApp; root: ShadowRoot }> {
  const app = new IncApp();
  document.body.append(app);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await app.updateComplete;
  return { app, root: app.shadowRoot as ShadowRoot };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  location.hash = "";
});

describe("Company brain discoverability (T26)", () => {
  it("Company → Brain is a tab in the Company tab row and opens the company brain", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    location.hash = "#/company/team";
    const { app, root } = await mountApp();

    const tabs = [
      ...(root.querySelectorAll('[role="tablist"] a[role="tab"]') as NodeListOf<HTMLAnchorElement>),
    ];
    const brainTab = tabs.find((a) => a.getAttribute("href") === "#/company/brain");
    expect(brainTab?.textContent?.trim()).toBe("Brain");

    location.hash = "#/company/brain";
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;
    expect(root.querySelector("inc-knowledge")?.getAttribute("repo")).toBe("handbook");
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe("Brain");
    // the old address lands on the same place
    location.hash = "#/handbook";
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(location.hash).toBe("#/company/brain");
  });

  it("The company brain renders its subtitle and team sections", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/knowledge/handbook") {
        return new Response(
          JSON.stringify({
            pages: [{ path: "INDEX.md", text: "# Company Map\nHandbook policies and facts." }],
            history: [],
            awaiting: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/teams") {
        return new Response(
          JSON.stringify({
            teams: [
              { id: "engineering", name: "Engineering", members: ["ada", "kit"] },
              { id: "design", name: "Design", members: ["lin"] },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/office") {
        return new Response(
          JSON.stringify({
            employees: [
              { id: "ada", name: "Ada Lovelace" },
              { id: "kit", name: "Kit" },
              { id: "lin", name: "Lin" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const { root } = await mountKnowledge("handbook");

    // The route frame owns the page title; the child view keeps only its contextual subtitle.
    expect(root.querySelector(".head h1")).toBeNull();
    expect(root.querySelector(".head h2")).toBeNull();

    // Subtitle in head
    const subtitle = root.querySelector(".head .muted");
    expect(subtitle?.textContent?.trim()).toBe(
      "Organisation-wide knowledge: facts, policies, and team guidelines",
    );

    // Dedicated Teams section
    const teamsSection = root.querySelector("section.teams");
    expect(teamsSection).not.toBeNull();
    expect(teamsSection?.querySelector("h2")?.textContent?.trim()).toBe("Teams");

    // Teams listed
    const teamCards = [...(teamsSection?.querySelectorAll(".team-section") ?? [])];
    expect(teamCards).toHaveLength(2);
    expect(teamCards[0]?.querySelector("h3")?.textContent?.trim()).toBe("Engineering");
    expect(teamCards[1]?.querySelector("h3")?.textContent?.trim()).toBe("Design");

    // Members linked to their brains
    const engLinks = [...(teamCards[0]?.querySelectorAll(".team-members a") ?? [])];
    expect(engLinks.map((a) => a.getAttribute("href"))).toEqual([
      "#/company/brain/ada",
      "#/company/brain/kit",
    ]);
    expect(engLinks.map((a) => a.textContent?.trim())).toEqual(["Ada Lovelace", "Kit"]);

    const designLinks = [...(teamCards[1]?.querySelectorAll(".team-members a") ?? [])];
    expect(designLinks.map((a) => a.getAttribute("href"))).toEqual(["#/company/brain/lin"]);
    expect(designLinks.map((a) => a.textContent?.trim())).toEqual(["Lin"]);
  });

  it("An employee's brain links to the company brain", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/knowledge/brains/ada") {
        return new Response(
          JSON.stringify({
            employee: { id: "ada", name: "Ada", role: "Staff Engineer", tint: 0 },
            pages: [{ path: "INDEX.md", text: "# Ada's Brain\nPersonal map and notes." }],
            history: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const { root } = await mountKnowledge("ada");

    // Clear link in header
    const companyLink = root.querySelector("a.company-link");
    expect(companyLink).not.toBeNull();
    expect(companyLink?.getAttribute("href")).toBe("#/company/brain");
    expect(companyLink?.textContent?.trim()).toBe("Company brain →");

    // Callout on map/INDEX.md page
    const callout = root.querySelector(".company-callout");
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain("Part of the organisation.");
    expect(callout?.textContent).toContain("shared policies and facts.");
    const calloutLink = callout?.querySelector("a");
    expect(calloutLink?.getAttribute("href")).toBe("#/company/brain");
    expect(calloutLink?.textContent?.trim()).toBe("Company brain");
  });

  it("Clicking the link navigates to the company brain", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/knowledge/brains/ada") {
        return new Response(
          JSON.stringify({
            employee: { id: "ada", name: "Ada", role: "Staff Engineer", tint: 0 },
            pages: [{ path: "INDEX.md", text: "# Ada's Brain\nPersonal map and notes." }],
            history: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/knowledge/handbook") {
        return new Response(
          JSON.stringify({
            pages: [{ path: "INDEX.md", text: "# Handbook Map\nCompany wide info" }],
            history: [],
            awaiting: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/teams") {
        return new Response(JSON.stringify({ teams: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    location.hash = "#/company/brain/ada";
    const { app, root: appRoot } = await mountApp();

    const knowledge = appRoot.querySelector("inc-knowledge") as IncKnowledge;
    expect(knowledge).not.toBeNull();
    await knowledge.updateComplete;

    const companyLink = knowledge.shadowRoot?.querySelector("a.company-link") as HTMLAnchorElement;
    expect(companyLink).not.toBeNull();

    // Click the company link in employee brain
    companyLink.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;

    expect(location.hash).toBe("#/company/brain");
    const activeKnowledge = appRoot.querySelector("inc-knowledge") as IncKnowledge;
    expect(activeKnowledge.getAttribute("repo")).toBe("handbook");

    // Also verify clicking callout link navigates to the company brain
    location.hash = "#/company/brain/ada";
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;

    const adaKnowledge = appRoot.querySelector("inc-knowledge") as IncKnowledge;
    await adaKnowledge.updateComplete;
    const calloutLink = adaKnowledge.shadowRoot?.querySelector(".company-callout a") as HTMLAnchorElement;
    expect(calloutLink).not.toBeNull();

    calloutLink.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await app.updateComplete;

    expect(location.hash).toBe("#/company/brain");
  });
});
