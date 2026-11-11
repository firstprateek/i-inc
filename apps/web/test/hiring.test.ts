// Hiring and editing: three choices on top (name, role, engine) with projects and working hours, the rest
// folded under More settings; the engine pickers show harness and "local", and saving sends engines per duty.
import type { Employee } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/hiring.ts";
import { standardRoles } from "../src/components/hiring.ts";
import type { Engine } from "../src/providers.ts";

const engines: Engine[] = [
  { id: "opus", harness: "claude-code", model: "Claude Opus", accountId: "claude-pro", local: false },
  { id: "gemini", harness: "antigravity", model: "Gemini Pro", accountId: "google", local: false },
  { id: "qwen", harness: "opencode", model: "qwen3", accountId: "local", local: true },
  { id: "codex", harness: "codex", model: "owner-entered-model", accountId: "codex-pro", local: true },
];

const projects = [{ id: "listy" }, { id: "website" }, { id: "Duet" }];

const ada: Employee = {
  id: "ada",
  name: "Ada",
  role: "Senior Engineer",
  duties: ["build", "review", "verify"],
  engines: { default: "opus", perDuty: { review: "gemini" }, fallbacks: ["qwen"] },
  switchRules: { outOfTokens: { action: "wait" }, checksFailedBeforeSwitch: 5, onStuck: "switch" },
};

let calls: { method: string; url: string; body: unknown }[] = [];

function serve(
  team: Employee[] = [ada],
  failEmployees = false,
  configuredTeams: { id: string; name: string; members: string[] }[] = [],
  available: Engine[] = engines,
) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/engines" && (init?.method ?? "GET") === "GET") return json({ engines: available });
    if (url === "/api/projects") return json({ projects });
    if (url === "/api/teams") return json({ teams: configuredTeams });
    if (url === "/api/employees" && (init?.method ?? "GET") === "GET")
      return failEmployees ? json({ error: "nope" }, 500) : json({ employees: team });
    return json({ ok: true });
  });
}

async function settle(el: Element) {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
}

async function mount(employeeId?: string): Promise<ShadowRoot> {
  const el = document.createElement("inc-hiring") as HTMLElement & { employeeId?: string };
  if (employeeId) el.employeeId = employeeId;
  document.body.append(el);
  await settle(el);
  return el.shadowRoot as ShadowRoot;
}

const selects = (root: ShadowRoot) => [...root.querySelectorAll("select")] as HTMLSelectElement[];
const pick = async (root: ShadowRoot, sel: HTMLSelectElement, value: string) => {
  sel.value = value;
  sel.dispatchEvent(new Event("change"));
  await settle(root.host);
};
const submit = async (root: ShadowRoot) => {
  (root.querySelector("form") as HTMLFormElement).dispatchEvent(
    new Event("submit", { cancelable: true, bubbles: true }),
  );
  await settle(root.host);
};
const typeName = async (root: ShadowRoot, value: string) => {
  const name = root.querySelector('input[type="text"]') as HTMLInputElement;
  name.value = value;
  name.dispatchEvent(new Event("input"));
  await settle(root.host);
};
const hireButton = (root: ShadowRoot) =>
  root.querySelector('.submit button[type="submit"]') as HTMLButtonElement;
const posted = () =>
  calls.find((c) => c.method === "POST" && c.url === "/api/employees")?.body as Record<string, unknown>;

beforeEach(() => {
  document.body.innerHTML = "";
  location.hash = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("hiring in three choices", () => {
  it("lists the spec's roles, Senior Engineer first and chosen, with no CEO", async () => {
    expect([...standardRoles]).toEqual([
      "Senior Engineer",
      "Staff Engineer",
      "Principal Engineer",
      "Product Manager",
      "UX Designer",
      "QA",
      "Personal Assistant",
    ]);
    serve();
    const root = await mount();
    const pills = [...root.querySelectorAll('[aria-labelledby="role-name"] .pill')];
    expect(pills.map((b) => b.textContent?.trim())).toEqual([...standardRoles, "Write a role…"]);
    expect(pills[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(root.textContent).not.toContain("CEO");
  });

  it("starts on an engine, so a name is all Hire waits for", async () => {
    serve();
    const root = await mount();
    expect(selects(root)[0]?.value).toBe("opus");
    expect(hireButton(root).disabled).toBe(true);
    await typeName(root, "Nova");
    expect(hireButton(root).disabled).toBe(false);
    expect(hireButton(root).textContent?.trim()).toBe("Hire Nova");
    await submit(root);
    expect(posted()).toMatchObject({
      name: "Nova",
      role: "Senior Engineer",
      engines: { default: "opus", fallbacks: [] },
    });
  });

  it("preselects the first engine that isn't a local model, whatever the list's order", async () => {
    serve([ada], false, [], [engines[2], engines[1], engines[0]] as Engine[]);
    const root = await mount();
    expect(selects(root)[0]?.value).toBe("gemini");
  });

  it("folds the rest under More settings, closed, holding the duties and the engine per duty", async () => {
    serve();
    const root = await mount();
    const more = root.querySelector("details.more") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.querySelector("summary")?.textContent?.trim()).toBe("More settings");
    const summary = more.querySelector("summary") as HTMLElement;
    expect(summary.closest("form")).not.toBeNull();
    expect(more.querySelector("fieldset.duty-set legend")?.textContent).toBe("Duties");
    expect(more.querySelector("fieldset.duties legend")?.textContent).toBe("Engine per duty");
    expect(more.querySelector("textarea")).not.toBeNull();
    const top = root.querySelector("section.card") as HTMLElement;
    expect(top.querySelector('input[type="checkbox"][name^="duty-"]')).toBeNull();
    expect(top.querySelector("textarea")).toBeNull();
  });

  it("uses the spec's words in More settings and no explanatory paragraphs", async () => {
    serve();
    const root = await mount();
    const more = root.querySelector("details.more") as HTMLElement;
    const text = more.textContent ?? "";
    for (const words of [
      "Duties",
      "Engine per duty",
      "If it runs out of tokens or gets stuck",
      "Default effort",
      "Role prompt",
      "Reset to the role's default",
    ]) {
      expect(text).toContain(words);
    }
    const duties = [...more.querySelectorAll(".duty-title")].map((t) => t.textContent?.trim());
    expect(duties).toEqual(["Plan", "Build", "Prove", "Review", "Librarian"]);
    expect(more.querySelector('input[name="duty-verify"]')).not.toBeNull();
    const efforts = [...more.querySelectorAll('.pill[role="radio"]')].map((b) => b.textContent?.trim());
    expect(efforts).toEqual(["Low", "Medium", "High"]);
    expect(root.querySelector(".duty-explainer")).toBeNull();
    expect(root.querySelector(".switching-explainer")).toBeNull();
    expect(root.textContent).not.toMatch(/How pipeline duties work|Model Switching Rules|System prompt/);
  });

  it("links to Settings to add an engine instead of an engine creator", async () => {
    serve();
    const root = await mount();
    const link = [...root.querySelectorAll("a")].find((a) => a.textContent === "Add an engine in Settings");
    expect(link?.getAttribute("href")).toBe("#/company/settings/engines");
    expect(root.querySelector(".custom-engine-box")).toBeNull();
    expect(root.textContent).not.toContain("Configure new engine");
  });

  it("doesn't list the team: that is on Team", async () => {
    serve();
    const root = await mount();
    expect(root.querySelector('[aria-label="Your team"]')).toBeNull();
    expect(root.querySelector('a[href="#/company/team/hiring/ada"]')).toBeNull();
  });

  it("sends the ticked projects' ids, in the company's order", async () => {
    serve();
    const root = await mount();
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[name="project"]')];
    expect(boxes.map((b) => b.value)).toEqual(["listy", "website", "Duet"]);
    expect(boxes.every((b) => !b.checked)).toBe(true);
    await typeName(root, "Juno");
    for (const id of ["website", "listy"]) {
      const box = boxes.find((b) => b.value === id) as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    }
    await settle(root.host);
    await submit(root);
    expect(posted()).toMatchObject({ name: "Juno", projects: ["listy", "website"] });
  });

  it("leaves projects out when none is ticked, meaning every project", async () => {
    serve();
    const root = await mount();
    expect(root.textContent).toContain("None ticked: every project.");
    await typeName(root, "Juno");
    await submit(root);
    expect(posted()).not.toHaveProperty("projects");
  });

  it("shows Home for a personal assistant's projects, and no list", async () => {
    serve();
    const root = await mount();
    const pa = [...root.querySelectorAll(".pill")].find((b) => b.textContent === "Personal Assistant");
    (pa as HTMLElement).click();
    await settle(root.host);
    expect(root.querySelector('input[name="project"]')).toBeNull();
    expect(root.querySelector("section.card")?.textContent).toContain("Home");
    await typeName(root, "Pip");
    await submit(root);
    expect(posted()).not.toHaveProperty("projects");
  });

  it("sets working hours to nights only, or any time by default", async () => {
    serve();
    const root = await mount();
    await typeName(root, "Owl");
    const hours = [...root.querySelectorAll<HTMLButtonElement>('[aria-labelledby="hours-name"] .pill')];
    expect(hours.map((b) => b.textContent?.trim())).toEqual(["Any time", "Nights only (10 pm to 7 am)"]);
    expect(hours[0]?.getAttribute("aria-pressed")).toBe("true");
    hours[1]?.click();
    await settle(root.host);
    await submit(root);
    expect(posted()).toMatchObject({ workingHours: { from: 22, to: 7 } });
  });

  it("keeps the fieldsets inside their cards and gives phones 44px targets", () => {
    // jsdom has no layout, so this guards the rules.
    const ctor = customElements.get("inc-hiring") as unknown as { styles: Array<{ cssText?: string }> };
    const sheet = ctor.styles.map((x) => x.cssText ?? "").join("\n");
    expect(sheet).toMatch(/fieldset\s*\{[^}]*margin:\s*0;[^}]*min-width:\s*0/);
    expect(sheet).toMatch(/\.more > summary\s*\{[^}]*min-height:\s*44px/);
    const phone = sheet.match(/@media \(max-width: 900px\)\s*\{([^@]*)\}\s*$/)?.[1] ?? "";
    expect(phone).toMatch(/\.btn\.small\s*\{[^}]*min-height:\s*44px/);
    expect(phone).toMatch(/\.engine-link\s*\{[^}]*min-height:\s*44px/);
  });
});

describe("hiring", () => {
  it("offers every engine with its harness, and a local badge on local ones", async () => {
    serve();
    const root = await mount();
    const [def] = selects(root);
    const labels = [...(def?.querySelectorAll("option") ?? [])].map((o) => o.textContent?.trim());
    expect(labels).toContain("Claude Opus · claude-code");
    expect(labels).toContain("qwen3 · opencode · local");
    expect(labels).toContain("owner-entered-model · codex");

    await pick(root, def as HTMLSelectElement, "qwen");
    const chips = [...root.querySelectorAll(".engine-field .chips .chip")].map((c) => c.textContent);
    expect(chips).toEqual(["opencode", "local"]);
  });

  it("can hire with Codex as the engine, a per-duty engine, and the fallback", async () => {
    serve();
    const root = await mount();
    await typeName(root, "Nell");
    const [def, build, review, , fallback] = selects(root);
    await pick(root, def as HTMLSelectElement, "codex");
    await pick(root, build as HTMLSelectElement, "codex");
    await pick(root, review as HTMLSelectElement, "gemini");
    await pick(root, fallback as HTMLSelectElement, "qwen");
    await submit(root);
    expect(posted()).toMatchObject({
      name: "Nell",
      engines: { default: "codex", perDuty: { build: "codex", review: "gemini" }, fallbacks: ["qwen"] },
    });
  });

  it("has a picker per duty of the role, each defaulting to the engine", async () => {
    serve();
    const root = await mount();
    const legend = root.querySelector(".duties legend")?.textContent;
    expect(legend).toBe("Engine per duty");
    const names = [...root.querySelectorAll(".duties label")].map((l) =>
      l.querySelector("span")?.textContent?.trim(),
    );
    expect(names).toEqual(["Build", "Review", "Prove"]);
    expect(root.querySelector(".duties option")?.textContent).toBe("Same as the engine");
  });

  it("sends the default, the duty engines and the fallback", async () => {
    serve();
    const root = await mount();
    const [def, build, review, , fallback] = selects(root);
    await typeName(root, "Nell");
    await pick(root, def as HTMLSelectElement, "opus");
    await pick(root, build as HTMLSelectElement, "qwen");
    await pick(root, review as HTMLSelectElement, "gemini");
    await pick(root, fallback as HTMLSelectElement, "gemini");
    await submit(root);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/employees");
    expect(post?.body).toMatchObject({
      name: "Nell",
      duties: ["build", "review", "verify"],
      engines: { default: "opus", perDuty: { build: "qwen", review: "gemini" }, fallbacks: ["gemini"] },
    });
  });

  it("leaves perDuty out when every duty uses the default", async () => {
    serve();
    const root = await mount();
    await typeName(root, "Nell");
    await submit(root);
    const sent = posted() as { engines: object };
    expect(sent.engines).toEqual({ default: "opus", fallbacks: [] });
  });

  it("offers only local engines to a personal assistant, and starts on the first", async () => {
    serve();
    const root = await mount();
    const pa = [...root.querySelectorAll(".pill")].find((b) => b.textContent === "Personal Assistant");
    (pa as HTMLElement).click();
    await settle(root.host);
    const def = selects(root)[0] as HTMLSelectElement;
    expect([...def.querySelectorAll("option")].map((o) => o.value)).toEqual(["qwen"]);
    expect(def.value).toBe("qwen");
  });

  it("says no local engine is set up yet when a personal assistant has none to pick", async () => {
    serve(
      [ada],
      false,
      [],
      engines.filter((e) => !e.local),
    );
    const root = await mount();
    const pa = [...root.querySelectorAll(".pill")].find((b) => b.textContent === "Personal Assistant");
    (pa as HTMLElement).click();
    await settle(root.host);
    const ids = [...(selects(root)[0]?.querySelectorAll("option") ?? [])].map((o) => o.value);
    expect(ids).toEqual([""]);
    const notes = [...root.querySelectorAll(".note")].map((n) => n.textContent ?? "").join(" ");
    expect(notes).toContain("sandbox has no internet");
    expect(notes).toContain("No local engine is set up yet");
    await typeName(root, "Pip");
    expect(hireButton(root).disabled).toBe(true);
  });

  const pip: Employee = {
    ...ada,
    id: "pip",
    name: "Pip",
    role: "Personal Assistant",
    engines: { default: "qwen", fallbacks: [] },
  };
  const pickPa = async (root: ShadowRoot) => {
    const pa = [...root.querySelectorAll(".pill")].find((b) => b.textContent === "Personal Assistant");
    (pa as HTMLElement).click();
    await settle(root.host);
  };

  it("hires a personal assistant without a team: no picker, no teamId, whatever teams there are", async () => {
    for (const teams of [
      [{ id: "engineering", name: "Engineering", members: ["ada"] }],
      [
        { id: "engineering", name: "Engineering", members: ["ada"] },
        { id: "design", name: "Design", members: [] },
      ],
    ]) {
      document.body.innerHTML = "";
      serve([ada], false, teams);
      const root = await mount();
      expect(root.querySelector('select[aria-label="Team"]') !== null).toBe(teams.length > 1);
      await pickPa(root);
      expect(root.querySelector('select[aria-label="Team"]')).toBeNull();
      expect(root.textContent).toContain("sandbox of its own");
      await typeName(root, "Pip");
      // Several teams and none chosen: a normal hire is blocked, a PA's is not.
      expect(hireButton(root).disabled).toBe(false);
      await submit(root);
      const post = posted();
      expect(post).toMatchObject({ name: "Pip", role: "Personal Assistant" });
      expect(post).not.toHaveProperty("teamId");
    }
  });

  it("saves a personal assistant that still shares a team without sending the team", async () => {
    serve([ada, pip], false, [{ id: "engineering", name: "Engineering", members: ["ada", "pip"] }]);
    const root = await mount("pip");
    expect(root.querySelector('select[aria-label="Team"]')).toBeNull();
    await submit(root);
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/employees/pip");
    expect(put).toBeDefined();
    expect(put?.body).not.toHaveProperty("teamId");
  });

  it("doesn't count a personal assistant's home team as a second team", async () => {
    serve([ada, pip], false, [
      { id: "engineering", name: "Engineering", members: ["ada"] },
      { id: "home-pip", name: "Pip's home", members: ["pip"] },
    ]);
    const root = await mount();
    expect(root.querySelector('select[aria-label="Team"]')).toBeNull();
    await typeName(root, "Nell");
    expect(hireButton(root).disabled).toBe(false);
    await submit(root);
    expect(posted()).toMatchObject({ teamId: "engineering" });
  });

  it("shows no team picker for one team, and sends its id with the hire", async () => {
    serve([ada], false, [{ id: "engineering", name: "Engineering", members: ["ada"] }]);
    const root = await mount();
    expect(root.querySelector('select[aria-label="Team"]')).toBeNull();
    await typeName(root, "Nell");
    await submit(root);
    expect(posted()).toMatchObject({ teamId: "engineering" });
  });

  it("requires a team selection when multiple teams are available", async () => {
    serve([ada], false, [
      { id: "engineering", name: "Engineering", members: [] },
      { id: "design", name: "Design", members: [] },
    ]);
    const root = await mount();
    const team = root.querySelector('select[aria-label="Team"]') as HTMLSelectElement;
    expect(team).toBeTruthy();
    expect(team.value).toBe("");
    expect(team.querySelector('option[value=""]')?.textContent).toBe("Choose a team");
    await typeName(root, "Nell");
    expect(hireButton(root).disabled).toBe(true);
    await pick(root, team, "design");
    expect(hireButton(root).disabled).toBe(false);
    await submit(root);
    expect(posted()).toMatchObject({ teamId: "design" });
  });

  it("does not show the team picker when there are no configured teams", async () => {
    serve();
    const root = await mount();
    expect(root.querySelector('select[aria-label="Team"]')).toBeNull();
  });

  it("works when the team can't be fetched", async () => {
    serve([], true);
    const root = await mount();
    expect(selects(root).length).toBeGreaterThan(0);
    expect(root.querySelector('[aria-label="Your team"]')).toBeNull();
  });
});

describe("editing someone's engines", () => {
  it("shows what the employee has now, and the fallback's harness, with More settings open", async () => {
    serve();
    const root = await mount("ada");
    expect((root.querySelector("details.more") as HTMLDetailsElement).open).toBe(true);
    const [def, build, review, verify, fallback] = selects(root) as HTMLSelectElement[];
    expect(def?.value).toBe("opus");
    expect(build?.value).toBe("");
    expect(review?.value).toBe("gemini");
    expect(verify?.value).toBe("");
    expect(fallback?.value).toBe("qwen");
    const last = [...(fallback?.parentElement?.querySelectorAll(".chip") ?? [])].map((c) => c.textContent);
    expect(last).toEqual(["opencode", "local"]);
    expect(root.querySelector(".submit .btn")?.textContent?.trim()).toBe("Save engines");
  });

  it("PUTs only the engines, keeping the other fallbacks", async () => {
    serve([{ ...ada, engines: { ...ada.engines, fallbacks: ["qwen", "gemini"] } }]);
    const root = await mount("ada");
    const [, build] = selects(root);
    await pick(root, build as HTMLSelectElement, "qwen");
    await submit(root);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/employees/ada");
    expect(put?.body).toEqual({
      engines: {
        default: "opus",
        perDuty: { build: "qwen", review: "gemini" },
        fallbacks: ["qwen", "gemini"],
      },
    });
    expect(location.hash).toBe("#/company/team");
  });

  it("ticks the employee's projects and sends them when they change", async () => {
    serve([{ ...ada, projects: ["listy"] }]);
    const root = await mount("ada");
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[name="project"]')];
    expect(boxes.filter((b) => b.checked).map((b) => b.value)).toEqual(["listy"]);
    const duet = boxes.find((b) => b.value === "Duet") as HTMLInputElement;
    duet.checked = true;
    duet.dispatchEvent(new Event("change"));
    await settle(root.host);
    await submit(root);
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ projects: ["listy", "Duet"] });
  });

  it("preselects the current team and sends the new team when editing", async () => {
    serve([ada], false, [
      { id: "engineering", name: "Engineering", members: ["ada"] },
      { id: "product", name: "Product", members: [] },
    ]);
    const root = await mount("ada");
    const team = root.querySelector('select[aria-label="Team"]') as HTMLSelectElement;
    expect(team.value).toBe("engineering");
    await pick(root, team, "product");
    await submit(root);
    expect(
      calls.find((call) => call.method === "PUT" && call.url === "/api/employees/ada")?.body,
    ).toMatchObject({
      teamId: "product",
    });
    expect(calls.some((call) => call.method === "POST" && call.url === "/api/employees")).toBe(false);
  });

  it("clears a duty back to the default", async () => {
    serve();
    const root = await mount("ada");
    await pick(root, selects(root)[2] as HTMLSelectElement, "");
    await submit(root);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ engines: { default: "opus", fallbacks: ["qwen"] } });
  });
});

describe("roles, role prompts and effort", () => {
  it("hires a Principal Engineer with the role's prompt and duties", async () => {
    serve();
    const root = await mount();
    await typeName(root, "Lin");
    const principal = [...root.querySelectorAll(".pill")].find(
      (b) => b.textContent?.trim() === "Principal Engineer",
    );
    (principal as HTMLElement).click();
    await settle(root.host);
    const promptArea = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(promptArea.value).toContain("Principal Engineer at i.inc");
    await submit(root);
    const body = posted();
    expect(body.role).toBe("Principal Engineer");
    expect(body.duties).toEqual(["plan", "review"]);
    expect(body.prompt).toContain("Principal Engineer at i.inc");
    expect(body.effort).toBe("medium");
    expect(body.engines).toMatchObject({ default: "opus" });
  });

  it("allows writing a role, its prompt, and an effort level", async () => {
    serve();
    const root = await mount();
    await typeName(root, "Grace");

    const write = [...root.querySelectorAll(".pill")].find((b) => b.textContent?.trim() === "Write a role…");
    (write as HTMLElement).click();
    await settle(root.host);

    const customRoleInput = root.querySelector("input.custom-role") as HTMLInputElement;
    expect(customRoleInput).not.toBeNull();
    customRoleInput.value = "Security Architect";
    customRoleInput.dispatchEvent(new Event("input"));
    await settle(root.host);

    const promptArea = root.querySelector("textarea") as HTMLTextAreaElement;
    promptArea.value = "You are the Security Architect. Audit all code for vulnerabilities.";
    promptArea.dispatchEvent(new Event("input"));

    const highEffort = [...root.querySelectorAll('.pill[role="radio"]')].find((b) =>
      b.textContent?.includes("High"),
    );
    (highEffort as HTMLElement).click();
    await settle(root.host);

    await pick(root, selects(root)[0] as HTMLSelectElement, "gemini");
    await submit(root);

    const body = posted();
    expect(body.name).toBe("Grace");
    expect(body.role).toBe("Security Architect");
    expect(body.prompt).toBe("You are the Security Architect. Audit all code for vulnerabilities.");
    expect(body.effort).toBe("high");
  });

  it("updates prompt and effort when editing an existing employee", async () => {
    serve();
    const root = await mount("ada");
    const promptArea = root.querySelector("textarea") as HTMLTextAreaElement;
    promptArea.value = "Updated prompt for Ada: focus strictly on performance.";
    promptArea.dispatchEvent(new Event("input"));

    const highEffort = [...root.querySelectorAll('.pill[role="radio"]')].find((b) =>
      b.textContent?.includes("High"),
    );
    (highEffort as HTMLElement).click();
    await settle(root.host);

    await submit(root);
    const put = calls.find((c) => c.method === "PUT");
    const body = put?.body as Record<string, unknown>;
    expect(body.prompt).toBe("Updated prompt for Ada: focus strictly on performance.");
    expect(body.effort).toBe("high");
    expect(body.engines).toBeDefined();
  });
});

describe("the duties form group (T63)", () => {
  const boxes = (root: ShadowRoot) => [
    ...root.querySelectorAll<HTMLInputElement>('fieldset.duty-set input[type="checkbox"]'),
  ];
  const change = (box: HTMLInputElement, checked: boolean) => {
    box.checked = checked;
    box.dispatchEvent(new Event("change"));
  };

  it("is a group named Duties, and every checkbox is named by its card", async () => {
    serve();
    const root = await mount();
    expect(root.querySelector("fieldset.duty-set > legend")?.textContent).toBe("Duties");
    const all = boxes(root);
    expect(all).toHaveLength(5);
    for (const box of all) {
      const label = box.closest("label");
      expect(label, box.name).not.toBeNull();
      expect(label?.querySelector(".duty-title")?.textContent?.trim()).toBeTruthy();
    }
    // The whole card is the label, so the tap target is the card, not an 18px box.
    expect(root.querySelectorAll("fieldset.duty-set label.duty-card")).toHaveLength(5);
  });

  it("keeps the last duty checked and says why", async () => {
    serve();
    const root = await mount();
    const all = boxes(root);
    for (const box of all.filter((b) => b.checked).slice(1)) change(box, false);
    await new Promise((r) => setTimeout(r, 0));
    const left = boxes(root).filter((b) => b.checked);
    expect(left).toHaveLength(1);
    const only = left[0] as HTMLInputElement;
    change(only, false);
    await new Promise((r) => setTimeout(r, 0));
    expect(only.checked).toBe(true);
    const note = root.querySelector(".duty-note");
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.textContent).toContain("needs at least one duty");
    // Checking another clears the note.
    const other = boxes(root).find((b) => !b.checked) as HTMLInputElement;
    change(other, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector(".duty-note")?.textContent?.trim()).toBe("");
  });
});
