// Company → Settings → Approvals (decided 2026-11-15): one level for the company, one per employee.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/components/setup-approvals.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const view = (over: Record<string, unknown> = {}) => ({
  company: "lenient",
  employees: [{ id: "ada", name: "Ada", role: "Senior Engineer", approvals: null }],
  lenientSkips: ["Plans"],
  alwaysAsks: ["Spending money"],
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mount(put: (body: unknown) => Response) {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      return put(body);
    }
    return json(view());
  });
  const el = document.createElement("inc-setup-approvals");
  document.body.append(el);
  await tick();
  return { root: el.shadowRoot as ShadowRoot, sent };
}

describe("the Approvals settings", () => {
  it("shows the company's level, each employee, and what always asks", async () => {
    const { root } = await mount(() => json(view()));
    const pressed = root.querySelector('.seg button[aria-pressed="true"]');
    expect(pressed?.textContent).toBe("Lenient");
    expect((root.querySelector("select") as HTMLSelectElement).value).toBe("company");
    expect(root.textContent).toContain("Spending money");
  });

  it("saves an employee's own level, and shows the saved level again when the save fails", async () => {
    const ok = await mount(() =>
      json(view({ employees: [{ ...view().employees[0], approvals: "careful" }] })),
    );
    const select = ok.root.querySelector("select") as HTMLSelectElement;
    select.value = "careful";
    select.dispatchEvent(new Event("change"));
    await tick();
    expect(ok.sent).toEqual([{ employees: { ada: "careful" } }]);
    expect(ok.root.textContent).toContain("Saved.");
    document.body.innerHTML = "";

    const bad = await mount(() => json({ error: "nope" }, 400));
    const s2 = bad.root.querySelector("select") as HTMLSelectElement;
    s2.value = "careful";
    s2.dispatchEvent(new Event("change"));
    await tick();
    expect((bad.root.querySelector("select") as HTMLSelectElement).value).toBe("company");
  });
});
