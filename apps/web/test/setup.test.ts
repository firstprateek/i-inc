// The Setup screens against a fake API: each section renders from it, and saving sends the right PUT.
import { defaultProjectPolicy } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/app.ts";
import "../src/components/setup.ts";
import { defaultSandbox, type Project, policyDefaults, type Sandbox, type Team } from "../src/setup-api.ts";

let calls: { method: string; url: string; body: unknown }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const engines = [
  { id: "opus", harness: "claude-code", model: "Claude Opus", accountId: "claude-pro", local: false },
  { id: "qwen", harness: "opencode", model: "qwen3", accountId: "local", local: true },
];
const accounts = [
  { id: "claude-pro", name: "Claude Pro", monthlyFee: 20, monthlyCap: 50 },
  { id: "local", name: "Local" },
];
const teams: Team[] = [
  { id: "engineering", name: "Engineering", members: ["ada", "juno"], sandbox: { cpus: 4, memory: "8G" } },
  { id: "home", name: "Home", members: [] },
];
const projects: Project[] = [
  {
    id: "Duet",
    repo: "demo/duet",
    checks: ["pnpm install", "pnpm test"],
    mode: "owner-merges",
    protectedPaths: [".github/", "docs/"],
    followUpsPerDay: 2,
  },
  { id: "bare", repo: "demo/bare", checks: ["make"] },
];
const sandboxes: Sandbox[] = [
  {
    team: "engineering",
    machine: "inc-engineering",
    state: "running",
    cpus: 4,
    memory: "8G",
    signedIn: { claude: true, antigravity: false, github: true },
  },
  {
    team: "home",
    machine: "inc-home",
    state: "error",
    cpus: 6,
    memory: "12G",
    signedIn: { claude: false, antigravity: false, github: false },
  },
];

function serve(opts: { sandboxes?: "ok" | "404" | "fail"; putFails?: string } = {}) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "PUT" && opts.putFails) return json({ error: opts.putFails }, 400);
    if (url === "/api/teams") return json({ teams });
    if (url === "/api/projects") return json({ projects });
    if (url === "/api/engines") return json({ engines });
    if (url === "/api/accounts") return json({ accounts, rateLimits: {} });
    if (url === "/api/office")
      return json({
        employees: [
          { id: "ada", name: "Ada" },
          { id: "juno", name: "Juno" },
        ],
      });
    if (url === "/api/sandboxes") {
      if (opts.sandboxes === "404") return json({ error: "not found" }, 404);
      if (opts.sandboxes === "fail") return new Response("<html>nope</html>", { status: 500 });
      return json({ sandboxes });
    }
    return json({ ok: true });
  });
}

async function settle(el: Element) {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
}

async function mount(tag: string): Promise<ShadowRoot> {
  const el = document.createElement(tag);
  document.body.append(el);
  await settle(el);
  return el.shadowRoot as ShadowRoot;
}

const type = async (host: ShadowRoot, input: Element, value: string) => {
  (input as HTMLInputElement).value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(host.host);
};

/** Opens a project's editor (one is open at a time; a wide screen starts with the first open). */
async function openProject(root: ShadowRoot, id: string): Promise<HTMLElement> {
  const card = root.querySelector(`section[aria-label="${id}"]`) as HTMLElement;
  const toggle = card.querySelector(".toggle") as HTMLButtonElement;
  if (toggle.getAttribute("aria-expanded") !== "true") {
    toggle.click();
    await settle(root.host);
  }
  return card;
}

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("defaults", () => {
  it("match the core's project policy", () => {
    expect(policyDefaults).toEqual({
      mode: defaultProjectPolicy.mode,
      protectedPaths: defaultProjectPolicy.protectedPaths,
      followUpsPerDay: defaultProjectPolicy.followUpsPerDay,
      autoRelease: defaultProjectPolicy.autoRelease,
    });
  });
});

describe("teams", () => {
  it("lists each team with its members and sandbox size", async () => {
    serve();
    const root = await mount("inc-setup-teams");
    const cards = [...root.querySelectorAll("section.card")];
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Engineering", "Home"]);
    expect(cards[0]?.textContent).toContain("Ada, Juno");
    const sizes = (c: Element | undefined) => [...(c?.querySelectorAll("input") ?? [])].map((i) => i.value);
    expect(sizes(cards[0])).toEqual(["4", "8"]);
    expect(sizes(cards[1])).toEqual([String(defaultSandbox.cpus), "12"]);
    expect(cards[1]?.textContent).toContain("No members yet");
  });

  it("saves the new size with the team's name and members", async () => {
    serve();
    const root = await mount("inc-setup-teams");
    const card = root.querySelector("section.card") as HTMLElement;
    expect(button(card, "Save size").disabled).toBe(true);
    await type(root, card.querySelectorAll("input")[0] as Element, "8");
    await type(root, card.querySelectorAll("input")[1] as Element, "16");
    button(card, "Save size").click();
    await settle(root.host);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/teams/engineering");
    expect(put?.body).toEqual({
      name: "Engineering",
      members: ["ada", "juno"],
      sandbox: { cpus: 8, memory: "16G" },
    });
    expect(root.textContent).toContain("Saved");
  });
});

describe("projects", () => {
  it("lists collapsed rows with name, repo and mode, and opens one editor at a time", async () => {
    serve();
    const root = await mount("inc-setup-projects");
    const rows = [...root.querySelectorAll(".toggle")];
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual(["Duet", "bare"]);
    expect(rows.map((r) => r.querySelector(".sub")?.textContent)).toEqual(["demo/duet", "demo/bare"]);
    expect(rows.map((r) => r.querySelector(".chip")?.textContent)).toEqual(["Owner merges", "Direct"]);

    // Close whatever a wide screen opened, then open each in turn.
    for (const r of rows) if (r.getAttribute("aria-expanded") === "true") (r as HTMLElement).click();
    await settle(root.host);
    expect(root.querySelectorAll(".editor").length).toBe(0);

    const values = (c: HTMLElement, sel: string) =>
      [...c.querySelectorAll(sel)].map((i) => (i as HTMLInputElement).value);
    const duet = await openProject(root, "Duet");
    expect(values(duet, "input.mono")).toEqual([
      "demo/duet",
      ".github/",
      "docs/",
      "pnpm install",
      "pnpm test",
    ]);
    expect(duet.querySelector('[aria-pressed="true"]')?.textContent).toBe("Owner merges");

    const bare = await openProject(root, "bare");
    expect(root.querySelectorAll(".editor").length).toBe(1);
    expect(duet.querySelector(".editor")).toBeNull();
    expect(bare.querySelector('[aria-pressed="true"]')?.textContent).toBe("Direct");
    expect(values(bare, "input.mono")).toEqual(["demo/bare", ...policyDefaults.protectedPaths, "make"]);
    expect(values(bare, 'input[type="number"]')).toEqual([String(policyDefaults.followUpsPerDay)]);
  });

  it("keeps an unsaved edit when its row is closed", async () => {
    serve();
    const root = await mount("inc-setup-projects");
    const card = await openProject(root, "Duet");
    await type(root, card.querySelector("input.mono") as Element, "demo/other");
    (card.querySelector(".toggle") as HTMLElement).click();
    await settle(root.host);
    expect(card.querySelector(".editor")).toBeNull();
    expect(card.querySelector(".sub")?.textContent).toBe("demo/other");
    expect(card.textContent).toContain("Unsaved");
  });

  it("saves what was edited as one PUT", async () => {
    serve();
    const root = await mount("inc-setup-projects");
    const card = await openProject(root, "Duet");
    expect(button(card, "Save").disabled).toBe(true);
    button(card, "Direct").click();
    await settle(root.host);
    await type(root, card.querySelector('input[type="number"]') as Element, "5");
    // Drop "docs/", add a command, and move it above the install step.
    (card.querySelector('[aria-label="Remove path 2"]') as HTMLElement).click();
    await settle(root.host);
    button(card, "Add command").click();
    await settle(root.host);
    await type(root, card.querySelector('[aria-label="command 3"]') as Element, "pnpm check");
    (card.querySelector('[aria-label="Move command 3 up"]') as HTMLElement).click();
    await settle(root.host);
    (card.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await settle(root.host);
    button(card, "Save").click();
    await settle(root.host);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/projects/Duet");
    expect(put?.body).toEqual({
      repo: "demo/duet",
      checks: ["pnpm install", "pnpm check", "pnpm test"],
      mode: "direct",
      protectedPaths: [".github/"],
      followUpsPerDay: 5,
      autoRelease: true,
    });
    expect(root.textContent).toContain("Saved");
  });

  it("refuses an empty recipe without calling the daemon", async () => {
    serve();
    const root = await mount("inc-setup-projects");
    const card = await openProject(root, "Duet");
    (card.querySelector('[aria-label="Remove command 1"]') as HTMLElement).click();
    await settle(root.host);
    (card.querySelector('[aria-label="Remove command 1"]') as HTMLElement).click();
    await settle(root.host);
    button(card, "Save").click();
    await settle(root.host);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("at least one command");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows the daemon's complaint and keeps the edit", async () => {
    serve({ putFails: "repo must be owner/name on GitHub" });
    const root = await mount("inc-setup-projects");
    const card = await openProject(root, "Duet");
    await type(root, card.querySelector("input.mono") as Element, "demo/other");
    button(card, "Save").click();
    await settle(root.host);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("owner/name");
    expect((root.querySelector("input.mono") as HTMLInputElement).value).toBe("demo/other");
  });
});

describe("engines and accounts", () => {
  it("lists engines with harness and a local badge, the account each uses, and the cap", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const rows = [...root.querySelectorAll(".engines li")];
    expect(rows.map((r) => r.getAttribute("title"))).toEqual([
      "Claude Opus · claude-code",
      "qwen3 · opencode · local",
    ]);
    expect([...(rows[1]?.querySelectorAll(".chip") ?? [])].map((c) => c.textContent)).toEqual(["local"]);
    expect(rows[0]?.querySelector(".chip")).toBeNull();
    expect(rows[0]?.textContent).toContain("Claude Pro");
    const cap = root.querySelector('input[aria-label="Monthly cap for Claude Pro"]') as HTMLInputElement;
    expect(cap.value).toBe("50");
  });

  it("adds an engine with the chosen account", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an engine"]') as HTMLElement;
    await type(root, form.querySelector('[name="engine-id"]') as Element, "flash");
    await type(root, form.querySelector('[name="engine-model"]') as Element, "Gemini Flash");
    const harness = form.querySelector('[name="engine-harness"]') as HTMLSelectElement;
    harness.value = "antigravity";
    harness.dispatchEvent(new Event("change", { bubbles: true }));
    const account = form.querySelector('[name="engine-account"]') as HTMLSelectElement;
    account.value = "local";
    account.dispatchEvent(new Event("change", { bubbles: true }));
    (form.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await settle(root.host);
    button(form, "Add engine").click();
    await settle(root.host);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/engines/flash");
    expect(put?.body).toEqual({
      harness: "antigravity",
      model: "Gemini Flash",
      accountId: "local",
      local: true,
    });
  });

  it("adds an account, and saves a cap without losing the fee", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an account"]') as HTMLElement;
    await type(root, form.querySelector('[name="account-id"]') as Element, "google-ai-pro");
    await type(root, form.querySelector('[name="account-name"]') as Element, "Google AI Pro");
    await type(root, form.querySelector('[name="account-fee"]') as Element, "20");
    button(form, "Add account").click();
    await settle(root.host);
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      url: "/api/accounts/google-ai-pro",
      body: { name: "Google AI Pro", monthlyFee: 20 },
    });

    calls = [];
    const cap = root.querySelector('input[aria-label="Monthly cap for Claude Pro"]') as Element;
    await type(root, cap, "75");
    button(root, "Save cap").click();
    await settle(root.host);
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      url: "/api/accounts/claude-pro",
      body: { name: "Claude Pro", monthlyFee: 20, monthlyCap: 75 },
    });
  });

  it("rejects a bad id before calling the daemon", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an engine"]') as HTMLElement;
    await type(root, form.querySelector('[name="engine-id"]') as Element, "Not Valid");
    button(form, "Add engine").click();
    await settle(root.host);
    expect(form.querySelector('[role="alert"]')?.textContent).toContain("lowercase");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("sandboxes", () => {
  it("shows each sandbox's state and which subscriptions are signed in", async () => {
    serve();
    const root = await mount("inc-setup-sandboxes");
    const [eng] = [...root.querySelectorAll("section.card")];
    expect(eng?.querySelector(".chip")?.textContent).toBe("Running");
    expect(eng?.textContent).toContain("4 CPUs · 8G");
    expect([...(eng?.querySelectorAll(".subs li") ?? [])].map((l) => l.textContent)).toEqual([
      "Claude: signed in",
      "Antigravity: not signed in",
      "GitHub: signed in",
    ]);
  });

  it("shows an error state as an error", async () => {
    serve();
    const root = await mount("inc-setup-sandboxes");
    const home = root.querySelector('section[aria-label="inc-home"]') as HTMLElement;
    expect(home.querySelector(".chip")?.textContent).toBe("Error");
    expect(home.querySelector(".chip")?.classList.contains("alarm")).toBe(true);
    expect(home.querySelector('[role="alert"]')?.textContent).toContain("error state");
  });

  it.each(["404", "fail"] as const)("falls back to a quiet line when the request is %s", async (mode) => {
    serve({ sandboxes: mode });
    const root = await mount("inc-setup-sandboxes");
    expect(root.textContent).toContain("Sandbox status isn't available yet");
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector("section.card")).toBeNull();
  });
});

describe("the Setup area", () => {
  it("is reachable from the nav and the More page, and shows the section in the address", async () => {
    serve();
    location.hash = "#/setup/projects";
    const root = await mount("inc-app");
    expect(root.querySelector("inc-setup")).not.toBeNull();
    const links = [...root.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
    expect(links).toContain("#/setup/teams");
    const setup = root.querySelector("inc-setup") as HTMLElement;
    const tabs = [...(setup.shadowRoot?.querySelectorAll("nav a") ?? [])];
    expect(tabs.map((a) => a.textContent)).toEqual([
      "Teams",
      "Projects",
      "Engines and accounts",
      "Sandboxes",
    ]);
    expect(tabs.find((a) => a.getAttribute("aria-current") === "page")?.textContent).toBe("Projects");
    expect(setup.shadowRoot?.querySelector("inc-setup-projects")).not.toBeNull();

    location.hash = "#/more";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle(root.host);
    expect([...root.querySelectorAll(".more a")].map((a) => a.getAttribute("href"))).toContain(
      "#/setup/teams",
    );
    location.hash = "";
  });
});
