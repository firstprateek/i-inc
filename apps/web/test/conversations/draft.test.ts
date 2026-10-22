// The New conversation screen: a centred composer with the employee, project and mode pickers (and the
// first-run checklist below it). It creates nothing until the first message is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IncConvDraft, resolveDraft } from "../../src/components/conv-draft.ts";
import { lastUsed, modeKey, modesKey, rememberLastUsed } from "../../src/conversations/prefs.ts";
import { must } from "../ahp/fake-host.ts";
import "../../src/components/conv-draft.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted rows.
type Any = any;

const employees: Any[] = [
  { id: "ada", name: "Ada", role: "Engineer", projects: ["Duet"], tint: 0 },
  { id: "kit", name: "Kit", role: "Engineer", projects: ["Other"], tint: 1 },
  { id: "zed", name: "Zed", role: "Designer", tint: 2 },
];
const projects = ["Duet", "Other"];
const none = { employee: "", project: "" };

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  localStorage.clear();
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mount(over: Partial<IncConvDraft> = {}) {
  const el = document.createElement("inc-conv-draft") as IncConvDraft;
  el.employees = employees;
  el.projects = projects;
  el.ready = true;
  el.onCreate = vi.fn(async () => null);
  Object.assign(el, over);
  document.body.append(el);
  await el.updateComplete;
  const root = el.shadowRoot as ShadowRoot;
  const [who, project] = [...root.querySelectorAll(".picks select")] as HTMLSelectElement[];
  const composer = must<Any>(root.querySelector("inc-conv-composer"));
  await composer.updateComplete;
  const mode = () => composer.shadowRoot?.querySelector(".pickers select") as HTMLSelectElement | null;
  return { el, root, who: who as HTMLSelectElement, project: project as HTMLSelectElement, composer, mode };
}

describe("resolveDraft", () => {
  it("takes the employee and project an address names", () => {
    expect(resolveDraft({ employee: "zed", project: "Duet" }, employees, projects, none, true)).toEqual({
      employee: "zed",
      project: "Duet",
      note: "",
    });
  });

  it("takes an employee who works on the project when only the project is named", () => {
    expect(resolveDraft({ employee: "", project: "Other" }, employees, projects, none, true)).toMatchObject({
      employee: "kit",
      project: "Other",
    });
  });

  it("starts from the last used employee and project when the address names neither", () => {
    expect(resolveDraft(none, employees, projects, { employee: "kit", project: "Other" }, true)).toEqual({
      employee: "kit",
      project: "Other",
      note: "",
    });
    // a last project this employee no longer works on falls back to none
    expect(resolveDraft(none, employees, projects, { employee: "kit", project: "Duet" }, true).project).toBe(
      "",
    );
    // nothing used yet: the first employee and no project
    expect(resolveDraft(none, employees, projects, none, true)).toEqual({
      employee: "ada",
      project: "",
      note: "",
    });
  });

  it("says so when the address names an employee or project that isn't there, and falls back", () => {
    const r = resolveDraft({ employee: "ghost", project: "nope" }, employees, projects, none, true);
    expect(r.note).toContain("That employee isn't available.");
    expect(r.note).toContain("That project isn't available");
    expect(r).toMatchObject({ employee: "ada", project: "" });
  });

  it("does not judge the address before the employees and projects have arrived", () => {
    expect(resolveDraft({ employee: "ada", project: "Duet" }, [], [], none, false)).toEqual({
      employee: "ada",
      project: "Duet",
      note: "",
    });
  });
});

describe("the centred composer", () => {
  it("is one column: a heading, the employee and project pickers, the composer and nothing else to open", async () => {
    const { root, who, project, composer } = await mount();
    expect(root.querySelector("h2")?.textContent).toBe("Start a conversation");
    expect(who.value).toBe("ada");
    expect(project.value).toBe("");
    expect([...project.options].map((o) => o.value)).toEqual(["", "Duet"]); // Ada's projects
    expect(composer.getAttribute("name") ?? composer.name).toBe("Ada");
    expect(root.querySelector("form")).toBeNull(); // no form of its own: the composer is the control
    // every select is named and 44px tall (CSS), so a phone can use it
    for (const s of root.querySelectorAll("select")) expect(s.getAttribute("aria-label")).toBeTruthy();
  });

  it("defaults to the last used employee and project", async () => {
    rememberLastUsed({ employee: "kit", project: "Other" });
    const { who, project } = await mount();
    expect(who.value).toBe("kit");
    expect(project.value).toBe("Other");
  });

  it("an address presets them, and an unknown one is said in words", async () => {
    const { root, who, project } = await mount({ preset: { employee: "zed", project: "ghost" } });
    expect(who.value).toBe("zed");
    expect(project.value).toBe("");
    expect(root.querySelector(".notice")?.textContent).toContain("That project isn't available");
  });

  it("changing the employee offers that employee's projects and drops one they don't work on", async () => {
    const { el, who, project } = await mount({ preset: { employee: "ada", project: "Duet" } });
    expect(project.value).toBe("Duet");
    who.value = "kit";
    who.dispatchEvent(new Event("change"));
    await el.updateComplete;
    const again = el.shadowRoot?.querySelectorAll(".picks select")[1] as HTMLSelectElement;
    expect([...again.options].map((o) => o.value)).toEqual(["", "Other"]);
    expect(again.value).toBe("");
  });

  it("waits for the employees before judging: shows the address, then settles", async () => {
    const el = document.createElement("inc-conv-draft") as IncConvDraft;
    el.preset = { employee: "ada", project: "Duet" };
    document.body.append(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".notice")).toBeNull();
    el.employees = employees;
    el.projects = projects;
    el.ready = true;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".notice")).toBeNull();
    const first = el.shadowRoot?.querySelector<HTMLSelectElement>(".picks select");
    expect(first?.value).toBe("ada");
  });

  it("puts the first-run checklist last, under the composer, so what loads later moves nothing above it", async () => {
    const { root } = await mount();
    const kids = [...(root.querySelector(".draft")?.children ?? [])].map((c) => c.tagName.toLowerCase());
    expect(kids.at(-1)).toBe("inc-getting-started");
    expect(kids.indexOf("inc-getting-started")).toBeGreaterThan(kids.indexOf("div")); // after the composer's wrapper
    const css = (customElements.get("inc-conv-draft") as unknown as { styles: { cssText: string }[] }).styles
      .map((c) => c.cssText)
      .join("\n");
    // top-aligned at a fixed place, never centred on the page's height (that moves when content arrives)
    expect(css).toMatch(/\.draft \{[^}]*padding: clamp\(/);
    expect(css).not.toMatch(/\.draft \{[^}]*margin: auto/);
  });

  it("shows a Back button on a phone with conversations to go back to", async () => {
    const a = await mount({ back: true, phone: true });
    expect(a.root.querySelector("button.back")?.textContent).toContain("Conversations");
    document.body.innerHTML = "";
    const b = await mount();
    expect(b.root.querySelector("button.back")).toBeNull();
  });
});

describe("the mode picker", () => {
  it("shows bypass permissions until the agent has named its modes", async () => {
    const { mode } = await mount();
    expect(mode()?.getAttribute("aria-label")).toBe("Mode: Bypass permissions");
    expect([...(mode()?.options ?? [])].map((o) => o.textContent)).toEqual(["Bypass permissions"]);
  });

  it("shows the employee's remembered mode, in words", async () => {
    localStorage.setItem(modeKey("ada"), "acceptEdits");
    const { mode } = await mount();
    expect(mode()?.getAttribute("aria-label")).toBe("Mode: Accept edits");
  });

  it("swaps in the agent's real list once it is known, with the remembered mode chosen", async () => {
    localStorage.setItem(modeKey("ada"), "plan");
    localStorage.setItem(
      modesKey("ada"),
      JSON.stringify([
        ["default", "Ask before edits"],
        ["plan", "Plan only"],
        ["bypassPermissions", "Bypass permissions"],
      ]),
    );
    const { mode } = await mount();
    expect([...(mode()?.options ?? [])].map((o) => o.value)).toEqual([
      "default",
      "plan",
      "bypassPermissions",
    ]);
    expect(mode()?.value).toBe("plan");
  });

  it("defaults to the agent's bypass mode when its list is known and none was chosen", async () => {
    localStorage.setItem(
      modesKey("ada"),
      JSON.stringify([
        ["default", "Ask before edits"],
        ["bypassPermissions", "Bypass permissions"],
      ]),
    );
    const { mode } = await mount();
    expect(mode()?.value).toBe("bypassPermissions");
  });

  it("remembers a choice for that employee, so the conversation starts in it", async () => {
    localStorage.setItem(
      modesKey("ada"),
      JSON.stringify([
        ["default", "Ask before edits"],
        ["bypassPermissions", "Bypass permissions"],
      ]),
    );
    const { mode, el } = await mount();
    const select = mode() as HTMLSelectElement;
    select.value = "default";
    select.dispatchEvent(new Event("change"));
    await el.updateComplete;
    expect(localStorage.getItem(modeKey("ada"))).toBe("default");
    expect(localStorage.getItem(modeKey("kit"))).toBeNull();
  });
});

describe("sending the first message", () => {
  it("creates the conversation with the chosen employee and project, and remembers them", async () => {
    const onCreate = vi.fn(async () => null as string | null);
    const { el, composer, who, project } = await mount({ onCreate });
    who.value = "zed";
    who.dispatchEvent(new Event("change"));
    await el.updateComplete;
    const p = el.shadowRoot?.querySelectorAll(".picks select")[1] as HTMLSelectElement;
    p.value = "Duet";
    p.dispatchEvent(new Event("change"));
    await el.updateComplete;
    composer.text = "hello";
    await composer.updateComplete;
    await composer.submit("turn");
    expect(onCreate).toHaveBeenCalledWith(
      { text: "hello", files: [], intent: "turn" },
      { employee: "zed", project: "Duet" },
    );
    expect(lastUsed()).toEqual({ employee: "zed", project: "Duet" });
    void project;
  });

  it("does not remember a conversation that could not be made, and gives the message back", async () => {
    const onCreate = vi.fn(async () => "The host didn't accept that.");
    const { composer } = await mount({ onCreate });
    composer.text = "hello";
    await composer.updateComplete;
    await composer.submit("turn");
    expect(lastUsed()).toEqual({ employee: "", project: "" });
    expect(composer.text).toBe("hello");
    expect(composer.shadowRoot?.querySelector(".problem")?.textContent).toContain("didn't accept");
  });

  it("is blocked, with a reason, when there is nobody to talk to", async () => {
    const { composer } = await mount({ employees: [] });
    expect(composer.blocked).toContain("Hire an employee first");
  });
});
