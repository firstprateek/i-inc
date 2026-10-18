// Hiring and editing: the engine pickers show harness and "local", and saving sends engines per duty.
import type { Employee, Engine } from "@i-inc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/components/hiring.ts";

const engines: Engine[] = [
  { id: "opus", harness: "claude-code", model: "Claude Opus", accountId: "claude-pro", local: false },
  { id: "gemini", harness: "antigravity", model: "Gemini Pro", accountId: "google", local: false },
  { id: "qwen", harness: "opencode", model: "qwen3", accountId: "local", local: true },
];

const ada: Employee = {
  id: "ada",
  name: "Ada",
  role: "Senior Engineer",
  duties: ["build", "review", "verify"],
  engines: { default: "opus", perDuty: { review: "gemini" }, fallbacks: ["qwen"] },
  switchRules: { outOfTokens: { action: "wait" }, checksFailedBeforeSwitch: 5, onStuck: "switch" },
};

let calls: { method: string; url: string; body: unknown }[] = [];

function serve(team: Employee[] = [ada], failEmployees = false) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/engines") return json({ engines });
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

beforeEach(() => {
  document.body.innerHTML = "";
  location.hash = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("hiring", () => {
  it("offers every engine with its harness, and a local badge on local ones", async () => {
    serve();
    const root = await mount();
    const [def] = selects(root);
    const labels = [...(def?.querySelectorAll("option") ?? [])].map((o) => o.textContent?.trim());
    expect(labels).toContain("Claude Opus · claude-code");
    expect(labels).toContain("qwen3 · opencode · local");

    await pick(root, def as HTMLSelectElement, "qwen");
    const chips = [...root.querySelectorAll("label .chips .chip")].map((c) => c.textContent);
    expect(chips).toEqual(["opencode", "local"]);
  });

  it("has a picker per duty of the role, each defaulting to the default engine", async () => {
    serve();
    const root = await mount();
    const legend = root.querySelector(".duties legend")?.textContent;
    expect(legend).toBe("Engine per duty");
    const names = [...root.querySelectorAll(".duties label")].map((l) =>
      l.querySelector("span")?.textContent?.trim(),
    );
    expect(names).toEqual(["Build", "Review", "Verify"]);
    expect(root.querySelector(".duties option")?.textContent).toBe("Same as default");
  });

  it("sends the default, the duty engines and the fallback", async () => {
    serve();
    const root = await mount();
    const [def, build, review, , fallback] = selects(root);
    const name = root.querySelector('input[type="text"]') as HTMLInputElement;
    name.value = "Nell";
    name.dispatchEvent(new Event("input"));
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
    const name = root.querySelector('input[type="text"]') as HTMLInputElement;
    name.value = "Nell";
    name.dispatchEvent(new Event("input"));
    await pick(root, selects(root)[0] as HTMLSelectElement, "opus");
    await submit(root);
    const post = calls.find((c) => c.method === "POST");
    const sent = post?.body as { engines: object };
    expect(sent.engines).toEqual({ default: "opus", fallbacks: [] });
  });

  it("offers only local engines to a personal assistant", async () => {
    serve();
    const root = await mount();
    const pa = [...root.querySelectorAll(".pill")].find((b) => b.textContent === "Personal Assistant");
    (pa as HTMLElement).click();
    await settle(root.host);
    const ids = [...(selects(root)[0]?.querySelectorAll("option") ?? [])].map((o) => o.value);
    expect(ids).toEqual(["", "qwen"]);
  });

  it("works when the team can't be fetched", async () => {
    serve([], true);
    const root = await mount();
    expect(selects(root).length).toBeGreaterThan(0);
    expect(root.querySelector('[aria-label="Your team"]')).toBeNull();
  });
});

describe("editing someone's engines", () => {
  it("links to each employee from the hiring page", async () => {
    serve();
    const root = await mount();
    const link = root.querySelector('[aria-label="Your team"] a') as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/hiring/ada");
  });

  it("shows what the employee has now, and the fallback's harness", async () => {
    serve();
    const root = await mount("ada");
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
    expect(location.hash).toBe("#/office");
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

describe("custom roles, system prompts, effort levels and explainers", () => {
  it("allows hiring a CEO with CEO system prompt and duties", async () => {
    serve();
    const root = await mount();
    const nameInput = root.querySelector('input[type="text"]') as HTMLInputElement;
    nameInput.value = "Satya";
    nameInput.dispatchEvent(new Event("input"));

    const ceoPill = [...root.querySelectorAll(".pill")].find((b) => b.textContent?.trim() === "CEO");
    (ceoPill as HTMLElement).click();
    await settle(root.host);

    const promptArea = root.querySelector("textarea") as HTMLTextAreaElement;
    expect(promptArea.value).toContain("Chief Executive Officer at i.inc");

    await pick(root, selects(root)[0] as HTMLSelectElement, "opus");
    await submit(root);

    const post = calls.find((c) => c.method === "POST");
    const body = post?.body as Record<string, unknown>;
    expect(body.name).toBe("Satya");
    expect(body.role).toBe("CEO");
    expect(body.duties).toEqual(["plan", "review"]);
    expect(body.prompt).toContain("Chief Executive Officer at i.inc");
    expect(body.effort).toBe("medium");
  });

  it("allows defining a custom role title, prompt, and effort level", async () => {
    serve();
    const root = await mount();
    const nameInput = root.querySelector('input[type="text"]') as HTMLInputElement;
    nameInput.value = "Grace";
    nameInput.dispatchEvent(new Event("input"));

    const customBtn = [...root.querySelectorAll(".pill")].find((b) =>
      b.textContent?.includes("+ Custom Role"),
    );
    (customBtn as HTMLElement).click();
    await settle(root.host);

    const customRoleInput = root.querySelector(
      'input[placeholder*="Chief Executive Officer"]',
    ) as HTMLInputElement;
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

    const post = calls.find((c) => c.method === "POST");
    const body = post?.body as Record<string, unknown>;
    expect(body.name).toBe("Grace");
    expect(body.role).toBe("Security Architect");
    expect(body.prompt).toBe("You are the Security Architect. Audit all code for vulnerabilities.");
    expect(body.effort).toBe("high");
  });

  it("renders educational duty explainer and model switching notes", async () => {
    serve();
    const root = await mount();
    const dutyExplainer = root.querySelector(".duty-explainer");
    expect(dutyExplainer?.textContent).toContain("How pipeline duties work");
    expect(dutyExplainer?.textContent).toContain("Plan → Build → Verify → Review");

    const switchingExplainer = root.querySelector(".switching-explainer");
    expect(switchingExplainer?.textContent).toContain("Model Switching Rules");
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

describe("configure new engine / model form and layout", () => {
  it("toggles the configure new engine box open and closed", async () => {
    serve();
    const root = await mount();
    expect(root.querySelector(".custom-engine-box")).toBeNull();

    const configBtn = [...root.querySelectorAll(".engine-header button")].find((b) =>
      b.textContent?.includes("+ Configure new engine / model"),
    ) as HTMLButtonElement;
    expect(configBtn).toBeDefined();
    configBtn.click();
    await settle(root.host);

    const box = root.querySelector(".custom-engine-box");
    expect(box).not.toBeNull();
    expect(box?.querySelector("h4")?.textContent).toBe("Configure new model or engine");
    expect(configBtn.textContent).toContain("✕ Close");

    // Close via header button
    configBtn.click();
    await settle(root.host);
    expect(root.querySelector(".custom-engine-box")).toBeNull();

    // Reopen and close via Cancel button
    configBtn.click();
    await settle(root.host);
    const cancelBtn = [...root.querySelectorAll(".custom-engine-actions button")].find((b) =>
      b.textContent?.includes("Cancel"),
    ) as HTMLButtonElement;
    expect(cancelBtn).toBeDefined();
    cancelBtn.click();
    await settle(root.host);
    expect(root.querySelector(".custom-engine-box")).toBeNull();
  });

  it("creates and selects a custom engine without overflowing fields", async () => {
    serve();
    const root = await mount();

    const configBtn = [...root.querySelectorAll(".engine-header button")].find((b) =>
      b.textContent?.includes("+ Configure new engine / model"),
    ) as HTMLButtonElement;
    configBtn.click();
    await settle(root.host);

    const box = root.querySelector(".custom-engine-box") as HTMLElement;
    expect(box).not.toBeNull();

    const modelInput = box.querySelector('input[placeholder*="claude-3-7-sonnet"]') as HTMLInputElement;
    const saveBtn = [...box.querySelectorAll(".custom-engine-actions button")].find((b) =>
      b.textContent?.includes("Save & select engine"),
    ) as HTMLButtonElement;

    // Disabled when empty
    expect(saveBtn.disabled).toBe(true);

    modelInput.value = "claude-3-7-sonnet";
    modelInput.dispatchEvent(new Event("input"));
    await settle(root.host);
    expect(saveBtn.disabled).toBe(false);

    saveBtn.click();
    await settle(root.host);

    const put = calls.find((c) => c.url === "/api/engines/claude-3-7-sonnet");
    expect(put).toBeDefined();
    expect(put?.method).toBe("PUT");
    expect(put?.body).toMatchObject({
      model: "claude-3-7-sonnet",
      harness: "claude-code",
    });
  });

  it("enforces layout bounding styles so custom engine controls do not overflow", async () => {
    serve();
    await mount();
    const styles = (customElements.get("inc-hiring") as unknown as { styles: { cssText: string }[] }).styles;
    const cssText = styles.map((s) => s.cssText).join("\n");

    expect(cssText).toContain(".custom-engine-box");
    expect(cssText).toContain("max-width: 100%");
    expect(cssText).toContain("box-sizing: border-box");
    expect(cssText).toContain(".custom-engine-grid");
    expect(cssText).toContain("grid-template-columns: 1fr");
  });
});
