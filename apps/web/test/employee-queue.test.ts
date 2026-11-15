import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type EmployeeQueueView, refreshNow } from "../src/api.ts";
import { IncEmployeeQueue } from "../src/components/employee-queue.ts";

const queue: EmployeeQueueView = {
  tickets: [
    { id: "2", title: "First ticket", project: "Duet", held: false },
    { id: "3", title: "Held ticket", project: "Duet", held: true },
    { id: "4", title: "Urgent ticket", project: "Duet", held: false },
  ],
};
async function mount() {
  const el = new IncEmployeeQueue();
  el.employeeId = "ada";
  el.employeeName = "Ada";
  document.body.append(el);
  await vi.waitFor(() => expect(el.data).not.toBeNull());
  await el.updateComplete;
  return el;
}
const root = (el: IncEmployeeQueue): ShadowRoot => {
  if (!el.shadowRoot) throw new Error("missing shadow root");
  return el.shadowRoot;
};
const ids = (el: IncEmployeeQueue) =>
  [...root(el).querySelectorAll("li")].map((row) => row.getAttribute("data-ticket"));
const button = (el: IncEmployeeQueue, name: string) =>
  required(root(el).querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`));
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing test element");
  return value;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("employee queue controls", () => {
  it("shows saved order and holds, moves by keyboard-accessible buttons, and keeps focus on the ticket", async () => {
    const read = vi.spyOn(api, "employeeQueue").mockResolvedValue(queue);
    const move = vi.spyOn(api, "moveQueued").mockImplementation(async () => {
      const next = {
        tickets: [required(queue.tickets[0]), required(queue.tickets[2]), required(queue.tickets[1])],
      };
      read.mockResolvedValue(next);
      return next;
    });
    const el = await mount();
    expect(ids(el)).toEqual(["2", "3", "4"]);
    expect(root(el).textContent).toContain("Duet · Held");
    button(el, "Move ticket #2 up").click();
    expect(move).not.toHaveBeenCalled();
    const down = button(el, "Move ticket #3 down");
    down.focus();
    down.click();
    await vi.waitFor(() => expect(ids(el)).toEqual(["2", "4", "3"]));
    expect(move).toHaveBeenCalledWith("ada", "3", null, ["2", "3", "4"]);
    expect(root(el).activeElement).toBe(down);
    expect(down.getAttribute("aria-disabled")).toBe("true");
    expect(root(el).querySelector('[role="status"]')?.textContent).toContain("Moved ticket #3 down");
  });

  it("refreshes after a conflict and reports the failure above the queue", async () => {
    const read = vi.spyOn(api, "employeeQueue").mockResolvedValue(queue);
    vi.spyOn(api, "moveQueued").mockImplementation(async () => {
      read.mockResolvedValue({ tickets: queue.tickets.slice(1) });
      throw new Error("The queue changed. Refresh it and try again.");
    });
    const el = await mount();
    button(el, "Move ticket #3 up").click();
    await vi.waitFor(() => expect(el.actionError).toContain("The queue changed"));
    expect(ids(el)).toEqual(["3", "4"]);
    expect(root(el).querySelector('[role="alert"]')?.textContent).toContain("The queue changed");
    read.mockResolvedValue({ tickets: [] });
    refreshNow({ tickets: new Set(["4"]), office: false });
    await vi.waitFor(() => expect(root(el).textContent).toContain("No waiting tickets."));
  });

  it("switches employees during a pending move without applying the old response to the new queue", async () => {
    const read = vi.spyOn(api, "employeeQueue").mockResolvedValue(queue);
    let finish: (value: EmployeeQueueView) => void = () => {};
    vi.spyOn(api, "moveQueued").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const el = await mount();
    button(el, "Move ticket #3 up").click();
    read.mockResolvedValue({ tickets: [] });
    el.employeeId = "kit";
    el.employeeName = "Kit";
    await vi.waitFor(() => expect(root(el).textContent).toContain("No waiting tickets."));
    finish(queue);
    await vi.waitFor(() => expect(el.pressing).toBe(false));
    expect(root(el).textContent).toContain("Kit's queue");
    expect(ids(el)).toEqual([]);
    expect(el.announcement).toBe("");
    expect(read).toHaveBeenLastCalledWith("kit");
  });
});
