import { afterEach, describe, expect, it } from "vitest";
import "../../src/components/conv-list.ts";
import type { IncConvList } from "../../src/components/conv-list.ts";
import { must } from "../ahp/fake-host.ts";

// biome-ignore lint/suspicious/noExplicitAny: scripted rows.
type Any = any;

const employees: Any[] = [
  { id: "ada", name: "Ada", role: "Engineer", projects: ["Duet"], tint: 0 },
  { id: "kit", name: "Kit", role: "Engineer", projects: ["Other"], tint: 1 },
];

async function mount(over: Partial<IncConvList> = {}) {
  const el = document.createElement("inc-conv-list") as IncConvList;
  el.employees = employees;
  Object.assign(el, over);
  document.body.append(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the New conversation button", () => {
  it("asks the screen for the draft in the centre pane: no form opens in the list", async () => {
    const el = await mount();
    let asked = 0;
    el.addEventListener("conv-new", () => asked++);
    const btn = must<HTMLButtonElement>(el.shadowRoot?.querySelector("button.new"));
    expect(btn.textContent?.trim()).toBe("New conversation");
    btn.click();
    await el.updateComplete;
    expect(asked).toBe(1);
    // the list has no form, selects or Start button of its own
    expect(el.shadowRoot?.querySelector("form.create")).toBeNull();
    expect(el.shadowRoot?.querySelector("select")).toBeNull();
    expect(el.shadowRoot?.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("is the current page while the draft is open", async () => {
    const el = await mount({ drafting: true });
    expect(el.shadowRoot?.querySelector("button.new")?.getAttribute("aria-current")).toBe("page");
    el.drafting = false;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("button.new")?.getAttribute("aria-current")).toBe("false");
  });
});

describe("an empty list", () => {
  it("is one small muted line: the centre pane carries the invitation", async () => {
    const el = await mount({ items: [], loading: false });
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector("p.none")?.textContent).toBe("No conversations yet.");
    // no big heading, no second paragraph of advice
    expect(root.querySelector(".groups h2")).toBeNull();
    expect(root.querySelectorAll(".groups p").length).toBe(1);
    const css = (customElements.get("inc-conv-list") as unknown as { styles: { cssText: string }[] }).styles
      .map((c) => c.cssText)
      .join("\n");
    expect(css).toMatch(/\.none \{[^}]*color: var\(--ink-2\)[^}]*font-size: 13\.5px/);
  });

  it("says so for archived conversations and for a search with no match", async () => {
    const el = await mount({ items: [], loading: false, showArchived: true });
    expect(el.shadowRoot?.querySelector("p.none")?.textContent).toBe("No archived conversations.");
  });
});
