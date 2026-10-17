// Session transcripts on the ticket page (contract C4).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TicketSession } from "../src/api.ts";
import "../src/components/transcript.ts";

const long = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

const sessions: TicketSession[] = [
  {
    stage: "plan",
    employeeId: "ada",
    engineId: "opus",
    startedAt: Date.UTC(2026, 9, 17, 12, 0),
    endedAt: Date.UTC(2026, 9, 17, 12, 4),
    items: [{ kind: "text", text: "Plan ready.", at: Date.UTC(2026, 9, 17, 12, 3) }],
  },
  {
    stage: "build",
    employeeId: "ada",
    engineId: "opus",
    startedAt: Date.UTC(2026, 9, 17, 12, 5),
    endedAt: null,
    items: [
      {
        kind: "text",
        text: "I will edit it:\n```ts\nconst a = 1;\n```\nDone.",
        at: Date.UTC(2026, 9, 17, 12, 6),
      },
      {
        kind: "tool",
        title: "Read src/index.ts",
        status: "completed",
        text: long,
        at: Date.UTC(2026, 9, 17, 12, 7),
      },
      { kind: "tool", title: "Run pnpm test", status: "failed", at: Date.UTC(2026, 9, 17, 12, 8) },
    ],
  },
];

function serve(status = 200, body: unknown = { sessions }) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return urls;
}

async function mount(): Promise<ShadowRoot> {
  const el = document.createElement("inc-transcript") as HTMLElement & { ticketId: string };
  el.ticketId = "7";
  document.body.append(el);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  }
  return el.shadowRoot as ShadowRoot;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = async (b: Element) => {
  (b as HTMLElement).click();
  await tick();
  await tick();
};
const heads = (r: ShadowRoot) => [...r.querySelectorAll<HTMLButtonElement>("button.head")];

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("<inc-transcript>", () => {
  it("lists the sessions from C4 with stage, employee, engine, times and state", async () => {
    const urls = serve();
    const root = await mount();
    expect(urls).toEqual(["/api/tickets/7/sessions"]);
    const h = heads(root);
    expect(h).toHaveLength(2);
    expect(h[0]?.textContent).toContain("plan · ada");
    expect(h[0]?.textContent).toContain("opus");
    expect(h[0]?.textContent).toContain("Finished");
    expect(h[0]?.textContent).toContain("4 min");
    expect(h[1]?.textContent).toContain("build");
    expect(h[1]?.textContent).toContain("Running");
    expect(h[1]?.textContent).toContain("Errors");
    expect(root.querySelector(".items")).toBeNull();
  });

  it("shows agent text with code blocks when a session is opened", async () => {
    serve();
    const root = await mount();
    await click(heads(root)[1] as Element);
    expect(heads(root)[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector(".text p")?.textContent).toBe("I will edit it:");
    expect(root.querySelector("pre.code")?.textContent).toBe("const a = 1;");
  });

  it("keeps tool calls collapsed until opened, and highlights failures", async () => {
    serve();
    const root = await mount();
    await click(heads(root)[1] as Element);
    const tools = [...root.querySelectorAll<HTMLElement>(".tool")];
    expect(tools).toHaveLength(2);
    expect(root.querySelector(".tool .detail")).toBeNull();
    expect(tools[0]?.textContent).toContain("Read src/index.ts");
    expect(tools[1]?.classList.contains("err")).toBe(true);
    expect(tools[0]?.classList.contains("err")).toBe(false);
    await click(tools[0]?.querySelector("button") as Element);
    expect(root.querySelector(".tool .detail pre.out")).not.toBeNull();
    await click(tools[0]?.querySelector("button") as Element);
    expect(root.querySelector(".tool .detail")).toBeNull();
  });

  it("truncates long tool output until Show all", async () => {
    serve();
    const root = await mount();
    await click(heads(root)[1] as Element);
    await click(root.querySelector(".tool button") as Element);
    const out = () => root.querySelector("pre.out")?.textContent ?? "";
    expect(out()).toContain("line 12");
    expect(out()).not.toContain("line 13");
    const more = root.querySelector<HTMLButtonElement>("button.more");
    expect(more?.textContent).toBe("Show all");
    await click(more as Element);
    expect(out()).toContain("line 40");
    expect(root.querySelector("button.more")?.textContent).toBe("Show less");
  });

  it("hides the section when the endpoint 404s", async () => {
    serve(404, { error: "no such ticket" });
    const root = await mount();
    expect(root.querySelector("section")).toBeNull();
    expect(root.textContent?.trim()).toBe("");
  });

  it("hides the section when there are no sessions", async () => {
    serve(200, { sessions: [] });
    const root = await mount();
    expect(root.querySelector("section")).toBeNull();
  });
});
