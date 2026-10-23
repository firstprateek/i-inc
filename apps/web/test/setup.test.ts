// The Setup screens against a fake API: each section renders from it, and saving sends the right PUT.
import { defaultProjectPolicy } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/app.ts";
import "../src/components/group-projects.ts";
import "../src/components/setup.ts";
import { defaultSandbox, type Project, policyDefaults, type Sandbox, type Team } from "../src/setup-api.ts";

let calls: { method: string; url: string; body: unknown }[] = [];
/** The headers of each PUT, in order. */
let putHeaders: Record<string, string>[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const engines = [
  { id: "opus", harness: "claude-code", model: "Claude Opus", accountId: "claude-pro", local: false },
  { id: "qwen", harness: "opencode", model: "qwen3", accountId: "local", local: true },
  { id: "codex-main", harness: "codex", model: "owner-entered-model", accountId: "codex-pro", local: true },
];
const accounts = [
  { id: "claude-pro", name: "Claude Pro", monthlyFee: 20, monthlyCap: 50 },
  { id: "codex-pro", name: "Codex subscription" },
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
    reason:
      "Apple container service is not responding — start the container service on the Mac mini: container system start",
    retryAt: 1700000000000,
  },
];

function serve(
  opts: {
    sandboxes?: "ok" | "404" | "fail";
    codexSignedIn?: boolean;
    staleLauncher?: boolean;
    putFails?: string;
    githubReposFails?: boolean;
  } = {},
) {
  calls = [];
  putHeaders = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PUT") putHeaders.push((init?.headers ?? {}) as Record<string, string>);
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "PUT" && opts.putFails) return json({ error: opts.putFails }, 400);
    if (url === "/api/teams") return json({ teams });
    if (url === "/api/projects") return json({ projects });
    if (url === "/api/engines") return json({ engines });
    if (url === "/api/accounts") return json({ accounts, rateLimits: {} });
    if (url === "/api/employees")
      return json({
        employees: [
          { id: "ada", name: "Ada", role: "Senior Engineer" },
          { id: "juno", name: "Juno", role: "Staff Engineer" },
          { id: "nell", name: "Nell", role: "Product Manager" },
          { id: "pat", name: "Pat", role: "Personal Assistant" },
        ],
      });
    if (url === "/api/office")
      return json({
        employees: [
          { id: "ada", name: "Ada" },
          { id: "juno", name: "Juno" },
        ],
      });
    if (url === "/api/github/repos") {
      if (opts.githubReposFails) {
        return json({ error: "GitHub integration error", repos: [] }, 502);
      }
      return json({
        repos: [
          {
            fullName: "firstprateek/my-service",
            name: "my-service",
            owner: "firstprateek",
            private: true,
            defaultBranch: "main",
            description: "A service",
            language: "TypeScript",
            empty: false,
            pushedAt: "2026-10-18T00:00:00Z",
            alreadyRegistered: false,
          },
        ],
      });
    }
    if (url.startsWith("/api/github/repos/") && url.endsWith("/inspect"))
      return json({
        id: "My Service",
        repo: "firstprateek/my-service",
        defaultBranch: "main",
        empty: false,
        checks: ["pnpm install --frozen-lockfile", "pnpm test"],
        protectedPaths: ["package.json"],
        detected: "node",
      });
    if (url.startsWith("/api/projects/") && url.endsWith("/bootstrap"))
      return json(
        { project: { id: "My Service", repo: "firstprateek/my-service" }, bootstrapped: true, commits: 1 },
        201,
      );
    if (url === "/api/sandboxes") {
      if (opts.sandboxes === "404") return json({ error: "not found" }, 404);
      if (opts.sandboxes === "fail") return new Response("<html>nope</html>", { status: 500 });
      let rows = opts.codexSignedIn
        ? sandboxes.map((s, i) => (i === 0 ? { ...s, signedIn: { ...s.signedIn, codex: true } } : s))
        : sandboxes;
      if (opts.staleLauncher)
        rows = rows.map((s, i) => (i === 0 ? { ...s, launcher: "needs-update" as const } : s));
      return json({ sandboxes: rows });
    }
    if (url.startsWith("/api/sandboxes/") && url.endsWith("/retry") && method === "POST") {
      const team = url.slice("/api/sandboxes/".length, -"/retry".length);
      return json({
        ok: true,
        sandbox: {
          team,
          machine: `inc-${team}`,
          state: "running",
          cpus: 6,
          memory: "12G",
          signedIn: { claude: true, antigravity: false, github: false },
        },
      });
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
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Engineering", "Home", "Make a team"]);
    expect(cards[0]?.textContent).toContain("Ada, Juno");
    const sizes = (c: Element | undefined) =>
      [...(c?.querySelectorAll('input[type="number"]') ?? [])].map((i) => (i as HTMLInputElement).value);
    expect(sizes(cards[0])).toEqual(["4", "8"]);
    expect(sizes(cards[1])).toEqual([String(defaultSandbox.cpus), "12"]);
    expect(cards[1]?.textContent).toContain("No members yet");
  });

  it("saves the new size with the team's name and members", async () => {
    serve();
    const root = await mount("inc-setup-teams");
    const card = root.querySelector("section.card") as HTMLElement;
    expect(button(card, "Save size").disabled).toBe(true);
    await type(root, card.querySelectorAll('input[type="number"]')[0] as Element, "8");
    await type(root, card.querySelectorAll('input[type="number"]')[1] as Element, "16");
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

  it("makes a team from a name, with the people picked, create-only", async () => {
    serve();
    const root = await mount("inc-setup-teams");
    const form = root.querySelector('section[aria-label="Make a team"]') as HTMLElement;
    // a personal assistant works on home data and has a sandbox of its own: never offered
    const offered = [...form.querySelectorAll('input[name="team-member"]')].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(offered).toEqual(["ada", "juno", "nell"]);
    await type(root, form.querySelector('[name="team-name"]') as Element, "Design Crew");
    const nell = form.querySelector('input[name="team-member"][value="nell"]') as HTMLInputElement;
    nell.click();
    await settle(root.host);
    button(form, "Make team").click();
    await settle(root.host);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/teams/design-crew");
    expect(put?.body).toEqual({ name: "Design Crew", members: ["nell"] });
    expect(putHeaders[0]).toMatchObject({ "if-none-match": "*" });
    expect(root.textContent).toContain("Made Design Crew");
  });

  it("refuses a name that is a team already, without asking the daemon", async () => {
    serve();
    const root = await mount("inc-setup-teams");
    const form = root.querySelector('section[aria-label="Make a team"]') as HTMLElement;
    await type(root, form.querySelector('[name="team-name"]') as Element, "engineering");
    button(form, "Make team").click();
    await settle(root.host);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(form.textContent).toContain("There is already a team called Engineering");
  });

  it("changes who works in a team, keeping a home employee it holds", async () => {
    serve();
    const root = await mount("inc-setup-teams");
    const card = root.querySelector('section[aria-label="Engineering"]') as HTMLElement;
    expect(button(card, "Save people").disabled).toBe(true);
    const nell = [...card.querySelectorAll('input[type="checkbox"]')].find((i) =>
      i.parentElement?.textContent?.includes("Nell"),
    ) as HTMLInputElement;
    nell.click();
    await settle(root.host);
    button(card, "Save people").click();
    await settle(root.host);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/teams/engineering");
    expect(put?.body).toMatchObject({ name: "Engineering", members: ["ada", "juno", "nell"] });
    expect(putHeaders[0]?.["if-none-match"]).toBeUndefined();
  });
});

describe("projects", () => {
  it("treats a GitHub problem (424, 429) as an answer, but a 502 from a proxy as the daemon being down", async () => {
    const { send } = await import("../src/api.ts");
    const { isOffline, report } = await import("../src/connection.ts");

    for (const status of [424, 429]) {
      vi.stubGlobal(
        "fetch",
        async () => new Response(JSON.stringify({ error: "Upstream failure" }), { status }),
      );
      expect((await send("/api/github/repos")).status).toBe(status);
      expect(isOffline()).toBe(false);
    }

    // The daemon never sends 502-504 for GitHub, so one on a GitHub route is a gateway with nothing behind it.
    vi.stubGlobal("fetch", async () => new Response("Bad gateway", { status: 502 }));
    await send("/api/github/repos");
    expect(isOffline()).toBe(true);
    report(true);
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
      "owner-entered-model · codex",
    ]);
    expect([...(rows[1]?.querySelectorAll(".chip") ?? [])].map((c) => c.textContent)).toEqual(["local"]);
    expect(rows[0]?.querySelector(".chip")).toBeNull();
    expect(rows[2]?.querySelector(".chip")).toBeNull();
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

  it("adds a Codex engine to its account and never marks it local", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an engine"]') as HTMLElement;
    await type(root, form.querySelector('[name="engine-id"]') as Element, "codex-new");
    await type(root, form.querySelector('[name="engine-model"]') as Element, "owner-entered-model");
    const harness = form.querySelector('[name="engine-harness"]') as HTMLSelectElement;
    harness.value = "opencode";
    harness.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(root.host);
    const local = form.querySelector('input[type="checkbox"]') as HTMLInputElement;
    local.click();
    await settle(root.host);
    expect(local.checked).toBe(true);
    harness.value = "codex";
    harness.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(root.host);
    const account = form.querySelector('[name="engine-account"]') as HTMLSelectElement;
    account.value = "codex-pro";
    account.dispatchEvent(new Event("change", { bubbles: true }));
    expect(local.disabled).toBe(true);
    expect(local.checked).toBe(false);
    await settle(root.host);
    button(form, "Add engine").click();
    await settle(root.host);
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      url: "/api/engines/codex-new",
      body: { harness: "codex", model: "owner-entered-model", accountId: "codex-pro", local: false },
    });
  });

  it("refuses to add an engine whose id is taken, and says what is there", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an engine"]') as HTMLElement;
    await type(root, form.querySelector('[name="engine-id"]') as Element, "opus");
    await type(root, form.querySelector('[name="engine-model"]') as Element, "oops-overwritten");
    button(form, "Add engine").click();
    await settle(root.host);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    const text = form.textContent ?? "";
    expect(text).toContain("There is already an engine called opus (Claude Opus on claude-code)");
    expect(text).not.toContain("Added");
    // what was typed stays
    expect((form.querySelector('[name="engine-model"]') as HTMLInputElement).value).toBe("oops-overwritten");
  });

  it("adds an engine create-only, so a race can't replace one either, and shows the daemon's refusal", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an engine"]') as HTMLElement;
    await type(root, form.querySelector('[name="engine-id"]') as Element, "fresh");
    await type(root, form.querySelector('[name="engine-model"]') as Element, "Some Model");
    button(form, "Add engine").click();
    await settle(root.host);
    expect(putHeaders[0]).toMatchObject({ "if-none-match": "*" });
    // the daemon says it exists (added by someone else a moment ago): 412, and nothing says "Added"
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? json(
            { error: "an engine called fresh already exists (Some Model on claude-code): pick another id" },
            412,
          )
        : json({ engines, accounts, rateLimits: {} }),
    );
    await type(root, form.querySelector('[name="engine-id"]') as Element, "fresher");
    await type(root, form.querySelector('[name="engine-model"]') as Element, "Another");
    button(form, "Add engine").click();
    await settle(root.host);
    expect(form.textContent).toContain("already exists");
    expect(form.textContent).not.toContain("Added Another");
  });

  it("refuses to add an account whose id is taken", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an account"]') as HTMLElement;
    await type(root, form.querySelector('[name="account-id"]') as Element, "claude-pro");
    await type(root, form.querySelector('[name="account-name"]') as Element, "Different");
    button(form, "Add account").click();
    await settle(root.host);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(form.textContent).toContain("There is already an account called claude-pro (Claude Pro)");
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
    // adding is create-only; saving a cap below is an update
    expect(putHeaders[0]).toMatchObject({ "if-none-match": "*" });

    calls = [];
    putHeaders = [];
    const cap = root.querySelector('input[aria-label="Monthly cap for Claude Pro"]') as Element;
    await type(root, cap, "75");
    button(root, "Save cap").click();
    await settle(root.host);
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      url: "/api/accounts/claude-pro",
      body: { name: "Claude Pro", monthlyFee: 20, monthlyCap: 75 },
    });
    expect(putHeaders[0]?.["if-none-match"]).toBeUndefined();
  });

  it("adds a Codex subscription account without asking for credentials", async () => {
    serve();
    const root = await mount("inc-setup-engines");
    const form = root.querySelector('section[aria-label="Add an account"]') as HTMLElement;
    await type(root, form.querySelector('[name="account-id"]') as Element, "codex-subscription");
    await type(root, form.querySelector('[name="account-name"]') as Element, "Codex subscription");
    button(form, "Add account").click();
    await settle(root.host);
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      url: "/api/accounts/codex-subscription",
      body: { name: "Codex subscription" },
    });
    expect(form.querySelector('input[type="password"]')).toBeNull();
    expect(form.textContent).not.toMatch(/token|secret|password/i);
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
      "Codex: not signed in",
    ]);
    expect(root.textContent).toContain("sh tools/host/sign-in-codex.sh engineering");
    expect(root.querySelector('a[href*="docs/codex.md"]')?.textContent).toBe("Owner sign-in instructions");
  });

  it("shows Codex signed in when the optional status is true", async () => {
    serve({ codexSignedIn: true });
    const root = await mount("inc-setup-sandboxes");
    const [engineering] = [...root.querySelectorAll("section.card")];
    expect(engineering?.textContent).toContain("Codex: signed in");
    expect(engineering?.textContent).not.toContain("sign-in-codex.sh");
  });

  it("says which sandbox needs its launcher updated, and how", async () => {
    serve({ staleLauncher: true });
    const root = await mount("inc-setup-sandboxes");
    const [engineering, other] = [...root.querySelectorAll("section.card")];
    expect(engineering?.querySelector(".launcher-help")?.textContent).toContain(
      "Needs update: run sh tools/host/update-machine.sh engineering",
    );
    expect(other?.querySelector(".launcher-help")).toBeNull();
  });

  it("shows an error state as an error with reason and Retry now button", async () => {
    serve();
    const root = await mount("inc-setup-sandboxes");
    const home = root.querySelector('section[aria-label="inc-home"]') as HTMLElement;
    expect(home.querySelector(".chip")?.textContent).toBe("Error");
    expect(home.querySelector(".chip")?.classList.contains("alarm")).toBe(true);
    expect(home.querySelector('[role="alert"]')?.textContent).toContain(
      "Apple container service is not responding",
    );

    const retryBtn = home.querySelector(".actions button") as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent?.trim()).toBe("Retry now");

    retryBtn.click();
    await settle(root.host);

    expect(calls).toContainEqual(
      expect.objectContaining({ method: "POST", url: "/api/sandboxes/home/retry" }),
    );
    expect(home.querySelector(".chip")?.textContent).toBe("Running");
  });

  it.each(["404", "fail"] as const)("falls back to a quiet line when the request is %s", async (mode) => {
    serve({ sandboxes: mode });
    const root = await mount("inc-setup-sandboxes");
    expect(root.textContent).toContain("Sandbox status isn't available yet");
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector("section.card")).toBeNull();
  });
});

describe("Company → Settings and Projects", () => {
  it("has Projects as its own Company tab and four sections under Settings, shown in the address", async () => {
    serve();
    location.hash = "#/company/settings/engines";
    const root = await mount("inc-app");
    expect(root.querySelector("inc-setup")).not.toBeNull();
    const companyTabs = [...root.querySelectorAll('[role="tablist"] a')];
    expect(companyTabs.map((a) => a.textContent?.trim())).toEqual([
      "Team",
      "Brain",
      "Projects",
      "Usage",
      "Settings",
    ]);
    expect(companyTabs.find((a) => a.getAttribute("aria-selected") === "true")?.textContent?.trim()).toBe(
      "Settings",
    );
    const setup = root.querySelector("inc-setup") as HTMLElement;
    const tabs = [...(setup.shadowRoot?.querySelectorAll("nav a") ?? [])];
    expect(tabs.map((a) => a.textContent)).toEqual([
      "Teams",
      "Engines and accounts",
      "Sandboxes",
      "Notifications",
    ]);
    expect(tabs.map((a) => a.getAttribute("href"))).toEqual([
      "#/company/settings/teams",
      "#/company/settings/engines",
      "#/company/settings/sandboxes",
      "#/company/settings/notifications",
    ]);
    expect(tabs.find((a) => a.getAttribute("aria-current") === "page")?.textContent).toBe(
      "Engines and accounts",
    );
    expect(setup.shadowRoot?.querySelector("inc-setup-engines")).not.toBeNull();

    location.hash = "#/company/projects";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await settle(root.host);
    expect(root.querySelector("inc-setup-projects")).not.toBeNull();
    expect(root.querySelector("inc-setup")).toBeNull();
    expect(
      [...root.querySelectorAll('[role="tablist"] a')]
        .find((a) => a.getAttribute("aria-selected") === "true")
        ?.textContent?.trim(),
    ).toBe("Projects");
    location.hash = "";
  });
});
