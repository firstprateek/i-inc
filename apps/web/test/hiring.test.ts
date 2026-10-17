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
    expect(labels).toContain("Claude Opus (claude-code) · claude-pro");
    expect(labels).toContain("qwen3 (opencode, local) · local");

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
