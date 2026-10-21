import { afterEach, describe, expect, it } from "vitest";
import "../../src/components/conv-list.ts";
import type { IncConvList } from "../../src/components/conv-list.ts";
import { must } from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted rows.
type Any = any;

const employees: Any[] = [
  { id: "ada", name: "Ada", role: "Engineer", projects: ["Duet"], tint: 0 },
  { id: "kit", name: "Kit", role: "Engineer", projects: ["Other"], tint: 1 },
  { id: "zed", name: "Zed", role: "Designer", tint: 2 },
];

async function mount(over: Partial<IncConvList> = {}) {
  const el = document.createElement("inc-conv-list") as IncConvList;
  el.employees = employees;
  el.projects = ["Duet", "Other"];
  Object.assign(el, over);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the New conversation form", () => {
  it("opens preset to a project from the address, with an employee who works on it", async () => {
    const el = await mount({ ready: true, preset: { employee: "", project: "Other" } });
    await el.updateComplete;
    const form = el.shadowRoot?.querySelector("form.create");
    expect(form).not.toBeNull();
    const [who, project] = [...(form?.querySelectorAll("select") ?? [])] as HTMLSelectElement[];
    expect(project?.value).toBe("Other");
    expect(who?.value).toBe("kit");
  });

  it("keeps a named employee, and Start only asks for a draft: nothing is created", async () => {
    const el = await mount({ ready: true, preset: { employee: "zed", project: "Duet" } });
    await el.updateComplete;
    const seen: unknown[] = [];
    el.addEventListener("conv-create", (e) => seen.push((e as CustomEvent).detail));
    must<HTMLFormElement>(el.shadowRoot?.querySelector("form.create")).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    expect(seen).toEqual([{ employeeId: "zed", project: "Duet" }]);
  });

  it("says so and falls back to No project when the address names a project that isn't there", async () => {
    const el = await mount({ ready: true, preset: { employee: "", project: "nope-unknown" } });
    await el.updateComplete;
    const form = el.shadowRoot?.querySelector("form.create");
    const [who, project] = [...(form?.querySelectorAll("select") ?? [])] as HTMLSelectElement[];
    expect(form?.textContent).toContain("That project isn't available.");
    expect(form?.textContent).not.toContain("nope-unknown");
    expect(project?.value).toBe("");
    expect(who?.value).toBe("ada");
  });

  it("says so when the employee isn't there either, and picks the first", async () => {
    const el = await mount({ ready: true, preset: { employee: "ghost", project: "Duet" } });
    await el.updateComplete;
    const form = el.shadowRoot?.querySelector("form.create");
    expect(form?.textContent).toContain("That employee isn't available.");
    expect(must<HTMLSelectElement>(form?.querySelectorAll("select")[1]).value).toBe("Duet");
  });

  it("does not judge the address before the employees and projects have arrived", async () => {
    const el = await mount({
      ready: false,
      projects: [],
      employees: [],
      preset: { employee: "ada", project: "Duet" },
    });
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("form.create")?.textContent).not.toContain("isn't available");
  });

  it("stays closed until asked for", async () => {
    const el = await mount();
    expect(el.shadowRoot?.querySelector("form.create")).toBeNull();
  });
});
