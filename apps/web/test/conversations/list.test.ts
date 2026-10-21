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
    const el = await mount({ preset: { employee: "", project: "Other" } });
    await el.updateComplete;
    const form = el.shadowRoot?.querySelector("form.create");
    expect(form).not.toBeNull();
    const [who, project] = [...(form?.querySelectorAll("select") ?? [])] as HTMLSelectElement[];
    expect(project?.value).toBe("Other");
    expect(who?.value).toBe("kit");
  });

  it("keeps a named employee, and Start only asks for a draft: nothing is created", async () => {
    const el = await mount({ preset: { employee: "zed", project: "Duet" } });
    await el.updateComplete;
    const seen: unknown[] = [];
    el.addEventListener("conv-create", (e) => seen.push((e as CustomEvent).detail));
    must<HTMLFormElement>(el.shadowRoot?.querySelector("form.create")).dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    expect(seen).toEqual([{ employeeId: "zed", project: "Duet" }]);
  });

  it("stays closed until asked for", async () => {
    const el = await mount();
    expect(el.shadowRoot?.querySelector("form.create")).toBeNull();
  });
});
